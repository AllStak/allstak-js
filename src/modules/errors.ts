import { HttpTransport } from '../transport/http';
import { AllStakConfig } from '../client';

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
interface ErrorIngestPayload {
  exceptionClass: string;
  message: string;
  stackTrace?: string[];
  level: string;
  environment?: string;
  release?: string;
  sessionId?: string;
  user?: { id?: string; email?: string; ip?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
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

  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
    private sessionId: string,
  ) {
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    this.setupAutocapture();
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

  captureException(error: Error, context?: Record<string, unknown>): void {
    const stackLines = error.stack
      ?.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('at ')) ?? [];

    // Drain breadcrumbs and attach to the error payload
    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? [...this.breadcrumbs] : undefined;
    this.breadcrumbs = [];

    const payload: ErrorIngestPayload = {
      exceptionClass: error.constructor?.name || error.name || 'Error',
      message: error.message,
      stackTrace: stackLines.length > 0 ? stackLines : undefined,
      level: 'error',
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: context ? { ...this.config.tags, ...context } : this.config.tags,
      breadcrumbs: currentBreadcrumbs,
    };

    this.transport.send(INGEST_PATH, payload);
  }

  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
  ): void {
    const payload: ErrorIngestPayload = {
      exceptionClass: 'Message',
      message,
      level,
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: this.config.tags,
    };

    this.transport.send(INGEST_PATH, payload);
  }

  private setupAutocapture(): void {
    if (typeof window === 'undefined') return;

    this.onErrorHandler = ((event: ErrorEvent) => {
      const errorEvent = event as unknown as globalThis.ErrorEvent;
      const err =
        errorEvent.error instanceof Error
          ? errorEvent.error
          : new Error(errorEvent.message || 'Unknown error');
      this.captureException(err);
    }) as (event: ErrorEvent) => void;

    this.onUnhandledRejectionHandler = (event: PromiseRejectionEvent) => {
      const err =
        event.reason instanceof Error
          ? event.reason
          : new Error(String(event.reason));
      this.captureException(err);
    };

    window.addEventListener('error', this.onErrorHandler as unknown as EventListener);
    window.addEventListener(
      'unhandledrejection',
      this.onUnhandledRejectionHandler as unknown as EventListener,
    );
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
