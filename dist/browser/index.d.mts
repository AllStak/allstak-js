import { D as DatabaseModule, a as DbQueryItem, T as TransportStats } from './database-BIg-JJj9.mjs';

interface HttpRequestItem {
    /** Unique trace identifier — generates one if not provided */
    traceId?: string;
    /** Unique request identifier — generates one if not provided */
    requestId?: string;
    /** 'inbound' = request arriving at this service; 'outbound' = request made to external service */
    direction: 'inbound' | 'outbound';
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
    host: string;
    path: string;
    statusCode: number;
    durationMs: number;
    requestSize?: number;
    responseSize?: number;
    requestBody?: string;
    responseBody?: string;
    requestHeaders?: Record<string, string>;
    responseHeaders?: Record<string, string>;
    requestBodyCaptureStatus?: string;
    responseBodyCaptureStatus?: string;
    requestBodyCaptureReason?: string;
    responseBodyCaptureReason?: string;
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

interface HttpBodyCaptureOptions {
    enabled?: boolean;
    maxBodySize?: number;
    contentTypes?: string[];
    redactFields?: string[];
}

/**
 * Per-call scoped context isolation.
 *
 * A `Scope` carries the same shape as the top-level config (user, tags,
 * extras, contexts, fingerprint, level) but only applies inside the
 * `withScope` callback that owns it. The client merges the active scope
 * stack on top of the base config when building each event payload, so:
 *
 *   - context set inside `withScope` does NOT leak out
 *   - nested scopes layer additively (later wins on key conflicts)
 *   - throwing or async work in the callback still pops the scope
 *
 * Use this on the server (SSR / RSC / API route handlers) to attach
 * per-request user/tags without leaking that data into another request
 * being processed concurrently.
 */
type Severity = 'fatal' | 'error' | 'warning' | 'info' | 'debug';
declare class Scope {
    user?: {
        id?: string;
        email?: string;
    };
    tags: Record<string, string>;
    extras: Record<string, unknown>;
    contexts: Record<string, Record<string, unknown>>;
    fingerprint?: string[];
    level?: Severity;
    setUser(user: {
        id?: string;
        email?: string;
    }): this;
    setTag(key: string, value: string): this;
    setTags(tags: Record<string, string>): this;
    setExtra(key: string, value: unknown): this;
    setExtras(extras: Record<string, unknown>): this;
    setContext(name: string, ctx: Record<string, unknown> | null): this;
    setLevel(level: Severity): this;
    setFingerprint(fingerprint: string[] | null): this;
    clear(): this;
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

/**
 * Release-tracking metadata. All fields are optional — the SDK auto-detects
 * sensible defaults from the runtime environment when possible:
 *
 * - `release`     ← `process.env.ALLSTAK_RELEASE`, then `npm_package_version`
 * - `commitSha`   ← `process.env.ALLSTAK_COMMIT_SHA`, `GIT_COMMIT`, `VERCEL_GIT_COMMIT_SHA`,
 *                   `RAILWAY_GIT_COMMIT_SHA`, `RENDER_GIT_COMMIT`
 * - `branch`      ← `process.env.ALLSTAK_BRANCH`, `GIT_BRANCH`, `VERCEL_GIT_COMMIT_REF`
 * - `dist`        ← (none — must be set explicitly when bundling multiple builds per release)
 * - `platform`    ← `'browser'` if `window` is defined, else `'node'`
 *
 * Explicit values in {@link AllStakConfig} always override auto-detection.
 */
interface ReleaseMetadata {
    /** Build distribution tag (e.g. `'ios'`, `'android'`, `'web'`). */
    dist?: string;
    /** Git commit SHA the running build was built from. */
    commitSha?: string;
    /** Git branch the running build was built from. */
    branch?: string;
    /** Runtime platform — auto-detected as `'browser'` or `'node'`. */
    platform?: string;
    /** SDK package name — defaults to `allstak-js`. */
    sdkName?: string;
    /** SDK semver — defaults to {@link SDK_VERSION}. */
    sdkVersion?: string;
}
interface ScreenshotArtifact {
    /** Data URL or base64-encoded image. Keep below `maxBytes`; oversized images are dropped. */
    data?: string;
    contentType?: 'image/png' | 'image/jpeg' | 'image/webp';
    width?: number;
    height?: number;
    sizeBytes?: number;
    redacted?: boolean;
    redactionStrategy?: string;
}
interface ScreenshotCaptureOptions {
    /** Off by default. Requires an explicit provider so the SDK does not add a heavy capture dependency. */
    enabled?: boolean;
    captureOnError?: boolean;
    timeoutMs?: number;
    maxBytes?: number;
    sampleRate?: number;
    provider?: (reason: {
        type: 'error';
        error: Error;
        traceId?: string;
        requestId?: string;
    }) => ScreenshotArtifact | null | undefined | Promise<ScreenshotArtifact | null | undefined>;
}
interface AllStakConfig extends ReleaseMetadata {
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
    /** Per-event extra data attached to every capture (override per call via context arg). */
    extras?: Record<string, unknown>;
    /** Named context bags (e.g. `app`, `device`). Each lives under `metadata['context.<name>']`. */
    contexts?: Record<string, Record<string, unknown>>;
    /** Default severity level for events that don't specify their own. */
    level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
    /** Custom grouping fingerprint applied to every event. */
    fingerprint?: string[];
    /**
     * Probability in [0, 1] that any given error is sent. Default: 1 (no sampling).
     * Applied per event before {@link beforeSend}.
     */
    sampleRate?: number;
    /**
     * Mutate or drop an event before it is sent. Return `null` (or a falsy
     * value) to drop. Sync or async. Errors thrown inside the hook are caught —
     * the original event is sent so a buggy hook can't black-hole telemetry.
     */
    beforeSend?: (event: any) => any | null | undefined | Promise<any | null | undefined>;
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
     * Privacy-first HTTP body capture. Disabled by default. When enabled, fetch
     * instrumentation captures only allowlisted content types, applies automatic
     * redaction, and truncates bodies to maxBodySize.
     */
    httpBodyCapture?: HttpBodyCaptureOptions;
    /**
     * Optional fail-open screenshot capture. The SDK never bundles a screenshot
     * library; customers provide an async provider (e.g. html2canvas wrapper)
     * and AllStak bounds timeout/size/sampling before adding metadata.
     */
    screenshot?: ScreenshotCaptureOptions;
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
    private scopeStack;
    constructor(config: AllStakConfig);
    private isNodeBuild;
    captureException(error: Error, context?: Record<string, unknown>): void;
    private withScopedConfig;
    withScope<T>(callback: (scope: Scope) => T): T;
    getCurrentScope(): Scope | null;
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
    /** Bulk-set tags. Merges with existing tags. */
    setTags(tags: Record<string, string>): void;
    /** Set a single extra value. */
    setExtra(key: string, value: unknown): void;
    /** Bulk-set extras. Merges with existing extras. */
    setExtras(extras: Record<string, unknown>): void;
    /**
     * Attach a named context bag (e.g. `app`, `device`, `runtime`) that appears
     * under `metadata['context.<name>']` on every subsequent event. Pass
     * `null` to remove a previously-set context.
     */
    setContext(name: string, ctx: Record<string, unknown> | null): void;
    /** Set the default severity level applied to subsequent captures. */
    setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void;
    /**
     * Set a custom grouping fingerprint applied to subsequent events.
     * Pass `null` or an empty array to clear and revert to default grouping.
     */
    setFingerprint(fingerprint: string[] | null): void;
    /**
     * Wait for the in-flight retry-buffer to drain. Resolves `true` if the
     * buffer empties within `timeoutMs` (default 2000ms), `false` otherwise.
     */
    flush(timeoutMs?: number): Promise<boolean>;
    /**
     * Phase 3 — runtime override of the SDK identity fields. Used by
     * platform-specific integrations (e.g. installReactNative) so the
     * resulting wire payload says `sdkName=allstak-react-native` and
     * carries an auto-detected `dist` such as `ios-hermes`.
     */
    setIdentity(identity: {
        sdkName?: string;
        sdkVersion?: string;
        platform?: string;
        dist?: string;
    }): void;
    getSessionId(): string;
    getTransportStats(): TransportStats;
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
    private shouldCaptureScreenshot;
    private withScreenshotMetadata;
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
    /** Phase 3 — runtime SDK-identity override (used by RN install). */
    setIdentity(identity: {
        sdkName?: string;
        sdkVersion?: string;
        platform?: string;
        dist?: string;
    }): void;
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
    setTags(tags: Record<string, string>): void;
    setExtra(key: string, value: unknown): void;
    setExtras(extras: Record<string, unknown>): void;
    setContext(name: string, ctx: Record<string, unknown> | null): void;
    setLevel(level: "fatal" | "error" | "warning" | "info" | "debug"): void;
    setFingerprint(fingerprint: string[] | null): void;
    /**
     * Wait for the in-flight retry-buffer to drain. Resolves `true` if the
     * buffer empties within `timeoutMs` (default 2000ms), `false` otherwise.
     */
    flush(timeoutMs?: number): Promise<boolean>;
    /**
     * Run `callback` with a fresh, temporary {@link Scope} that isolates any
     * user/tag/extra/context/fingerprint/level it sets. Pop is automatic for
     * sync, async, and throwing callbacks.
     */
    withScope<T>(callback: (scope: Scope) => T): T;
    getSessionId(): string;
    getTransportStats(): TransportStats;
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

export { AllStak, type AllStakConfig, type Breadcrumb, type DOMEvent, DatabaseModule, DbQueryItem, type ErrorEvent, type HeartbeatOptions, type HttpRequestItem, type LogEvent, type LogLevel, type ReplayEvent, Scope, type ScreenshotArtifact, type ScreenshotCaptureOptions, Span, type SpanData, TransportStats };
