import { EventBuffer } from './buffer';
import { withRetry } from '../utils/retry';

const REQUEST_TIMEOUT = 3000;

export class HttpTransport {
  private buffer = new EventBuffer();
  private flushing = false;

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async send(path: string, payload: unknown): Promise<void> {
    const url = `${this.baseUrl}${path}`;

    try {
      await this.doFetch(url, payload);
      // On success, try to flush any buffered events
      await this.flushBuffer(path);
    } catch {
      this.buffer.push({ path, payload });
    }
  }

  private async doFetch(url: string, payload: unknown): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

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
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  private async flushBuffer(currentPath?: string): Promise<void> {
    if (this.flushing || this.buffer.size === 0) return;
    this.flushing = true;

    try {
      const items = this.buffer.drain() as { path: string; payload: unknown }[];
      for (const item of items) {
        const url = `${this.baseUrl}${item.path || currentPath}`;
        await withRetry(() => this.doFetch(url, item.payload));
      }
    } catch {
      // If flush fails, items are already drained — they were attempted
    } finally {
      this.flushing = false;
    }
  }

  getBufferSize(): number {
    return this.buffer.size;
  }
}
