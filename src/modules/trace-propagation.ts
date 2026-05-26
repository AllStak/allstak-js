/**
 * Shared trace-propagation primitives — the single source of truth for the
 * AllStak distributed-tracing wire format (W3C `traceparent` + `baggage` +
 * `x-allstak-*`). Used by both the fetch instrumentation (Headers-based) and
 * the Node `http`/`https` instrumentation (plain header objects), so a browser
 * → Node → downstream chain shares one trace.
 */
import type { TracePropagationTarget } from './auto-breadcrumbs';

export function normalizeTraceId(traceId: string): string {
  return traceId.replace(/-/g, '').slice(0, 32).padEnd(32, '0');
}

export function normalizeSpanId(spanId: string): string {
  return spanId.replace(/-/g, '').slice(0, 16).padEnd(16, '0');
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
  const spanId = normalizeSpanId(rawSpanId.replace(/-/g, ''));
  const flag = sampled ? '01' : '00';
  const traceparent = `00-${normalizeTraceId(traceId)}-${spanId}-${flag}`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(traceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`,
  ].join(',');
  return { traceparent, allstakTrace: `${traceId}-${spanId}-${sampled ? '1' : '0'}`, baggage, traceId, requestId };
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
