import { HttpTransport } from '../transport/http';
import { AllStakConfig } from '../client';
import { redactObject } from '../utils/redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface LogEvent {
  type: 'log';
  dsn: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  environment: string;
  meta?: Record<string, unknown>;
}

// Matches backend LogIngestRequest DTO
interface LogIngestPayload {
  level: string;
  message: string;
  service?: string;
  traceId?: string;
  environment?: string;
  release?: string;
  spanId?: string;
  requestId?: string;
  userId?: string;
  errorId?: string;
  metadata?: Record<string, unknown>;
}

const INGEST_PATH = '/ingest/v1/logs';

const BREADCRUMB_LOG_LEVELS = new Set<LogLevel>(['warn', 'error', 'fatal']);

type OnLogBreadcrumb = (level: LogLevel, message: string) => void;

export class LogModule {
  private onLogBreadcrumb: OnLogBreadcrumb | null = null;

  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
  ) {}

  /**
   * Register a callback for auto-breadcrumbs on warn/error/fatal logs.
   */
  setOnLogBreadcrumb(cb: OnLogBreadcrumb): void {
    this.onLogBreadcrumb = cb;
  }

  send(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    // Auto-breadcrumb for warn/error/fatal
    if (this.onLogBreadcrumb && BREADCRUMB_LOG_LEVELS.has(level)) {
      this.onLogBreadcrumb(level, message);
    }

    // Redact caller-supplied metadata before serialisation. The structural
    // routing fields below (service/traceId/etc.) are read from the raw
    // `meta` since they're SDK-controlled scalar identifiers, never secrets.
    const extraKeys = (this.config as any).redactKeys as (string | RegExp)[] | undefined;
    const safeMeta = redactObject(meta, { extraKeys });

    const payload: LogIngestPayload = {
      level,
      message,
      service: (meta?.service as string | undefined) ?? this.config.tags?.service,
      traceId: meta?.traceId as string | undefined,
      environment: (meta?.environment as string | undefined) ?? this.config.environment,
      release: (meta?.release as string | undefined) ?? this.config.release,
      spanId: meta?.spanId as string | undefined,
      requestId: meta?.requestId as string | undefined,
      userId: (meta?.userId as string | undefined) ?? this.config.user?.id,
      errorId: meta?.errorId as string | undefined,
      metadata: safeMeta,
    };
    this.transport.send(INGEST_PATH, payload);
  }
}
