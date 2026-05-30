import { EventBuffer } from './buffer';
import {
  OfflineQueue,
  NoopOfflineQueue,
  PersistedEvent,
  nextPersistedId,
  isPersistablePath,
} from './offline-queue';

const REQUEST_TIMEOUT = 2000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 300_000;
const COMPRESSION_THRESHOLD_BYTES = 1024;

/**
 * A unit of work in the transport. `persistId` is set once the item has been
 * written to the {@link OfflineQueue}; it lets us remove the persisted copy
 * after a successful (2xx) send or a permanent (non-429 4xx) drop, and avoids
 * writing the same payload to disk twice on repeated buffer cycles.
 */
export type Pending = { path: string; payload: unknown; persistId?: string };

/**
 * Error thrown for a non-2xx HTTP response, carrying the status and the
 * server's `Retry-After` header (when present) so the retry/circuit-breaker
 * logic can honour real rate-limit signals instead of regex-scraping a string.
 */
class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfter: string | null,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpResponseError';
  }
}

export interface TransportStats {
  queued: number;
  sent: number;
  failed: number;
  dropped: number;
  retryAttempts: number;
  rateLimited: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastTransportLatencyMs?: number;
  lastFlushDurationMs?: number;
  /** Events written to the persistent offline store (instead of dropped). */
  persisted?: number;
  /** Events re-sent from the persistent store on init. */
  replayed?: number;
  /** Payloads gzip-compressed before send. */
  compressed?: number;
  /** Payloads sent without compression. */
  uncompressed?: number;
  /** Approximate bytes saved by compression. */
  compressionBytesSaved?: number;
}

export class HttpTransport {
  private buffer = new EventBuffer();
  private inFlight = new Set<Promise<void>>();
  private flushing = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private sent = 0;
  private failed = 0;
  private dropped = 0;
  private retryAttempts = 0;
  private rateLimited = 0;
  private lastTransportLatencyMs: number | undefined;
  private lastFlushDurationMs: number | undefined;
  private persisted = 0;
  private replayed = 0;
  private compressed = 0;
  private uncompressed = 0;
  private compressionBytesSaved = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimerDueAt = 0;
  private pendingRetryDelayMs = 0;
  private closed = false;

  /**
   * Persistent / offline store. Defaults to a no-op so existing callers and
   * tests keep their pure in-memory behavior; the client injects a real queue
   * (localStorage / fs spool / pluggable adapter) when `enableOfflineQueue` is
   * on. Every interaction is fail-open.
   */
  private offlineQueue: OfflineQueue;
  /** True only when a real (non-noop) persistent store is wired up. */
  private offlineEnabled: boolean;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    offlineQueue?: OfflineQueue,
  ) {
    this.offlineQueue = offlineQueue ?? new NoopOfflineQueue();
    this.offlineEnabled = !!offlineQueue && !(offlineQueue instanceof NoopOfflineQueue);
  }

  send(path: string, payload: unknown): Promise<void> {
    if (this.closed && !isPersistablePath(path)) {
      return Promise.resolve();
    }
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }

  private enqueueOrDispatch(item: Pending): void {
    if (Date.now() < this.circuitOpenUntil) {
      this.persistOne(item, false);
      this.bufferOrPersist(item);
      this.scheduleFlush();
      return;
    }
    this.track(this.dispatch(item));
  }

  /**
   * Push an item back onto the in-memory buffer. If the buffer is full the
   * OLDEST item is evicted — instead of dropping that evictee on the floor we
   * persist it to the offline store (already PII-scrubbed) so it survives a
   * restart/outage and is replayed on the next init. Session lifecycle paths
   * are never persisted. Fully fail-open.
   */
  private bufferOrPersist(item: Pending): void {
    if (this.closed) {
      this.persistOne(item);
      return;
    }
    const evicted = this.buffer.pushReturningEvicted(item) as Pending | null;
    // The buffer is full — the OLDEST item was evicted to make room. Instead of
    // dropping it on the floor, persist it (already PII-scrubbed) so it survives
    // a restart/outage. `persistOne` reuses an existing persistId so a replayed
    // item isn't written to the store twice across buffer cycles.
    if (evicted) this.persistOne(evicted);
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
  }

  private async dispatch(item: Pending): Promise<void> {
    try {
      await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
      this.onSendSuccess(item);
      if (!this.closed) this.scheduleFlush();
    } catch (err) {
      this.onSendFailure(item, err);
    }
  }

  /** A 2xx (or replay) succeeded: clear the persisted copy if this was one. */
  private onSendSuccess(item: Pending): void {
    this.sent++;
    this.consecutiveFailures = 0;
    this.circuitOpenUntil = 0;
    if (item.persistId) {
      try {
        this.offlineQueue.remove(item.persistId);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * A send failed. Transient errors (network, 429, 5xx) re-buffer the item
   * (spilling the buffer evictee to the offline store). A PERMANENT failure
   * — a 4xx other than 429 — means the server will never accept this payload,
   * so we drop it and remove any persisted copy rather than replaying forever.
   */
  private onSendFailure(item: Pending, err: unknown): void {
    this.failed++;
    if (err instanceof HttpResponseError && err.status === 429) this.rateLimited++;
    const retryDelay = this.recordFailure(err);
    if (isPermanentFailure(err)) {
      this.dropped++;
      if (item.persistId) {
        try {
          this.offlineQueue.remove(item.persistId);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (this.closed) {
      this.persistOne(item);
      return;
    }
    // Persist the failing item immediately when a real offline store exists.
    // The in-memory buffer still retries it in this process, but the persisted
    // copy protects against tab/process death before the next retry fires.
    this.persistOne(item, false);
    this.bufferOrPersist(item);
    this.retryAttempts++;
    this.scheduleFlush(retryDelay);
  }

  private async doFetch(url: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const started = Date.now();
    const bodyJson = JSON.stringify(payload);
    const body = await this.prepareRequestBody(bodyJson);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
          ...body.headers,
        },
        body: body.body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) throw new HttpResponseError(res.status, res.headers.get('Retry-After'));
      return res;
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    } finally {
      this.lastTransportLatencyMs = Date.now() - started;
    }
  }

  private scheduleFlush(delayMs = 0): void {
    if (this.closed) return;
    if (this.buffer.size === 0) return;
    if (this.flushing) {
      this.pendingRetryDelayMs = Math.max(this.pendingRetryDelayMs, delayMs);
      return;
    }
    const delay = Math.max(delayMs, this.pendingRetryDelayMs, Math.max(0, this.circuitOpenUntil - Date.now()));
    this.pendingRetryDelayMs = 0;
    const dueAt = Date.now() + delay;
    if (this.retryTimer && this.retryTimerDueAt <= dueAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerDueAt = dueAt;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerDueAt = 0;
      void this.flushBuffer().catch(() => undefined);
    }, delay);
    this.retryTimer = timer;
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    if (this.closed) return;
    this.flushing = true;
    const started = Date.now();

    try {
      const items = this.buffer.drain() as Pending[];
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          this.persistOne(item, false);
          this.bufferOrPersist(item);
          continue;
        }
        try {
          await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
          this.onSendSuccess(item);
        } catch (err) {
          this.onSendFailure(item, err);
        }
      }
    } catch {
      // Best-effort telemetry must never escape transport internals.
    } finally {
      this.lastFlushDurationMs = Date.now() - started;
      this.flushing = false;
      if (this.buffer.size > 0) this.scheduleFlush();
    }
  }

  private recordFailure(error: unknown): number {
    this.consecutiveFailures++;
    const backoff = jitteredBackoff(this.consecutiveFailures);
    // A real `Retry-After` from a 429/503 response overrides the computed
    // backoff; otherwise fall back to the jittered exponential backoff.
    const retryAfterMs = retryAfterFromResponse(error);
    const delay = retryAfterMs > 0 ? retryAfterMs : backoff;
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitOpenUntil = Date.now() + delay;
    }
    return delay;
  }

  getBufferSize(): number {
    return this.buffer.size;
  }

  /**
   * Replay events persisted by a previous process/session (offline queue).
   * Loads the store, re-sends each entry through the existing transport (so it
   * honours the same retry/backoff/circuit-breaker), and removes an entry only
   * once it is accepted (2xx) or permanently undeliverable (non-429 4xx).
   * Transient failures keep the entry in the store for the NEXT init.
   *
   * Runs asynchronously and is fully fail-open — it never throws and never
   * blocks init. Items carry their `persistId` so a successful send clears the
   * stored copy in {@link onSendSuccess}.
   */
  drainPersisted(): void {
    let persistedItems: PersistedEvent[];
    try {
      persistedItems = this.offlineQueue.load();
    } catch {
      return;
    }
    if (persistedItems.length === 0) return;

    for (const entry of persistedItems) {
      if (!isPersistablePath(entry.path)) {
        // Defensive: never replay a session lifecycle call even if one leaked
        // into the store from an older SDK version.
        try {
          this.offlineQueue.remove(entry.id);
        } catch {
          /* ignore */
        }
        continue;
      }
      this.replayed++;
      this.enqueueOrDispatch({ path: entry.path, payload: entry.payload, persistId: entry.id });
    }
  }

  /**
   * Spill everything still buffered in memory into the persistent store. Called
   * on graceful shutdown (process exit / tab close) so in-flight telemetry that
   * could not be flushed in time survives a restart instead of being dropped.
   * Session lifecycle paths are skipped. Fail-open.
   */
  persistBufferedNow(): void {
    let items: Pending[];
    try {
      items = this.buffer.drain() as Pending[];
    } catch {
      return;
    }
    for (const item of items) this.persistOne(item);
  }

  close(): void {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.retryTimerDueAt = 0;
    this.pendingRetryDelayMs = 0;
    this.persistBufferedNow();
  }

  /**
   * Drain the in-memory buffer and hand the items to the caller. Used by the
   * browser unload path so the client can attempt a `navigator.sendBeacon` for
   * each event and persist only what the beacon could not take. Fail-open.
   */
  drainBufferForUnload(): Pending[] {
    try {
      return this.buffer.drain() as Pending[];
    } catch {
      return [];
    }
  }

  /**
   * Persist a single already-scrubbed item to the offline store. Session
   * lifecycle paths are skipped (counted as a real drop). Fail-open.
   */
  persistOne(item: Pending, countDropOnSkip = true): void {
    if (item.persistId) {
      if (this.offlineEnabled && isPersistablePath(item.path)) {
        try {
          this.offlineQueue.enqueue({ id: item.persistId, path: item.path, payload: item.payload, ts: Date.now() });
          this.persisted++;
        } catch {
          if (countDropOnSkip) this.dropped++;
        }
      }
      return;
    }
    // No real store (offline queue disabled / unavailable) → legacy in-memory
    // behavior: an evicted/overflow item is a real drop. Session lifecycle
    // paths are also a real drop (never persisted).
    if (!this.offlineEnabled || !isPersistablePath(item.path)) {
      if (countDropOnSkip) this.dropped++;
      return;
    }
    try {
      const id = item.persistId ?? nextPersistedId();
      this.offlineQueue.enqueue({ id, path: item.path, payload: item.payload, ts: Date.now() });
      item.persistId = id;
      this.persisted++;
    } catch {
      if (countDropOnSkip) this.dropped++;
    }
  }

  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (this.buffer.size > 0 && !this.flushing && Date.now() >= this.circuitOpenUntil) {
        await this.flushBuffer();
      }

      if (this.buffer.size === 0 && this.inFlight.size === 0 && !this.flushing) {
        return true;
      }

      if (Date.now() >= deadline) {
        return false;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  noteDropped(count = 1): void {
    this.dropped += Math.max(0, count);
  }

  private async prepareRequestBody(bodyJson: string): Promise<PreparedBody> {
    const rawBytes = byteLength(bodyJson);
    if (rawBytes < COMPRESSION_THRESHOLD_BYTES) {
      this.uncompressed++;
      return { body: bodyJson, headers: {} };
    }

    const compressed = await gzipBody(bodyJson);
    if (!compressed || compressed.byteLength >= rawBytes) {
      this.uncompressed++;
      return { body: bodyJson, headers: {} };
    }

    this.compressed++;
    this.compressionBytesSaved += rawBytes - compressed.byteLength;
    return {
      body: compressed as unknown as BodyInit,
      headers: { 'Content-Encoding': 'gzip' },
    };
  }

  getStats(): TransportStats {
    return {
      queued: this.buffer.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      retryAttempts: this.retryAttempts,
      rateLimited: this.rateLimited,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransportLatencyMs: this.lastTransportLatencyMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
      persisted: this.persisted,
      replayed: this.replayed,
      compressed: this.compressed,
      uncompressed: this.uncompressed,
      compressionBytesSaved: this.compressionBytesSaved,
    };
  }
}

function byteLength(value: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).byteLength;
  return value.length;
}

type PreparedBody = {
  body: BodyInit;
  headers: Record<string, string>;
};

async function gzipBody(bodyJson: string): Promise<Uint8Array | null> {
  const compressionStream = (globalThis as any).CompressionStream;
  if (typeof compressionStream === 'function' && typeof Blob !== 'undefined' && typeof Response !== 'undefined') {
    try {
      const stream = new Blob([bodyJson], { type: 'application/json' })
        .stream()
        .pipeThrough(new compressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  try {
    const proc = (globalThis as any).process;
    const zlib = proc?.getBuiltinModule?.('node:zlib') ??
      optionalRequire('node:zlib') ??
      optionalRequire('zlib') ??
      (proc?.versions?.node ? await import('node:zlib').catch(() => null) : null);
    const compressed = zlib?.gzipSync?.(bodyJson);
    return compressed ? new Uint8Array(compressed) : null;
  } catch {
    return null;
  }
}

function optionalRequire(id: string): any | null {
  try {
    // eslint-disable-next-line no-new-func
    const req = Function('return typeof require === "function" ? require : undefined')();
    return typeof req === 'function' ? req(id) : null;
  } catch {
    return null;
  }
}

/**
 * A failure is PERMANENT when the server returned a 4xx other than 429 — the
 * payload will never be accepted, so it is dropped (and its persisted copy
 * removed) rather than retried/replayed forever. Network errors, timeouts,
 * 429s, and 5xx are transient and re-buffered/persisted.
 */
function isPermanentFailure(error: unknown): boolean {
  if (!(error instanceof HttpResponseError)) return false;
  return error.status >= 400 && error.status < 500 && error.status !== 429;
}

function jitteredBackoff(failures: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(8, failures - 1)));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

/**
 * Compute the rate-limit delay (ms) to honour for a failed dispatch. Returns 0
 * unless the error is a 429/503 `HttpResponseError` carrying a parseable
 * `Retry-After` header, in which case the caller uses it instead of backoff.
 */
function retryAfterFromResponse(error: unknown): number {
  if (!(error instanceof HttpResponseError)) return 0;
  if (error.status !== 429 && error.status !== 503) return 0;
  return parseRetryAfter(error.retryAfter, Date.now());
}

/**
 * Parse an HTTP `Retry-After` header value into milliseconds.
 *
 * Accepts either delta-seconds (e.g. "120") or an HTTP-date, per RFC 7231.
 * Returns the delay clamped to [0, 300000] ms. Returns 0 when the header is
 * absent or invalid, signalling the caller to fall back to computed backoff.
 */
export function parseRetryAfter(headerValue: string | null, now: number): number {
  if (headerValue == null) return 0;
  const value = headerValue.trim();
  if (value === '') return 0;

  // delta-seconds: a non-negative integer.
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds)) return 0;
    return clampRetryAfter(seconds * 1000);
  }

  // HTTP-date: compute the delta from `now`.
  const dateMs = Date.parse(value);
  if (Number.isNaN(dateMs)) return 0;
  const delta = dateMs - now;
  if (delta <= 0) return 0;
  return clampRetryAfter(delta);
}

function clampRetryAfter(ms: number): number {
  if (ms <= 0) return 0;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}
