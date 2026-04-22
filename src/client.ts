import { HttpTransport } from './transport/http';
import { ErrorModule } from './modules/errors';
import { LogModule, LogLevel } from './modules/logs';
import { SessionReplayModule } from './modules/session-replay';
import { HttpRequestModule, HttpRequestItem } from './modules/http-requests';
import { CronModule, HeartbeatOptions } from './modules/cron';
import { TracingModule, Span } from './modules/tracing';
import { DatabaseModule, DbQueryItem, enableDbAutoInstrumentation } from './modules/database';
import { setTraceResolver } from './integrations/db/shared';
import { instrumentFetch, instrumentConsole } from './modules/auto-breadcrumbs';
import { instrumentNodeHttp } from './modules/auto-node-http';
import { generateId } from './utils/uuid';

/**
 * Single, static AllStak ingest host. Not customer-configurable in normal use:
 * customers should never have to know which URL their events go to. To point
 * the SDK at a different deployment (e.g. self-hosted), set the optional
 * {@link AllStakConfig#host} field.
 */
export const INGEST_HOST = 'https://api.allstak.sa';

/** SDK semver. Surfaced internally; not currently sent on the wire. */
export const SDK_VERSION = '1.1.0';

export interface AllStakConfig {
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
  user?: { id?: string; email?: string };
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

interface ParsedConfig {
  baseUrl: string;
  apiKey: string;
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

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private errors: ErrorModule;
  private logs: LogModule;
  private httpRequests: HttpRequestModule;
  private cron: CronModule;
  private tracing: TracingModule;
  private _database: DatabaseModule;
  private sessionReplay: SessionReplayModule | null = null;
  private sessionId: string;

  constructor(config: AllStakConfig) {
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = resolveTransport(config);
    this.transport = new HttpTransport(baseUrl, apiKey);

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

    // Auto-DB instrumentation is Node-only (requires `require()` + `process`).
    // Skip entirely in browsers so the SDK never references `process` there.
    if (config.autoDbInstrumentation !== false && typeof window === 'undefined') {
      enableDbAutoInstrumentation(this._database, {
        service: config.tags?.service,
        environment: config.environment,
      });
    }
    this.tracing = new TracingModule(this.transport, {
      service: config.tags?.service,
      environment: config.environment,
    });

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

    // Wire automatic breadcrumb instrumentation
    if (config.autoBreadcrumbs !== false) {
      instrumentFetch(
        (type, msg, level, data) => this.addBreadcrumb(type, msg, level, data),
        (item) => this.captureRequest({ ...item, method: item.method as HttpRequestItem['method'] }),
        baseUrl,
      );
      instrumentConsole((type, msg, level, data) => this.addBreadcrumb(type, msg, level, data));

      // Node-only: also patch node:http and node:https so libraries that don't
      // go through global fetch (axios, got, node-fetch, native http) are
      // captured as outbound HTTP requests too.
      if (this.isNodeBuild() || typeof process !== 'undefined' && process.versions?.node) {
        try {
          instrumentNodeHttp(
            (item) => this.captureRequest({ ...item, method: item.method as HttpRequestItem['method'] }),
            (type, msg, level, data) => this.addBreadcrumb(type, msg, level, data),
            baseUrl,
          );
        } catch {
          /* not in Node — ignore */
        }
      }

      this.logs.setOnLogBreadcrumb((level, message) => {
        const bcLevel = level === 'warn' ? 'warn' : 'error';
        this.addBreadcrumb('log', message, bcLevel, { logLevel: level });
      });

      this.httpRequests.setOnCapture((item) => {
        this.addBreadcrumb(
          'http',
          `${item.method} ${item.path} -> ${item.statusCode}`,
          item.statusCode >= 400 ? 'error' : 'info',
          { method: item.method, path: item.path, statusCode: item.statusCode, durationMs: item.durationMs },
        );
      });
    }
  }

  private isNodeBuild(): boolean {
    return typeof globalThis.__ALLSTAK_NODE__ !== 'undefined';
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    const traceContext: Record<string, unknown> = {};
    const traceId = this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const spanId = this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    this.errors.captureException(error, { ...traceContext, ...context });
  }

  addBreadcrumb(
    type: string,
    message: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    this.errors.addBreadcrumb(type, message, level, data);
  }

  clearBreadcrumbs(): void {
    this.errors.clearBreadcrumbs();
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
    options: { as?: 'log' | 'error' | 'both' } = {},
  ): void {
    const as = options.as ?? (level === 'fatal' || level === 'error' ? 'both' : 'log');
    if (as === 'log' || as === 'both') {
      // Map error->error, warning->warn, fatal->fatal, info->info
      const logLevel = (level === 'warning' ? 'warn' : level) as
        'debug' | 'info' | 'warn' | 'error' | 'fatal';
      this.logs.send(logLevel, message);
    }
    if (as === 'error' || as === 'both') {
      this.errors.captureMessage(message, level);
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

  setUser(user: { id?: string; email?: string }): void {
    this.config.user = user;
  }

  setTag(key: string, value: string): void {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }

  getSessionId(): string {
    return this.sessionId;
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
    options?: { description?: string; tags?: Record<string, string> },
  ): Span {
    return this.tracing.startSpan(operation, options);
  }

  /** Get the current trace ID (creates one if none exists). */
  getTraceId(): string {
    return this.tracing.getTraceId();
  }

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    this.tracing.setTraceId(traceId);
  }

  /** Get the current active span ID, or null if no span is active. */
  getCurrentSpanId(): string | null {
    return this.tracing.getCurrentSpanId();
  }

  /** Reset trace context (trace ID and span stack). */
  resetTrace(): void {
    this.tracing.resetTrace();
  }

  destroy(): void {
    setTraceResolver(null);
    this.tracing.destroy();
    this.errors.destroy();
    this.httpRequests.destroy();
    this._database.destroy();
    this.sessionReplay?.destroy();
    this.uninstallNodeErrorHandlers();
  }

  // ─── Node uncaughtException / unhandledRejection auto-capture ─────
  private nodeUncaughtHandler: ((err: Error) => void) | null = null;
  private nodeRejectionHandler: ((reason: unknown) => void) | null = null;

  private installNodeErrorHandlers(): void {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }
    this.nodeUncaughtHandler = (err: Error) => {
      try {
        const e = err instanceof Error ? err : new Error(String(err));
        this.errors.captureException(e, { source: 'uncaughtException' });
      } catch {
        /* never break the host process */
      }
    };
    this.nodeRejectionHandler = (reason: unknown) => {
      try {
        const e = reason instanceof Error ? reason : new Error(String(reason));
        this.errors.captureException(e, { source: 'unhandledRejection' });
      } catch {
        /* never break the host process */
      }
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

// Re-export for module consumers
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';
export type { LogLevel } from './modules/logs';
export type { SpanData } from './modules/tracing';
export { Span } from './modules/tracing';
export type { DbQueryItem } from './modules/database';
export { DatabaseModule } from './modules/database';

declare global {
  // eslint-disable-next-line no-var
  var __ALLSTAK_NODE__: boolean | undefined;
}
