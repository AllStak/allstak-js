import { HttpTransport } from './transport/http';
import { AllStakConfig } from './client';
import { generateId } from './utils/uuid';

/**
 * Lifecycle status of a release-health session. Vocabulary matches the AllStak
 * backend's `/ingest/v1/sessions/end` contract and the SDK's release-health
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
const SESSION_STATE_VERSION = 1;
const SESSION_STATE_PREFIX = 'allstak.session.v1';
const SESSION_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_RECOVERY_LOCK_MS = 30_000;
const SESSION_RECOVERY_MAX_ATTEMPTS = 3;

export interface SessionStateStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface PersistedSessionState {
  version: 1;
  sessionId: string;
  startedAt: number;
  updatedAt: number;
  status: SessionStatus;
  release?: string;
  environment?: string;
  userId?: string;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  closed?: boolean;
  endedAt?: number;
  recoveryAttempts?: number;
  recoveryLockOwner?: string;
  recoveryLockUntil?: number;
  recoveredAt?: number;
}

export interface SessionTrackerOptions {
  storage?: SessionStateStorage | null;
  storageKey?: string;
}

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
      return process.env.NODE_ENV === 'test'
        || process.env.VITEST === 'true'
        || process.env.VITEST_WORKER_ID != null
        || process.env.VITEST_POOL_ID != null;
    }
  } catch {
    /* ignore */
  }
  try {
    if ((globalThis as any).__vitest_worker__ != null) return true;
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
  private readonly storage: SessionStateStorage | null;
  private readonly storageKey: string;

  constructor(
    private config: AllStakConfig,
    private transport: HttpTransport,
    private sessionId: string,
    options: SessionTrackerOptions = {},
  ) {
    this.storageKey = options.storageKey ?? sessionStorageKey(config);
    this.storage = options.storage === undefined
      ? defaultSessionStateStorage()
      : options.storage;
  }

  /**
   * Idempotent. Reuses the client's existing session id, sends `/sessions/start`,
   * and installs the graceful-shutdown end hooks. Returns the active session.
   * Fail-open: never throws.
   */
  start(): Session {
    if (this.active) return this.active;
    this.recoverPreviousSession();
    const session = new Session(this.sessionId);
    this.active = session;

    try {
      const release = this.resolveRelease();
      this.writeState({
        version: SESSION_STATE_VERSION,
        sessionId: session.id,
        startedAt: session.startedAt,
        updatedAt: Date.now(),
        status: session.status,
        release,
        environment: this.config.environment,
        userId: this.config.user?.id,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        platform: this.config.platform,
        closed: false,
      });
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
    const session = this.current();
    session?.recordError();
    if (session) this.updateOpenState(session);
  }

  /** Record an UNHANDLED/fatal crash. No I/O — the end POST carries the status. */
  recordCrash(): void {
    const session = this.current();
    session?.recordCrash();
    if (session) this.updateOpenState(session);
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
      this.writeState({
        version: SESSION_STATE_VERSION,
        sessionId: session.id,
        startedAt: session.startedAt,
        updatedAt: Date.now(),
        status,
        release: this.resolveRelease(),
        environment: this.config.environment,
        userId: this.config.user?.id,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        platform: this.config.platform,
        closed: true,
        endedAt: Date.now(),
      });
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

  private recoverPreviousSession(): void {
    const previous = this.readState();
    if (!previous) return;

    const now = Date.now();
    if (previous.closed) {
      this.removeState();
      return;
    }
    if (now - previous.startedAt > SESSION_STATE_MAX_AGE_MS) {
      this.removeState();
      return;
    }
    if ((previous.recoveryAttempts ?? 0) >= SESSION_RECOVERY_MAX_ATTEMPTS) {
      this.removeState();
      return;
    }
    if (previous.recoveryLockUntil && previous.recoveryLockUntil > now) {
      return;
    }

    const owner = generateId();
    const locked: PersistedSessionState = {
      ...previous,
      recoveryAttempts: (previous.recoveryAttempts ?? 0) + 1,
      recoveryLockOwner: owner,
      recoveryLockUntil: now + SESSION_RECOVERY_LOCK_MS,
      updatedAt: now,
    };
    this.writeState(locked);
    const claimed = this.readState();
    if (!claimed || claimed.recoveryLockOwner !== owner) return;

    const status: SessionStatus = previous.status === 'crashed' ? 'crashed' : 'abnormal';
    const endedAt = previous.updatedAt || now;
    try {
      this.transport.send(PATH_END, {
        sessionId: previous.sessionId,
        durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, endedAt - previous.startedAt)),
        status,
      });
      this.writeState({
        ...locked,
        status,
        closed: true,
        endedAt: now,
        recoveredAt: now,
        recoveryLockUntil: undefined,
      });
    } catch {
      this.writeState({
        ...locked,
        recoveryLockUntil: 0,
      });
    }
  }

  private updateOpenState(session: Session): void {
    const current = this.readState();
    if (!current || current.sessionId !== session.id || current.closed) return;
    this.writeState({
      ...current,
      status: session.status,
      updatedAt: Date.now(),
      userId: this.config.user?.id,
    });
  }

  private readState(): PersistedSessionState | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!isPersistedSessionState(parsed)) {
        this.removeState();
        return null;
      }
      return parsed;
    } catch {
      this.removeState();
      return null;
    }
  }

  private writeState(state: PersistedSessionState): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(state));
    } catch {
      /* fail-open: session recovery state must never break the app */
    }
  }

  private removeState(): void {
    if (!this.storage) return;
    try {
      this.storage.removeItem(this.storageKey);
    } catch {
      /* ignore */
    }
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

function isPersistedSessionState(value: unknown): value is PersistedSessionState {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<PersistedSessionState>;
  return (
    s.version === SESSION_STATE_VERSION &&
    typeof s.sessionId === 'string' &&
    s.sessionId.length > 0 &&
    typeof s.startedAt === 'number' &&
    Number.isFinite(s.startedAt) &&
    typeof s.updatedAt === 'number' &&
    Number.isFinite(s.updatedAt) &&
    (s.status === 'ok' || s.status === 'errored' || s.status === 'crashed' || s.status === 'abnormal')
  );
}

function sessionStorageKey(config: AllStakConfig): string {
  return `${SESSION_STATE_PREFIX}.${stableHash([
    config.host ?? '',
    config.apiKey ?? '',
    config.release ?? '',
    config.sdkName ?? '',
  ].join('|'))}`;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function defaultSessionStateStorage(): SessionStateStorage | null {
  return browserSessionStateStorage() ?? nodeSessionStateStorage();
}

function browserSessionStateStorage(): SessionStateStorage | null {
  try {
    const storage = typeof window !== 'undefined' ? window.localStorage : undefined;
    if (!storage) return null;
    const probe = '__allstak_session_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

interface NodeFsLike {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readFileSync(path: string, enc: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
}

class FileSessionStateStorage implements SessionStateStorage {
  constructor(private fs: NodeFsLike, private dir: string) {
    this.fs.mkdirSync(this.dir, { recursive: true });
  }

  getItem(key: string): string | null {
    try {
      const file = this.fileFor(key);
      return this.fs.existsSync(file) ? this.fs.readFileSync(file, 'utf8') : null;
    } catch {
      return null;
    }
  }

  setItem(key: string, value: string): void {
    try {
      this.fs.mkdirSync(this.dir, { recursive: true });
      this.fs.writeFileSync(this.fileFor(key), value);
    } catch {
      /* ignore */
    }
  }

  removeItem(key: string): void {
    try {
      const file = this.fileFor(key);
      if (this.fs.existsSync(file)) this.fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }

  private fileFor(key: string): string {
    return `${this.dir}/${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
  }
}

function nodeSessionStateStorage(): SessionStateStorage | null {
  try {
    if (typeof process === 'undefined' || !process.versions?.node || typeof window !== 'undefined') {
      return null;
    }
    const proc = (globalThis as any).process;
    const fs = proc?.getBuiltinModule?.('node:fs') ??
      (typeof require === 'function' ? require('node:fs') : null);
    const os = proc?.getBuiltinModule?.('node:os') ??
      (typeof require === 'function' ? require('node:os') : null);
    if (!fs) return null;
    const tmp = os?.tmpdir?.() ?? '/tmp';
    return new FileSessionStateStorage(fs as NodeFsLike, `${String(tmp).replace(/\/$/, '')}/allstak-session-state`);
  } catch {
    return null;
  }
}

declare const require: undefined | ((id: string) => any);
