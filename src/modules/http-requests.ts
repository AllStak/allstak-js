import { HttpTransport } from '../transport/http';
import { newTraceId, normalizeSpanId, normalizeTraceId } from './trace-propagation';

export interface HttpRequestItem {
  /** Unique trace identifier — generates one if not provided */
  traceId?: string;
  /** Unique request identifier — generates one if not provided */
  requestId?: string;
  /** Current span id for this HTTP request */
  spanId?: string;
  /** Parent span id when available */
  parentSpanId?: string;
  /** 'inbound' = request arriving at this service; 'outbound' = request made to external service */
  direction: 'inbound' | 'outbound';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string> | string;
  responseHeaders?: Record<string, string> | string;
  requestBodyCaptureStatus?: string;
  responseBodyCaptureStatus?: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
  userId?: string;
  /** Fingerprint of a linked error event */
  errorFingerprint?: string;
  /** ISO-8601 timestamp — defaults to now */
  timestamp?: string;
}

// Matches backend HttpRequestItem DTO exactly
interface HttpRequestIngestItem {
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
  direction: 'inbound' | 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: string;
  responseHeaders?: string;
  requestBodyCaptureStatus?: string;
  responseBodyCaptureStatus?: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
  userId?: string;
  errorFingerprint?: string;
  /** Per-request env / release for accurate filtering on the dashboard. */
  environment?: string;
  release?: string;
  timestamp: string;
}

interface HttpRequestIngestPayload {
  requests: HttpRequestIngestItem[];
}

const INGEST_PATH = '/ingest/v1/http-requests';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

type OnCaptureBreadcrumb = (item: HttpRequestItem) => void;

export class HttpRequestModule {
  private queue: HttpRequestIngestItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private onCapture: OnCaptureBreadcrumb | null = null;
  private defaults: { environment?: string; release?: string } = {};

  constructor(private transport: HttpTransport) {
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === 'object' && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  /** Apply environment / release tags to every captured request. */
  setDefaults(defaults: { environment?: string; release?: string }): void {
    this.defaults = { ...this.defaults, ...defaults };
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
      traceId: item.traceId ? normalizeTraceId(item.traceId) : newTraceId(),
      requestId: item.requestId ?? newTraceId(),
      spanId: item.spanId ? normalizeSpanId(item.spanId) : undefined,
      parentSpanId: item.parentSpanId ? normalizeSpanId(item.parentSpanId) : undefined,
      direction: item.direction,
      method: item.method,
      host: item.host,
      path: item.path,
      statusCode: item.statusCode,
      durationMs: item.durationMs,
      requestSize: item.requestSize,
      responseSize: item.responseSize,
      requestBody: item.requestBody,
      responseBody: item.responseBody,
      requestHeaders: serializeHeaders(item.requestHeaders),
      responseHeaders: serializeHeaders(item.responseHeaders),
      requestBodyCaptureStatus: item.requestBodyCaptureStatus,
      responseBodyCaptureStatus: item.responseBodyCaptureStatus,
      requestBodyCaptureReason: item.requestBodyCaptureReason,
      responseBodyCaptureReason: item.responseBodyCaptureReason,
      userId: item.userId,
      errorFingerprint: item.errorFingerprint,
      environment: this.defaults.environment,
      release: this.defaults.release,
      timestamp: item.timestamp ?? new Date().toISOString(),
    });

    if (this.queue.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
    }
  }

  flush(): void {
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

function serializeHeaders(headers: Record<string, string> | string | undefined): string | undefined {
  if (headers == null) return undefined;
  if (typeof headers === 'string') return headers;
  try {
    return JSON.stringify(headers);
  } catch {
    return undefined;
  }
}
