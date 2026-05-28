import { HttpTransport, TransportStats } from './transport/http';
import { ErrorModule, ErrorEventProcessor, EventFilterPattern } from './modules/errors';
import { LogModule, LogLevel } from './modules/logs';
import { SessionReplayModule } from './modules/session-replay';
import { HttpRequestModule, HttpRequestItem } from './modules/http-requests';
import { CronModule, HeartbeatOptions } from './modules/cron';
import { TracingModule, Span, SpanData, SpanFilterPattern, SpanOptions, SpanProcessor, TracesSampler, SamplingContext } from './modules/tracing';
import { DatabaseModule, DbQueryItem } from './modules/database';
import { setTraceResolver } from './integrations/db/shared';
import { HttpBodyCaptureOptions, TracePropagationTarget } from './modules/auto-breadcrumbs';
import { generateId } from './utils/uuid';
import { registerRuntimeRelease } from './release-registration';
import { SessionTracker, isTestRuntime as isSessionTestRuntime } from './session';
import {
  AllStakIntegration,
  IntegrationIndex,
  IntegrationOption,
  getIntegrationsToSetup,
  setupIntegrations,
} from './integration';
import { getDefaultIntegrations } from './integrations/defaults';
import { detectGitRelease, GitRunner } from './release-detect';

/**
 * Single, static AllStak ingest host. Not customer-configurable in normal use:
 * customers should never have to know which URL their events go to. To point
 * the SDK at a different deployment (e.g. self-hosted), set the optional
 * {@link AllStakConfig#host} field.
 */
export const INGEST_HOST = 'https://api.allstak.sa';

/** SDK semver. Sent on the wire as `sdk.version` in event metadata. */
export const SDK_VERSION = '0.2.4';
/** SDK package name. Sent on the wire as `sdk.name`. */
export const SDK_NAME = 'allstak-js';

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
export interface ReleaseMetadata {
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

export interface ScreenshotArtifact {
  /** Data URL or base64-encoded image. Keep below `maxBytes`; oversized images are dropped. */
  data?: string;
  contentType?: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
  sizeBytes?: number;
  redacted?: boolean;
  redactionStrategy?: string;
}

export interface ScreenshotCaptureOptions {
  /** Off by default. Requires an explicit provider so the SDK does not add a heavy capture dependency. */
  enabled?: boolean;
  captureOnError?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  sampleRate?: number;
  provider?: (reason: { type: 'error'; error: Error; traceId?: string; requestId?: string }) =>
    | ScreenshotArtifact | null | undefined
    | Promise<ScreenshotArtifact | null | undefined>;
}

export interface AllStakConfig extends ReleaseMetadata {
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
  /**
   * Track release-health sessions ("one session per process / app-launch").
   * On init the SDK POSTs `/sessions/start`; on graceful shutdown it POSTs
   * `/sessions/end` with the final status (`ok`/`errored`/`crashed`). Sessions
   * are never sampled and tracking is fully fail-open. Default true. Set false
   * to opt out. Automatically skipped under a unit-test runtime.
   */
  enableAutoSessionTracking?: boolean;
  user?: { id?: string; email?: string };
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

interface ParsedConfig {
  baseUrl: string;
  apiKey: string;
}

/**
 * Read an env var safely. Returns `undefined` in browsers (where `process` is
 * not defined) and in any environment where the variable is unset/empty. We
 * never throw — release-metadata auto-detection is best-effort.
 */
function envVar(name: string): string | undefined {
  try {
    if (typeof process !== 'undefined' && process.env) {
      const v = process.env[name];
      if (v && v.length > 0) return v;
    }
  } catch {
    /* ignore */
  }
  return undefined;
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
export function applyReleaseAutodetect(config: AllStakConfig, gitRunner?: GitRunner | null): void {
  const isBrowser = typeof window !== 'undefined';
  if (!config.platform) config.platform = isBrowser ? 'browser' : 'node';
  if (!config.sdkName) config.sdkName = SDK_NAME;
  if (!config.sdkVersion) config.sdkVersion = SDK_VERSION;

  const autoDetect = config.autoDetectRelease !== false;

  if (!config.release) {
    // Steps 1 (explicit) handled by the `if (!config.release)` guard.
    // Step 2: conventional CI/runtime env vars.
    config.release =
      envVar('ALLSTAK_RELEASE') ??
      envVar('npm_package_version') ??
      envVar('VERCEL_GIT_COMMIT_SHA')?.slice(0, 12) ??
      envVar('RAILWAY_GIT_COMMIT_SHA')?.slice(0, 12) ??
      envVar('RENDER_GIT_COMMIT')?.slice(0, 12);
  }
  if (!config.release && autoDetect) {
    // Step 3: local git probe — NODE ONLY, fully guarded, runs once + cached.
    // In browsers/RN/edge `detectGitRelease` is a clean no-op (returns undefined).
    config.release = detectGitRelease(gitRunner);
  }
  if (!config.release && autoDetect) {
    // Step 4: never-empty fallback to the SDK version.
    config.release = config.sdkVersion ?? SDK_VERSION;
  }
  if (!config.commitSha) {
    config.commitSha =
      envVar('ALLSTAK_COMMIT_SHA') ??
      envVar('GIT_COMMIT') ??
      envVar('VERCEL_GIT_COMMIT_SHA') ??
      envVar('RAILWAY_GIT_COMMIT_SHA') ??
      envVar('RENDER_GIT_COMMIT');
  }
  if (!config.branch) {
    config.branch =
      envVar('ALLSTAK_BRANCH') ??
      envVar('GIT_BRANCH') ??
      envVar('VERCEL_GIT_COMMIT_REF') ??
      envVar('RAILWAY_GIT_BRANCH');
  }
  if (!config.environment) {
    config.environment = envVar('ALLSTAK_ENVIRONMENT') ?? envVar('NODE_ENV') ?? 'production';
  }
}

function resolveTransport(config: AllStakConfig): ParsedConfig {
  // New (recommended) shape: { apiKey, host? }
  if (config.apiKey) {
    return {
      apiKey: config.apiKey,
      baseUrl: (config.host ?? INGEST_HOST).replace(/\/$/, ''),
    };
  }
  // Backwards-compat: legacy DSN string
  if (config.dsn) {
    const url = new URL(config.dsn);
    const apiKey = decodeURIComponent(url.username);
    url.username = '';
    return { apiKey, baseUrl: url.origin };
  }
  throw new Error('AllStak: config.apiKey is required');
}

import { Scope, mergeScopes } from './scope';
export { Scope } from './scope';

interface AsyncScopeStorage {
  getStore(): Scope[] | undefined;
  run<T>(store: Scope[], callback: () => T): T;
}

declare const require: undefined | ((id: string) => { AsyncLocalStorage?: new () => AsyncScopeStorage });

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private errors: ErrorModule;
  private logs: LogModule;
  private httpRequests: HttpRequestModule;
  private cron: CronModule;
  private tracing: TracingModule;
  private _database: DatabaseModule;
  private baseUrl: string;
  private integrations: IntegrationIndex = {};
  private sessionReplay: SessionReplayModule | null = null;
  private sessionId: string;
  private sessionTracker: SessionTracker | null = null;
  private globalScopeStack: Scope[] = [];
  private asyncScopeStorage: AsyncScopeStorage | null = createAsyncScopeStorage();

  constructor(config: AllStakConfig) {
    applyReleaseAutodetect(config);
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = resolveTransport(config);
    this.baseUrl = baseUrl;
    this.transport = new HttpTransport(baseUrl, apiKey);
    if (config.autoRegisterRelease !== false) {
      registerRuntimeRelease({
        host: baseUrl,
        apiKey,
        release: config.release,
        environment: config.environment,
        commitSha: config.commitSha,
        branch: config.branch,
        service: config.tags?.service,
        enabled: config.autoRegisterRelease,
      });
    }

    // Auto-capture unhandled errors / rejections in Node. Browser auto-capture
    // is wired separately inside ErrorModule via window event listeners.
    if (config.autoNodeErrorCapture !== false && typeof process !== 'undefined' && typeof window === 'undefined') {
      this.installNodeErrorHandlers();
    }

    this.errors = new ErrorModule(this.transport, this.config, this.sessionId);
    this.logs = new LogModule(this.transport, this.config);
    this.httpRequests = new HttpRequestModule(this.transport);
    this.httpRequests.setDefaults({
      environment: config.environment,
      release: config.release,
    });
    this.cron = new CronModule(this.transport);
    this._database = new DatabaseModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment,
    });

    this.tracing = new TracingModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment,
      platform: config.platform,
      beforeSendSpan: config.beforeSendSpan,
      ignoreSpans: config.ignoreSpans,
      tracesSampleRate: config.tracesSampleRate,
      tracesSampler: config.tracesSampler,
    });

    const defaultIntegrations = config.defaultIntegrations === undefined
      ? getDefaultIntegrations()
      : config.defaultIntegrations;
    this.integrations = setupIntegrations(
      this,
      getIntegrationsToSetup({
        defaultIntegrations,
        integrations: config.integrations,
      }),
    );

    // Let DB integrations auto-populate traceId/spanId.
    setTraceResolver(() => ({
      traceId: this.tracing.getTraceId() ?? undefined,
      spanId: this.tracing.getCurrentSpanId() ?? undefined,
    }));

    if (
      typeof window !== 'undefined' &&
      config.sessionReplay?.enabled &&
      !this.isNodeBuild()
    ) {
      this.sessionReplay = new SessionReplayModule(
        this.transport,
        this.config,
        this.sessionId,
      );
    }

    // Release-health: one session per process / app-launch. Opt out via
    // enableAutoSessionTracking:false; automatically skipped under unit tests.
    if (config.enableAutoSessionTracking !== false && !isSessionTestRuntime()) {
      this.sessionTracker = new SessionTracker(this.config, this.transport, this.sessionId);
      // Browser autocapture sees unhandled errors inside ErrorModule; route
      // them to a crashed-session transition.
      this.errors.setOnUnhandled(() => this.sessionTracker?.recordCrash());
      this.sessionTracker.start();
    }
  }

  private isNodeBuild(): boolean {
    return typeof globalThis.__ALLSTAK_NODE__ !== 'undefined';
  }

  isNodeRuntime(): boolean {
    return this.isNodeBuild() || (typeof process !== 'undefined' && !!process.versions?.node);
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    // Release-health: a HANDLED captureException marks the session errored.
    // Node's uncaught/unhandledRejection handlers route through
    // installNodeErrorHandlers and mark the session crashed instead.
    this.sessionTracker?.recordError();
    const traceContext: Record<string, unknown> = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const requestId = this.tracing.getRequestId();
    if (requestId) traceContext.requestId = requestId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    this.withScopedConfig(() =>
      this.errors.captureException(error, { ...traceContext, ...context }),
    );
  }

  private withScopedConfig<T>(work: () => T): T {
    const stack = this.scopeStack();
    if (stack.length === 0) return work();
    const eff = mergeScopes(this.config, stack);
    const snap = {
      user: this.config.user,
      tags: this.config.tags,
      extras: (this.config as any).extras,
      contexts: (this.config as any).contexts,
      fingerprint: (this.config as any).fingerprint,
      level: (this.config as any).level,
    };
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    (this.config as any).extras = eff.extras;
    (this.config as any).contexts = eff.contexts;
    (this.config as any).fingerprint = eff.fingerprint;
    (this.config as any).level = eff.level;
    try { return work(); }
    finally {
      this.config.user = snap.user;
      this.config.tags = snap.tags;
      (this.config as any).extras = snap.extras;
      (this.config as any).contexts = snap.contexts;
      (this.config as any).fingerprint = snap.fingerprint;
      (this.config as any).level = snap.level;
    }
  }

  private scopeStack(): Scope[] {
    return this.asyncScopeStorage?.getStore() ?? this.globalScopeStack;
  }

  withScope<T>(callback: (scope: Scope) => T): T {
    const scope = new Scope();
    if (this.asyncScopeStorage) {
      const parent = this.scopeStack();
      return this.asyncScopeStorage.run([...parent, scope], () => callback(scope));
    }

    this.globalScopeStack.push(scope);
    let popped = false;
    const pop = () => { if (!popped) { popped = true; this.globalScopeStack.pop(); } };
    try {
      const result = callback(scope);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (v: any) => { pop(); return v; },
          (e: any) => { pop(); throw e; },
        );
      }
      pop();
      return result;
    } catch (err) {
      pop();
      throw err;
    }
  }

  getCurrentScope(): Scope | null {
    const stack = this.scopeStack();
    return stack[stack.length - 1] ?? null;
  }

  configureScope(callback: (scope: Scope) => void): void {
    const current = this.getCurrentScope();
    if (current) {
      callback(current);
      return;
    }
    const scope = new Scope();
    callback(scope);
    const eff = mergeScopes(this.config, [scope]);
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    this.config.extras = eff.extras;
    this.config.contexts = eff.contexts;
    this.config.fingerprint = eff.fingerprint;
    this.config.level = eff.level;
  }

  addBreadcrumb(
    typeOrCrumb: string | { type: string; message: string; level?: string; data?: Record<string, unknown> },
    message?: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    if (typeof typeOrCrumb === 'object') {
      this.errors.addBreadcrumb(typeOrCrumb.type, typeOrCrumb.message, typeOrCrumb.level, typeOrCrumb.data);
    } else {
      this.errors.addBreadcrumb(typeOrCrumb, message!, level, data);
    }
  }

  clearBreadcrumbs(): void {
    this.errors.clearBreadcrumbs();
  }

  addEventProcessor(processor: ErrorEventProcessor): void {
    this.errors.addEventProcessor(processor);
  }

  addSpanProcessor(processor: SpanProcessor): void {
    this.tracing.addSpanProcessor(processor);
  }

  onLogBreadcrumb(callback: Parameters<LogModule['setOnLogBreadcrumb']>[0]): void {
    this.logs.setOnLogBreadcrumb(callback);
  }

  onHttpRequestCaptured(callback: Parameters<HttpRequestModule['setOnCapture']>[0]): void {
    this.httpRequests.setOnCapture(callback);
  }

  addIntegration(integration: AllStakIntegration): void {
    const existing = this.integrations[integration.name];
    if (existing) return;
    this.integrations[integration.name] = integration;
    integration.setupOnce?.();
    integration.setup?.(this);
    if (integration.processEvent) {
      this.addEventProcessor((event) => integration.processEvent!(event, this));
    }
    if (integration.processSpan) {
      this.addSpanProcessor((span) => integration.processSpan!(span, this));
    }
  }

  getIntegration(name: string): AllStakIntegration | undefined {
    return this.integrations[name];
  }

  getOptions(): AllStakConfig {
    return this.config;
  }

  /**
   * Capture a freeform message. Routes to the **logs** ingest stream by default
   * (so messages appear in the dashboard's "Logs" view and don't pollute the
   * Errors view). For severities >= warning, it ALSO writes to errors so the
   * message is visible alongside real exceptions when triaging.
   *
   * Pass `{ as: 'error' }` to send only to the errors stream (preserves the
   * legacy behaviour for callers that need it).
   */
  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options: { as?: 'log' | 'error' | 'both'; data?: Record<string, unknown>; metadata?: Record<string, unknown> } = {},
  ): void {
    const as = options.as ?? (level === 'fatal' || level === 'error' ? 'both' : 'log');
    // Accept both `data` (per the historical public .d.ts) and `metadata`
    // (current SDK convention). Caller-supplied keys are redacted downstream
    // in logs.send + errors.captureMessage before reaching the wire.
    const callerMeta = options.metadata ?? options.data;
    if (as === 'log' || as === 'both') {
      // Map error->error, warning->warn, fatal->fatal, info->info
      const logLevel = (level === 'warning' ? 'warn' : level) as
        'debug' | 'info' | 'warn' | 'error' | 'fatal';
      this.logs.send(logLevel, message, callerMeta);
    }
    if (as === 'error' || as === 'both') {
      this.withScopedConfig(() => this.errors.captureMessage(message, level, { metadata: callerMeta }));
    }
  }

  /**
   * Report an HTTP request (inbound or outbound).
   * Batches internally and flushes every 5s or when 20 items accumulate.
   * Automatically attaches current traceId if not already set on the item.
   */
  captureRequest(item: HttpRequestItem): void {
    if (!item.traceId) {
      item.traceId = this.tracing.getTraceId();
    }
    if (!item.requestId) {
      item.requestId = this.tracing.getRequestId() ?? undefined;
    }
    if (!item.spanId) {
      item.spanId = this.tracing.getCurrentSpanId() ?? undefined;
    }
    this.httpRequests.capture(item);
  }

  /**
   * Access the database module for capturing DB query telemetry.
   */
  get database(): DatabaseModule {
    return this._database;
  }

  /**
   * Report a database query to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureDbQuery(item: DbQueryItem): void {
    this._database.capture(item);
  }

  /**
   * Report a cron job execution.
   * The cron monitor slug must match one configured in the AllStak dashboard.
   */
  heartbeat(options: HeartbeatOptions): void {
    this.cron.heartbeat(options);
  }

  get log() {
    const withTrace = (meta?: Record<string, unknown>): Record<string, unknown> => {
      const enriched: Record<string, unknown> = { ...meta };
      if (!enriched.traceId) {
        const traceId = this.tracing.getTraceId();
        if (traceId) enriched.traceId = traceId;
      }
      if (!enriched.spanId) {
        const spanId = this.tracing.getCurrentSpanId();
        if (spanId) enriched.spanId = spanId;
      }
      if (!enriched.requestId) {
        const requestId = this.tracing.getRequestId();
        if (requestId) enriched.requestId = requestId;
      }
      return enriched;
    };

    return {
      debug: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('debug', message, withTrace(meta)),
      info: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('info', message, withTrace(meta)),
      warn: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('warn', message, withTrace(meta)),
      error: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('error', message, withTrace(meta)),
      fatal: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('fatal', message, withTrace(meta)),
    };
  }

  get logger() {
    return this.log;
  }

  setUser(user: { id?: string; email?: string }): void {
    this.config.user = user;
  }

  setTag(key: string, value: string): void {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }

  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    if (!this.config.tags) this.config.tags = {};
    Object.assign(this.config.tags, tags);
  }

  /** Set a single extra value. */
  setExtra(key: string, value: unknown): void {
    if (!this.config.extras) this.config.extras = {};
    this.config.extras[key] = value;
  }

  /** Bulk-set extras. Merges with existing extras. */
  setExtras(extras: Record<string, unknown>): void {
    if (!this.config.extras) this.config.extras = {};
    Object.assign(this.config.extras, extras);
  }

  /**
   * Attach a named context bag (e.g. `app`, `device`, `runtime`) that appears
   * under `metadata['context.<name>']` on every subsequent event. Pass
   * `null` to remove a previously-set context.
   */
  setContext(name: string, ctx: Record<string, unknown> | null): void {
    if (!this.config.contexts) this.config.contexts = {};
    if (ctx === null) delete this.config.contexts[name];
    else this.config.contexts[name] = ctx;
  }

  /** Set the default severity level applied to subsequent captures. */
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void {
    this.config.level = level;
  }

  /**
   * Set a custom grouping fingerprint applied to subsequent events.
   * Pass `null` or an empty array to clear and revert to default grouping.
   */
  setFingerprint(fingerprint: string[] | null): void {
    this.config.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : undefined;
  }

  /**
   * Flush queued module batches and wait for in-flight transport work to
   * finish. Resolves `true` when telemetry drains within `timeoutMs`
   * (default 2000ms), `false` otherwise.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    this.httpRequests.flush();
    this._database.flush();
    this.tracing.flush();
    this.sessionReplay?.flush();
    return this.transport.flush(timeoutMs);
  }

  /**
   * Phase 3 — runtime override of the SDK identity fields. Used by
   * platform-specific integrations (e.g. installReactNative) so the
   * resulting wire payload says `sdkName=allstak-react-native` and
   * carries an auto-detected `dist` such as `ios-hermes`.
   */
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    if (identity.sdkName)    this.config.sdkName    = identity.sdkName
    if (identity.sdkVersion) this.config.sdkVersion = identity.sdkVersion
    if (identity.platform)   this.config.platform   = identity.platform
    if (identity.dist)       this.config.dist       = identity.dist
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getTransportStats(): TransportStats {
    return this.transport.getStats();
  }

  // ------------------------------------------------------------------
  // Distributed Tracing
  // ------------------------------------------------------------------

  /**
   * Start a new span. Automatically parented to the current active span.
   * Call `span.finish()` when the operation completes.
   */
  startSpan(
    operation: string,
    options?: SpanOptions,
  ): Span {
    return this.tracing.startSpan(operation, options);
  }

  /**
   * AllStak-style helper: creates a span, runs the callback, then finishes the
   * span automatically. Async callbacks are supported, and thrown/rejected
   * errors mark the span as failed before being rethrown.
   */
  trace<T>(
    operation: string,
    callback: (span: Span) => T,
    options?: SpanOptions,
  ): T {
    const span = this.tracing.startSpan(operation, options);
    let finished = false;
    const finish = (status: 'ok' | 'error') => {
      if (!finished) {
        finished = true;
        span.finish(status);
      }
    };

    try {
      const result = callback(span);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (value: any) => {
            finish('ok');
            return value;
          },
          (error: any) => {
            finish('error');
            throw error;
          },
        );
      }
      finish('ok');
      return result;
    } catch (error) {
      finish('error');
      throw error;
    }
  }

  /** @internal Used by server framework integrations to isolate request tracing. */
  withTraceContext<T>(traceId: string | undefined, callback: () => T): T;
  withTraceContext<T>(traceId: string | undefined, requestId: string | undefined, callback: () => T): T;
  withTraceContext<T>(
    traceId: string | undefined,
    requestIdOrCallback: string | undefined | (() => T),
    maybeCallback?: () => T,
  ): T {
    if (typeof requestIdOrCallback === 'function') {
      return this.tracing.withTraceContext(traceId, requestIdOrCallback);
    }
    return this.tracing.withTraceContext(traceId, requestIdOrCallback, maybeCallback!);
  }

  /** Get the current trace ID (creates one if none exists). */
  getTraceId(): string {
    return this.tracing.getTraceId();
  }

  /** Get the current request ID, when inside a server framework request context. */
  getRequestId(): string | null {
    return this.tracing.getRequestId();
  }

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    this.tracing.setTraceId(traceId);
  }

  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId(): string | null {
    return this.tracing.getCurrentSpanId();
  }

  /**
   * The sticky head-of-trace sampling decision for the current trace. Drives
   * the propagated `traceparent` sampled flag. Returns `true` when no decision
   * has been forced yet (back-compat: always-sampled).
   */
  getTraceSampled(): boolean {
    return this.tracing.getSampled();
  }

  /**
   * Record the sampling decision inherited from an incoming `traceparent`, so
   * a configured {@link AllStakConfig.tracesSampler} can honor `parentSampled`.
   * @internal Used by server framework integrations.
   */
  setParentSampled(parentSampled: boolean | undefined): void {
    this.tracing.setParentSampled(parentSampled);
  }

  /** Reset trace context (trace ID and span stack). */
  resetTrace(): void {
    this.tracing.resetTrace();
  }

  destroy(): void {
    // End the release-health session (graceful shutdown / dispose) before
    // tearing down transport-backed modules. Best-effort + fail-open.
    this.sessionTracker?.end();
    setTraceResolver(null);
    this.tracing.destroy();
    this.errors.destroy();
    this.httpRequests.destroy();
    this._database.destroy();
    this.sessionReplay?.destroy();
    this.uninstallNodeErrorHandlers();
  }

  private shouldCaptureScreenshot(): boolean {
    const screenshot = this.config.screenshot;
    if (!screenshot?.enabled || screenshot.captureOnError === false || !screenshot.provider) {
      return false;
    }
    const sampleRate = screenshot.sampleRate ?? 1;
    return !(sampleRate <= 0 || (sampleRate < 1 && Math.random() >= sampleRate));
  }

  private async withScreenshotMetadata(error: Error, context: Record<string, unknown>): Promise<Record<string, unknown>> {
    const screenshot = this.config.screenshot;
    if (!screenshot?.provider) return { ...context, 'screenshot.status': 'unsupported' };
    const timeoutMs = Math.max(100, Math.min(screenshot.timeoutMs ?? 1500, 5000));
    const maxBytes = Math.max(1024, screenshot.maxBytes ?? 200_000);
    const traceId = typeof context.traceId === 'string' ? context.traceId : undefined;
    const requestId = typeof context.requestId === 'string' ? context.requestId : undefined;

    try {
      const artifact = await Promise.race([
        Promise.resolve(screenshot.provider({ type: 'error', error, traceId, requestId })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!artifact) return { ...context, 'screenshot.status': 'timeout_or_empty' };
      const size = artifact.sizeBytes ?? byteSize(artifact.data);
      if (size > maxBytes) {
        this.transport.noteDropped();
        return { ...context, 'screenshot.status': 'dropped_too_large', 'screenshot.sizeBytes': size };
      }
      return {
        ...context,
        'screenshot.status': 'captured',
        'screenshot.contentType': artifact.contentType,
        'screenshot.width': artifact.width,
        'screenshot.height': artifact.height,
        'screenshot.sizeBytes': size,
        'screenshot.redacted': artifact.redacted ?? false,
        'screenshot.redactionStrategy': artifact.redactionStrategy,
        ...(artifact.data ? { 'screenshot.data': artifact.data } : {}),
      };
    } catch {
      return { ...context, 'screenshot.status': 'failed' };
    }
  }

  // ─── Node uncaughtException / unhandledRejection auto-capture ─────
  private nodeUncaughtHandler: ((err: Error) => void) | null = null;
  private nodeRejectionHandler: ((reason: unknown) => void) | null = null;

  private installNodeErrorHandlers(): void {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }
    this.nodeUncaughtHandler = (err: Error) => {
      const e = err instanceof Error ? err : new Error(String(err));
      try {
        // Unhandled/fatal → crashed (terminal, overrides errored).
        this.sessionTracker?.recordCrash();
        this.errors.captureException(e, { source: 'uncaughtException' });
      } catch {
        /* never break the host process */
      }
      this.uninstallNodeErrorHandlers();
      throw e;
    };
    this.nodeRejectionHandler = (reason: unknown) => {
      const e = reason instanceof Error ? reason : new Error(String(reason));
      try {
        // Unhandled/fatal → crashed (terminal, overrides errored).
        this.sessionTracker?.recordCrash();
        this.errors.captureException(e, { source: 'unhandledRejection' });
      } catch {
        /* never break the host process */
      }
      this.uninstallNodeErrorHandlers();
      setTimeout(() => {
        throw e;
      }, 0);
    };
    process.on('uncaughtException', this.nodeUncaughtHandler);
    process.on('unhandledRejection', this.nodeRejectionHandler);
  }

  private uninstallNodeErrorHandlers(): void {
    if (typeof process === 'undefined' || typeof process.off !== 'function') {
      return;
    }
    if (this.nodeUncaughtHandler) {
      process.off('uncaughtException', this.nodeUncaughtHandler);
      this.nodeUncaughtHandler = null;
    }
    if (this.nodeRejectionHandler) {
      process.off('unhandledRejection', this.nodeRejectionHandler);
      this.nodeRejectionHandler = null;
    }
  }
}

function createAsyncScopeStorage(): AsyncScopeStorage | null {
  const proc = (globalThis as any).process;
  if (typeof globalThis.__ALLSTAK_NODE__ === 'undefined' && !proc?.versions?.node) return null;
  try {
    const fromProcess = proc?.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof require === 'function' ? require : undefined;
    const AsyncLocalStorage = req?.('node:async_hooks').AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

// Re-export for module consumers
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';
export type { LogLevel } from './modules/logs';
export type { SpanData, TracesSampler, SamplingContext } from './modules/tracing';
export { Span } from './modules/tracing';
export type { DbQueryItem } from './modules/database';
export { DatabaseModule } from './modules/database';

declare global {
  // eslint-disable-next-line no-var
  var __ALLSTAK_NODE__: boolean | undefined;
}

function byteSize(value?: string): number {
  if (!value) return 0;
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  } catch {
    /* ignore */
  }
  return value.length;
}
