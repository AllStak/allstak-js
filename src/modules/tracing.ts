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
  op?: string;
  platform?: string;
  measurements?: Record<string, number>;
  attributes?: Record<string, string>;
}

export interface SpanOptions {
  description?: string;
  tags?: Record<string, string>;
  attributes?: Record<string, string>;
  measurements?: Record<string, number>;
  op?: string;
  platform?: string;
}

export type SpanProcessor = (span: SpanData) => SpanData | null | undefined;
export type SpanFilterPattern = string | RegExp | ((span: SpanData) => boolean);

interface SpanIngestPayload {
  spans: SpanData[];
}

const INGEST_PATH = '/ingest/v1/spans';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

export interface TraceState {
  traceId: string | null;
  requestId?: string | null;
  spanStack: string[];
}

interface AsyncTraceStorage {
  getStore(): TraceState | undefined;
  run<T>(store: TraceState, callback: () => T): T;
}

declare const require: undefined | ((id: string) => { AsyncLocalStorage?: new () => AsyncTraceStorage });

declare global {
  // eslint-disable-next-line no-var
  var __ALLSTAK_NODE__: boolean | undefined;
}

export class Span {
  private _traceId: string;
  private _spanId: string;
  private _parentSpanId: string;
  private _operation: string;
  private _description: string;
  private _service: string;
  private _environment: string;
  private _tags: Record<string, string>;
  private _attributes: Record<string, string>;
  private _measurements: Record<string, number>;
  private _op?: string;
  private _platform?: string;
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
    attributes: Record<string, string>;
    measurements: Record<string, number>;
    op?: string;
    platform?: string;
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
    this._attributes = { ...config.attributes };
    this._measurements = { ...config.measurements };
    this._op = config.op;
    this._platform = config.platform;
    this._startTimeMillis = config.startTimeMillis;
    this._onFinish = config.onFinish;
  }

  /** Set a tag on this span. */
  setTag(key: string, value: string): this {
    this._tags[key] = value;
    this._attributes[key] = value;
    return this;
  }

  /** Set a queryable span attribute. */
  setAttribute(key: string, value: string): this {
    this._attributes[key] = value;
    return this;
  }

  /** Set a numeric span measurement. */
  setMeasurement(key: string, value: number): this {
    this._measurements[key] = value;
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
    const durationMs = endTimeMillis - this._startTimeMillis;
    this._onFinish({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      operation: this._operation,
      description: this._description,
      status,
      durationMs,
      startTimeMillis: this._startTimeMillis,
      endTimeMillis,
      service: this._service,
      environment: this._environment,
      tags: this._tags,
      data: this._data,
      op: this._op || inferOp(this._operation),
      platform: this._platform,
      measurements: {
        duration_ms: durationMs,
        ...this._measurements,
      },
      attributes: {
        ...this._tags,
        ...this._attributes,
      },
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
  private platform: string;
  private globalState: TraceState = { traceId: null, spanStack: [] };
  private asyncStorage: AsyncTraceStorage | null = createAsyncTraceStorage();
  private completedSpans: SpanData[] = [];
  private spanProcessors: SpanProcessor[] = [];
  private beforeSendSpan?: SpanProcessor;
  private ignoreSpans: SpanFilterPattern[];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    transport: HttpTransport,
    config: {
      service?: string;
      environment?: string;
      platform?: string;
      beforeSendSpan?: SpanProcessor;
      ignoreSpans?: SpanFilterPattern[];
    },
  ) {
    this.transport = transport;
    this.service = config.service || '';
    this.environment = config.environment || '';
    this.platform = config.platform || '';
    this.beforeSendSpan = config.beforeSendSpan;
    this.ignoreSpans = config.ignoreSpans ?? [];
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (typeof this.flushTimer === 'object' && typeof this.flushTimer.unref === 'function') {
      this.flushTimer.unref();
    }
  }

  addSpanProcessor(processor: SpanProcessor): void {
    this.spanProcessors.push(processor);
  }

  /**
   * Run work inside an isolated trace context. In Node this uses
   * AsyncLocalStorage so overlapping requests don't share trace/span state.
   * Browser builds fall back to the historical global context.
   */
  withTraceContext<T>(traceId: string | undefined, callback: () => T): T;
  withTraceContext<T>(traceId: string | undefined, requestId: string | undefined, callback: () => T): T;
  withTraceContext<T>(
    traceId: string | undefined,
    requestIdOrCallback: string | undefined | (() => T),
    maybeCallback?: () => T,
  ): T {
    const requestId = typeof requestIdOrCallback === 'function' ? undefined : requestIdOrCallback;
    const callback = typeof requestIdOrCallback === 'function' ? requestIdOrCallback : maybeCallback!;
    if (!this.asyncStorage) {
      if (traceId) this.globalState.traceId = traceId;
      if (requestId) this.globalState.requestId = requestId;
      return callback();
    }
    return this.asyncStorage.run({ traceId: traceId ?? null, requestId: requestId ?? null, spanStack: [] }, callback);
  }

  private state(): TraceState {
    return this.asyncStorage?.getStore() ?? this.globalState;
  }

  /** Get the current trace ID, creating one if none exists. */
  getTraceId(): string {
    const state = this.state();
    if (!state.traceId) {
      state.traceId = generateId().replace(/-/g, '');
    }
    return state.traceId;
  }

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    this.state().traceId = traceId;
  }

  getRequestId(): string | null {
    return this.state().requestId ?? null;
  }

  setRequestId(requestId: string): void {
    this.state().requestId = requestId;
  }

  /** Get the current active span ID (top of the span stack), or null. */
  getCurrentSpanId(): string | null {
    const state = this.state();
    return state.spanStack.length > 0
      ? state.spanStack[state.spanStack.length - 1]
      : null;
  }

  /**
   * Start a new span. The span is automatically parented to the current
   * active span (if any). Call span.finish() when the operation completes.
   */
  startSpan(
    operation: string,
    options?: SpanOptions,
  ): Span {
    const state = this.state();
    const spanId = generateId().replace(/-/g, '');
    const parentSpanId = this.getCurrentSpanId() || '';
    const traceId = this.getTraceId();

    state.spanStack.push(spanId);

    const span = new Span({
      traceId,
      spanId,
      parentSpanId,
      operation,
      description: options?.description || '',
      service: this.service,
      environment: this.environment,
      tags: options?.tags || {},
      attributes: options?.attributes || {},
      measurements: options?.measurements || {},
      op: options?.op || inferOp(operation),
      platform: options?.platform || this.platform,
      startTimeMillis: Date.now(),
      onFinish: (spanData: SpanData) => {
        const idx = state.spanStack.indexOf(spanId);
        if (idx >= 0) state.spanStack.splice(idx, 1);
        const finalSpan = this.processSpan(spanData);
        if (finalSpan) this.completedSpans.push(finalSpan);
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
    const state = this.state();
    state.traceId = null;
    state.requestId = null;
    state.spanStack = [];
  }

  /** Stop the flush timer and do a final flush. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  private processSpan(span: SpanData): SpanData | null {
    if (this.shouldIgnoreSpan(span)) return null;

    let final: SpanData | null | undefined = span;
    for (const processor of this.spanProcessors) {
      if (!final) return null;
      try {
        final = processor(final) ?? null;
      } catch {
        // A broken span processor must not break application execution.
      }
    }

    if (!final) return null;
    if (this.beforeSendSpan) {
      try {
        final = this.beforeSendSpan(final) ?? null;
      } catch {
        // Keep the processed span if the hook itself fails.
      }
    }

    return final ?? null;
  }

  private shouldIgnoreSpan(span: SpanData): boolean {
    return this.ignoreSpans.some((pattern) => {
      if (typeof pattern === 'function') return pattern(span);
      const target = `${span.operation} ${span.description}`;
      if (typeof pattern === 'string') return target.includes(pattern);
      return pattern.test(target);
    });
  }
}

function createAsyncTraceStorage(): AsyncTraceStorage | null {
  if (typeof globalThis.__ALLSTAK_NODE__ === 'undefined') return null;
  try {
    const req = typeof require === 'function' ? require : undefined;
    const AsyncLocalStorage = req?.('node:async_hooks').AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

function inferOp(operation: string): string {
  const trimmed = operation.trim();
  const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(trimmed);
  if (methodMatch) return 'http.server';
  if (trimmed.startsWith('db.') || trimmed.includes('.query')) return 'db';
  if (trimmed.startsWith('http.') || trimmed.includes('fetch') || trimmed.includes('request')) return 'http.client';
  return trimmed.includes('.') ? trimmed.split('.')[0] || trimmed : 'custom';
}
