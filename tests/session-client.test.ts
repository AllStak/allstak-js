import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllStak } from '../src/index';

/**
 * Integration coverage for the client wiring of release-health sessions.
 *
 * The client suppresses session tracking under a unit-test runtime (VITEST /
 * NODE_ENV=test), mirroring the Java SDK + the SDK's release-registration
 * guard. These tests deliberately clear those env flags so the production code
 * path runs, then restore them afterwards.
 */
function sessionStartCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(([url]) => String(url).includes('/ingest/v1/sessions/start'));
}

describe('client session tracking wiring', () => {
  const prevVitest = process.env.VITEST;
  const prevNodeEnv = process.env.NODE_ENV;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.VITEST;
    delete process.env.NODE_ENV;
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
    if (prevVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = prevVitest;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  });

  it('posts /sessions/start on init by default', async () => {
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      environment: 'production',
      release: 'web@1.2.3',
      autoRegisterRelease: false,
    });

    await vi.waitFor(() => expect(sessionStartCalls(fetchSpy).length).toBe(1));
    const [, init] = sessionStartCalls(fetchSpy)[0];
    const body = JSON.parse(init.body);
    expect(body.sessionId).toBe(AllStak.getSessionId());
    expect(body.release).toBe('web@1.2.3');
    expect(body.environment).toBe('production');
    expect(body.sdkName).toBe('allstak-js');
    expect(body.platform).toBeDefined();
  });

  it('does not post any session calls when enableAutoSessionTracking is false', async () => {
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      release: 'web@1.2.3',
      autoRegisterRelease: false,
      enableAutoSessionTracking: false,
    });

    await new Promise((r) => setTimeout(r, 25));
    const sessionCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/ingest/v1/sessions/'),
    );
    expect(sessionCalls).toHaveLength(0);

    // Capturing an error must still work (and not throw) with tracking off.
    expect(() => AllStak.captureException(new Error('boom'))).not.toThrow();
  });

  it('posts /sessions/end on destroy with errored status after a handled error', async () => {
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      release: 'web@1.2.3',
      autoRegisterRelease: false,
    });
    await vi.waitFor(() => expect(sessionStartCalls(fetchSpy).length).toBe(1));

    AllStak.captureException(new Error('handled'));
    AllStak.destroy();

    await vi.waitFor(() => {
      const ends = fetchSpy.mock.calls.filter(([url]) =>
        String(url).includes('/ingest/v1/sessions/end'),
      );
      expect(ends.length).toBe(1);
    });
    const endCall = fetchSpy.mock.calls.find(([url]) =>
      String(url).includes('/ingest/v1/sessions/end'),
    )!;
    const body = JSON.parse(endCall[1].body);
    expect(body.status).toBe('errored');
    expect(typeof body.durationMs).toBe('number');
  });
});

describe('client session tracking is skipped under the unit-test runtime guard', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // VITEST is set by the runner here; do NOT clear it — assert the guard.
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
  });

  it('does not POST sessions/start while running under vitest', async () => {
    process.env.VITEST = 'true';
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.example.test',
      release: 'web@1.2.3',
      autoRegisterRelease: false,
    });
    await new Promise((r) => setTimeout(r, 25));
    const sessionCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/ingest/v1/sessions/'),
    );
    expect(sessionCalls).toHaveLength(0);
  });
});
