import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('HTTP Request Module', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    vi.useFakeTimers();
    AllStak.init({ dsn: TEST_DSN, environment: 'test' });
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('batches requests and flushes on interval', async () => {
    AllStak.captureRequest({
      direction: 'inbound',
      method: 'GET',
      host: 'api.example.com',
      path: '/users',
      statusCode: 200,
      durationMs: 42,
    });

    // Not sent yet
    expect(fetchSpy).not.toHaveBeenCalled();

    // Advance past flush interval
    vi.advanceTimersByTime(5_000);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/ingest/v1/http-requests');
    expect(options.headers['X-AllStak-Key']).toBe('test-key');

    const body = JSON.parse(options.body);
    expect(body.requests).toHaveLength(1);
    const req = body.requests[0];
    expect(req.direction).toBe('inbound');
    expect(req.method).toBe('GET');
    expect(req.host).toBe('api.example.com');
    expect(req.path).toBe('/users');
    expect(req.statusCode).toBe(200);
    expect(req.durationMs).toBe(42);
    expect(req.traceId).toBeDefined();
    expect(req.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('flushes immediately when batch reaches 20 items', async () => {
    for (let i = 0; i < 20; i++) {
      AllStak.captureRequest({
        direction: 'outbound',
        method: 'POST',
        host: 'db.internal',
        path: '/query',
        statusCode: 201,
        durationMs: 10,
      });
    }

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.requests).toHaveLength(20);
  });

  it('uses provided traceId and timestamp', async () => {
    const ts = '2026-01-15T10:00:00.000Z';
    AllStak.captureRequest({
      traceId: 'my-trace-id',
      direction: 'outbound',
      method: 'DELETE',
      host: 'storage.example.com',
      path: '/file/123',
      statusCode: 204,
      durationMs: 8,
      timestamp: ts,
    });

    vi.advanceTimersByTime(5_000);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.requests[0].traceId).toBe('my-trace-id');
    expect(body.requests[0].timestamp).toBe(ts);
  });

  it('flushes remaining items on destroy', async () => {
    AllStak.captureRequest({
      direction: 'inbound',
      method: 'GET',
      host: 'api.example.com',
      path: '/health',
      statusCode: 200,
      durationMs: 1,
    });

    AllStak.destroy();

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.requests).toHaveLength(1);
  });
});
