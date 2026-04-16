import { HttpTransport } from '../transport/http';
import { generateId } from '../utils/uuid';

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  operation: string;
  description: string;
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  startTimeMillis: number;
  endTimeMillis: number;
  service: string;
  environment: string;
  tags: Record<string, string>;
  data: string;
}

interface SpanIngestPayload {
  spans: SpanData[];
}

const INGEST_PATH = '/ingest/v1/spans';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

export class Span {
  private _traceId: string;
  private _spanId: string;
  private _parentSpanId: string;
  private _operation: string;
  private _description: string;
  private _service: string;
  private _environment: string;
  private _tags: Record<string, string>;
  private _data: string = '';
  private _startTimeMillis: number;
  private _finished = false;
  private _onFinish: (spanData: SpanData) => void;

  constructor(config: {
    traceId: string;
    spanId: string;
    parentSpanId: string;
    operation: string;
    description: string;
    service: string;
    environment: string;
    tags: Record<string, string>;
    startTimeMillis: number;
    onFinish: (spanData: SpanData) => void;
  }) {
    this._traceId = config.traceId;
    this._spanId = config.spanId;
    this._parentSpanId = config.parentSpanId;
    this._operation = config.operation;
    this._description = config.description;
    this._service = config.service;
    this._environment = config.environment;
    this._tags = { ...config.tags };
    this._startTimeMillis = config.startTimeMillis;
    this._onFinish = config.onFinish;
  }

  /** Set a tag on this span. */
  setTag(key: string, value: string): this {
    this._tags[key] = value;
    return this;
  }

  /** Set arbitrary string data on this span. */
  setData(data: string): this {
    this._data = data;
    return this;
  }

  /** Set the description after creation. */
  setDescription(description: string): this {
    this._description = description;
    return this;
  }

  /**
   * Finish the span. Status defaults to 'ok'.
   * Calling finish() more than once is a no-op.
   */
  finish(status: 'ok' | 'error' | 'timeout' = 'ok'): void {
    if (this._finished) return;
    this._finished = true;
    const endTimeMillis = Date.now();
    this._onFinish({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      operation: this._operation,
      description: this._description,
      status,
      durationMs: endTimeMillis - this._startTimeMillis,
      startTimeMillis: this._startTimeMillis,
      endTimeMillis,
      service: this._service,
      environment: this._environment,
      tags: this._tags,
      data: this._data,
    });
  }

  get spanId(): string {
    return this._spanId;
  }

  get traceId(): string {
    return this._traceId;
  }

  get isFinished(): boolean {
    return this._finished;
  }
}

export class TracingModule {
  private transport: HttpTransport;
  private service: string;
  private environment: string;
  private currentTraceId: string | null = null;
  private spanStack: string[] = [];
  private completedSpans: SpanData[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    transport: HttpTransport,
    config: { service?: string; environment?: string },
  ) {
    this.transport = transport;
    this.service = config.service || '';
    this.environment = config.environment || '';
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Get the current trace ID, creating one if none exists. */
  getTraceId(): string {
    if (!this.currentTraceId) {
      this.currentTraceId = generateId().replace(/-/g, '');
    }
    return this.currentTraceId;
  }

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    this.currentTraceId = traceId;
  }

  /** Get the current active span ID (top of the span stack), or null. */
  getCurrentSpanId(): string | null {
    return this.spanStack.length > 0
      ? this.spanStack[this.spanStack.length - 1]
      : null;
  }

  /**
   * Start a new span. The span is automatically parented to the current
   * active span (if any). Call span.finish() when the operation completes.
   */
  startSpan(
    operation: string,
    options?: { description?: string; tags?: Record<string, string> },
  ): Span {
    const spanId = generateId().replace(/-/g, '');
    const parentSpanId = this.getCurrentSpanId() || '';
    const traceId = this.getTraceId();

    this.spanStack.push(spanId);

    const span = new Span({
      traceId,
      spanId,
      parentSpanId,
      operation,
      description: options?.description || '',
      service: this.service,
      environment: this.environment,
      tags: options?.tags || {},
      startTimeMillis: Date.now(),
      onFinish: (spanData: SpanData) => {
        const idx = this.spanStack.indexOf(spanId);
        if (idx >= 0) this.spanStack.splice(idx, 1);
        this.completedSpans.push(spanData);
        if (this.completedSpans.length >= BATCH_SIZE_THRESHOLD) {
          this.flush();
        }
      },
    });

    return span;
  }

  /** Flush all completed spans to the backend. */
  flush(): void {
    if (this.completedSpans.length === 0) return;
    const spans = this.completedSpans.splice(0, this.completedSpans.length);
    const payload: SpanIngestPayload = { spans };
    this.transport.send(INGEST_PATH, payload);
  }

  /** Reset trace context — clears trace ID and span stack. */
  resetTrace(): void {
    this.currentTraceId = null;
    this.spanStack = [];
  }

  /** Stop the flush timer and do a final flush. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}
