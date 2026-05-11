import { describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/transport/http';

describe('HttpTransport fail-open behavior', () => {
  it('does not wait for a hung AllStak ingest request', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)));
    const transport = new HttpTransport('https://api.invalid', 'ask_test');

    await expect(transport.send('/ingest/v1/errors', { message: 'x' })).resolves.toBeUndefined();
  });

  it('swallows transport failures and buffers bounded telemetry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('dns failed')));
    const transport = new HttpTransport('https://api.invalid', 'ask_test');

    for (let i = 0; i < 150; i++) {
      await transport.send('/ingest/v1/errors', { i });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(transport.getBufferSize()).toBeLessThanOrEqual(100);
    const stats = transport.getStats();
    expect(stats.queued).toBeLessThanOrEqual(100);
    expect(stats.failed).toBeGreaterThan(0);
    expect(stats.dropped).toBeGreaterThan(0);
  });
});
