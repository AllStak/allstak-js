import { AllStakClient, AllStakConfig } from './client';
import { Scope } from './scope';
export { Scope } from './scope';
import type { TransportStats } from './transport/http';
import type { ErrorEventProcessor } from './modules/errors';
import type { HttpRequestItem } from './modules/http-requests';
import type { HeartbeatOptions } from './modules/cron';
import type { Span, SpanOptions, SpanProcessor } from './modules/tracing';
import type { DbQueryItem } from './modules/database';
import type { DatabaseModule } from './modules/database';
import type { AllStakIntegration } from './integration';

export type { AllStakConfig, ScreenshotArtifact, ScreenshotCaptureOptions } from './client';
export type { AllStakIntegration, IntegrationIndex, IntegrationOption } from './integration';
export { defineIntegration } from './integration';
export { eventFiltersIntegration, inboundFiltersIntegration } from './integrations/event-filters';
export { dedupeIntegration } from './integrations/dedupe';
export { consoleIntegration } from './integrations/console';
export { httpClientIntegration } from './integrations/http-client';
export { databaseIntegration } from './integrations/database';
export type { TransportStats } from './transport/http';
export type { ErrorEvent, Breadcrumb, ErrorEventProcessor, EventFilterPattern, ErrorIngestPayload } from './modules/errors';
export type { LogEvent, LogLevel } from './modules/logs';
export type { ReplayEvent, DOMEvent } from './modules/session-replay';
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';
export type { SpanData, SpanOptions, SpanProcessor, SpanFilterPattern, TracesSampler, SamplingContext } from './modules/tracing';
export { Span } from './modules/tracing';
export type { DbQueryItem } from './modules/database';
export { DatabaseModule } from './modules/database';

let instance: AllStakClient | null = null;

export const AllStak = {
  init(config: AllStakConfig): AllStakClient {
    if (instance) {
      instance.destroy();
    }
    instance = new AllStakClient(config);
    return instance;
  },

  captureException(error: Error, context?: Record<string, unknown>): void {
    ensureInit().captureException(error, context);
  },

  addBreadcrumb(
    typeOrCrumb: string | { type: string; message: string; level?: string; data?: Record<string, unknown> },
    message?: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    if (typeof typeOrCrumb === 'object') {
      ensureInit().addBreadcrumb(typeOrCrumb.type, typeOrCrumb.message, typeOrCrumb.level, typeOrCrumb.data);
    } else {
      ensureInit().addBreadcrumb(typeOrCrumb, message!, level, data);
    }
  },

  clearBreadcrumbs(): void {
    ensureInit().clearBreadcrumbs();
  },

  addEventProcessor(processor: ErrorEventProcessor): void {
    ensureInit().addEventProcessor(processor);
  },

  addSpanProcessor(processor: SpanProcessor): void {
    ensureInit().addSpanProcessor(processor);
  },

  addIntegration(integration: AllStakIntegration): void {
    ensureInit().addIntegration(integration);
  },

  getIntegration(name: string): AllStakIntegration | undefined {
    return ensureInit().getIntegration(name);
  },

  /** Phase 3 — runtime SDK-identity override (used by RN install). */
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    ensureInit().setIdentity(identity);
  },

  /**
   * Capture a freeform message. By default routes to the **logs** stream
   * (so it shows up under "Logs" in the dashboard). For `error` / `fatal`
   * severities it ALSO writes to the errors stream so the message is visible
   * during incident triage. Override with `{ as: 'log' | 'error' | 'both' }`.
   */
  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options?: { as?: 'log' | 'error' | 'both'; data?: Record<string, unknown>; metadata?: Record<string, unknown> },
  ): void {
    ensureInit().captureMessage(message, level, options);
  },

  /**
   * Report an HTTP request (inbound or outbound) to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureRequest(item: HttpRequestItem): void {
    ensureInit().captureRequest(item);
  },

  /**
   * Report a cron job execution to AllStak.
   * The slug must match a cron monitor configured in the AllStak dashboard.
   */
  heartbeat(options: HeartbeatOptions): void {
    ensureInit().heartbeat(options);
  },

  /**
   * Access the database module for capturing DB query telemetry.
   */
  get database(): DatabaseModule {
    return ensureInit().database;
  },

  /**
   * Report a database query to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureDbQuery(item: DbQueryItem): void {
    ensureInit().captureDbQuery(item);
  },

  get log() {
    return ensureInit().log;
  },

  get logger() {
    return ensureInit().logger;
  },

  setUser(user: { id?: string; email?: string }): void {
    ensureInit().setUser(user);
  },

  setTag(key: string, value: string): void {
    ensureInit().setTag(key, value);
  },

  setTags(tags: Record<string, string>): void {
    ensureInit().setTags(tags);
  },

  setExtra(key: string, value: unknown): void {
    ensureInit().setExtra(key, value);
  },

  setExtras(extras: Record<string, unknown>): void {
    ensureInit().setExtras(extras);
  },

  setContext(name: string, ctx: Record<string, unknown> | null): void {
    ensureInit().setContext(name, ctx);
  },

  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void {
    ensureInit().setLevel(level);
  },

  setFingerprint(fingerprint: string[] | null): void {
    ensureInit().setFingerprint(fingerprint);
  },

  /**
   * Flush queued module batches and wait for in-flight transport work to drain.
   * Resolves `true` if telemetry drains within `timeoutMs` (default 2000ms),
   * `false` otherwise.
   */
  flush(timeoutMs?: number): Promise<boolean> {
    return ensureInit().flush(timeoutMs);
  },

  /**
   * Run `callback` with a fresh, temporary {@link Scope} that isolates any
   * user/tag/extra/context/fingerprint/level it sets. Pop is automatic for
   * sync, async, and throwing callbacks.
   */
  withScope<T>(callback: (scope: Scope) => T): T {
    return ensureInit().withScope(callback);
  },

  getCurrentScope(): Scope | null {
    return ensureInit().getCurrentScope();
  },

  configureScope(callback: (scope: Scope) => void): void {
    ensureInit().configureScope(callback);
  },

  getSessionId(): string {
    return ensureInit().getSessionId();
  },

  getTransportStats(): TransportStats {
    return ensureInit().getTransportStats();
  },

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
    return ensureInit().startSpan(operation, options);
  },

  /**
   * Run a sync or async function inside a span and finish it automatically.
   */
  trace<T>(
    operation: string,
    callback: (span: Span) => T,
    options?: SpanOptions,
  ): T {
    return ensureInit().trace(operation, callback, options);
  },

  /** Get the current trace ID (creates one if none exists). */
  getTraceId(): string {
    return ensureInit().getTraceId();
  },

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    ensureInit().setTraceId(traceId);
  },

  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId(): string | null {
    return ensureInit().getCurrentSpanId();
  },

  /** Reset trace context (trace ID and span stack). */
  resetTrace(): void {
    ensureInit().resetTrace();
  },

  destroy(): void {
    instance?.destroy();
    instance = null;
  },

  /** @internal — exposed for testing */
  _getInstance(): AllStakClient | null {
    return instance;
  },
};

export default AllStak;

function ensureInit(): AllStakClient {
  if (!instance) {
    throw new Error('AllStak.init() must be called before using the SDK');
  }
  return instance;
}
