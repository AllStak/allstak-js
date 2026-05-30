/**
 * Shared trace-propagation primitives — the single source of truth for the
 * AllStak distributed-tracing wire format (W3C `traceparent` + `baggage` +
 * `x-allstak-*`). Used by both the fetch instrumentation (Headers-based) and
 * the Node `http`/`https` instrumentation (plain header objects), so a browser
 * → Node → downstream chain shares one trace.
 */
import type { TracePropagationTarget } from './auto-breadcrumbs';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const ZERO_TRACE_ID_RE = /^0{32}$/;
const ZERO_SPAN_ID_RE = /^0{16}$/;

function randomHex(byteLength: number): string {
  const g = globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const bytes = new Uint8Array(byteLength);
    g.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  return Array.from({ length: byteLength * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

export function newTraceId(): string {
  let id = randomHex(16).toLowerCase();
  if (ZERO_TRACE_ID_RE.test(id)) id = `1${id.slice(1)}`;
  return id;
}

export function newSpanId(): string {
  let id = randomHex(8).toLowerCase();
  if (ZERO_SPAN_ID_RE.test(id)) id = `1${id.slice(1)}`;
  return id;
}

function hexOnly(value: string): string {
  return value.replace(/[^0-9a-f]/gi, '').toLowerCase();
}

export function isValidTraceId(traceId: string | undefined): traceId is string {
  return !!traceId && TRACE_ID_RE.test(traceId) && !ZERO_TRACE_ID_RE.test(traceId);
}

export function isValidSpanId(spanId: string | undefined): spanId is string {
  return !!spanId && SPAN_ID_RE.test(spanId) && !ZERO_SPAN_ID_RE.test(spanId);
}

export function normalizeTraceId(traceId: string): string {
  const hex = hexOnly(traceId);
  if (hex.length === 32 && !ZERO_TRACE_ID_RE.test(hex)) return hex;
  if (hex.length > 32) {
    const sliced = hex.slice(0, 32);
    return ZERO_TRACE_ID_RE.test(sliced) ? newTraceId() : sliced;
  }
  if (hex.length > 0) {
    const padded = hex.padEnd(32, '0');
    return ZERO_TRACE_ID_RE.test(padded) ? newTraceId() : padded;
  }
  return newTraceId();
}

export function normalizeSpanId(spanId: string): string {
  const hex = hexOnly(spanId);
  if (hex.length === 16 && !ZERO_SPAN_ID_RE.test(hex)) return hex;
  if (hex.length > 16) {
    const sliced = hex.slice(0, 16);
    return ZERO_SPAN_ID_RE.test(sliced) ? newSpanId() : sliced;
  }
  if (hex.length > 0) {
    const padded = hex.padEnd(16, '0');
    return ZERO_SPAN_ID_RE.test(padded) ? newSpanId() : padded;
  }
  return newSpanId();
}

export interface ParsedTraceparent {
  traceId: string;
  parentSpanId: string;
  sampled: boolean;
}

export function parseTraceparent(header: string | undefined): ParsedTraceparent | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec((header ?? '').trim());
  if (!match) return undefined;
  const traceId = match[1].toLowerCase();
  const parentSpanId = match[2].toLowerCase();
  if (!isValidTraceId(traceId) || !isValidSpanId(parentSpanId)) return undefined;
  return {
    traceId,
    parentSpanId,
    sampled: (parseInt(match[3], 16) & 0x01) === 0x01,
  };
}

/** Merge incoming AllStak baggage members into an existing baggage string, preserving vendor members. */
export function mergeBaggageValue(existing: string, baggage: string): string {
  const preserved = existing
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part && !part.toLowerCase().startsWith('allstak-'));
  return [...preserved, ...baggage.split(',')].join(',');
}

export interface TracePropagationValues {
  traceparent: string;
  allstakTrace: string;
  baggage: string;
  traceId: string;
  requestId: string;
}

/**
 * Options controlling the propagated W3C head-of-trace state.
 *
 * - `sampled` — the head-of-trace sampling decision. `true` → traceparent
 *   flag `-01`, `false` → `-00`. Defaults to `true` to preserve the historical
 *   always-sampled propagation behavior for callers that don't pass a value.
 * - `spanId` — the active span id to advertise as the parent span. When
 *   provided (and non-empty) it is used verbatim (normalized to 16 hex chars);
 *   otherwise the parent span id is derived from `requestId` as before.
 */
export interface TracePropagationOptions {
  sampled?: boolean;
  spanId?: string;
}

/** Computes the propagation header values for a trace/request pair. */
export function tracePropagationValues(
  traceId: string,
  requestId: string,
  options?: TracePropagationOptions,
): TracePropagationValues {
  const sampled = options?.sampled !== false; // default: sampled (back-compat)
  // Prefer the active span id when one exists; otherwise derive from requestId.
  const rawSpanId = options?.spanId && options.spanId.length > 0 ? options.spanId : requestId;
  const wireTraceId = normalizeTraceId(traceId);
  const spanId = normalizeSpanId(rawSpanId);
  const flag = sampled ? '01' : '00';
  const traceparent = `00-${wireTraceId}-${spanId}-${flag}`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(wireTraceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`,
  ].join(',');
  return { traceparent, allstakTrace: `${wireTraceId}-${spanId}-${sampled ? '1' : '0'}`, baggage, traceId: wireTraceId, requestId };
}

type HeaderBag = Record<string, unknown>;

function findKey(headers: HeaderBag, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return key;
  }
  return undefined;
}

function setIfMissing(headers: HeaderBag, name: string, value: string): void {
  if (!findKey(headers, name)) headers[name] = value;
}

function mergeBaggageInto(headers: HeaderBag, name: string, baggage: string): void {
  const key = findKey(headers, name);
  if (!key) {
    headers[name] = baggage;
    return;
  }
  const existing = headers[key];
  const existingStr = Array.isArray(existing) ? existing.join(',') : String(existing ?? '');
  headers[key] = mergeBaggageValue(existingStr, baggage);
}

/**
 * Applies AllStak trace-propagation headers to a Node-style plain header object,
 * in place. Existing user headers are respected (set-if-missing); baggage is
 * merged. Header lookups are case-insensitive.
 */
export function applyTracePropagationToHeaders(
  headers: HeaderBag,
  traceId: string,
  requestId: string,
  options?: TracePropagationOptions,
): void {
  const p = tracePropagationValues(traceId, requestId, options);
  setIfMissing(headers, 'traceparent', p.traceparent);
  setIfMissing(headers, 'allstak-trace', p.allstakTrace);
  mergeBaggageInto(headers, 'allstak-baggage', p.baggage);
  mergeBaggageInto(headers, 'baggage', p.baggage);
  setIfMissing(headers, 'x-allstak-trace-id', p.traceId);
  setIfMissing(headers, 'x-allstak-request-id', p.requestId);
}

/** Whether an outbound URL is allowed to receive trace headers (empty targets = all). */
export function targetMatches(url: string, targets?: TracePropagationTarget[]): boolean {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => (typeof target === 'string' ? url.includes(target) : target.test(url)));
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
