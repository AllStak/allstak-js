import { HttpTransport } from './transport/http';
import { ErrorModule } from './modules/errors';
import { LogModule, LogLevel } from './modules/logs';
import { SessionReplayModule } from './modules/session-replay';
import { HttpRequestModule, HttpRequestItem } from './modules/http-requests';
import { CronModule, HeartbeatOptions } from './modules/cron';
import { generateId } from './utils/uuid';

export interface AllStakConfig {
  dsn: string;
  environment?: string;
  release?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  sessionReplay?: {
    enabled?: boolean;
    maskAllInputs?: boolean;
    sampleRate?: number;
  };
}

interface ParsedDsn {
  baseUrl: string;
  apiKey: string;
}

function parseDsn(dsn: string): ParsedDsn {
  const url = new URL(dsn);
  const apiKey = url.username;
  url.username = '';
  const baseUrl = url.origin;
  return { baseUrl, apiKey };
}

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private errors: ErrorModule;
  private logs: LogModule;
  private httpRequests: HttpRequestModule;
  private cron: CronModule;
  private sessionReplay: SessionReplayModule | null = null;
  private sessionId: string;

  constructor(config: AllStakConfig) {
    this.config = config;
    this.sessionId = generateId();
    const { baseUrl, apiKey } = parseDsn(config.dsn);
    this.transport = new HttpTransport(baseUrl, apiKey);

    this.errors = new ErrorModule(this.transport, this.config, this.sessionId);
    this.logs = new LogModule(this.transport, this.config);
    this.httpRequests = new HttpRequestModule(this.transport);
    this.cron = new CronModule(this.transport);

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
  }

  private isNodeBuild(): boolean {
    return typeof globalThis.__ALLSTAK_NODE__ !== 'undefined';
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    this.errors.captureException(error, context);
  }

  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
  ): void {
    this.errors.captureMessage(message, level);
  }

  /**
   * Report an HTTP request (inbound or outbound).
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  captureRequest(item: HttpRequestItem): void {
    this.httpRequests.capture(item);
  }

  /**
   * Report a cron job execution.
   * The cron monitor slug must match one configured in the AllStak dashboard.
   */
  heartbeat(options: HeartbeatOptions): void {
    this.cron.heartbeat(options);
  }

  get log() {
    return {
      debug: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('debug', message, meta),
      info: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('info', message, meta),
      warn: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('warn', message, meta),
      error: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('error', message, meta),
      fatal: (message: string, meta?: Record<string, unknown>) =>
        this.logs.send('fatal', message, meta),
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

  destroy(): void {
    this.errors.destroy();
    this.httpRequests.destroy();
    this.sessionReplay?.destroy();
  }
}

// Re-export for module consumers
export type { HttpRequestItem } from './modules/http-requests';
export type { HeartbeatOptions } from './modules/cron';
export type { LogLevel } from './modules/logs';

declare global {
  // eslint-disable-next-line no-var
  var __ALLSTAK_NODE__: boolean | undefined;
}
