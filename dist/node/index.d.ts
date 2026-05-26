import { H as HttpTransport, D as DatabaseModule, a as DbQueryItem, T as TransportStats } from './database-DMxZg38h.js';
import { H as HttpBodyCaptureOptions, T as TracePropagationTarget } from './auto-breadcrumbs-DRB0ieVv.js';

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
interface ErrorRequestContext {
    method?: string;
    path?: string;
    host?: string;
    route?: string;
    query?: string;
    statusCode?: number;
    durationMs?: number;
    userAgent?: string;
}
/**
 * v2 frame shape — matches backend {@code ErrorIngestRequest.Frame}.
 * Sent alongside the legacy `stackTrace` string list so older backends
 * keep working unchanged; new backends prefer `frames` when present.
 */
interface PayloadFrame {
    filename?: string;
    absPath?: string;
    function?: string;
    lineno?: number;
    colno?: number;
    inApp?: boolean;
    platform?: string;
    debugId?: string;
}
interface PayloadDebugImage {
    type?: string;
    debugId?: string;
    codeFile?: string;
    imageAddr?: string;
}
interface ErrorIngestPayload {
    exceptionClass: string;
    message: string;
    stackTrace?: string[];
    frames?: PayloadFrame[];
    debugMeta?: {
        images?: PayloadDebugImage[];
    };
    platform?: string;
    sdkName?: string;
    sdkVersion?: string;
    dist?: string;
    level: string;
    environment?: string;
    release?: string;
    sessionId?: string;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    requestId?: string;
    replayId?: string;
    service?: string;
    user?: {
        id?: string;
        email?: string;
        ip?: string;
    };
    metadata?: Record<string, unknown>;
    breadcrumbs?: Breadcrumb[];
    requestContext?: ErrorRequestContext;
    fingerprint?: string[];
}
type EventFilterPattern = string | RegExp;
type ErrorEventProcessor = (event: ErrorIngestPayload) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;

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
type OnLogBreadcrumb = (level: LogLevel, message: string) => void;
declare class LogModule {
    private transport;
    private config;
    private onLogBreadcrumb;
    constructor(transport: HttpTransport, config: AllStakConfig);
    /**
     * Register a callback for auto-breadcrumbs on warn/error/fatal logs.
     */
    setOnLogBreadcrumb(cb: OnLogBreadcrumb): void;
    send(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}

interface HttpRequestItem {
    /** Unique trace identifier — generates one if not provided */
    traceId?: string;
    /** Unique request identifier — generates one if not provided */
    requestId?: string;
    /** Current span id for this HTTP request */
    spanId?: string;
    /** Parent span id when available */
    parentSpanId?: string;
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
    requestHeaders?: Record<string, string> | string;
    responseHeaders?: Record<string, string> | string;
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
type OnCaptureBreadcrumb = (item: HttpRequestItem) => void;
declare class HttpRequestModule {
    private transport;
    private queue;
    private flushTimer;
    private onCapture;
    private defaults;
    constructor(transport: HttpTransport);
    /** Apply environment / release tags to every captured request. */
    setDefaults(defaults: {
        environment?: string;
        release?: string;
    }): void;
    /**
     * Register a callback invoked on every capture(), used for auto-breadcrumbs.
     */
    setOnCapture(cb: OnCaptureBreadcrumb): void;
    /**
     * Report an HTTP request (inbound or outbound) to AllStak.
     * Batches internally and flushes every 5s or when 20 items accumulate.
     */
    capture(item: HttpRequestItem): void;
    flush(): void;
    destroy(): void;
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
    op?: string;
    platform?: string;
    measurements?: Record<string, number>;
    attributes?: Record<string, string>;
}
interface SpanOptions {
    description?: string;
    tags?: Record<string, string>;
    attributes?: Record<string, string>;
    measurements?: Record<string, number>;
    op?: string;
    platform?: string;
}
type SpanProcessor = (span: SpanData) => SpanData | null | undefined;
type SpanFilterPattern = string | RegExp | ((span: SpanData) => boolean);
/**
 * Context passed to {@link AllStakConfig.tracesSampler} when deciding whether a
 * trace is sampled. The decision is made once, at the root of a trace, and
 * inherited by all child spans (W3C sticky head-of-trace).
 */
interface SamplingContext {
    /** Operation name of the root span starting this trace. */
    name: string;
    /**
     * Sampling decision inherited from an incoming `traceparent`, if any.
     * `true`/`false` when a parent decision was propagated in, otherwise
     * `undefined` (this service is the head of the trace).
     */
    parentSampled?: boolean;
    /** Attributes/tags supplied to the root span. */
    attributes: Record<string, string>;
}
/**
 * Function form of traces sampling. Receives the {@link SamplingContext} and
 * returns either a boolean (sampled / not) or a number in [0, 1] used as the
 * probability of sampling this trace.
 */
type TracesSampler = (context: SamplingContext) => number | boolean;
declare global {
    var __ALLSTAK_NODE__: boolean | undefined;
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
    private _attributes;
    private _measurements;
    private _op?;
    private _platform?;
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
        attributes: Record<string, string>;
        measurements: Record<string, number>;
        op?: string;
        platform?: string;
        startTimeMillis: number;
        onFinish: (spanData: SpanData) => void;
    });
    /** Set a tag on this span. */
    setTag(key: string, value: string): this;
    /** Set a queryable span attribute. */
    setAttribute(key: string, value: string): this;
    /** Set a numeric span measurement. */
    setMeasurement(key: string, value: number): this;
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

interface AllStakIntegration {
    name: string;
    setupOnce?: () => void;
    setup?: (client: AllStakClient) => void;
    processEvent?: (event: ErrorIngestPayload, client: AllStakClient) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;
    processSpan?: (span: SpanData, client: AllStakClient) => SpanData | null | undefined;
    isDefaultInstance?: boolean;
}
type IntegrationIndex = Record<string, AllStakIntegration>;
type IntegrationFactory<Args extends unknown[] = unknown[]> = (...args: Args) => AllStakIntegration;
type IntegrationOption = AllStakIntegration[] | ((defaultIntegrations: AllStakIntegration[]) => AllStakIntegration | AllStakIntegration[]);
declare function defineIntegration<Fn extends IntegrationFactory>(factory: Fn): Fn;

/**
 * Local-git RUNTIME release auto-detection (no CI/CD required).
 *
 * This module provides a *pure*, testable parse layer plus a fully-guarded
 * Node-only git runner. It is consumed by `applyReleaseAutodetect` in
 * `client.ts` as the step that sits *below* explicit config and env-var
 * detection, and *above* the SDK-version fallback.
 *
 * Resolution order for `release` (highest priority first):
 *   1. Explicit `config.release`            — always wins (handled in client.ts).
 *   2. Env vars (ALLSTAK_RELEASE, VERCEL_GIT_COMMIT_SHA, …) — handled in client.ts.
 *   3. Local git at init (NODE ONLY)        — this module, `detectGitRelease`.
 *   4. SDK version constant                 — never-empty fallback (client.ts).
 *
 * CRITICAL — environment safety: steps 3 must NEVER run or throw in a browser,
 * React Native, edge, or any non-Node runtime (there is no `child_process`
 * there). We detect Node via `typeof process`, `process.versions?.node`, and a
 * *guarded dynamic* require of `child_process`. The require is intentionally
 * NOT a static `import` so browser/RN bundlers do not try to resolve it.
 */
/** A function that runs a git command and returns its trimmed stdout (or '' / throws on failure). */
type GitRunner = (args: string[]) => string;
/**
 * Parse raw git output into a release string. PURE — no I/O, no spawning. This
 * is the seam tests target so they never need a real repo or to spawn git.
 *
 * @param describeOut Output of `git describe --tags --always --dirty` (preferred).
 * @param revParseOut Output of `git rev-parse --short HEAD` (fallback).
 * @param porcelainOut Output of `git status --porcelain` (used to add `-dirty`
 *                     to the rev-parse fallback when the working tree is dirty).
 * @returns A trimmed release string, or `undefined` when nothing usable was found.
 */
declare function parseGitRelease(describeOut: string | undefined, revParseOut?: string | undefined, porcelainOut?: string | undefined): string | undefined;
/**
 * Is the current runtime a Node-like environment that *could* spawn git?
 * Returns false in browsers, React Native, Deno-without-node-compat, edge, etc.
 */
declare function isNodeRuntime(): boolean;
/**
 * Detect a release string from the local git repo at init time. NODE ONLY and
 * fully guarded: in a browser / React Native / edge runtime, or when git / the
 * `.git` dir / `child_process` is unavailable, this returns `undefined`
 * silently. Runs at most once per process; the result is cached.
 *
 * @param runner Optional injected git runner (test seam). When omitted, a
 *               guarded Node runner is created — and is `null` off-Node.
 */
declare function detectGitRelease(runner?: GitRunner | null): string | undefined;

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

/**
 * Release-tracking metadata. All fields are optional — the SDK auto-detects
 * sensible defaults from the runtime environment when possible:
 *
 * - `release`     ← `process.env.ALLSTAK_RELEASE`, then `npm_package_version`,
 *                   then (NODE ONLY, opt-out via `autoDetectRelease: false`)
 *                   the local git repo (`git describe`/`rev-parse`), then the
 *                   {@link SDK_VERSION} constant so it is never empty
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
    /**
     * Auto-detect `release` (and the never-empty version fallback) when it is not
     * set explicitly or via env vars. Default: `true`. On Node this additionally
     * probes the local git repo at init (`git describe`/`rev-parse`); in
     * browsers/React Native the git step is a no-op and detection falls through
     * to the SDK-version fallback. Set `false` to disable the git probe AND the
     * version fallback (release may then be left empty).
     */
    autoDetectRelease?: boolean;
    /**
     * Register the resolved release with AllStak from the server runtime at SDK
     * init, without requiring a CI/CD hook. Default true. Browser runtimes are
     * skipped to avoid one release-registration request per visitor.
     */
    autoRegisterRelease?: boolean;
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
    /**
     * AllStak-style event processors. Each processor can mutate an error event or
     * return null to drop it before `beforeSend`.
     */
    eventProcessors?: ErrorEventProcessor[];
    /** Drop errors whose message or exception class matches any pattern. */
    ignoreErrors?: EventFilterPattern[];
    /** Only send errors whose last useful stack frame URL matches one of these patterns. */
    allowUrls?: EventFilterPattern[];
    /** Drop errors whose last useful stack frame URL matches one of these patterns. */
    denyUrls?: EventFilterPattern[];
    /** Disable the built-in browser-noise ignore list. Default: false. */
    disableDefaultIgnoreErrors?: boolean;
    /** Drop consecutive duplicate error/message events. Default: true. */
    dedupe?: boolean;
    /**
     * Mutate or drop spans before they are batched. Return null to drop.
     */
    beforeSendSpan?: SpanProcessor;
    /**
     * Drop spans matching an operation/description pattern or predicate.
     */
    ignoreSpans?: SpanFilterPattern[];
    /**
     * Probability in [0, 1] that any given trace is sampled (recorded + sent).
     * The decision is made ONCE at the root span and inherited by every child
     * span in the trace (W3C sticky head-of-trace), and it drives the propagated
     * `traceparent` sampled flag (`-01` sampled / `-00` not).
     *
     * BACK-COMPAT DEFAULT: when neither {@link tracesSampleRate} nor
     * {@link tracesSampler} is set, tracing stays fully on (every trace sampled)
     * and propagation advertises `-01`, matching the SDK's historical behavior.
     * Setting this to `0` disables trace recording; `1` records everything.
     */
    tracesSampleRate?: number;
    /**
     * Function form of traces sampling. Receives a {@link SamplingContext}
     * (`name`, `parentSampled`, `attributes`) and returns a boolean or a number
     * in [0, 1]. Takes precedence over {@link tracesSampleRate} when set. A
     * throwing sampler fails open (the trace is sampled).
     */
    tracesSampler?: TracesSampler;
    /**
     * Default integrations. Set false to disable all built-in integrations, or
     * provide a replacement list.
     */
    defaultIntegrations?: boolean | AllStakIntegration[];
    /**
     * Additional integrations, or a function that receives defaults and returns
     * the final integration list.
     */
    integrations?: IntegrationOption;
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
     * Limit distributed-tracing header propagation to matching URLs.
     * Empty/undefined means all non-AllStak ingest requests are eligible.
     */
    tracePropagationTargets?: TracePropagationTarget[];
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
/**
 * Apply release-metadata auto-detection to a config object, mutating it in
 * place. Explicit user values always win. Auto-detected values come from
 * conventional CI/runtime env vars (Vercel, Railway, Render, plain GIT_*),
 * then — when `autoDetectRelease !== false` — the local git repo (Node only)
 * and finally the SDK version constant so `release` is never empty.
 *
 * @param config The config to mutate.
 * @param gitRunner Test seam: an injected git runner. When omitted, a guarded
 *                  Node-only runner is used (and is a no-op off-Node). Pass
 *                  `null` to force-skip the git probe.
 */
declare function applyReleaseAutodetect(config: AllStakConfig, gitRunner?: GitRunner | null): void;

declare class AllStakClient {
    private transport;
    private config;
    private errors;
    private logs;
    private httpRequests;
    private cron;
    private tracing;
    private _database;
    private baseUrl;
    private integrations;
    private sessionReplay;
    private sessionId;
    private globalScopeStack;
    private asyncScopeStorage;
    constructor(config: AllStakConfig);
    private isNodeBuild;
    isNodeRuntime(): boolean;
    getBaseUrl(): string;
    captureException(error: Error, context?: Record<string, unknown>): void;
    private withScopedConfig;
    private scopeStack;
    withScope<T>(callback: (scope: Scope) => T): T;
    getCurrentScope(): Scope | null;
    configureScope(callback: (scope: Scope) => void): void;
    addBreadcrumb(typeOrCrumb: string | {
        type: string;
        message: string;
        level?: string;
        data?: Record<string, unknown>;
    }, message?: string, level?: string, data?: Record<string, unknown>): void;
    clearBreadcrumbs(): void;
    addEventProcessor(processor: ErrorEventProcessor): void;
    addSpanProcessor(processor: SpanProcessor): void;
    onLogBreadcrumb(callback: Parameters<LogModule['setOnLogBreadcrumb']>[0]): void;
    onHttpRequestCaptured(callback: Parameters<HttpRequestModule['setOnCapture']>[0]): void;
    addIntegration(integration: AllStakIntegration): void;
    getIntegration(name: string): AllStakIntegration | undefined;
    getOptions(): AllStakConfig;
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
        data?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
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
    get logger(): {
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
     * Flush queued module batches and wait for in-flight transport work to
     * finish. Resolves `true` when telemetry drains within `timeoutMs`
     * (default 2000ms), `false` otherwise.
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
    startSpan(operation: string, options?: SpanOptions): Span;
    /**
     * AllStak-style helper: creates a span, runs the callback, then finishes the
     * span automatically. Async callbacks are supported, and thrown/rejected
     * errors mark the span as failed before being rethrown.
     */
    trace<T>(operation: string, callback: (span: Span) => T, options?: SpanOptions): T;
    /** @internal Used by server framework integrations to isolate request tracing. */
    withTraceContext<T>(traceId: string | undefined, callback: () => T): T;
    withTraceContext<T>(traceId: string | undefined, requestId: string | undefined, callback: () => T): T;
    /** Get the current trace ID (creates one if none exists). */
    getTraceId(): string;
    /** Get the current request ID, when inside a server framework request context. */
    getRequestId(): string | null;
    /** Set the trace ID explicitly (e.g. from an incoming request header). */
    setTraceId(traceId: string): void;
    /** Get the current active span ID, or null if no span is active. */
    getCurrentSpanId(): string | null;
    /**
     * The sticky head-of-trace sampling decision for the current trace. Drives
     * the propagated `traceparent` sampled flag. Returns `true` when no decision
     * has been forced yet (back-compat: always-sampled).
     */
    getTraceSampled(): boolean;
    /**
     * Record the sampling decision inherited from an incoming `traceparent`, so
     * a configured {@link AllStakConfig.tracesSampler} can honor `parentSampled`.
     * @internal Used by server framework integrations.
     */
    setParentSampled(parentSampled: boolean | undefined): void;
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

interface RegisterRuntimeReleaseOptions {
    host: string;
    apiKey: string;
    release?: string;
    environment?: string;
    commitSha?: string;
    branch?: string;
    service?: string;
    enabled?: boolean;
    fetchImpl?: typeof fetch;
}
declare function canRegisterRuntimeRelease(): boolean;
declare function registerRuntimeRelease(options: RegisterRuntimeReleaseOptions): void;
/** @internal */
declare function _resetRuntimeReleaseRegistrationForTest(): void;

declare const eventFiltersIntegration: () => {
    name: string;
    processEvent(event: ErrorIngestPayload, client: AllStakClient): ErrorIngestPayload | null;
};
declare const inboundFiltersIntegration: () => {
    name: string;
    processEvent(event: ErrorIngestPayload, client: AllStakClient): ErrorIngestPayload | null;
};

declare const dedupeIntegration: () => {
    name: string;
    processEvent(event: ErrorIngestPayload, client: AllStakClient): ErrorIngestPayload | null;
};

declare const consoleIntegration: () => {
    name: string;
    setup(client: AllStakClient): void;
};

declare const httpClientIntegration: () => {
    name: string;
    setup(client: AllStakClient): void;
};

declare const databaseIntegration: () => {
    name: string;
    setup(client: AllStakClient): void;
};

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
    addBreadcrumb(typeOrCrumb: string | {
        type: string;
        message: string;
        level?: string;
        data?: Record<string, unknown>;
    }, message?: string, level?: string, data?: Record<string, unknown>): void;
    clearBreadcrumbs(): void;
    addEventProcessor(processor: ErrorEventProcessor): void;
    addSpanProcessor(processor: SpanProcessor): void;
    addIntegration(integration: AllStakIntegration): void;
    getIntegration(name: string): AllStakIntegration | undefined;
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
        data?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
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
    readonly logger: {
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
     * Flush queued module batches and wait for in-flight transport work to drain.
     * Resolves `true` if telemetry drains within `timeoutMs` (default 2000ms),
     * `false` otherwise.
     */
    flush(timeoutMs?: number): Promise<boolean>;
    /**
     * Run `callback` with a fresh, temporary {@link Scope} that isolates any
     * user/tag/extra/context/fingerprint/level it sets. Pop is automatic for
     * sync, async, and throwing callbacks.
     */
    withScope<T>(callback: (scope: Scope) => T): T;
    getCurrentScope(): Scope | null;
    configureScope(callback: (scope: Scope) => void): void;
    getSessionId(): string;
    getTransportStats(): TransportStats;
    /**
     * Start a new span. Automatically parented to the current active span.
     * Call `span.finish()` when the operation completes.
     */
    startSpan(operation: string, options?: SpanOptions): Span;
    /**
     * Run a sync or async function inside a span and finish it automatically.
     */
    trace<T>(operation: string, callback: (span: Span) => T, options?: SpanOptions): T;
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

export { AllStak, type AllStakConfig, type AllStakIntegration, type Breadcrumb, type DOMEvent, DatabaseModule, DbQueryItem, type ErrorEvent, type ErrorEventProcessor, type ErrorIngestPayload, type EventFilterPattern, type GitRunner, type HeartbeatOptions, type HttpRequestItem, type IntegrationIndex, type IntegrationOption, type LogEvent, type LogLevel, type RegisterRuntimeReleaseOptions, type ReplayEvent, type SamplingContext, Scope, type ScreenshotArtifact, type ScreenshotCaptureOptions, Span, type SpanData, type SpanFilterPattern, type SpanOptions, type SpanProcessor, type TracesSampler, TransportStats, _resetRuntimeReleaseRegistrationForTest, applyReleaseAutodetect, canRegisterRuntimeRelease, consoleIntegration, databaseIntegration, dedupeIntegration, AllStak as default, defineIntegration, detectGitRelease, eventFiltersIntegration, httpClientIntegration, inboundFiltersIntegration, isNodeRuntime, parseGitRelease, registerRuntimeRelease };
