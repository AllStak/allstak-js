import { TracingModule } from './tracing';

/**
 * Core Web Vitals collection for the browser entry of the SDK.
 *
 * Implements the standard web-vitals observers directly — WITHOUT adding the
 * `web-vitals` dependency — and reports the collected metrics to AllStak as a
 * single span:
 *
 *   POST /ingest/v1/spans  →  SpanItem { op: 'web.vital', operation: 'web.vital',
 *                                        measurements: { LCP, CLS, INP, FCP, TTFB } }
 *
 * The backend classifies `op IN ('pageload','navigation',
 * 'browser.resource','web.vital')` as the "web" category and persists the
 * `measurements` field, which is how vitals reach the web-vitals
 * dashboard.
 *
 * Metric derivation (web-vitals-style):
 *   - LCP  — the last `largest-contentful-paint` entry observed before the page
 *            is hidden (the "final" LCP).
 *   - CLS  — the sum of `layout-shift` entry values that did NOT follow recent
 *            user input (`hadRecentInput === false`).
 *   - INP  — the worst (max) interaction latency from `event`/`first-input`
 *            entries (a pragmatic single-page approximation of INP). Falls back
 *            to FID (the first `first-input` delay) when no `event` entries are
 *            observable.
 *   - FCP  — the `first-contentful-paint` paint-timing entry.
 *   - TTFB — `responseStart` from the navigation timing entry.
 *
 * Finalize + emit happens on `visibilitychange('hidden')` / `pagehide` (the
 * standard web-vitals reporting moment), guarded so the span is sent at most
 * once. Everything is fully fail-open: a missing/throwing observer never breaks
 * the host page, and unsupported environments simply collect nothing.
 */

const WEB_VITAL_OP = 'web.vital';

/** A measurement value is included only when it was actually collected. */
type VitalKey = 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB';

interface PerformanceObserverLike {
  observe(options: { type?: string; entryTypes?: string[]; buffered?: boolean }): void;
  disconnect(): void;
}

type PerformanceObserverCtor = new (
  callback: (list: { getEntries(): any[] }) => void,
) => PerformanceObserverLike;

export interface WebVitalsContext {
  release?: string;
  environment?: string;
  service?: string;
  sessionId?: string;
  platform?: string;
}

/**
 * Detect a browser-with-PerformanceObserver runtime. Web Vitals are a no-op
 * everywhere else (Node, edge, RN without DOM, jsdom without the observer).
 */
export function isWebVitalsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (globalThis as any).PerformanceObserver !== 'undefined'
  );
}

export class WebVitalsModule {
  private tracing: TracingModule;
  private context: WebVitalsContext;
  private observers: PerformanceObserverLike[] = [];
  private cleanup: Array<() => void> = [];
  private sent = false;
  private started = false;

  // Collected metric values. `undefined` means "not collected" → excluded.
  private lcp?: number;
  private cls = 0;
  private clsObserved = false;
  private inp?: number;
  private fid?: number;
  private fcp?: number;
  private ttfb?: number;

  constructor(tracing: TracingModule, context: WebVitalsContext = {}) {
    this.tracing = tracing;
    this.context = context;
  }

  /**
   * Begin observing Core Web Vitals. Idempotent and fail-open: a second call is
   * a no-op, and any error wiring an observer is swallowed so the host page is
   * never affected. Does nothing outside a browser-with-PerformanceObserver.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!isWebVitalsSupported()) return;

    this.collectNavigationTiming();
    this.observeLcp();
    this.observeCls();
    this.observeInp();
    this.observeFcp();
    this.installReportHooks();
  }

  // ── Observers ──────────────────────────────────────────────────────────────

  private get PO(): PerformanceObserverCtor | undefined {
    return (globalThis as any).PerformanceObserver as PerformanceObserverCtor | undefined;
  }

  private safeObserve(
    type: string,
    handle: (entries: any[]) => void,
    extra: { buffered?: boolean } = { buffered: true },
  ): void {
    const Ctor = this.PO;
    if (!Ctor) return;
    try {
      const observer = new Ctor((list) => {
        try {
          handle(list.getEntries());
        } catch {
          /* fail-open */
        }
      });
      observer.observe({ type, buffered: extra.buffered !== false });
      this.observers.push(observer);
    } catch {
      // Some entry types are unsupported in older browsers — observing them
      // throws. Skip that single metric; the others keep working.
    }
  }

  /** LCP = the value of the LAST largest-contentful-paint entry. */
  private observeLcp(): void {
    this.safeObserve('largest-contentful-paint', (entries) => {
      const last = entries[entries.length - 1];
      if (last && typeof last.startTime === 'number') {
        // `renderTime` falls back to `loadTime` for cross-origin images.
        const value =
          typeof last.renderTime === 'number' && last.renderTime > 0
            ? last.renderTime
            : typeof last.loadTime === 'number' && last.loadTime > 0
              ? last.loadTime
              : last.startTime;
        this.lcp = value;
      }
    });
  }

  /** CLS = sum of layout-shift values WITHOUT recent user input. */
  private observeCls(): void {
    this.safeObserve('layout-shift', (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput && typeof entry.value === 'number') {
          this.cls += entry.value;
          this.clsObserved = true;
        }
      }
    });
  }

  /**
   * INP from `event` timing (max interaction latency), and FID from the first
   * `first-input` entry as a fallback. INP entries are large, so the browser
   * requires an explicit `durationThreshold`; we keep the default and read the
   * worst observed duration.
   */
  private observeInp(): void {
    this.safeObserve('event', (entries) => {
      for (const entry of entries) {
        if (typeof entry.duration === 'number') {
          this.inp = this.inp === undefined ? entry.duration : Math.max(this.inp, entry.duration);
        }
      }
    });
    this.safeObserve('first-input', (entries) => {
      const first = entries[0];
      if (first && typeof first.processingStart === 'number' && typeof first.startTime === 'number') {
        this.fid = Math.max(0, first.processingStart - first.startTime);
      }
    });
  }

  /** FCP from the paint-timing `first-contentful-paint` entry. */
  private observeFcp(): void {
    this.safeObserve('paint', (entries) => {
      for (const entry of entries) {
        if (entry.name === 'first-contentful-paint' && typeof entry.startTime === 'number') {
          this.fcp = entry.startTime;
        }
      }
    });
  }

  /**
   * TTFB (and a fallback FCP) from navigation timing. `responseStart` relative
   * to the navigation start is TTFB. Read eagerly at start so it is available
   * even if the navigation entry buffer is empty by report time.
   */
  private collectNavigationTiming(): void {
    try {
      const perf = (globalThis as any).performance as
        | { getEntriesByType?: (t: string) => any[]; timing?: any }
        | undefined;
      const navEntries = perf?.getEntriesByType?.('navigation');
      const nav = navEntries && navEntries[0];
      if (nav && typeof nav.responseStart === 'number' && nav.responseStart >= 0) {
        this.ttfb = nav.responseStart;
      } else if (perf?.timing && typeof perf.timing.responseStart === 'number') {
        // Legacy PerformanceTiming fallback (absolute epoch values).
        const t = perf.timing;
        if (typeof t.navigationStart === 'number') {
          this.ttfb = Math.max(0, t.responseStart - t.navigationStart);
        }
      }
    } catch {
      /* fail-open */
    }
  }

  // ── Report on hide ──────────────────────────────────────────────────────────

  private installReportHooks(): void {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;

    const onHide = () => this.report();
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.report();
      }
    };

    window.addEventListener('pagehide', onHide);
    this.cleanup.push(() => window.removeEventListener('pagehide', onHide));

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibility);
      this.cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));
    }
  }

  /**
   * Finalize the collected metrics and emit a single `web.vital` span. Guarded
   * so it sends at most once (visibilitychange + pagehide can both fire on a
   * single tab close). Emits nothing when no metric was collected.
   */
  report(): void {
    if (this.sent) return;
    this.sent = true;

    // Pull a fresh navigation reading in case the buffer filled after start.
    if (this.ttfb === undefined) this.collectNavigationTiming();

    const measurements: Record<string, number> = {};
    const set = (key: VitalKey, value: number | undefined) => {
      if (typeof value === 'number' && Number.isFinite(value)) {
        // Round to whole milliseconds for time metrics; keep CLS precision.
        measurements[key] = key === 'CLS' ? round(value, 4) : Math.round(value);
      }
    };

    set('LCP', this.lcp);
    if (this.clsObserved) set('CLS', this.cls);
    // INP preferred; FID fallback is reported under INP for the dashboard.
    set('INP', this.inp ?? this.fid);
    set('FCP', this.fcp);
    set('TTFB', this.ttfb);

    // Stop observing once we've taken the final reading.
    this.disconnectObservers();

    if (Object.keys(measurements).length === 0) return;

    this.tracing.emitSpan({
      operation: WEB_VITAL_OP,
      op: WEB_VITAL_OP,
      description: 'Core Web Vitals',
      status: 'ok',
      durationMs: 0,
      service: this.context.service,
      environment: this.context.environment,
      platform: this.context.platform ?? 'browser',
      measurements,
      attributes: pruneUndefined({
        'web_vital.report': 'page_hide',
        release: this.context.release,
        sessionId: this.context.sessionId,
      }),
    });
  }

  private disconnectObservers(): void {
    for (const observer of this.observers) {
      try {
        observer.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.observers = [];
  }

  /** Stop observing and remove report hooks. Best-effort, idempotent. */
  destroy(): void {
    this.disconnectObservers();
    for (const fn of this.cleanup) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.cleanup = [];
  }
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function pruneUndefined(obj: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  return out;
}
