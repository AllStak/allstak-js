import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Session, SessionTracker } from '../src/session';
import type { AllStakConfig } from '../src/client';
import type { HttpTransport } from '../src/transport/http';
import type { SessionStateStorage } from '../src/session';

/**
 * The SessionTracker is exercised directly (mirroring the Java
 * SessionTrackerTest) because the client suppresses session tracking under a
 * unit-test runtime. A minimal fake transport records each send so we can
 * assert the exact `/sessions/start` and `/sessions/end` payload shapes.
 */
function makeTransport() {
  const sends: Array<{ path: string; payload: any }> = [];
  const transport = {
    send: vi.fn((path: string, payload: unknown) => {
      sends.push({ path, payload });
      return Promise.resolve();
    }),
  } as unknown as HttpTransport;
  return { transport, sends };
}

function baseConfig(overrides: Partial<AllStakConfig> = {}): AllStakConfig {
  return {
    apiKey: 'ask_test',
    environment: 'test',
    release: 'v0.0.1-test',
    sdkName: 'allstak-js',
    sdkVersion: '0.2.4',
    platform: 'node',
    ...overrides,
  };
}

function makeStorage(initial?: Record<string, string>): SessionStateStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(Object.entries(initial ?? {}));
  return {
    data,
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clearBrowserSessionState();
});

beforeEach(() => {
  clearBrowserSessionState();
});

function clearBrowserSessionState(): void {
  try {
    const storage = window.localStorage;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith('allstak.session.v1.')) storage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

describe('Session status model', () => {
  it('starts ok and escalates ok -> errored on handled error', () => {
    const s = new Session('sid');
    expect(s.status).toBe('ok');
    s.recordError();
    expect(s.status).toBe('errored');
    expect(s.errorCount).toBe(1);
  });

  it('escalates to crashed and crashed is terminal (errored does not downgrade it)', () => {
    const s = new Session('sid');
    s.recordError();
    s.recordCrash();
    expect(s.status).toBe('crashed');
    s.recordError();
    expect(s.status).toBe('crashed');
  });

  it('abnormal promotes ok/errored but never downgrades crashed', () => {
    const ok = new Session('a');
    ok.recordAbnormalExit();
    expect(ok.status).toBe('abnormal');

    const crashed = new Session('b');
    crashed.recordCrash();
    crashed.recordAbnormalExit();
    expect(crashed.status).toBe('crashed');
  });

  it('durationMs is non-negative', () => {
    const s = new Session('sid');
    expect(s.durationMs()).toBeGreaterThanOrEqual(0);
  });
});

describe('SessionTracker.start', () => {
  it('posts /sessions/start with the full payload shape', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(
      baseConfig({ user: { id: 'user-42' } }),
      transport,
      'session-abc',
    );
    tracker.start();

    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(sends[0].path).toBe('/ingest/v1/sessions/start');
    expect(sends[0].payload).toEqual({
      sessionId: 'session-abc',
      release: 'v0.0.1-test',
      environment: 'test',
      userId: 'user-42',
      sdkName: 'allstak-js',
      sdkVersion: '0.2.4',
      platform: 'node',
    });
  });

  it('reuses the provided sessionId and is idempotent', () => {
    const { transport } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'session-xyz');
    const first = tracker.start();
    const second = tracker.start();
    expect(first.id).toBe('session-xyz');
    expect(second).toBe(first);
    expect(transport.send).toHaveBeenCalledTimes(1);
  });

  it('falls back to sdkVersion as release when no release is configured', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(
      baseConfig({ release: undefined, sdkVersion: '9.9.9' }),
      transport,
      'sid',
    );
    tracker.start();
    expect(sends[0].payload.release).toBe('9.9.9');
  });

  it('is fail-open: a throwing transport never escapes start', () => {
    const transport = {
      send: vi.fn(() => {
        throw new Error('network down');
      }),
    } as unknown as HttpTransport;
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    expect(() => tracker.start()).not.toThrow();
    // The session is still active in memory so status transitions keep working.
    tracker.recordError();
    expect(tracker.current()?.status).toBe('errored');
  });
});

describe('SessionTracker.end status transitions', () => {
  it('posts ok when no errors occurred (ok -> end)', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    tracker.end();

    const end = sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(end).toBeDefined();
    expect(end!.payload.sessionId).toBe('sid');
    expect(end!.payload.status).toBe('ok');
    expect(typeof end!.payload.durationMs).toBe('number');
    expect(end!.payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('posts errored after a handled error (ok -> errored -> end)', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    tracker.recordError();
    tracker.recordError();
    tracker.end();

    const end = sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(end!.payload.status).toBe('errored');
  });

  it('posts crashed after an unhandled crash (ok -> errored -> crashed -> end)', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    tracker.recordError();
    tracker.recordCrash();
    tracker.end();

    const end = sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(end!.payload.status).toBe('crashed');
  });

  it('is idempotent: a second end is a no-op', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    tracker.end();
    tracker.end();
    const ends = sends.filter((s) => s.path === '/ingest/v1/sessions/end');
    expect(ends).toHaveLength(1);
  });

  it('an explicit final status overrides the accumulated status', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    tracker.recordError();
    tracker.end('abnormal');
    const end = sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(end!.payload.status).toBe('abnormal');
  });

  it('is fail-open: a throwing transport never escapes end', () => {
    let calls = 0;
    const transport = {
      send: vi.fn(() => {
        calls++;
        if (calls > 1) throw new Error('network down');
        return Promise.resolve();
      }),
    } as unknown as HttpTransport;
    const tracker = new SessionTracker(baseConfig(), transport, 'sid');
    tracker.start();
    expect(() => tracker.end()).not.toThrow();
  });
});

describe('SessionTracker browser graceful shutdown', () => {
  it('ends the session on pagehide', () => {
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig({ platform: 'browser' }), transport, 'sid');
    tracker.start();
    window.dispatchEvent(new Event('pagehide'));
    const end = sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(end).toBeDefined();
    expect(end!.payload.status).toBe('ok');
  });
});

describe('SessionTracker abnormal session recovery', () => {
  it('does not report an abnormal session after a clean shutdown', () => {
    const storage = makeStorage();
    const key = 'allstak.session.test.clean';
    const first = makeTransport();
    const tracker = new SessionTracker(baseConfig(), first.transport, 'sid-clean', { storage, storageKey: key });
    tracker.start();
    tracker.end();

    const second = makeTransport();
    const nextTracker = new SessionTracker(baseConfig(), second.transport, 'sid-next', { storage, storageKey: key });
    nextTracker.start();

    expect(second.sends.filter((s) => s.path === '/ingest/v1/sessions/end')).toHaveLength(0);
    expect(second.sends.filter((s) => s.path === '/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('reports a previous open session as abnormal on the next start', () => {
    const storage = makeStorage();
    const key = 'allstak.session.test.abnormal';
    const first = makeTransport();
    const tracker = new SessionTracker(baseConfig(), first.transport, 'sid-open', { storage, storageKey: key });
    tracker.start();

    const second = makeTransport();
    const nextTracker = new SessionTracker(baseConfig(), second.transport, 'sid-next', { storage, storageKey: key });
    nextTracker.start();

    const recovered = second.sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(recovered).toBeDefined();
    expect(recovered!.payload).toMatchObject({ sessionId: 'sid-open', status: 'abnormal' });
    expect(second.sends.filter((s) => s.path === '/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('reports a previous crashed open session as crashed on the next start', () => {
    const storage = makeStorage();
    const key = 'allstak.session.test.crashed';
    const first = makeTransport();
    const tracker = new SessionTracker(baseConfig(), first.transport, 'sid-crashed', { storage, storageKey: key });
    tracker.start();
    tracker.recordCrash();

    const second = makeTransport();
    const nextTracker = new SessionTracker(baseConfig(), second.transport, 'sid-next', { storage, storageKey: key });
    nextTracker.start();

    const recovered = second.sends.find((s) => s.path === '/ingest/v1/sessions/end');
    expect(recovered).toBeDefined();
    expect(recovered!.payload).toMatchObject({ sessionId: 'sid-crashed', status: 'crashed' });
  });

  it('drops corrupt session state safely and starts a new session', () => {
    const key = 'allstak.session.test.corrupt';
    const storage = makeStorage({ [key]: '{not-json' });
    const { transport, sends } = makeTransport();
    const tracker = new SessionTracker(baseConfig(), transport, 'sid-new', { storage, storageKey: key });

    expect(() => tracker.start()).not.toThrow();
    expect(sends.filter((s) => s.path === '/ingest/v1/sessions/end')).toHaveLength(0);
    expect(sends.filter((s) => s.path === '/ingest/v1/sessions/start')).toHaveLength(1);
  });

  it('does not duplicate abnormal recovery reports across repeated starts', () => {
    const storage = makeStorage();
    const key = 'allstak.session.test.dedupe';
    const first = makeTransport();
    new SessionTracker(baseConfig(), first.transport, 'sid-open', { storage, storageKey: key }).start();

    const second = makeTransport();
    const secondTracker = new SessionTracker(baseConfig(), second.transport, 'sid-second', { storage, storageKey: key });
    secondTracker.start();
    secondTracker.end();
    const third = makeTransport();
    new SessionTracker(baseConfig(), third.transport, 'sid-third', { storage, storageKey: key }).start();

    expect(second.sends.filter((s) => s.path === '/ingest/v1/sessions/end' && s.payload.status === 'abnormal')).toHaveLength(1);
    expect(third.sends.filter((s) => s.path === '/ingest/v1/sessions/end' && s.payload.status === 'abnormal')).toHaveLength(0);
  });
});
