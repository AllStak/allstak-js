import { HttpTransport } from '../transport/http';

export interface HttpRequestItem {
  /** Unique trace identifier — generates one if not provided */
  traceId?: string;
  /** 'inbound' = request arriving at this service; 'outbound' = request made to external service */
  direction: 'inbound' | 'outbound';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  /** Fingerprint of a linked error event */
  errorFingerprint?: string;
  /** ISO-8601 timestamp — defaults to now */
  timestamp?: string;
}

// Matches backend HttpRequestItem DTO exactly
interface HttpRequestIngestItem {
  traceId: string;
  direction: 'inbound' | 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  userId?: string;
  errorFingerprint?: string;
  timestamp: string;
}

interface HttpRequestIngestPayload {
  requests: HttpRequestIngestItem[];
}

const INGEST_PATH = '/ingest/v1/http-requests';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

type OnCaptureBreadcrumb = (item: HttpRequestItem) => void;

export class HttpRequestModule {
  private queue: HttpRequestIngestItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private onCapture: OnCaptureBreadcrumb | null = null;

  constructor(private transport: HttpTransport) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /**
   * Register a callback invoked on every capture(), used for auto-breadcrumbs.
   */
  setOnCapture(cb: OnCaptureBreadcrumb): void {
    this.onCapture = cb;
  }

  /**
   * Report an HTTP request (inbound or outbound) to AllStak.
   * Batches internally and flushes every 5s or when 20 items accumulate.
   */
  capture(item: HttpRequestItem): void {
    if (this.onCapture) {
      this.onCapture(item);
    }

    this.queue.push({
      traceId: item.traceId ?? generateTraceId(),
      direction: item.direction,
      method: item.method,
      host: item.host,
      path: item.path,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      requestSize: item.requestSize,
      responseSize: item.responseSize,
      userId: item.userId,
      errorFingerprint: item.errorFingerprint,
      timestamp: item.timestamp ?? new Date().toISOString(),
    });

    if (this.queue.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.queue.length === 0) return;

    const batch = this.queue.splice(0, this.queue.length);
    const payload: HttpRequestIngestPayload = { requests: batch };
    this.transport.send(INGEST_PATH, payload);
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
