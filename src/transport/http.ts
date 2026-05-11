import { EventBuffer } from './buffer';

const REQUEST_TIMEOUT = 2000;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

type Pending = { path: string; payload: unknown };

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
    void this.dispatch(item).catch(() => undefined);
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
    const retryAfterMs = retryAfterFromError(error);
    const backoff = retryAfterMs ?? jitteredBackoff(this.consecutiveFailures);
    this.circuitOpenUntil = Date.now() + backoff;
  }

  getBufferSize(): number {
    return this.buffer.size;
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

function retryAfterFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : '';
  const match = /HTTP\s+(429|503)/.exec(message);
  return match ? BACKOFF_MAX_MS : null;
}
