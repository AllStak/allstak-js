import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('Cron Module', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    AllStak.init({ dsn: TEST_DSN, environment: 'test' });
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
  });

  it('heartbeat sends correct payload for success', async () => {
    AllStak.heartbeat({ slug: 'daily-report', status: 'success', durationMs: 1234 });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const [url, options] = fetchSpy.mock.calls[0];
    expect(url).toContain('/ingest/v1/heartbeat');
    expect(options.headers['X-AllStak-Key']).toBe('test-key');

    const body = JSON.parse(options.body);
    expect(body.slug).toBe('daily-report');
    expect(body.status).toBe('success');
    expect(body.durationMs).toBe(1234);
    expect(body.message).toBeUndefined();
  });

  it('heartbeat sends correct payload for failure with message', async () => {
    AllStak.heartbeat({
      slug: 'nightly-cleanup',
      status: 'failed',
      durationMs: 500,
      message: 'DB connection timeout',
    });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.slug).toBe('nightly-cleanup');
    expect(body.status).toBe('failed');
    expect(body.durationMs).toBe(500);
    expect(body.message).toBe('DB connection timeout');
  });

  it('multiple heartbeats send separate requests', async () => {
    AllStak.heartbeat({ slug: 'job-a', status: 'success', durationMs: 100 });
    AllStak.heartbeat({ slug: 'job-b', status: 'success', durationMs: 200 });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));

    const slugs = fetchSpy.mock.calls.map(([, opts]: [string, RequestInit]) => {
      return JSON.parse(opts.body as string).slug;
    });
    expect(slugs).toContain('job-a');
    expect(slugs).toContain('job-b');
  });
});
