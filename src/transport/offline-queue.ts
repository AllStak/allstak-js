/**
 * Persistent / offline event queue.
 *
 * Sentry persists un-sent envelopes to an offline store (a cache dir / IndexedDB)
 * and replays them on the next init. This module brings the AllStak JS SDK to
 * parity: when an event cannot be delivered (network error, retries exhausted,
 * circuit open / offline, or the app/process is shutting down with events still
 * buffered) the transport writes the payload to a persistent store instead of
 * dropping it, then drains the store on the next init.
 *
 * Invariants (all enforced by {@link HttpTransport}, documented here for the
 * reader):
 *
 *  - Payloads handed to {@link OfflineQueue.enqueue} are ALREADY PII-scrubbed.
 *    The transport sits below every module (errors/logs/spans/http/db), and
 *    each module redacts before calling `transport.send`. We persist the exact
 *    bytes the transport would have sent — never raw user data.
 *  - Session lifecycle calls (`/ingest/v1/sessions/start` + `/end`) are
 *    best-effort live-only and are NEVER persisted (a replayed stale session
 *    would skew durations). The transport filters these out before enqueue.
 *  - The store is bounded (count + bytes + max-age); when full the OLDEST entry
 *    is dropped. It can never grow unbounded.
 *  - Everything is fail-open: a store that is unavailable / unwritable
 *    (read-only FS, serverless, no localStorage, sandboxed RN) degrades
 *    silently to the existing in-memory behavior. No method ever throws.
 */

/** A persisted, already-scrubbed transport payload. */
export interface PersistedEvent {
  /** Monotonic-ish id used for stable ordering + de-dup of the store entry. */
  id: string;
  /** Ingest path (e.g. `/ingest/v1/errors`). Session paths are never stored. */
  path: string;
  /** The PII-scrubbed payload exactly as the transport would POST it. */
  payload: unknown;
  /** Epoch ms the entry was written. Used for max-age eviction. */
  ts: number;
}

/**
 * Storage backend contract. Implementations MUST be fail-open: any internal
 * error is swallowed and the method returns a safe default (e.g. `[]`).
 */
export interface OfflineQueue {
  /** Persist one already-scrubbed event. Best-effort; never throws. */
  enqueue(event: PersistedEvent): void;
  /** Load everything currently persisted, oldest-first. Never throws. */
  load(): PersistedEvent[];
  /** Remove a persisted entry by id (after it is accepted / permanently dropped). */
  remove(id: string): void;
  /** Drop everything (used by tests + opt-out reset). */
  clear(): void;
}

/**
 * Pluggable async-storage adapter, mirroring the React Native AsyncStorage
 * surface. RN does not bundle a native fs, so callers wire their own store via
 * {@link setPersistence}. Only the synchronous-friendly subset we need.
 */
export interface PersistenceAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

export interface OfflineQueueOptions {
  /** Master switch. Defaults are platform-specific (see {@link createOfflineQueue}). */
  enabled?: boolean;
  /** Node only: spool directory. Defaults to `<tmpdir>/allstak-offline-queue`. */
  dir?: string;
  /** Max number of stored events before the oldest is evicted. */
  maxEvents?: number;
  /** Max total stored bytes (approx, JSON length) before the oldest is evicted. */
  maxBytes?: number;
  /** Max age (ms) of a stored event; older entries are dropped on load. */
  maxAgeMs?: number;
  /** Test seam / RN: an explicit pluggable persistence adapter. */
  adapter?: PersistenceAdapter | null;
}

// ── Sane platform defaults ──────────────────────────────────────────────────
// Clients (browser/RN) keep a small queue; servers tolerate a few MB.
const BROWSER_MAX_EVENTS = 50;
const BROWSER_MAX_BYTES = 1_000_000; // ~1 MB of localStorage
const NODE_MAX_EVENTS = 500;
const NODE_MAX_BYTES = 5_000_000; // ~5 MB spool
const DEFAULT_MAX_AGE_MS = 48 * 60 * 60 * 1000; // 48h
const STORAGE_KEY = 'allstak.offline.v1';

let idCounter = 0;
/** Stable, collision-resistant-enough id for a store entry. */
export function nextPersistedId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Approx serialized byte size of one entry. Fail-open → 0 on a circular value. */
function entryBytes(event: PersistedEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}

/**
 * Bounded in-memory list shared by the concrete backends. Enforces
 * count + bytes + max-age caps, dropping OLDEST first. Returns the number of
 * entries dropped so the transport can account them as `dropped`.
 */
function applyBounds(
  list: PersistedEvent[],
  maxEvents: number,
  maxBytes: number,
  maxAgeMs: number,
): { kept: PersistedEvent[]; dropped: number } {
  const now = Date.now();
  let dropped = 0;

  // 1. Age out stale entries first.
  let kept = list.filter((e) => {
    const fresh = now - e.ts <= maxAgeMs;
    if (!fresh) dropped++;
    return fresh;
  });

  // 2. Count cap — drop oldest.
  while (kept.length > maxEvents) {
    kept.shift();
    dropped++;
  }

  // 3. Byte cap — drop oldest until under budget.
  let total = kept.reduce((sum, e) => sum + entryBytes(e), 0);
  while (kept.length > 0 && total > maxBytes) {
    const removed = kept.shift()!;
    total -= entryBytes(removed);
    dropped++;
  }

  return { kept, dropped };
}

/**
 * No-op queue used when persistence is disabled or no store is available.
 * Keeps the rest of the transport branch-free.
 */
export class NoopOfflineQueue implements OfflineQueue {
  enqueue(): void {
    /* no-op */
  }
  load(): PersistedEvent[] {
    return [];
  }
  remove(): void {
    /* no-op */
  }
  clear(): void {
    /* no-op */
  }
}

/**
 * Browser backend: a single capped JSON blob in `localStorage`. Reads + writes
 * the whole array (the queue is small by design). Every access is wrapped so a
 * quota error, private-mode `localStorage` throw, or JSON corruption degrades
 * to a no-op rather than breaking telemetry.
 */
export class LocalStorageOfflineQueue implements OfflineQueue {
  constructor(
    private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
    private readonly key: string = STORAGE_KEY,
  ) {}

  private read(): PersistedEvent[] {
    try {
      const raw = this.storage.getItem(this.key);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPersistedEvent);
    } catch {
      return [];
    }
  }

  private write(list: PersistedEvent[]): void {
    try {
      const { kept } = applyBounds(list, this.maxEvents, this.maxBytes, this.maxAgeMs);
      if (kept.length === 0) {
        this.storage.removeItem(this.key);
        return;
      }
      this.storage.setItem(this.key, JSON.stringify(kept));
    } catch {
      // Quota exceeded / private mode: drop silently. We never throw.
    }
  }

  enqueue(event: PersistedEvent): void {
    // Upsert by id: a replayed item that fails and is re-persisted under its
    // original id must REPLACE its stored copy, not create a duplicate.
    const list = this.read().filter((e) => e.id !== event.id);
    list.push(event);
    this.write(list);
  }

  load(): PersistedEvent[] {
    const list = this.read();
    // Re-persist the bounded view so aged-out entries don't linger.
    this.write(list);
    return this.read();
  }

  remove(id: string): void {
    const list = this.read().filter((e) => e.id !== id);
    this.write(list);
  }

  clear(): void {
    try {
      this.storage.removeItem(this.key);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Async pluggable-adapter backend (React Native AsyncStorage, custom stores).
 * The adapter may be sync or async; we keep an in-memory mirror so the
 * synchronous {@link OfflineQueue} contract holds while writes flush in the
 * background. Fully fail-open.
 */
export class AdapterOfflineQueue implements OfflineQueue {
  private mirror: PersistedEvent[] = [];
  private hydrated = false;

  constructor(
    private adapter: PersistenceAdapter,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
    private readonly key: string = STORAGE_KEY,
  ) {
    this.hydrate();
  }

  private hydrate(): void {
    try {
      const got = this.adapter.getItem(this.key);
      if (isThenable(got)) {
        got
          .then((raw) => {
            this.mirror = parseList(raw);
            this.hydrated = true;
          })
          .catch(() => {
            this.hydrated = true;
          });
      } else {
        this.mirror = parseList(got);
        this.hydrated = true;
      }
    } catch {
      this.hydrated = true;
    }
  }

  private flush(): void {
    try {
      const { kept } = applyBounds(this.mirror, this.maxEvents, this.maxBytes, this.maxAgeMs);
      this.mirror = kept;
      const r = this.adapter.setItem(this.key, JSON.stringify(kept));
      if (isThenable(r)) r.catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  enqueue(event: PersistedEvent): void {
    // Upsert by id (see LocalStorageOfflineQueue.enqueue).
    this.mirror = this.mirror.filter((e) => e.id !== event.id);
    this.mirror.push(event);
    this.flush();
  }

  load(): PersistedEvent[] {
    const { kept } = applyBounds(this.mirror, this.maxEvents, this.maxBytes, this.maxAgeMs);
    this.mirror = kept;
    return [...kept];
  }

  remove(id: string): void {
    this.mirror = this.mirror.filter((e) => e.id !== id);
    this.flush();
  }

  clear(): void {
    this.mirror = [];
    try {
      const r = this.adapter.removeItem(this.key);
      if (isThenable(r)) r.catch(() => undefined);
    } catch {
      /* ignore */
    }
  }

  /** @internal test seam */
  isHydrated(): boolean {
    return this.hydrated;
  }
}

interface NodeFsLike {
  mkdirSync(path: string, opts: { recursive: boolean }): void;
  readdirSync(path: string): string[];
  readFileSync(path: string, enc: 'utf8'): string;
  writeFileSync(path: string, data: string): void;
  unlinkSync(path: string): void;
  existsSync(path: string): boolean;
}

/**
 * Node backend: a filesystem spool, one JSON file per event under a configurable
 * directory (default `<tmpdir>/allstak-offline-queue`). One-file-per-envelope
 * keeps writes atomic-ish and removal O(1) without rewriting a log. If the dir
 * is not writable (read-only FS, restricted serverless sandbox) construction
 * fails closed and the factory falls back to a {@link NoopOfflineQueue}.
 */
export class FsOfflineQueue implements OfflineQueue {
  constructor(
    private fs: NodeFsLike,
    private readonly dir: string,
    private readonly maxEvents: number,
    private readonly maxBytes: number,
    private readonly maxAgeMs: number,
  ) {
    // Probe writability up front so the factory can fall back cleanly.
    this.fs.mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: string): string {
    // ids are url-safe (base36 + dashes); still guard against traversal.
    const safe = id.replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${this.dir}/allstak-${safe}.json`;
  }

  private listFiles(): string[] {
    try {
      return this.fs
        .readdirSync(this.dir)
        .filter((f) => f.startsWith('allstak-') && f.endsWith('.json'))
        .sort(); // lexical sort ≈ chronological (base36 ts prefix)
    } catch {
      return [];
    }
  }

  enqueue(event: PersistedEvent): void {
    try {
      this.fs.writeFileSync(this.fileFor(event.id), JSON.stringify(event));
      this.enforceBounds();
    } catch {
      /* ignore — disk full / removed dir */
    }
  }

  load(): PersistedEvent[] {
    const out: PersistedEvent[] = [];
    for (const f of this.listFiles()) {
      const full = `${this.dir}/${f}`;
      try {
        const parsed = JSON.parse(this.fs.readFileSync(full, 'utf8'));
        if (isPersistedEvent(parsed)) out.push(parsed);
        else this.safeUnlink(full);
      } catch {
        this.safeUnlink(full); // corrupt entry → drop it
      }
    }
    out.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    const { kept } = applyBounds(out, this.maxEvents, this.maxBytes, this.maxAgeMs);
    // Evict on-disk files that fell outside the bounds.
    const keepIds = new Set(kept.map((e) => e.id));
    for (const e of out) if (!keepIds.has(e.id)) this.safeUnlink(this.fileFor(e.id));
    return kept;
  }

  remove(id: string): void {
    this.safeUnlink(this.fileFor(id));
  }

  clear(): void {
    for (const f of this.listFiles()) this.safeUnlink(`${this.dir}/${f}`);
  }

  private enforceBounds(): void {
    const events = this.load(); // load() already enforces + evicts
    void events;
  }

  private safeUnlink(full: string): void {
    try {
      this.fs.unlinkSync(full);
    } catch {
      /* ignore */
    }
  }
}

// ── Pluggable adapter registry (React Native) ───────────────────────────────
let injectedAdapter: PersistenceAdapter | null = null;

/**
 * Register a custom persistence adapter (e.g. React Native's AsyncStorage).
 * Call before {@link AllStak.init}. Pass `null` to clear. The SDK does NOT pull
 * in a native dependency — RN apps wire their own store here, or the SDK falls
 * back to a detected global `AsyncStorage`, else in-memory.
 */
export function setPersistence(adapter: PersistenceAdapter | null): void {
  injectedAdapter = adapter && typeof adapter.getItem === 'function' ? adapter : null;
}

/** @internal test seam */
export function _getInjectedPersistence(): PersistenceAdapter | null {
  return injectedAdapter;
}

/** Detect a globally-exposed AsyncStorage-shaped object (RN convention). */
function detectGlobalAsyncStorage(): PersistenceAdapter | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const candidate = (g.AsyncStorage ?? g.__ALLSTAK_ASYNC_STORAGE__) as
      | Partial<PersistenceAdapter>
      | undefined;
    if (
      candidate &&
      typeof candidate.getItem === 'function' &&
      typeof candidate.setItem === 'function' &&
      typeof candidate.removeItem === 'function'
    ) {
      return candidate as PersistenceAdapter;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function isNodeRuntime(): boolean {
  try {
    return (
      typeof globalThis.__ALLSTAK_NODE__ !== 'undefined' ||
      (typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined')
    );
  } catch {
    return false;
  }
}

function getLocalStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    if (typeof window === 'undefined') return null;
    const ls = window.localStorage;
    if (!ls) return null;
    // Probe: Safari private mode throws on setItem, not on access.
    const probe = '__allstak_probe__';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

function loadNodeFs(): NodeFsLike | null {
  try {
    if (!isNodeRuntime()) return null;
    const proc = (globalThis as any).process;
    // Prefer the spec-compliant getBuiltinModule when present (matches the
    // SDK's AsyncLocalStorage lookup), else fall back to require('node:fs').
    const fromProcess = proc?.getBuiltinModule?.('node:fs');
    if (fromProcess) return fromProcess as NodeFsLike;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const req = typeof require === 'function' ? require : undefined;
    return (req ? (req('node:fs') as NodeFsLike) : null);
  } catch {
    return null;
  }
}

function defaultNodeDir(): string {
  try {
    const proc = (globalThis as any).process;
    const os = proc?.getBuiltinModule?.('node:os') ??
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      (typeof require === 'function' ? require('node:os') : null);
    const tmp = os?.tmpdir?.() ?? '/tmp';
    return `${tmp.replace(/\/$/, '')}/allstak-offline-queue`;
  } catch {
    return '/tmp/allstak-offline-queue';
  }
}

declare const require: undefined | ((id: string) => any);

/**
 * Build the right {@link OfflineQueue} for the current runtime, applying
 * platform defaults. Never throws — any failure yields a {@link NoopOfflineQueue}
 * so the transport silently keeps its existing in-memory behavior.
 *
 * Selection order:
 *   1. Disabled (`enabled === false`)        → Noop.
 *   2. Explicit adapter / `setPersistence`    → Adapter (RN, custom).
 *   3. Node (fs available, dir writable)      → Fs spool.
 *   4. Browser (localStorage usable)          → localStorage blob.
 *   5. Detected global AsyncStorage           → Adapter.
 *   6. Anything else (edge, sandbox)          → Noop (degrade in-memory).
 */
export function createOfflineQueue(options: OfflineQueueOptions = {}): OfflineQueue {
  try {
    if (options.enabled === false) return new NoopOfflineQueue();

    const node = isNodeRuntime();
    const maxEvents = options.maxEvents ?? (node ? NODE_MAX_EVENTS : BROWSER_MAX_EVENTS);
    const maxBytes = options.maxBytes ?? (node ? NODE_MAX_BYTES : BROWSER_MAX_BYTES);
    const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

    // 2. Explicit / injected pluggable adapter wins everywhere (RN-first).
    const adapter = options.adapter ?? injectedAdapter;
    if (adapter && typeof adapter.getItem === 'function') {
      return new AdapterOfflineQueue(adapter, maxEvents, maxBytes, maxAgeMs);
    }

    // 3. Node filesystem spool.
    if (node) {
      const fs = loadNodeFs();
      const dir = options.dir ?? defaultNodeDir();
      if (fs) {
        try {
          return new FsOfflineQueue(fs, dir, maxEvents, maxBytes, maxAgeMs);
        } catch {
          return new NoopOfflineQueue(); // read-only FS / sandbox
        }
      }
      return new NoopOfflineQueue(); // edge runtime: no fs
    }

    // 4. Browser localStorage.
    const ls = getLocalStorage();
    if (ls) return new LocalStorageOfflineQueue(ls, maxEvents, maxBytes, maxAgeMs);

    // 5. Detected global AsyncStorage (RN without explicit setPersistence).
    const detected = detectGlobalAsyncStorage();
    if (detected) return new AdapterOfflineQueue(detected, maxEvents, maxBytes, maxAgeMs);

    // 6. Degrade silently.
    return new NoopOfflineQueue();
  } catch {
    return new NoopOfflineQueue();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function isPersistedEvent(v: unknown): v is PersistedEvent {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as PersistedEvent).id === 'string' &&
    typeof (v as PersistedEvent).path === 'string' &&
    typeof (v as PersistedEvent).ts === 'number'
  );
}

function parseList(raw: string | null): PersistedEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isPersistedEvent) : [];
  } catch {
    return [];
  }
}

function isThenable<T = unknown>(v: unknown): v is Promise<T> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function';
}

/**
 * Ingest paths that must NOT be persisted. Session lifecycle is best-effort
 * live-only; a replayed stale `/sessions/start` or `/end` would skew durations.
 */
export function isPersistablePath(path: string): boolean {
  return !path.startsWith('/ingest/v1/sessions/');
}
