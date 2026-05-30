import { HttpTransport } from '../transport/http';
import {
  isValidSpanId,
  isValidTraceId,
  newSpanId,
  newTraceId,
  normalizeSpanId,
  normalizeTraceId,
} from './trace-propagation';

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

/**
 * Context passed to {@link AllStakConfig.tracesSampler} when deciding whether a
 * trace is sampled. The decision is made once, at the root of a trace, and
 * inherited by all child spans (W3C sticky head-of-trace).
 */
export interface SamplingContext {
  /** Operation name of the root span starting this trace. */
  name: string;
  /**
   * Sampling decision inherited from an incoming `traceparent`, if any.
   * `true`/`false` when a parent decision was propagated in, otherwise
   * `undefined` (this service is the head of the trace).
   */
  parentSampled?: boolean;
  /** Attributes/tags supplied to the root span. */
  attributes: Record<string, string>;
}

/**
 * Function form of traces sampling. Receives the {@link SamplingContext} and
 * returns either a boolean (sampled / not) or a number in [0, 1] used as the
 * probability of sampling this trace.
 */
export type TracesSampler = (context: SamplingContext) => number | boolean;

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
  /**
   * Sticky head-of-trace sampling decision for this trace. `null`/`undefined`
   * means "not yet decided" — the first span to start in this context computes
   * it and all later spans in the same trace inherit it.
   */
  sampled?: boolean | null;
  /** Sampling decision inherited from an incoming `traceparent`, if any. */
  parentSampled?: boolean;
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
  private tracesSampleRate?: number;
  private tracesSampler?: TracesSampler;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    transport: HttpTransport,
    config: {
      service?: string;
      environment?: string;
      platform?: string;
      beforeSendSpan?: SpanProcessor;
      ignoreSpans?: SpanFilterPattern[];
      tracesSampleRate?: number;
      tracesSampler?: TracesSampler;
    },
  ) {
    this.transport = transport;
    this.service = config.service || '';
    this.environment = config.environment || '';
    this.platform = config.platform || '';
    this.beforeSendSpan = config.beforeSendSpan;
    this.ignoreSpans = config.ignoreSpans ?? [];
    this.tracesSampleRate = config.tracesSampleRate;
    this.tracesSampler = config.tracesSampler;
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
  withTraceContext<T>(traceId: string | undefined, requestId: string | undefined, callback: () => T, parentSpanId?: string): T;
  withTraceContext<T>(
    traceId: string | undefined,
    requestIdOrCallback: string | undefined | (() => T),
    maybeCallback?: () => T,
    parentSpanId?: string,
  ): T {
    const requestId = typeof requestIdOrCallback === 'function' ? undefined : requestIdOrCallback;
    const callback = typeof requestIdOrCallback === 'function' ? requestIdOrCallback : maybeCallback!;
    const normalizedTraceId = traceId ? normalizeTraceId(traceId) : null;
    const spanStack = parentSpanId ? [normalizeSpanId(parentSpanId)] : [];
    if (!this.asyncStorage) {
      if (normalizedTraceId) this.globalState.traceId = normalizedTraceId;
      if (requestId) this.globalState.requestId = requestId;
      if (spanStack.length > 0) this.globalState.spanStack = spanStack;
      return callback();
    }
    return this.asyncStorage.run(
      { traceId: normalizedTraceId, requestId: requestId ?? null, spanStack, sampled: null },
      callback,
    );
  }

  private state(): TraceState {
    return this.asyncStorage?.getStore() ?? this.globalState;
  }

  /**
   * Record the sampling decision inherited from an incoming `traceparent`.
   * Surfaced to {@link TracesSampler} as `parentSampled`; when no
   * `tracesSampler`/`tracesSampleRate` is configured this has no effect on the
   * local decision (back-compat: tracing stays always-on).
   */
  setParentSampled(parentSampled: boolean | undefined): void {
    this.state().parentSampled = parentSampled;
  }

  /**
   * The sticky head-of-trace sampling decision for the current trace. Returns
   * `true` when undecided so propagation/recording stay in the historical
   * always-sampled behavior until a decision is forced.
   */
  getSampled(): boolean {
    const sampled = this.state().sampled;
    return sampled === undefined || sampled === null ? true : sampled;
  }

  /** Get the current trace ID, creating one if none exists. */
  getTraceId(): string {
    const state = this.state();
    if (!state.traceId) {
      state.traceId = newTraceId();
    }
    return state.traceId;
  }

  /** Set the trace ID explicitly (e.g. from an incoming request header). */
  setTraceId(traceId: string): void {
    this.state().traceId = normalizeTraceId(traceId);
  }

  /**
   * Continue a validated inbound W3C trace. Unlike setTraceId(), this rejects
   * malformed IDs and seeds the span stack with the upstream parent span so the
   * next local span is correctly linked as a child.
   */
  continueTrace(traceId: string, parentSpanId?: string, sampled?: boolean): boolean {
    const normalizedTraceId = traceId.trim().toLowerCase();
    if (!isValidTraceId(normalizedTraceId)) return false;

    let normalizedParentSpanId = '';
    if (parentSpanId != null && parentSpanId.trim() !== '') {
      normalizedParentSpanId = parentSpanId.trim().toLowerCase();
      if (!isValidSpanId(normalizedParentSpanId)) return false;
    }

    const state = this.state();
    state.traceId = normalizedTraceId;
    state.spanStack = normalizedParentSpanId ? [normalizedParentSpanId] : [];
    state.parentSampled = typeof sampled === 'boolean' ? sampled : undefined;
    state.sampled = typeof sampled === 'boolean' ? sampled : null;
    return true;
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

  getCurrentTraceId(): string | null {
    return this.state().traceId;
  }

  getActiveSpanCount(): number {
    return this.state().spanStack.length;
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
    const spanId = newSpanId();
    const parentSpanId = this.getCurrentSpanId() || '';
    const traceId = this.getTraceId();

    // Sticky head-of-trace decision: computed once (at the root span) using the
    // root span's name/attributes, then inherited by every child span.
    const recorded = this.ensureSamplingDecision(operation, {
      ...(options?.tags || {}),
      ...(options?.attributes || {}),
    });

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
        // Unsampled traces are dropped before any processor/transport work.
        if (!recorded) return;
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

  /**
   * Emit a fully-formed span that was assembled outside the normal
   * start/finish lifecycle (e.g. Core Web Vitals, which are observed
   * asynchronously and reported at page-hide as a single `web.vital` span).
   *
   * The span still runs through the same ignore-list + span-processor +
   * beforeSendSpan pipeline and the same batched transport (so it respects the
   * offline queue and retry/backoff). Service/environment/platform defaults are
   * back-filled from the module config when the caller leaves them blank. Any
   * caller-supplied `traceId`/`spanId` are kept, otherwise fresh ids are minted
   * so the span is self-contained. Fully fail-open.
   */
  emitSpan(partial: Partial<SpanData> & { operation: string }): void {
    try {
      const now = Date.now();
      const spanData: SpanData = {
        traceId: partial.traceId ? normalizeTraceId(partial.traceId) : newTraceId(),
        spanId: partial.spanId ? normalizeSpanId(partial.spanId) : newSpanId(),
        parentSpanId: partial.parentSpanId ? normalizeSpanId(partial.parentSpanId) : '',
        operation: partial.operation,
        description: partial.description ?? '',
        status: partial.status ?? 'ok',
        durationMs: partial.durationMs ?? 0,
        startTimeMillis: partial.startTimeMillis ?? now,
        endTimeMillis: partial.endTimeMillis ?? now,
        service: partial.service ?? this.service,
        environment: partial.environment ?? this.environment,
        tags: partial.tags ?? {},
        data: partial.data ?? '',
        op: partial.op ?? inferOp(partial.operation),
        platform: partial.platform ?? this.platform,
        measurements: partial.measurements,
        attributes: partial.attributes,
      };
      const finalSpan = this.processSpan(spanData);
      if (!finalSpan) return;
      this.completedSpans.push(finalSpan);
      // Vitals are emitted at page-hide; flush immediately so the unload-time
      // beacon/persist path can pick them up rather than waiting for the timer.
      this.flush();
    } catch {
      /* fail-open: telemetry emission must never break the host page */
    }
  }

  /** Reset trace context — clears trace ID and span stack. */
  resetTrace(): void {
    const state = this.state();
    state.traceId = null;
    state.requestId = null;
    state.spanStack = [];
    state.sampled = null;
    state.parentSampled = undefined;
  }

  /**
   * Resolve (and memoize) the sticky head-of-trace sampling decision for the
   * current trace.
   *
   * Precedence:
   * 1. A decision already made for this trace is reused (sticky inheritance).
   * 2. `tracesSampler(context)` — return value coerced to a decision.
   * 3. `tracesSampleRate` — probabilistic.
   * 4. Neither configured → `true` (BACK-COMPAT default: existing users who set
   *    nothing keep full tracing; we never silently disable it).
   */
  private ensureSamplingDecision(operation: string, attributes: Record<string, string>): boolean {
    const state = this.state();
    if (state.sampled === true || state.sampled === false) return state.sampled;

    let decision: boolean;
    if (this.tracesSampler) {
      const context: SamplingContext = {
        name: operation,
        parentSampled: state.parentSampled,
        attributes,
      };
      let result: number | boolean;
      try {
        result = this.tracesSampler(context);
      } catch {
        // A throwing sampler must not break tracing — fall back to "sampled".
        result = true;
      }
      decision = typeof result === 'number' ? rollSample(result) : !!result;
    } else if (typeof this.tracesSampleRate === 'number') {
      decision = rollSample(this.tracesSampleRate);
    } else {
      // Back-compat: no traces sampling configured → keep current behavior.
      decision = true;
    }

    state.sampled = decision;
    return decision;
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
  const proc = (globalThis as any).process;
  if (typeof globalThis.__ALLSTAK_NODE__ === 'undefined' && !proc?.versions?.node) return null;
  try {
    const fromProcess = proc?.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof require === 'function' ? require : undefined;
    const AsyncLocalStorage = req?.('node:async_hooks').AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
}

/** Coerce a sample rate in [0, 1] into a boolean decision. */
function rollSample(rate: number): boolean {
  if (!(typeof rate === 'number') || Number.isNaN(rate)) return true;
  const clamped = Math.max(0, Math.min(1, rate));
  if (clamped >= 1) return true;
  if (clamped <= 0) return false;
  return Math.random() < clamped;
}

function inferOp(operation: string): string {
  const trimmed = operation.trim();
  const methodMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.exec(trimmed);
  if (methodMatch) return 'http.server';
  if (trimmed.startsWith('db.') || trimmed.includes('.query')) return 'db';
  if (trimmed.startsWith('http.') || trimmed.includes('fetch') || trimmed.includes('request')) return 'http.client';
  return trimmed.includes('.') ? trimmed.split('.')[0] || trimmed : 'custom';
}
