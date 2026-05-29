import { HttpTransport } from '../transport/http';
import { AllStakConfig, SDK_NAME, SDK_VERSION } from '../client';
import { parseStack } from '../utils/stack';
import { resolveDebugId } from '../utils/debug-id';
import { redactObject, scrubStringValue, ValueScrubOptions } from '../utils/redact';

export interface ErrorEvent {
  type: 'error';
  dsn: string;
  timestamp: string;
  level: 'fatal' | 'error' | 'warning' | 'info';
  message: string;
  stack?: string;
  environment: string;
  release?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  context?: Record<string, unknown>;
}

export interface Breadcrumb {
  timestamp: string;
  type: string;
  message: string;
  level: string;
  data?: Record<string, unknown>;
}

// Matches backend ErrorIngestRequest DTO
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

export interface ErrorIngestPayload {
  exceptionClass: string;
  message: string;
  stackTrace?: string[];
  // ── v2 ingest fields (additive, optional) ─────────────────────
  frames?: PayloadFrame[];
  debugMeta?: { images?: PayloadDebugImage[] };
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
  user?: { id?: string; email?: string; ip?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  requestContext?: ErrorRequestContext;
  fingerprint?: string[];
}

export type EventFilterPattern = string | RegExp;
export type ErrorEventProcessor =
  (event: ErrorIngestPayload) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;

/**
 * Detect the runtime so the SDK can stamp `platform` even when the
 * customer hasn't configured it explicitly. React Native is identified
 * by Hermes' global, browser by `window`, otherwise Node.
 */
function detectPlatform(): string {
  if (typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== 'undefined') return 'react-native';
  if (typeof window !== 'undefined') return 'browser';
  return 'node';
}

/**
 * Render a structured frame back to a `"at fn (file:line:col)"` line so
 * older backends that only look at `stackTrace[]` still get a useful
 * representation. Coordinates match what V8 would have printed.
 */
function frameToString(f: PayloadFrame): string {
  const fn = f.function && f.function.length > 0 ? f.function : '<anonymous>';
  const file = f.filename || f.absPath || '<anonymous>';
  const line = typeof f.lineno === 'number' ? f.lineno : 0;
  const col = typeof f.colno === 'number' ? f.colno : 0;
  return `    at ${fn} (${file}:${line}:${col})`;
}

function browserRequestContext(): ErrorRequestContext | undefined {
  if (typeof window === 'undefined' || typeof location === 'undefined') return undefined;
  return {
    method: 'GET',
    path: location.pathname || '/',
    host: location.host || '',
    query: location.search || undefined,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  };
}

function runtimeMetadata(platform: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    'runtime.platform': platform,
  };

  if (typeof process !== 'undefined' && process.versions?.node) {
    out['runtime.name'] = 'node';
    out['runtime.version'] = process.versions.node;
    out['node.version'] = process.version;
    out['node.arch'] = process.arch;
    out['os.name'] = process.platform;
    out['os.arch'] = process.arch;
    if (typeof process.pid === 'number') out['process.pid'] = process.pid;
    if (typeof process.title === 'string' && process.title) out['process.title'] = process.title;
  } else if (typeof navigator !== 'undefined') {
    out['runtime.name'] = 'browser';
    out['browser.userAgent'] = navigator.userAgent;
    out['browser.language'] = navigator.language;
    if (typeof navigator.platform === 'string' && navigator.platform) out['os.name'] = navigator.platform;
  }

  if (typeof window !== 'undefined' && typeof location !== 'undefined') {
    out['url'] = location.href;
    out['request.url'] = location.href;
  }

  return out;
}

function requestContextFromContext(context?: Record<string, unknown>): ErrorRequestContext | undefined {
  const raw = context?.requestContext;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>;
    return compactRequestContext({
      method: stringValue(r.method),
      path: stringValue(r.path),
      host: stringValue(r.host),
      route: stringValue(r.route),
      query: stringValue(r.query),
      statusCode: numberValue(r.statusCode),
      durationMs: numberValue(r.durationMs),
      userAgent: stringValue(r.userAgent),
    });
  }

  return compactRequestContext({
    method: stringValue(context?.['request.method'] ?? context?.httpMethod),
    path: stringValue(context?.['request.path'] ?? context?.httpPath),
    host: stringValue(context?.['request.host'] ?? context?.httpHost),
    route: stringValue(context?.['request.route'] ?? context?.httpRoute),
    query: stringValue(context?.['request.query'] ?? context?.httpQuery),
    statusCode: numberValue(context?.['request.status_code'] ?? context?.statusCode),
    durationMs: numberValue(context?.['request.duration_ms'] ?? context?.durationMs),
    userAgent: stringValue(context?.['request.userAgent'] ?? context?.userAgent),
  });
}

function compactRequestContext(ctx: ErrorRequestContext): ErrorRequestContext | undefined {
  const out: ErrorRequestContext = {};
  for (const [key, value] of Object.entries(ctx) as Array<[keyof ErrorRequestContext, string | number | undefined]>) {
    if (value !== undefined && value !== '') (out as any)[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function requestMetadata(ctx?: ErrorRequestContext): Record<string, unknown> {
  if (!ctx) return {};
  const out: Record<string, unknown> = {};
  if (ctx.method) {
    out['request.method'] = ctx.method;
    out['http.method'] = ctx.method;
  }
  if (ctx.path) {
    out['request.path'] = ctx.path;
    out['http.path'] = ctx.path;
  }
  if (ctx.host) {
    out['request.host'] = ctx.host;
    out['http.host'] = ctx.host;
  }
  if (ctx.route) out['request.route'] = ctx.route;
  if (ctx.query) out['request.query'] = ctx.query;
  if (ctx.statusCode !== undefined) {
    out['request.status_code'] = ctx.statusCode;
    out['http.status_code'] = ctx.statusCode;
  }
  if (ctx.durationMs !== undefined) out['request.duration_ms'] = ctx.durationMs;
  if (ctx.userAgent) out['request.userAgent'] = ctx.userAgent;
  return out;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

const INGEST_PATH = '/ingest/v1/errors';

const VALID_BREADCRUMB_TYPES = new Set(['http', 'log', 'ui', 'navigation', 'query', 'default']);
const VALID_BREADCRUMB_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const DEFAULT_MAX_BREADCRUMBS = 50;
export class ErrorModule {
  private onErrorHandler: ((event: ErrorEvent) => void) | null = null;
  private onUnhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;
  private eventProcessors: ErrorEventProcessor[] = [];
  /**
   * Optional hook invoked when the browser autocapture observes an UNHANDLED
   * error/rejection. The client wires this to mark the release-health session
   * as crashed. Best-effort: a throwing hook never blocks capture.
   */
  private onUnhandled: (() => void) | null = null;

  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
    private sessionId: string,
  ) {
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    this.setupAutocapture();
  }

  addEventProcessor(processor: ErrorEventProcessor): void {
    this.eventProcessors.push(processor);
  }

  /**
   * Register a callback fired when browser autocapture sees an unhandled
   * error/rejection (used by the client to mark the session crashed).
   */
  setOnUnhandled(callback: (() => void) | null): void {
    this.onUnhandled = callback;
  }

  addBreadcrumb(
    type: string,
    message: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    const crumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      type: VALID_BREADCRUMB_TYPES.has(type) ? type : 'default',
      message,
      level: level && VALID_BREADCRUMB_LEVELS.has(level) ? level : 'info',
      ...(data ? { data } : {}),
    };
    if (this.breadcrumbs.length >= this.maxBreadcrumbs) {
      this.breadcrumbs.shift(); // drop oldest
    }
    this.breadcrumbs.push(crumb);
  }

  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  /**
   * Build the release-metadata block we attach to every event. Backend stores
   * `release` + `environment` as first-class fields; the rest (sdk.name,
   * sdk.version, platform, dist, commitSha, branch) ride along inside
   * `metadata` so they survive the wire even before the backend has dedicated
   * columns. Once those columns land, the ingester reads them out of metadata.
   */
  /**
   * Value-pattern scrubbing options derived from config. `scrubValues` is
   * always on (the always-scrub CC/SSN layer must run); `sendDefaultPii`
   * gates the email/IP layer. Errors here can't throw — both fields are plain
   * boolean reads.
   */
  private valueScrubOptions(): ValueScrubOptions {
    return { scrubValues: true, sendDefaultPii: (this.config as any).sendDefaultPii === true };
  }

  private releaseTags(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.config.sdkName) out['sdk.name'] = this.config.sdkName;
    if (this.config.sdkVersion) out['sdk.version'] = this.config.sdkVersion;
    if (this.config.platform) out['platform'] = this.config.platform;
    if (this.config.dist) out['dist'] = this.config.dist;
    if (this.config.commitSha) out['commit.sha'] = this.config.commitSha;
    if (this.config.branch) out['commit.branch'] = this.config.branch;
    return out;
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    // Parse the engine-native stack into structured frames. Falls back
    // to an empty list if the runtime didn't populate `error.stack`.
    const parsed = parseStack(error.stack);
    const platform = this.config.platform || detectPlatform();
    const frames: PayloadFrame[] = parsed.map((f) => ({
      filename: f.filename,
      absPath: f.absPath,
      function: f.function,
      lineno: f.lineno,
      colno: f.colno,
      inApp: f.inApp,
      platform,
      // Try to attribute the frame to a specific bundle's debug-id so
      // the symbolicator can pick the right map. Reads either the
      // browser registry (`globalThis._allstakDebugIds`) or the bundle
      // file directly (Node). Cached per filename — repeated frames
      // pointing at the same bundle hit the cache.
      debugId: resolveDebugId(f.filename),
    }));

    // Aggregate unique debug-ids into the per-event debugMeta.images[]
    // table. AllStak-compatible shape; the symbolicator can match by
    // image-level debugId even when individual frames lack one.
    const debugIdSet = new Set<string>();
    for (const f of frames) if (f.debugId) debugIdSet.add(f.debugId);
    const debugMeta = debugIdSet.size > 0
      ? { images: Array.from(debugIdSet).map((id) => ({ type: 'sourcemap', debugId: id })) }
      : undefined;

    // Keep the v1 string list populated so older backends still ingest.
    // We synthesise it from the structured frames for consistency rather
    // than re-splitting the raw stack — fewer divergent code paths.
    const stackTrace = frames.length > 0 ? frames.map(frameToString) : undefined;

    // Drain breadcrumbs and attach to the error payload. Each breadcrumb's
    // free-form `message` + `data` are caller-controlled, so they go through
    // the same key-redactor AND value-pattern scrubber as the error message.
    const extraKeys = (this.config as any).redactKeys as (string | RegExp)[] | undefined;
    const scrub = this.valueScrubOptions();
    const currentBreadcrumbs =
      this.breadcrumbs.length > 0
        ? this.breadcrumbs.map((bc) => ({
            ...bc,
            message: scrubStringValue(bc.message, scrub),
            ...(bc.data ? { data: redactObject(bc.data, { extraKeys, ...scrub }) } : {}),
          }))
        : undefined;
    this.breadcrumbs = [];

    if (!this.passesSampleRate()) return;

    // Prefer an explicit `error.name` override (e.g. native crashes set
    // it to 'NSException'); fall back to constructor name then 'Error'.
    const exceptionClass =
      (error.name && error.name !== 'Error' ? error.name : undefined) ||
      error.constructor?.name ||
      'Error';

    const requestCtx = requestContextFromContext(context) ?? browserRequestContext();
    const transaction = stringContext(context, 'transaction')
      ?? requestCtx?.route
      ?? (requestCtx?.method && requestCtx?.path ? `${requestCtx.method} ${requestCtx.path}` : undefined);
    const payload: any = {
      exceptionClass,
      // Scrub PII that leaked into the exception message free text. The
      // exceptionClass is a type name, not user data, so it is left intact.
      message: scrubStringValue(error.message, scrub),
      stackTrace,
      frames: frames.length > 0 ? frames : undefined,
      debugMeta,
      platform,
      sdkName: this.config.sdkName ?? SDK_NAME,
      sdkVersion: this.config.sdkVersion ?? SDK_VERSION,
      dist: this.config.dist,
      level: this.config.level ?? 'error',
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      traceId: stringContext(context, 'traceId'),
      spanId: stringContext(context, 'spanId'),
      parentSpanId: stringContext(context, 'parentSpanId'),
      requestId: stringContext(context, 'requestId'),
      replayId: stringContext(context, 'replayId'),
      service: stringContext(context, 'service'),
      user: this.config.user,
      metadata: this.buildMetadata(context, platform, requestCtx, transaction),
      breadcrumbs: currentBreadcrumbs,
      requestContext: requestCtx,
      fingerprint: this.config.fingerprint,
    };

    this.sendThroughPipeline(payload);
  }

  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options?: { data?: Record<string, unknown>; metadata?: Record<string, unknown> },
  ): void {
    if (!this.passesSampleRate()) return;
    const platform = this.config.platform || detectPlatform();
    // Accept both `data` (legacy / per the public .d.ts) and `metadata`
    // (current SDK convention). Caller-supplied keys are redacted before
    // they reach the wire.
    const callerMeta = options?.metadata ?? options?.data;
    const payload: any = {
      exceptionClass: 'Message',
      // Free-text message: value-pattern scrub PII the same way as exceptions.
      message: scrubStringValue(message, this.valueScrubOptions()),
      platform,
      sdkName: this.config.sdkName ?? SDK_NAME,
      sdkVersion: this.config.sdkVersion ?? SDK_VERSION,
      dist: this.config.dist,
      level,
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: this.buildMetadata(callerMeta, platform, browserRequestContext()),
      requestContext: browserRequestContext(),
      fingerprint: this.config.fingerprint,
    };

    this.sendThroughPipeline(payload);
  }

  // ── Filtering / control ─────────────────────────────────────────────

  private passesSampleRate(): boolean {
    const r = (this.config as any).sampleRate;
    if (typeof r !== 'number' || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }

  private buildMetadata(
    perCallContext?: Record<string, unknown>,
    platform = this.config.platform || detectPlatform(),
    requestCtx?: ErrorRequestContext,
    transaction?: string,
  ): Record<string, unknown> {
    // Redact caller-owned inputs (per-call context, configured tags/extras,
    // named contexts) BEFORE merging so the assembled metadata is safe by
    // construction. Key-based redaction removes named secrets; value-pattern
    // scrubbing (CC/SSN always, email/IP unless sendDefaultPii) strips PII that
    // leaked into free-text values. Release tags / runtime metadata / request
    // metadata are SDK-owned (type names, URL components, request shape) and
    // keep their existing handling — they are not free-text value sinks.
    const extraKeys = (this.config as any).redactKeys as (string | RegExp)[] | undefined;
    const scrub = this.valueScrubOptions();
    const opts = { extraKeys, ...scrub };
    const safePerCall = redactObject(perCallContext, opts);
    const safeTags = redactObject(this.config.tags as Record<string, unknown> | undefined, opts);
    const safeExtras = redactObject((this.config as any).extras as Record<string, unknown> | undefined, opts);
    const out: Record<string, unknown> = {
      ...this.releaseTags(),
      ...runtimeMetadata(platform),
      ...requestMetadata(requestCtx),
      ...(safeTags ?? {}),
      ...(safeExtras ?? {}),
      ...(safePerCall ?? {}),
    };
    delete out.requestContext;
    if (transaction) out.transaction = transaction;
    const contexts = (this.config as any).contexts as Record<string, Record<string, unknown>> | undefined;
    if (contexts) {
      for (const [name, ctx] of Object.entries(contexts)) {
        out[`context.${name}`] = redactObject(ctx, opts) ?? ctx;
      }
    }
    return out;
  }

  private async sendThroughPipeline(payload: ErrorIngestPayload): Promise<void> {
    let final: ErrorIngestPayload | null | undefined = this.sanitizeForWire(payload);

    for (const processor of this.allEventProcessors()) {
      if (!final) return;
      try {
        final = await processor(final);
      } catch {
        // Match the SDK's fail-open posture: a broken processor should not
        // hide production telemetry.
      }
    }

    if (!final) return;

    const beforeSend = (this.config as any).beforeSend;
    if (typeof beforeSend === 'function') {
      try { final = await beforeSend(final); }
      catch { /* keep processed event */ }
    }
    if (!final) return;
    final = this.sanitizeForWire(final);
    if (!final) return;
    this.transport.send(INGEST_PATH, final);
  }

  private sanitizeForWire(payload: ErrorIngestPayload): ErrorIngestPayload {
    const extraKeys = (this.config as any).redactKeys as (string | RegExp)[] | undefined;
    const scrub = this.valueScrubOptions();
    const opts = { extraKeys, ...scrub };
    const out: ErrorIngestPayload = {
      ...payload,
      message: scrubStringValue(payload.message, scrub),
    };
    if (payload.metadata) out.metadata = redactObject(payload.metadata, opts) ?? payload.metadata;
    if (payload.user) {
      out.user = redactObject(
        payload.user as Record<string, unknown>,
        { ...opts, sendDefaultPii: true },
      ) as ErrorIngestPayload['user'];
    }
    if (payload.requestContext) {
      out.requestContext = redactObject(payload.requestContext as Record<string, unknown>, opts) as ErrorRequestContext;
    }
    if (Array.isArray(payload.breadcrumbs)) {
      out.breadcrumbs = payload.breadcrumbs.map((bc) => ({
        ...bc,
        message: scrubStringValue(bc.message, scrub),
        ...(bc.data ? { data: redactObject(bc.data, opts) ?? bc.data } : {}),
      }));
    }
    if (Array.isArray(payload.fingerprint)) {
      out.fingerprint = payload.fingerprint.map((part) => scrubStringValue(String(part), scrub));
    }
    return out;
  }

  private allEventProcessors(): ErrorEventProcessor[] {
    const configured = ((this.config as any).eventProcessors ?? []) as ErrorEventProcessor[];
    return [...configured, ...this.eventProcessors];
  }

  private setupAutocapture(): void {
    if (typeof window === 'undefined') return;

    this.onErrorHandler = ((event: ErrorEvent) => {
      const errorEvent = event as unknown as globalThis.ErrorEvent;
      const err =
        errorEvent.error instanceof Error
          ? errorEvent.error
          : new Error(errorEvent.message || 'Unknown error');
      this.notifyUnhandled();
      this.captureException(err);
    }) as (event: ErrorEvent) => void;

    this.onUnhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const err =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      this.notifyUnhandled();
      this.captureException(err);
    };

    window.addEventListener('error', this.onErrorHandler as unknown as EventListener);
    window.addEventListener(
      'unhandledrejection',
      this.onUnhandledRejectionHandler as unknown as EventListener,
    );
  }

  private notifyUnhandled(): void {
    try {
      this.onUnhandled?.();
    } catch {
      /* never block capture on a broken session hook */
    }
  }

  destroy(): void {
    if (typeof window === 'undefined') return;
    if (this.onErrorHandler) {
      window.removeEventListener('error', this.onErrorHandler as unknown as EventListener);
    }
    if (this.onUnhandledRejectionHandler) {
      window.removeEventListener(
        'unhandledrejection',
        this.onUnhandledRejectionHandler as unknown as EventListener,
      );
    }
  }
}

function stringContext(context: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = context?.[key];
  if (typeof value !== 'string') return undefined;
  return value.trim().length > 0 ? value : undefined;
}
