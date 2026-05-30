/**
 * Persistent / offline event queue.
 *
 * Un-sent envelopes are persisted to an offline store (a cache dir / IndexedDB)
 * and replayed on the next init: when an event cannot be delivered (network
 * error, retries exhausted, circuit open / offline, or the app/process is
 * shutting down with events still buffered) the transport writes the payload to
 * a persistent store instead of dropping it, then drains the store on the next
 * init.
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
interface PersistedEvent {
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
interface OfflineQueue {
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
interface PersistenceAdapter {
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
}
interface OfflineQueueOptions {
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
/**
 * Register a custom persistence adapter (e.g. React Native's AsyncStorage).
 * Call before {@link AllStak.init}. Pass `null` to clear. The SDK does NOT pull
 * in a native dependency — RN apps wire their own store here, or the SDK falls
 * back to a detected global `AsyncStorage`, else in-memory.
 */
declare function setPersistence(adapter: PersistenceAdapter | null): void;
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
declare function createOfflineQueue(options?: OfflineQueueOptions): OfflineQueue;

/**
 * A unit of work in the transport. `persistId` is set once the item has been
 * written to the {@link OfflineQueue}; it lets us remove the persisted copy
 * after a successful (2xx) send or a permanent (non-429 4xx) drop, and avoids
 * writing the same payload to disk twice on repeated buffer cycles.
 */
type Pending = {
    path: string;
    payload: unknown;
    persistId?: string;
};
interface TransportStats {
    queued: number;
    sent: number;
    failed: number;
    dropped: number;
    retryAttempts: number;
    rateLimited: number;
    consecutiveFailures: number;
    circuitOpenUntil: number;
    lastTransportLatencyMs?: number;
    lastFlushDurationMs?: number;
    /** Events written to the persistent offline store (instead of dropped). */
    persisted?: number;
    /** Events re-sent from the persistent store on init. */
    replayed?: number;
    /** Payloads gzip-compressed before send. */
    compressed?: number;
    /** Payloads sent without compression. */
    uncompressed?: number;
    /** Approximate bytes saved by compression. */
    compressionBytesSaved?: number;
}
declare class HttpTransport {
    private baseUrl;
    private apiKey;
    private buffer;
    private inFlight;
    private flushing;
    private consecutiveFailures;
    private circuitOpenUntil;
    private sent;
    private failed;
    private dropped;
    private retryAttempts;
    private rateLimited;
    private lastTransportLatencyMs;
    private lastFlushDurationMs;
    private persisted;
    private replayed;
    private compressed;
    private uncompressed;
    private compressionBytesSaved;
    private retryTimer;
    private retryTimerDueAt;
    private pendingRetryDelayMs;
    private closed;
    /**
     * Persistent / offline store. Defaults to a no-op so existing callers and
     * tests keep their pure in-memory behavior; the client injects a real queue
     * (localStorage / fs spool / pluggable adapter) when `enableOfflineQueue` is
     * on. Every interaction is fail-open.
     */
    private offlineQueue;
    /** True only when a real (non-noop) persistent store is wired up. */
    private offlineEnabled;
    constructor(baseUrl: string, apiKey: string, offlineQueue?: OfflineQueue);
    send(path: string, payload: unknown): Promise<void>;
    private enqueueOrDispatch;
    /**
     * Push an item back onto the in-memory buffer. If the buffer is full the
     * OLDEST item is evicted — instead of dropping that evictee on the floor we
     * persist it to the offline store (already PII-scrubbed) so it survives a
     * restart/outage and is replayed on the next init. Session lifecycle paths
     * are never persisted. Fully fail-open.
     */
    private bufferOrPersist;
    private track;
    private dispatch;
    /** A 2xx (or replay) succeeded: clear the persisted copy if this was one. */
    private onSendSuccess;
    /**
     * A send failed. Transient errors (network, 429, 5xx) re-buffer the item
     * (spilling the buffer evictee to the offline store). A PERMANENT failure
     * — a 4xx other than 429 — means the server will never accept this payload,
     * so we drop it and remove any persisted copy rather than replaying forever.
     */
    private onSendFailure;
    private doFetch;
    private scheduleFlush;
    private flushBuffer;
    private recordFailure;
    getBufferSize(): number;
    /**
     * Replay events persisted by a previous process/session (offline queue).
     * Loads the store, re-sends each entry through the existing transport (so it
     * honours the same retry/backoff/circuit-breaker), and removes an entry only
     * once it is accepted (2xx) or permanently undeliverable (non-429 4xx).
     * Transient failures keep the entry in the store for the NEXT init.
     *
     * Runs asynchronously and is fully fail-open — it never throws and never
     * blocks init. Items carry their `persistId` so a successful send clears the
     * stored copy in {@link onSendSuccess}.
     */
    drainPersisted(): void;
    /**
     * Spill everything still buffered in memory into the persistent store. Called
     * on graceful shutdown (process exit / tab close) so in-flight telemetry that
     * could not be flushed in time survives a restart instead of being dropped.
     * Session lifecycle paths are skipped. Fail-open.
     */
    persistBufferedNow(): void;
    close(): void;
    /**
     * Drain the in-memory buffer and hand the items to the caller. Used by the
     * browser unload path so the client can attempt a `navigator.sendBeacon` for
     * each event and persist only what the beacon could not take. Fail-open.
     */
    drainBufferForUnload(): Pending[];
    /**
     * Persist a single already-scrubbed item to the offline store. Session
     * lifecycle paths are skipped (counted as a real drop). Fail-open.
     */
    persistOne(item: Pending, countDropOnSkip?: boolean): void;
    flush(timeoutMs?: number): Promise<boolean>;
    noteDropped(count?: number): void;
    private prepareRequestBody;
    getStats(): TransportStats;
}

interface DbQueryItem {
    normalizedQuery: string;
    queryHash: string;
    queryType: string;
    durationMs: number;
    timestampMillis: number;
    status: string;
    errorMessage?: string;
    databaseName?: string;
    databaseType?: string;
    service?: string;
    environment?: string;
    traceId?: string;
    spanId?: string;
    rowsAffected?: number;
}
/**
 * Transport / queue for DB query telemetry. Actual driver-specific
 * instrumentation lives in `src/integrations/db/*.ts`.
 */
declare class DatabaseModule {
    private transport;
    private moduleConfig;
    private queue;
    private flushTimer;
    constructor(transport: HttpTransport, moduleConfig: {
        service?: string;
        environment?: string;
    });
    /**
     * Record a database query. Batches internally and flushes every 5s or
     * when 20 items accumulate.
     */
    capture(item: DbQueryItem): void;
    flush(): void;
    destroy(): void;
}

export { DatabaseModule as D, HttpTransport as H, type OfflineQueue as O, type PersistedEvent as P, type TransportStats as T, type DbQueryItem as a, type OfflineQueueOptions as b, type PersistenceAdapter as c, createOfflineQueue as d, setPersistence as s };
