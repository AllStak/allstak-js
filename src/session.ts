import { HttpTransport } from './transport/http';
import { AllStakConfig } from './client';
import { generateId } from './utils/uuid';

/**
 * Lifecycle status of a release-health session. Vocabulary matches the AllStak
 * backend's `/ingest/v1/sessions/end` contract and Sentry's release-health
 * conventions, and mirrors the Java SDK's {@code SessionStatus}:
 *
 * - `ok`       — session ended normally with at most non-fatal logs.
 * - `errored`  — at least one HANDLED error landed during the session, but the
 *                process kept running.
 * - `crashed`  — an UNHANDLED/fatal exception ended the process (the SDK only
 *                reports this when it observes the uncaught error itself).
 * - `abnormal` — process ended without a normal flush. Reserved for callers
 *                that pass an explicit final status to {@link SessionTracker.end}.
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

/**
 * A single release-health session — one per process / app-launch in the default
 * "single session" mode. Mirrors the Java SDK's {@code Session} status model:
 * `recordError` escalates OK→ERRORED, `recordCrash` is terminal (CRASHED), and
 * `recordAbnormalExit` promotes OK/ERRORED→ABNORMAL.
 */
export class Session {
  readonly id: string;
  readonly startedAt: number;
  private _status: SessionStatus = 'ok';
  private _errorCount = 0;

  constructor(id: string = generateId(), startedAt: number = Date.now()) {
    this.id = id;
    this.startedAt = startedAt;
  }

  get status(): SessionStatus {
    return this._status;
  }

  get errorCount(): number {
    return this._errorCount;
  }

  /** Increment the error counter and bump OK→ERRORED (terminal status wins). */
  recordError(): void {
    this._errorCount++;
    if (this._status === 'ok') this._status = 'errored';
  }

  /** Mark a terminal crashed status (overrides ERRORED). Used by the uncaught handler. */
  recordCrash(): void {
    this._status = 'crashed';
    this._errorCount++;
  }

  /** Promote to ABNORMAL only if still OK or ERRORED (never downgrade CRASHED). */
  recordAbnormalExit(): void {
    if (this._status === 'ok' || this._status === 'errored') this._status = 'abnormal';
  }

  /** Duration from start to now, floored at 0. */
  durationMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }
}

/**
 * Detect a unit-test runtime so session tracking can be skipped automatically
 * (mirrors the Java SDK + the SDK's own release-registration guard). Vitest sets
 * `VITEST`/`NODE_ENV=test`; we never throw probing `process`.
 */
export function isTestRuntime(): boolean {
  try {
    if (typeof process !== 'undefined' && process.env) {
      return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * "One session per process / app-launch" tracker.
 *
 * On {@link start} the SDK reuses the client's existing session id, records a
 * start timestamp, sets in-memory status to `ok`, and POSTs `/sessions/start`.
 * Errored/crashed transitions are recorded in-memory only; the terminal
 * {@link end} call carries the final status + duration to `/sessions/end`.
 *
 * Sessions are NEVER sampled. Every network call is best-effort and fail-open —
 * a failure must never throw or block init/shutdown.
 *
 * Re-entrancy safe: a second {@link start} is a no-op; once ended the tracker
 * does not re-arm.
 */
export class SessionTracker {
  private active: Session | null = null;
  private ended = false;
  private cleanup: Array<() => void> = [];

  constructor(
    private config: AllStakConfig,
    private transport: HttpTransport,
    private sessionId: string,
  ) {}

  /**
   * Idempotent. Reuses the client's existing session id, sends `/sessions/start`,
   * and installs the graceful-shutdown end hooks. Returns the active session.
   * Fail-open: never throws.
   */
  start(): Session {
    if (this.active) return this.active;
    const session = new Session(this.sessionId);
    this.active = session;

    try {
      const release = this.resolveRelease();
      if (release) {
        const payload: Record<string, unknown> = {
          sessionId: session.id,
          release,
          environment: this.config.environment,
          userId: this.config.user?.id,
          sdkName: this.config.sdkName,
          sdkVersion: this.config.sdkVersion,
          platform: this.config.platform,
        };
        // Sessions are never sampled — always send through the existing transport.
        this.transport.send(PATH_START, payload);
      }
      this.installShutdownHooks();
    } catch {
      /* fail-open: session start must never break init */
    }
    return session;
  }

  /** The active session, or null if not started / already ended. */
  current(): Session | null {
    return this.ended ? null : this.active;
  }

  /** Record a HANDLED error against the active session. No I/O. */
  recordError(): void {
    this.current()?.recordError();
  }

  /** Record an UNHANDLED/fatal crash. No I/O — the end POST carries the status. */
  recordCrash(): void {
    this.current()?.recordCrash();
  }

  /**
   * Terminate the session and POST `/sessions/end`. Idempotent and best-effort.
   * When `finalStatus` is omitted the session's accumulated status is used.
   * Fail-open: never throws.
   */
  end(finalStatus?: SessionStatus): void {
    if (this.ended) return;
    const session = this.active;
    this.active = null;
    if (!session) {
      this.ended = true;
      return;
    }
    this.ended = true;
    this.removeShutdownHooks();

    try {
      const status = finalStatus ?? session.status;
      const release = this.resolveRelease();
      if (!release) return;
      const payload: Record<string, unknown> = {
        sessionId: session.id,
        durationMs: Math.min(Number.MAX_SAFE_INTEGER, session.durationMs()),
        status,
      };
      this.transport.send(PATH_END, payload);
    } catch {
      /* fail-open: session end must never break shutdown */
    }
  }

  /**
   * The session's `release` falls back to `sdkVersion` (then nothing) so a
   * session is still attributable even when no release is configured.
   */
  private resolveRelease(): string | undefined {
    const release = this.config.release?.trim();
    if (release) return release;
    const sdkVersion = this.config.sdkVersion?.trim();
    return sdkVersion || undefined;
  }

  // ── Graceful-shutdown hooks ───────────────────────────────────────────────

  private installShutdownHooks(): void {
    const endOnce = () => this.end();

    // Browser / React Native WebView: end on tab close + background→terminate.
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      const onPageHide = () => endOnce();
      const onVisibility = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') endOnce();
      };
      window.addEventListener('pagehide', onPageHide);
      this.cleanup.push(() => window.removeEventListener('pagehide', onPageHide));
      if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('visibilitychange', onVisibility);
        this.cleanup.push(() => document.removeEventListener('visibilitychange', onVisibility));
      }
      return;
    }

    // Node: end on graceful process exit.
    if (typeof process !== 'undefined' && typeof process.on === 'function') {
      const onExit = () => endOnce();
      process.on('beforeExit', onExit);
      process.on('exit', onExit);
      process.on('SIGTERM', onExit);
      this.cleanup.push(() => {
        if (typeof process.off === 'function') {
          process.off('beforeExit', onExit);
          process.off('exit', onExit);
          process.off('SIGTERM', onExit);
        }
      });
    }
  }

  private removeShutdownHooks(): void {
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
