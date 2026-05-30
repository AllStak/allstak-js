import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpTransport } from '../src/transport/http';

describe('transport compression', () => {
  const sent: Array<{ url: string; init: RequestInit }> = [];

  afterEach(() => {
    sent.length = 0;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function stubFetch(): void {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }));
  }

  it('does not compress tiny payloads', async () => {
    stubFetch();
    const transport = new HttpTransport('https://api.test', 'ask_test');
    const payload = { message: 'tiny' };

    await transport.send('/ingest/v1/errors', payload);
    await transport.flush(500);

    expect(sent).toHaveLength(1);
    expect(header(sent[0].init.headers, 'Content-Encoding')).toBeUndefined();
    expect(sent[0].init.body).toBe(JSON.stringify(payload));
    expect(transport.getStats().uncompressed).toBe(1);
    expect(transport.getStats().compressed).toBe(0);
  });

  it('gzip-compresses large payloads and exposes compression stats', async () => {
    stubFetch();
    vi.stubGlobal('CompressionStream', undefined);
    vi.stubGlobal('process', {
      ...process,
      getBuiltinModule: () => ({ gzipSync }),
      versions: process.versions,
    });
    const transport = new HttpTransport('https://api.test', 'ask_test');
    const payload = {
      spans: Array.from({ length: 60 }, (_, i) => ({
        traceId: '0'.repeat(32),
        spanId: String(i).padStart(16, '0'),
        operation: 'large.batch',
        data: 'x'.repeat(200),
      })),
    };

    await transport.send('/ingest/v1/spans', payload);
    await transport.flush(500);

    expect(sent).toHaveLength(1);
    expect(header(sent[0].init.headers, 'Content-Encoding')).toBe('gzip');
    expect(gunzipSync(bodyBuffer(sent[0].init.body)).toString('utf8')).toBe(JSON.stringify(payload));
    const stats = transport.getStats();
    expect(stats.compressed).toBe(1);
    expect(stats.uncompressed).toBe(0);
    expect(stats.compressionBytesSaved).toBeGreaterThan(0);
  });
});

function header(headers: HeadersInit | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const h = new Headers(headers);
  return h.get(name) ?? undefined;
}

function bodyBuffer(body: BodyInit | null | undefined): Buffer {
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  throw new Error(`Unsupported body type: ${Object.prototype.toString.call(body)}`);
}
