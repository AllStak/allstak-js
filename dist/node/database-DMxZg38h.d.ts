interface TransportStats {
    queued: number;
    sent: number;
    failed: number;
    dropped: number;
    consecutiveFailures: number;
    circuitOpenUntil: number;
    lastTransportLatencyMs?: number;
    lastFlushDurationMs?: number;
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
    private lastTransportLatencyMs;
    private lastFlushDurationMs;
    constructor(baseUrl: string, apiKey: string);
    send(path: string, payload: unknown): Promise<void>;
    private enqueueOrDispatch;
    private track;
    private dispatch;
    private doFetch;
    private scheduleFlush;
    private flushBuffer;
    private recordFailure;
    getBufferSize(): number;
    flush(timeoutMs?: number): Promise<boolean>;
    noteDropped(count?: number): void;
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

export { DatabaseModule as D, HttpTransport as H, type TransportStats as T, type DbQueryItem as a };
