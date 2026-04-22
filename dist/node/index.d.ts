import { D as DatabaseModule, a as DbQueryItem } from './database-C7jn1y4z.js';

interface HttpRequestItem {
    /** Unique trace identifier — generates one if not provided */
    traceId?: string;
    /** 'inbound' = request arriving at this service; 'outbound' = request made to external service */
    direction: 'inbound' | 'outbound';
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    host: string;
    path: string;
    statusCode: number;
    durationMs: number;
    requestSize?: number;
    responseSize?: number;
    userId?: string;
    /** Fingerprint of a linked error event */
    errorFingerprint?: string;
    /** ISO-8601 timestamp — defaults to now */
    timestamp?: string;
}

interface HeartbeatOptions {
    /** The cron monitor slug as configured in the AllStak dashboard */
    slug: string;
    /** Whether the job run succeeded or failed */
    status: 'success' | 'failed';
    /** How long the job took to run, in milliseconds */
    durationMs: number;
    /** Optional message or error description */
    message?: string;
}

interface SpanData {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    operation: string;
    description: string;
    status: 'ok' | 'error' | 'timeout';
    durationMs: number;
    startTimeMillis: number;
    endTimeMillis: number;
    service: string;
    environment: string;
    tags: Record<string, string>;
    data: string;
}
declare class Span {
    private _traceId;
    private _spanId;
    private _parentSpanId;
    private _operation;
    private _description;
    private _service;
    private _environment;
    private _tags;
    private _data;
    private _startTimeMillis;
    private _finished;
    private _onFinish;
    constructor(config: {
        traceId: string;
        spanId: string;
        parentSpanId: string;
        operation: string;
        description: string;
        service: string;
        environment: string;
        tags: Record<string, string>;
        startTimeMillis: number;
        onFinish: (spanData: SpanData) => void;
    });
    /** Set a tag on this span. */
    setTag(key: string, value: string): this;
    /** Set arbitrary string data on this span. */
    setData(data: string): this;
    /** Set the description after creation. */
    setDescription(description: string): this;
    /**
     * Finish the span. Status defaults to 'ok'.
     * Calling finish() more than once is a no-op.
     */
    finish(status?: 'ok' | 'error' | 'timeout'): void;
    get spanId(): string;
    get traceId(): string;
    get isFinished(): boolean;
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
interface LogEvent {
    type: 'log';
    dsn: string;
    timestamp: string;
    level: LogLevel;
    message: string;
    environment: string;
    meta?: Record<string, unknown>;
}

interface AllStakConfig {
    /**
     * Project API key from the AllStak dashboard (`ask_live_…`).
     * Required.
     */
    apiKey: string;
    /**
     * Optional ingest host override. Leave unset to use the production AllStak
     * ingest URL ({@link INGEST_HOST}). Set this only for self-hosted AllStak
     * deployments or integration tests.
     */
    host?: string;
    environment?: string;
    release?: string;
    user?: {
        id?: string;
        email?: string;
    };
    tags?: Record<string, string>;
    /** Enable automatic breadcrumbs for fetch, console.warn/error, and HTTP requests. Default: true */
    autoBreadcrumbs?: boolean;
    /** Enable automatic database instrumentation for pg and mysql2. Default: true */
    autoDbInstrumentation?: boolean;
    /** Enable automatic capture of Node uncaughtException + unhandledRejection. Default: true */
    autoNodeErrorCapture?: boolean;
    /** Maximum number of breadcrumbs to keep in the ring buffer. Default: 50 */
    maxBreadcrumbs?: number;
    sessionReplay?: {
        enabled?: boolean;
        maskAllInputs?: boolean;
        sampleRate?: number;
    };
    /**
     * @deprecated Use {@link apiKey} (and optionally {@link host}) instead.
     * If a {@code dsn} is provided we still parse it for backwards-compatibility:
     * the username is taken as the API key and the origin as the host.
     */
    dsn?: string;
}
declare class AllStakClient {
    private transport;
    private config;
    private errors;
    private logs;
    private httpRequests;
    private cron;
    private tracing;
    private _database;
    private sessionReplay;
    private sessionId;
    constructor(config: AllStakConfig);
    private isNodeBuild;
    captureException(error: Error, context?: Record<string, unknown>): void;
    addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void;
    clearBreadcrumbs(): void;
    /**
     * Capture a freeform message. Routes to the **logs** ingest stream by default
     * (so messages appear in the dashboard's "Logs" view and don't pollute the
     * Errors view). For severities >= warning, it ALSO writes to errors so the
     * message is visible alongside real exceptions when triaging.
     *
     * Pass `{ as: 'error' }` to send only to the errors stream (preserves the
     * legacy behaviour for callers that need it).
     */
    captureMessage(message: string, level?: 'fatal' | 'error' | 'warning' | 'info', options?: {
        as?: 'log' | 'error' | 'both';
    }): void;
    /**
     * Report an HTTP request (inbound or outbound).
     * Batches internally and flushes every 5s or when 20 items accumulate.
     * Automatically attaches current traceId if not already set on the item.
     */
    captureRequest(item: HttpRequestItem): void;
    /**
     * Access the database module for capturing DB query telemetry.
     */
    get database(): DatabaseModule;
    /**
     * Report a database query to AllStak.
     * Batches internally and flushes every 5s or when 20 items accumulate.
     */
    captureDbQuery(item: DbQueryItem): void;
    /**
     * Report a cron job execution.
     * The cron monitor slug must match one configured in the AllStak dashboard.
     */
    heartbeat(options: HeartbeatOptions): void;
    get log(): {
        debug: (message: string, meta?: Record<string, unknown>) => void;
        info: (message: string, meta?: Record<string, unknown>) => void;
        warn: (message: string, meta?: Record<string, unknown>) => void;
        error: (message: string, meta?: Record<string, unknown>) => void;
        fatal: (message: string, meta?: Record<string, unknown>) => void;
    };
    setUser(user: {
        id?: string;
        email?: string;
    }): void;
    setTag(key: string, value: string): void;
    getSessionId(): string;
    /**
     * Start a new span. Automatically parented to the current active span.
     * Call `span.finish()` when the operation completes.
     */
    startSpan(operation: string, options?: {
        description?: string;
        tags?: Record<string, string>;
    }): Span;
    /** Get the current trace ID (creates one if none exists). */
    getTraceId(): string;
    /** Set the trace ID explicitly (e.g. from an incoming request header). */
    setTraceId(traceId: string): void;
    /** Get the current active span ID, or null if no span is active. */
    getCurrentSpanId(): string | null;
    /** Reset trace context (trace ID and span stack). */
    resetTrace(): void;
    destroy(): void;
    private nodeUncaughtHandler;
    private nodeRejectionHandler;
    private installNodeErrorHandlers;
    private uninstallNodeErrorHandlers;
}

declare global {
    var __ALLSTAK_NODE__: boolean | undefined;
}

interface ErrorEvent {
    type: 'error';
    dsn: string;
    timestamp: string;
    level: 'fatal' | 'error' | 'warning' | 'info';
    message: string;
    stack?: string;
    environment: string;
    release?: string;
    user?: {
        id?: string;
        email?: string;
    };
    tags?: Record<string, string>;
    context?: Record<string, unknown>;
}
interface Breadcrumb {
    timestamp: string;
    type: string;
    message: string;
    level: string;
    data?: Record<string, unknown>;
}

interface DOMEvent {
    type: string;
    timestamp: string;
    data: unknown;
}
/** @deprecated — kept for backwards compat; internal format changed to match backend */
interface ReplayEvent {
    type: 'replay';
    dsn: string;
    sessionId: string;
    timestamp: string;
    events: DOMEvent[];
    environment: string;
}

declare const AllStak: {
    init(config: AllStakConfig): AllStakClient;
    captureException(error: Error, context?: Record<string, unknown>): void;
    addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void;
    clearBreadcrumbs(): void;
    /**
     * Capture a freeform message. By default routes to the **logs** stream
     * (so it shows up under "Logs" in the dashboard). For `error` / `fatal`
     * severities it ALSO writes to the errors stream so the message is visible
     * during incident triage. Override with `{ as: 'log' | 'error' | 'both' }`.
     */
    captureMessage(message: string, level?: "fatal" | "error" | "warning" | "info", options?: {
        as?: "log" | "error" | "both";
    }): void;
    /**
     * Report an HTTP request (inbound or outbound) to AllStak.
     * Batches internally and flushes every 5s or when 20 items accumulate.
     */
    captureRequest(item: HttpRequestItem): void;
    /**
     * Report a cron job execution to AllStak.
     * The slug must match a cron monitor configured in the AllStak dashboard.
     */
    heartbeat(options: HeartbeatOptions): void;
    /**
     * Access the database module for capturing DB query telemetry.
     */
    readonly database: DatabaseModule;
    /**
     * Report a database query to AllStak.
     * Batches internally and flushes every 5s or when 20 items accumulate.
     */
    captureDbQuery(item: DbQueryItem): void;
    readonly log: {
        debug: (message: string, meta?: Record<string, unknown>) => void;
        info: (message: string, meta?: Record<string, unknown>) => void;
        warn: (message: string, meta?: Record<string, unknown>) => void;
        error: (message: string, meta?: Record<string, unknown>) => void;
        fatal: (message: string, meta?: Record<string, unknown>) => void;
    };
    setUser(user: {
        id?: string;
        email?: string;
    }): void;
    setTag(key: string, value: string): void;
    getSessionId(): string;
    /**
     * Start a new span. Automatically parented to the current active span.
     * Call `span.finish()` when the operation completes.
     */
    startSpan(operation: string, options?: {
        description?: string;
        tags?: Record<string, string>;
    }): Span;
    /** Get the current trace ID (creates one if none exists). */
    getTraceId(): string;
    /** Set the trace ID explicitly (e.g. from an incoming request header). */
    setTraceId(traceId: string): void;
    /** Get the current active span ID, or null if no span is active. */
    getCurrentSpanId(): string | null;
    /** Reset trace context (trace ID and span stack). */
    resetTrace(): void;
    destroy(): void;
    /** @internal — exposed for testing */
    _getInstance(): AllStakClient | null;
};

export { AllStak, type AllStakConfig, type Breadcrumb, type DOMEvent, DatabaseModule, DbQueryItem, type ErrorEvent, type HeartbeatOptions, type HttpRequestItem, type LogEvent, type LogLevel, type ReplayEvent, Span, type SpanData };
