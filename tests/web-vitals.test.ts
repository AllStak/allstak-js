import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

/**
 * Controllable PerformanceObserver stub.
 *
 * Each constructed observer registers itself under the `type` passed to
 * `observe()` so a test can synchronously feed entries to a specific metric
 * observer via `emit(type, entries)`. jsdom does NOT ship PerformanceObserver,
 * so the SDK's browser web-vitals path is otherwise a no-op under the test
 * runtime — installing this stub is what exercises the collector.
 */
interface StubObserver {
  type: string;
  callback: (list: { getEntries(): any[] }) => void;
  disconnect: ReturnType<typeof vi.fn>;
}

function installPerformanceObserver() {
  const observers: StubObserver[] = [];

  class FakePerformanceObserver {
    private cb: (list: { getEntries(): any[] }) => void;
    private entry: StubObserver | null = null;
    constructor(cb: (list: { getEntries(): any[] }) => void) {
      this.cb = cb;
    }
    observe(options: { type?: string; buffered?: boolean }) {
      this.entry = { type: options.type || '', callback: this.cb, disconnect: vi.fn() };
      observers.push(this.entry);
    }
    disconnect() {
      if (this.entry) this.entry.disconnect();
    }
  }

  vi.stubGlobal('PerformanceObserver', FakePerformanceObserver as unknown as typeof PerformanceObserver);

  return {
    observers,
    /** Synchronously deliver entries to every observer registered for `type`. */
    emit(type: string, entries: any[]) {
      for (const obs of observers.filter((o) => o.type === type)) {
        obs.callback({ getEntries: () => entries });
      }
    },
  };
}

/** Stub navigation timing so TTFB is collected. */
function installNavigationTiming(responseStart: number) {
  const original = (globalThis as any).performance;
  const perf = {
    ...original,
    getEntriesByType: (t: string) =>
      t === 'navigation' ? [{ responseStart }] : [],
  };
  vi.stubGlobal('performance', perf);
}

function spanCalls(fetchSpy: ReturnType<typeof vi.fn>) {
  return fetchSpy.mock.calls.filter(
    ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/v1/spans'),
  );
}

function emittedVitalSpans(fetchSpy: ReturnType<typeof vi.fn>) {
  const spans: any[] = [];
  for (const [, init] of spanCalls(fetchSpy)) {
    try {
      const body = JSON.parse((init as any).body);
      for (const s of body.spans ?? []) {
        if (s.op === 'web.vital') spans.push(s);
      }
    } catch {
      /* ignore */
    }
  }
  return spans;
}

describe('Web Vitals', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true, headers: { get: () => null } });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('emits a web.vital span with op="web.vital" and a measurements map on visibilitychange(hidden)', async () => {
    const po = installPerformanceObserver();
    installNavigationTiming(123);

    AllStak.init({ dsn: TEST_DSN, environment: 'test', autoRegisterRelease: false });

    // Feed each observer a representative entry.
    po.emit('largest-contentful-paint', [{ startTime: 1500, renderTime: 1500 }]);
    po.emit('layout-shift', [{ value: 0.05, hadRecentInput: false }, { value: 0.03, hadRecentInput: false }]);
    po.emit('event', [{ duration: 40 }, { duration: 90 }]);
    po.emit('paint', [{ name: 'first-contentful-paint', startTime: 800 }]);

    // Standard web-vitals reporting moment.
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(emittedVitalSpans(fetchSpy).length).toBe(1));

    const span = emittedVitalSpans(fetchSpy)[0];
    expect(span.op).toBe('web.vital');
    expect(span.operation).toBe('web.vital');
    expect(span.measurements).toBeTypeOf('object');
    expect(span.measurements.LCP).toBe(1500);
    expect(span.measurements.CLS).toBeCloseTo(0.08, 5);
    expect(span.measurements.INP).toBe(90); // worst interaction latency
    expect(span.measurements.FCP).toBe(800);
    expect(span.measurements.TTFB).toBe(123);
  });

  it('also reports on pagehide', async () => {
    const po = installPerformanceObserver();
    installNavigationTiming(50);

    AllStak.init({ dsn: TEST_DSN, environment: 'test', autoRegisterRelease: false });
    po.emit('paint', [{ name: 'first-contentful-paint', startTime: 600 }]);

    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(emittedVitalSpans(fetchSpy).length).toBe(1));
    expect(emittedVitalSpans(fetchSpy)[0].measurements.FCP).toBe(600);
  });

  it('sends the web.vital span at most once across multiple hide triggers', async () => {
    const po = installPerformanceObserver();
    installNavigationTiming(70);

    AllStak.init({ dsn: TEST_DSN, environment: 'test', autoRegisterRelease: false });
    po.emit('largest-contentful-paint', [{ startTime: 2000, renderTime: 2000 }]);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(emittedVitalSpans(fetchSpy).length).toBe(1));

    // Give any stray async sends a chance to land, then re-assert single-send.
    await new Promise((r) => setTimeout(r, 25));
    expect(emittedVitalSpans(fetchSpy).length).toBe(1);
  });

  it('does NOT collect or emit web vitals when enableWebVitals is false', async () => {
    const po = installPerformanceObserver();
    installNavigationTiming(100);

    AllStak.init({
      dsn: TEST_DSN,
      environment: 'test',
      autoRegisterRelease: false,
      enableWebVitals: false,
    });

    // No observer should have been registered.
    expect(po.observers.length).toBe(0);

    po.emit('largest-contentful-paint', [{ startTime: 1000, renderTime: 1000 }]);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));

    await new Promise((r) => setTimeout(r, 25));
    expect(emittedVitalSpans(fetchSpy).length).toBe(0);
  });

  it('emits nothing when no metrics were collected', async () => {
    installPerformanceObserver();
    // No navigation timing → TTFB undefined; no entries fed → nothing collected.
    vi.stubGlobal('performance', { getEntriesByType: () => [] });

    AllStak.init({ dsn: TEST_DSN, environment: 'test', autoRegisterRelease: false });

    window.dispatchEvent(new Event('pagehide'));
    await new Promise((r) => setTimeout(r, 25));
    expect(emittedVitalSpans(fetchSpy).length).toBe(0);
  });

  it('startWebVitals() re-arms collection after an opt-out', async () => {
    const po = installPerformanceObserver();
    installNavigationTiming(88);

    AllStak.init({
      dsn: TEST_DSN,
      environment: 'test',
      autoRegisterRelease: false,
      enableWebVitals: false,
    });
    expect(po.observers.length).toBe(0);

    AllStak.startWebVitals();
    po.emit('paint', [{ name: 'first-contentful-paint', startTime: 700 }]);
    window.dispatchEvent(new Event('pagehide'));

    await vi.waitFor(() => expect(emittedVitalSpans(fetchSpy).length).toBe(1));
    expect(emittedVitalSpans(fetchSpy)[0].measurements.TTFB).toBe(88);
  });
});
