import { HttpTransport } from '../transport/http';
import { AllStakConfig } from '../client';

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
  metadata?: Record<string, unknown>;
}

const INGEST_PATH = '/ingest/v1/logs';

export class LogModule {
  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
  ) {}

  send(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const payload: LogIngestPayload = {
      level,
      message,
      service: (meta?.service as string | undefined) ?? this.config.tags?.service,
      traceId: meta?.traceId as string | undefined,
      metadata: meta,
    };
    this.transport.send(INGEST_PATH, payload);
  }
}
