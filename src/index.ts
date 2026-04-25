import { AllStakClient, AllStakConfig } from './client';
import type { HttpRequestItem } from './modules/http-requests';
import type { HeartbeatOptions } from './modules/cron';
import type { Span } from './modules/tracing';
import type { DbQueryItem } from './modules/database';
import type { DatabaseModule } from './modules/database';

export type { AllStakConfig } from './client';
export type { ErrorEvent, Breadcrumb } from './modules/errors';
export type { LogEvent, LogLevel } from './modules/logs';
export type { ReplayEvent, DOMEvent } from './modules/session-replay';
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';
export type { SpanData } from './modules/tracing';
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
    type: string,
    message: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    ensureInit().addBreadcrumb(type, message, level, data);
  },

  clearBreadcrumbs(): void {
    ensureInit().clearBreadcrumbs();
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
    options?: { as?: 'log' | 'error' | 'both' },
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

  setUser(user: { id?: string; email?: string }): void {
    ensureInit().setUser(user);
  },

  setTag(key: string, value: string): void {
    ensureInit().setTag(key, value);
  },

  getSessionId(): string {
    return ensureInit().getSessionId();
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
    options?: { description?: string; tags?: Record<string, string> },
  ): Span {
    return ensureInit().startSpan(operation, options);
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

function ensureInit(): AllStakClient {
  if (!instance) {
    throw new Error('AllStak.init() must be called before using the SDK');
  }
  return instance;
}
