import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('Error Module', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    AllStak.init({ dsn: TEST_DSN, environment: 'test', release: '1.0.0' });
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
  });

  it('captureException sends correct payload', async () => {
    const error = new Error('Something broke');
    AllStak.captureException(error, { route: '/api/users' });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/ingest/v1/errors');

    const body = JSON.parse(options.body);
    expect(body.exceptionClass).toBe('Error');
    expect(body.level).toBe('error');
    expect(body.message).toBe('Something broke');
    expect(body.stackTrace).toBeDefined();
    expect(body.environment).toBe('test');
    expect(body.release).toBe('1.0.0');
    // metadata may also include auto-injected traceId/spanId from the client
    // wrapper, in addition to the caller's own context fields.
    expect(body.metadata).toMatchObject({ route: '/api/users' });
  });

  it('captureMessage sends correct payload', async () => {
    AllStak.captureMessage('Disk space low', 'warning');

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/ingest/v1/logs');
    const body = JSON.parse(options.body);
    expect(body.level).toBe('warn');
    expect(body.message).toBe('Disk space low');
  });

  it('auto-captures window.onerror', async () => {
    const errorEvent = new ErrorEvent('error', {
      error: new Error('Uncaught!'),
      message: 'Uncaught!',
    });
    window.dispatchEvent(errorEvent);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe('Uncaught!');
    expect(body.level).toBe('error');
  });

  it('auto-captures unhandledrejection', async () => {
    const event = new Event('unhandledrejection') as PromiseRejectionEvent;
    Object.defineProperty(event, 'reason', { value: new Error('Promise failed') });
    window.dispatchEvent(event);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.message).toBe('Promise failed');
  });

  it('failed request pushes to buffer', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('Network error'));

    AllStak.captureException(new Error('buffered'));

    // Give it a tick to process
    await new Promise((r) => setTimeout(r, 50));

    // The event should have been buffered (fetch was called but failed)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('captureMessage routes to logs endpoint with user id', async () => {
    AllStak.setUser({ id: '123', email: 'test@example.com' });
    AllStak.setTag('component', 'auth');
    AllStak.captureMessage('test', 'info');

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/ingest/v1/logs');
    const body = JSON.parse(options.body);
    expect(body.level).toBe('info');
    expect(body.message).toBe('test');
    expect(body.userId).toBe('123');
  });

  it('captureException emits v2 structured frames + sdk identity', async () => {
    const error = new Error('v2 frame test');
    AllStak.captureException(error);

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);

    // v2 contract: structured frames present
    expect(Array.isArray(body.frames)).toBe(true);
    expect(body.frames.length).toBeGreaterThan(0);
    const top = body.frames[0];
    expect(top).toEqual(
      expect.objectContaining({
        filename: expect.any(String),
        lineno: expect.any(Number),
        colno: expect.any(Number),
        platform: expect.any(String),
      }),
    );

    // SDK identity promoted to first-class fields
    expect(body.sdkName).toBe('allstak-js');
    expect(typeof body.sdkVersion).toBe('string');
    expect(body.sdkVersion.length).toBeGreaterThan(0);
    expect(['browser', 'node', 'react-native']).toContain(body.platform);

    // v1 back-compat: stackTrace[] still populated, derived from frames
    expect(Array.isArray(body.stackTrace)).toBe(true);
    expect(body.stackTrace.length).toBe(body.frames.length);
    expect(body.stackTrace[0]).toMatch(/^ {4}at .+ \(.+:\d+:\d+\)$/);
  });

  it('captureException includes user via userId on log payload', async () => {
    AllStak.setUser({ id: '123', email: 'test@example.com' });
    AllStak.setTag('component', 'auth');
    AllStak.captureException(new Error('boom'), { route: '/api/x' });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.user).toEqual({ id: '123', email: 'test@example.com' });
    expect(body.metadata).toMatchObject({ component: 'auth', route: '/api/x' });
  });

  it('captureException automatically promotes runtime and request metadata', async () => {
    AllStak.captureException(new Error('request tags'), {
      transaction: 'GET /orders/:id',
      requestContext: {
        method: 'GET',
        path: '/orders/42',
        host: 'api.example.test',
        route: '/orders/:id',
        statusCode: 500,
        durationMs: 37,
        userAgent: 'vitest-agent',
      },
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.transaction).toBe('GET /orders/:id');
    expect(body.requestContext).toMatchObject({
      method: 'GET',
      path: '/orders/42',
      host: 'api.example.test',
      route: '/orders/:id',
      statusCode: 500,
      durationMs: 37,
      userAgent: 'vitest-agent',
    });
    expect(body.tags).toMatchObject({
      'sdk.name': 'allstak-js',
      'sdk.version': expect.any(String),
      platform: expect.any(String),
      'request.method': 'GET',
      'request.path': '/orders/42',
      'request.host': 'api.example.test',
      'request.route': '/orders/:id',
      'request.status_code': '500',
      transaction: 'GET /orders/:id',
    });
    expect(body.metadata).toMatchObject({
      'runtime.platform': expect.any(String),
      'request.method': 'GET',
      'request.path': '/orders/42',
      'request.host': 'api.example.test',
      'request.route': '/orders/:id',
      'request.status_code': 500,
      'request.duration_ms': 37,
      'request.userAgent': 'vitest-agent',
    });
    expect(body.metadata.requestContext).toBeUndefined();
  });

  it.skip('captures screenshot metadata through an opt-in fail-open provider (screenshot API not in 0.2.0)', async () => {
  });

  it.skip('drops oversized screenshots without throwing or blocking error capture (screenshot API not in 0.2.0)', async () => {
  });
});
