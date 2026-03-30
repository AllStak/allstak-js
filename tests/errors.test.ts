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
    expect(body.metadata).toEqual({ route: '/api/users' });
  });

  it('captureMessage sends correct payload', async () => {
    AllStak.captureMessage('Disk space low', 'warning');

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.exceptionClass).toBe('Message');
    expect(body.level).toBe('warning');
    expect(body.message).toBe('Disk space low');
    expect(body.stackTrace).toBeUndefined();
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

  it('includes user and tags when set', async () => {
    AllStak.setUser({ id: '123', email: 'test@example.com' });
    AllStak.setTag('component', 'auth');
    AllStak.captureMessage('test', 'info');

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.user).toEqual({ id: '123', email: 'test@example.com' });
    expect(body.metadata).toEqual({ component: 'auth' });
  });
});
