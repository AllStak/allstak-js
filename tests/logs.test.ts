import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('Log Module', () => {
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

  it.each(['debug', 'info', 'warn', 'error'] as const)(
    'log.%s sends correct level field',
    async (level) => {
      AllStak.log[level](`${level} message`);

      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

      const [url, options] = fetchSpy.mock.calls[0];
      expect(url).toContain('/ingest/v1/logs');

      const body = JSON.parse(options.body);
      expect(body.level).toBe(level);
      expect(body.message).toBe(`${level} message`);
    },
  );

  it('meta object is included in payload', async () => {
    AllStak.log.info('user login', { userId: '42', ip: '10.0.0.1' });

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.metadata).toEqual({ userId: '42', ip: '10.0.0.1' });
  });

  it('timeout triggers buffer fallback', async () => {
    fetchSpy.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    AllStak.log.error('timed out');

    await new Promise((r) => setTimeout(r, 50));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends correct authorization header', async () => {
    AllStak.log.info('auth test');

    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers['X-AllStak-Key']).toBe('test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });
});
