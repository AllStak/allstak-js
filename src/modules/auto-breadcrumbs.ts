/**
 * Automatic breadcrumb instrumentation for fetch, console, and safe UI clicks
 * in browser environments.
 *
 * These patches are safe: they only wrap if the globals exist and always
 * delegate to the original implementation.
 */
import { mergeBaggageValue, normalizeSpanId, normalizeTraceId, type TracePropagationOptions } from './trace-propagation';
import { redactValue as redactTelemetryValue, scrubStringValue } from '../utils/redact';

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

export interface AutoBreadcrumb {
  type: string;
  message: string;
  level?: string;
  data?: Record<string, unknown>;
}

export type BeforeBreadcrumb = (breadcrumb: AutoBreadcrumb) => AutoBreadcrumb | null | undefined;

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

const CLICK_FLAG = '__allstak_click_patched__';

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
  // Bearer/JWT scrubbing stays here (token-shape, not value-pattern PII).
  // Credit-card + SSN redaction is delegated to the shared value scrubber so
  // the Luhn check is applied — a digit run that FAILS Luhn (e.g. an order id
  // or timestamp) is now preserved instead of being nuked as a fake "card".
  const tokenScrubbed = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]');
  // Always-on financial/identity layer only (email/IP gating is owned by the
  // error/log wire path; the HTTP body-capture path stays value-conservative).
  return scrubStringValue(tokenScrubbed, { scrubValues: true, sendDefaultPii: true });
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

export interface ClickBreadcrumbOptions {
  beforeBreadcrumb?: BeforeBreadcrumb;
  maxSelectorLength?: number;
}

/**
 * Capture privacy-safe click breadcrumbs. The SDK records only a bounded
 * selector summary (tag/id/classes/role/type), never input values or element
 * text. The final breadcrumb is redacted before it reaches the SDK buffer so a
 * custom beforeBreadcrumb hook cannot reintroduce obvious secrets.
 */
export function instrumentClicks(
  addBreadcrumb: AddBreadcrumbFn,
  options: ClickBreadcrumbOptions = {},
): void {
  const doc = (globalThis as any).document;
  if (!doc || typeof doc.addEventListener !== 'function') return;
  if ((doc as any)[CLICK_FLAG]) return;

  const maxSelectorLength = Math.max(32, options.maxSelectorLength ?? 160);
  const handler = (event: Event) => {
    try {
      const target = closestClickable((event as any).target);
      if (!target || isSensitiveClickable(target)) return;
      const selector = selectorSummary(target, maxSelectorLength);
      if (!selector) return;
      const breadcrumb: AutoBreadcrumb = {
        type: 'ui',
        message: `click ${selector}`,
        level: 'info',
        data: { action: 'click', selector, tag: tagName(target) },
      };
      const next = options.beforeBreadcrumb ? options.beforeBreadcrumb(breadcrumb) : breadcrumb;
      if (!next) return;
      const safe = sanitizeAutoBreadcrumb(next);
      addBreadcrumb(safe.type, safe.message, safe.level, safe.data);
    } catch {
      /* click instrumentation must never break the app */
    }
  };

  doc.addEventListener('click', handler, true);
  (doc as any)[CLICK_FLAG] = true;
}

function sanitizeAutoBreadcrumb(breadcrumb: AutoBreadcrumb): AutoBreadcrumb {
  const safe = redactTelemetryValue(
    {
      type: breadcrumb.type,
      message: breadcrumb.message,
      level: breadcrumb.level,
      data: breadcrumb.data,
    },
    { scrubValues: true, sendDefaultPii: false },
  ) as AutoBreadcrumb;
  return {
    type: typeof safe.type === 'string' ? safe.type : 'default',
    message: typeof safe.message === 'string' ? safe.message : '',
    level: typeof safe.level === 'string' ? safe.level : undefined,
    data: safe.data && typeof safe.data === 'object' && !Array.isArray(safe.data)
      ? safe.data as Record<string, unknown>
      : undefined,
  };
}

function closestClickable(target: unknown): Element | null {
  let el = asElement(target);
  while (el) {
    const tag = tagName(el);
    if (
      tag === 'button' ||
      tag === 'a' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      attr(el, 'role') === 'button' ||
      attr(el, 'data-allstak-click') !== null
    ) {
      return el;
    }
    el = asElement((el as unknown as { parentElement?: unknown }).parentElement);
  }
  return asElement(target);
}

function asElement(value: unknown): Element | null {
  if (!value || typeof value !== 'object') return null;
  const maybe = value as { tagName?: unknown; nodeType?: unknown };
  return typeof maybe.tagName === 'string' || maybe.nodeType === 1 ? value as Element : null;
}

function isSensitiveClickable(el: Element): boolean {
  if (tagName(el) !== 'input') return false;
  const type = (attr(el, 'type') ?? '').toLowerCase();
  return type === 'password' || type === 'hidden';
}

function selectorSummary(el: Element, maxLength: number): string {
  const tag = tagName(el) || 'element';
  const parts = [tag];
  const id = cleanSelectorPart(attr(el, 'id'));
  if (id) parts.push(`#${id}`);
  const classes = classNames(el).slice(0, 3).map(cleanSelectorPart).filter(Boolean);
  if (classes.length) parts.push(classes.map((c) => `.${c}`).join(''));
  const role = cleanSelectorPart(attr(el, 'role'));
  if (role) parts.push(`[role="${role}"]`);
  const type = cleanSelectorPart(attr(el, 'type'));
  if (type && tag === 'input') parts.push(`[type="${type}"]`);
  return truncateSelector(parts.join(''), maxLength);
}

function tagName(el: Element): string {
  return ((el as unknown as { tagName?: string }).tagName ?? '').toLowerCase();
}

function attr(el: Element, name: string): string | null {
  try {
    const getter = (el as unknown as { getAttribute?: (n: string) => string | null }).getAttribute;
    if (typeof getter === 'function') return getter.call(el, name);
    const value = (el as unknown as Record<string, unknown>)[name];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function classNames(el: Element): string[] {
  try {
    const list = (el as unknown as { classList?: Iterable<string>; className?: unknown }).classList;
    if (list) return Array.from(list).filter((v): v is string => typeof v === 'string');
    const className = (el as unknown as { className?: unknown }).className;
    return typeof className === 'string' ? className.split(/\s+/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function cleanSelectorPart(value: string | null): string {
  if (!value) return '';
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

function truncateSelector(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, Math.max(0, maxLength - 12)) + '[truncated]';
}

/** @internal - for tests. Resets the click wrap-once flag. */
export function __resetClickInstrumentationFlagForTest(): void {
  const doc = (globalThis as any).document;
  if (doc) delete (doc as any)[CLICK_FLAG];
}
