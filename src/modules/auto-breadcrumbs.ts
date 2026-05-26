/**
 * Automatic breadcrumb instrumentation for fetch and console in browser environments.
 *
 * These patches are safe: they only wrap if the globals exist and always
 * delegate to the original implementation.
 */
import { mergeBaggageValue, normalizeSpanId, normalizeTraceId, type TracePropagationOptions } from './trace-propagation';

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

type CaptureRequestFn = (item: {
  direction: 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  traceId?: string;
  requestId?: string;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBodyCaptureStatus?: string;
  responseBodyCaptureStatus?: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
}) => void;

type TraceContextFn = () =>
  | { traceId?: string; requestId?: string; sampled?: boolean; spanId?: string }
  | undefined;

export type TracePropagationTarget = string | RegExp;

export interface HttpBodyCaptureOptions {
  enabled?: boolean;
  maxBodySize?: number;
  contentTypes?: string[];
  redactFields?: string[];
}

/**
 * Wrap `globalThis.fetch` to record HTTP breadcrumbs AND ship the request
 * to /ingest/v1/http-requests so it shows up on the Requests dashboard.
 *
 * Own-ingest POSTs (to the SDK baseUrl) are skipped to avoid recursion.
 */
export function instrumentFetch(
  addBreadcrumb: AddBreadcrumbFn,
  captureRequest?: CaptureRequestFn,
  ownBaseUrl?: string,
  traceContext?: TraceContextFn,
  bodyCapture?: HttpBodyCaptureOptions,
  tracePropagationTargets?: TracePropagationTarget[],
): void {
  if (typeof globalThis.fetch !== 'function') return;

  const originalFetch = globalThis.fetch;

  globalThis.fetch = async function (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const method = init?.method?.toUpperCase() || 'GET';
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    // Strip query string to avoid leaking sensitive params
    const safePath = url.split('?')[0];

    const isOwnIngest = ownBaseUrl && url.startsWith(ownBaseUrl);
    const correlation = !isOwnIngest ? traceContext?.() : undefined;
    const requestId = correlation?.requestId ?? generateRequestId();
    const traceId = correlation?.traceId;
    const shouldPropagate = !isOwnIngest && traceId && targetMatches(url, tracePropagationTargets);
    const propagatedInit = shouldPropagate
      ? withTraceHeaders(input, init, traceId, requestId, {
          sampled: correlation?.sampled,
          spanId: correlation?.spanId,
        })
      : init;

    let host = '';
    let path = safePath;
    try {
      const u = new URL(url, typeof location !== 'undefined' ? location.href : 'http://localhost');
      host = u.host;
      path = u.pathname || '/';
    } catch {
      /* ignore */
    }

    const start = Date.now();
    try {
      const response = await originalFetch.call(this, input, propagatedInit);
      const durationMs = Date.now() - start;
      addBreadcrumb(
        'http',
        `${method} ${safePath} -> ${response.status}`,
        response.status >= 400 ? 'error' : 'info',
        { method, url: safePath, statusCode: response.status, durationMs },
      );
      if (captureRequest && !isOwnIngest) {
        try {
          const captured = await captureBodies(input, propagatedInit, response, bodyCapture);
          captureRequest({
            direction: 'outbound',
            method,
            host,
            path,
            statusCode: response.status,
            durationMs,
            traceId,
            requestId,
            ...captured,
          });
        } catch {
          /* never break host */
        }
      }
      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      addBreadcrumb('http', `${method} ${safePath} -> failed`, 'error', {
        method,
        url: safePath,
        error: String(err),
        durationMs,
      });
      if (captureRequest && !isOwnIngest) {
        try {
          captureRequest({
            direction: 'outbound',
            method,
            host,
            path,
            statusCode: 0,
            durationMs,
            traceId,
            requestId,
          });
        } catch {
          /* never break host */
        }
      }
      throw err;
    }
  };
}

async function captureBodies(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
  options?: HttpBodyCaptureOptions,
): Promise<Pick<Parameters<CaptureRequestFn>[0],
  'requestBody' | 'responseBody' | 'requestHeaders' | 'responseHeaders' |
  'requestBodyCaptureStatus' | 'responseBodyCaptureStatus' | 'requestBodyCaptureReason' | 'responseBodyCaptureReason'
>> {
  if (!options?.enabled) {
    return {
      requestBodyCaptureStatus: 'disabled',
      responseBodyCaptureStatus: 'disabled',
      requestBodyCaptureReason: 'HTTP body capture is disabled by SDK configuration.',
      responseBodyCaptureReason: 'HTTP body capture is disabled by SDK configuration.',
    };
  }

  const requestHeaders = headersToObject(init?.headers);
  const responseHeaders = headersToObject(response.headers);
  const contentTypes = options.contentTypes ?? ['application/json', 'text/plain'];
  const maxBodySize = Math.max(0, options.maxBodySize ?? 8_192);

  const requestCapture = typeof init?.body === 'string'
    ? sanitizeBody(init.body, requestHeaders['content-type'], contentTypes, maxBodySize, options.redactFields)
    : { status: 'unsupported', reason: 'Request body was not a string init.body and cannot be safely cloned.' };

  let responseCapture: BodySanitization = { status: 'unsupported', reason: 'Response content type is not allowlisted for body capture.' };
  const responseContentType = responseHeaders['content-type'];
  if (isAllowedContentType(responseContentType, contentTypes)) {
    try {
      responseCapture = sanitizeBody(await response.clone().text(), responseContentType, contentTypes, maxBodySize, options.redactFields);
    } catch {
      responseCapture = { status: 'unsupported', reason: 'Response body could not be cloned safely.' };
    }
  }

  // The Request object body is a stream and cannot be read safely without
  // changing app behavior. Only explicit init.body strings are captured.
  void input;
  return {
    requestBody: requestCapture.body,
    responseBody: responseCapture.body,
    requestHeaders: sanitizeHeaders(requestHeaders),
    responseHeaders: sanitizeHeaders(responseHeaders),
    requestBodyCaptureStatus: requestCapture.status,
    responseBodyCaptureStatus: responseCapture.status,
    requestBodyCaptureReason: requestCapture.reason,
    responseBodyCaptureReason: responseCapture.reason,
  };
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => { out[key.toLowerCase()] = value; });
  return out;
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase();
    out[normalized] = /authorization|cookie|token|secret|password|otp|session/i.test(normalized)
      ? '[REDACTED]'
      : value;
  }
  return out;
}

interface BodySanitization {
  body?: string;
  status: string;
  reason?: string;
}

function sanitizeBody(
  body: string,
  contentType: string | undefined,
  allowedContentTypes: string[],
  maxBodySize: number,
  customFields?: string[],
): BodySanitization {
  if (!isAllowedContentType(contentType, allowedContentTypes)) {
    return { status: 'unsupported', reason: 'Content type is not allowlisted for HTTP body capture.' };
  }
  const truncated = body.length > maxBodySize;
  const raw = truncated ? body.slice(0, maxBodySize) + '\n[TRUNCATED]' : body;
  let sanitized: string;
  try {
    const parsed = JSON.parse(raw.replace(/\n\[TRUNCATED]$/, ''));
    sanitized = JSON.stringify(redactValue(parsed, customFields), null, 2) + (truncated ? '\n[TRUNCATED]' : '');
  } catch {
    sanitized = redactText(raw);
  }
  const redacted = sanitized !== raw;
  return {
    body: sanitized,
    status: truncated ? 'truncated' : redacted ? 'redacted' : 'captured',
    reason: truncated ? `Body exceeded configured max size of ${maxBodySize} bytes.` :
      redacted ? 'Sensitive fields or values were redacted before transport.' : undefined,
  };
}

function isAllowedContentType(contentType: string | undefined, allowed: string[]): boolean {
  if (!contentType) return false;
  return allowed.some((candidate) => contentType.toLowerCase().includes(candidate.toLowerCase()));
}

function redactValue(value: unknown, customFields: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, customFields));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key, customFields) ? '[REDACTED]' : redactValue(child, customFields);
    }
    return out;
  }
  if (typeof value === 'string') return redactText(value);
  return value;
}

function isSensitiveKey(key: string, customFields: string[]): boolean {
  return /password|passcode|authorization|cookie|otp|token|jwt|secret|refresh|iban|national.?id|card/i.test(key) ||
    customFields.some((field) => field.toLowerCase() === key.toLowerCase());
}

function redactText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, '[REDACTED_CARD]');
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function targetMatches(url: string, targets?: TracePropagationTarget[]): boolean {
  if (!targets || targets.length === 0) return true;
  return targets.some((target) => typeof target === 'string' ? url.includes(target) : target.test(url));
}

function withTraceHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  traceId: string,
  requestId: string,
  options?: TracePropagationOptions,
): RequestInit {
  const next: RequestInit = { ...(init ?? {}) };
  const headers = new Headers(init?.headers ?? requestHeadersFromInput(input));
  const sampled = options?.sampled !== false; // default sampled (back-compat)
  // Prefer the active span id; fall back to the requestId-derived parent.
  const rawSpanId = options?.spanId && options.spanId.length > 0 ? options.spanId : requestId;
  const spanId = normalizeSpanId(rawSpanId.replace(/-/g, ''));
  const flag = sampled ? '01' : '00';
  const traceparent = `00-${normalizeTraceId(traceId)}-${spanId}-${flag}`;
  const baggage = [
    `allstak-trace_id=${encodeURIComponent(traceId)}`,
    `allstak-span_id=${encodeURIComponent(spanId)}`,
    `allstak-request_id=${encodeURIComponent(requestId)}`,
  ].join(',');

  setHeaderIfMissing(headers, 'traceparent', traceparent);
  setHeaderIfMissing(headers, 'allstak-trace', `${traceId}-${spanId}-${sampled ? '1' : '0'}`);
  mergeAllStakBaggage(headers, baggage);
  setHeaderIfMissing(headers, 'x-allstak-trace-id', traceId);
  setHeaderIfMissing(headers, 'x-allstak-request-id', requestId);
  next.headers = headers;
  return next;
}

function requestHeadersFromInput(input: RequestInfo | URL): HeadersInit | undefined {
  if (typeof Request !== 'undefined' && input instanceof Request) return input.headers;
  return undefined;
}

function setHeaderIfMissing(headers: Headers, key: string, value: string): void {
  if (!headers.has(key)) headers.set(key, value);
}

function mergeAllStakBaggage(headers: Headers, baggage: string): void {
  const allstakBaggage = headers.get('allstak-baggage');
  if (!allstakBaggage) {
    headers.set('allstak-baggage', baggage);
  } else {
    headers.set('allstak-baggage', mergeBaggageValue(allstakBaggage, baggage));
  }

  const standardBaggage = headers.get('baggage');
  if (!standardBaggage) {
    headers.set('baggage', baggage);
  } else {
    headers.set('baggage', mergeBaggageValue(standardBaggage, baggage));
  }
}


/**
 * Wrap `console.warn` and `console.error` to record log breadcrumbs.
 */
export function instrumentConsole(addBreadcrumb: AddBreadcrumbFn): void {
  if (typeof console === 'undefined') return;

  const origWarn = console.warn;
  const origError = console.error;

  console.warn = function (...args: unknown[]) {
    addBreadcrumb('log', args.map(String).join(' '), 'warn');
    origWarn.apply(console, args);
  };

  console.error = function (...args: unknown[]) {
    addBreadcrumb('log', args.map(String).join(' '), 'error');
    origError.apply(console, args);
  };
}
