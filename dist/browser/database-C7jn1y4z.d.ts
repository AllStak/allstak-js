declare class HttpTransport {
    private baseUrl;
    private apiKey;
    private buffer;
    private flushing;
    constructor(baseUrl: string, apiKey: string);
    send(path: string, payload: unknown): Promise<void>;
    private doFetch;
    private flushBuffer;
    getBufferSize(): number;
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
    private flush;
    destroy(): void;
}

export { DatabaseModule as D, type DbQueryItem as a };
