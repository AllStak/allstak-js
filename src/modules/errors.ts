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

// Matches backend ErrorIngestRequest DTO
interface ErrorIngestPayload {
  exceptionClass: string;
  message: string;
  stackTrace?: string[];
  level: string;
  environment?: string;
  release?: string;
  user?: { id?: string; email?: string; ip?: string };
  metadata?: Record<string, unknown>;
}

const INGEST_PATH = '/ingest/v1/errors';

export class ErrorModule {
  private onErrorHandler: ((event: ErrorEvent) => void) | null = null;
  private onUnhandledRejectionHandler: ((event: PromiseRejectionEvent) => void) | null = null;

  constructor(
    private transport: HttpTransport,
    private config: AllStakConfig,
  ) {
    this.setupAutocapture();
  }

  captureException(error: Error, context?: Record<string, unknown>): void {
    const stackLines = error.stack
      ?.split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('at ')) ?? [];

    const payload: ErrorIngestPayload = {
      exceptionClass: error.constructor?.name || error.name || 'Error',
      message: error.message,
      stackTrace: stackLines.length > 0 ? stackLines : undefined,
      level: 'error',
      environment: this.config.environment,
      release: this.config.release,
      user: this.config.user,
      metadata: context ? { ...this.config.tags, ...context } : this.config.tags,
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
