import { EventBuffer } from './buffer';

const REQUEST_TIMEOUT = 2000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const RETRY_AFTER_MAX_MS = 300_000;

type Pending = { path: string; payload: unknown };

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
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastTransportLatencyMs?: number;
  lastFlushDurationMs?: number;
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
  private lastTransportLatencyMs: number | undefined;
  private lastFlushDurationMs: number | undefined;

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  send(path: string, payload: unknown): Promise<void> {
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }

  private enqueueOrDispatch(item: Pending): void {
    if (Date.now() < this.circuitOpenUntil) {
      if (this.buffer.push(item)) this.dropped++;
      return;
    }
    this.track(this.dispatch(item));
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
  }

  private async dispatch(item: Pending): Promise<void> {
    try {
      await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
      this.sent++;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      this.scheduleFlush();
    } catch (err) {
      this.failed++;
      this.recordFailure(err);
      if (this.buffer.push(item)) this.dropped++;
    }
  }

  private async doFetch(url: string, payload: unknown): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const started = Date.now();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
        },
        body: JSON.stringify(payload),
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

  private scheduleFlush(): void {
    if (this.buffer.size === 0 || this.flushing) return;
    const delay = Math.max(0, this.circuitOpenUntil - Date.now());
    const timer = setTimeout(() => {
      void this.flushBuffer().catch(() => undefined);
    }, delay);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;
    const started = Date.now();

    try {
      const items = this.buffer.drain() as Pending[];
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          if (this.buffer.push(item)) this.dropped++;
          continue;
        }
        try {
          await this.doFetch(`${this.baseUrl}${item.path}`, item.payload);
          this.sent++;
          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
        } catch (err) {
          this.failed++;
          this.recordFailure(err);
          if (this.buffer.push(item)) this.dropped++;
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

  private recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;
    const backoff = jitteredBackoff(this.consecutiveFailures);
    // A real `Retry-After` from a 429/503 response overrides the computed
    // backoff; otherwise fall back to the jittered exponential backoff.
    const retryAfterMs = retryAfterFromResponse(error);
    this.circuitOpenUntil = Date.now() + (retryAfterMs > 0 ? retryAfterMs : backoff);
  }

  getBufferSize(): number {
    return this.buffer.size;
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

  getStats(): TransportStats {
    return {
      queued: this.buffer.size,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransportLatencyMs: this.lastTransportLatencyMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
    };
  }
}

function jitteredBackoff(failures: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, failures - FAILURE_THRESHOLD));
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
