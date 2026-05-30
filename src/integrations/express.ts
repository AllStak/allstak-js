/**
 * Drop-in Express middleware for the AllStak SDK.
 *
 * Usage:
 * ```ts
 * import express from 'express';
 * import { AllStak } from '@allstak/js';
 * import { allstakExpress } from '@allstak/js/express';
 *
 * AllStak.init({ apiKey: 'ask_live_…', environment: 'production' });
 *
 * const app = express();
 *
 * // Mount BEFORE your routes — this opens the request span and captures the
 * // inbound request, sets the per-request context, and auto-attaches the
 * // authenticated user (req.user) onto error events.
 * app.use(allstakExpress.requestHandler());
 *
 * app.get('/tasks', (req, res) => { … });
 *
 * // Mount AFTER your routes — captures any error thrown by an Express route
 * // or middleware via the error-handling-middleware signature.
 * app.use(allstakExpress.errorHandler());
 * ```
 */

import { AllStak } from '../index';
import type { Span } from '../modules/tracing';
import type { HttpBodyCaptureOptions } from '../modules/auto-breadcrumbs';
import { isValidTraceId, parseTraceparent } from '../modules/trace-propagation';
import { redactHeaderRecord, redactValue } from '../utils/redact';

// Minimal Express type-shapes — we don't depend on @types/express to keep
// the SDK install footprint small. Customers who already have @types/express
// installed get full inference automatically.
interface ExpressRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  route?: { path?: string | RegExp | Array<string | RegExp> };
  baseUrl?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { id?: string | number; email?: string; [k: string]: unknown };
  [k: string]: unknown;
}
interface ExpressResponse {
  statusCode: number;
  getHeader(name: string): unknown;
  setHeader?(name: string, value: unknown): void;
  on(event: 'finish' | 'close', cb: () => void): void;
  send?: (body?: unknown) => unknown;
  json?: (body?: unknown) => unknown;
  [k: string]: unknown;
}
type NextFn = (err?: unknown) => void;

interface ExpressRequestHandlerOptions {
  /**
   * Capture inbound Express request/response bodies. Defaults to the global
   * `httpBodyCapture` SDK option. Bodies are redacted and size-limited before
   * transport; auth/cookie/session headers are always redacted.
   */
  bodyCapture?: HttpBodyCaptureOptions | boolean;
}

function pathFromRequest(req: ExpressRequest): string {
  const raw = req.originalUrl ?? req.url ?? req.path ?? '/';
  // Strip query string for stable grouping
  const qIdx = raw.indexOf('?');
  return qIdx >= 0 ? raw.substring(0, qIdx) : raw;
}

function methodOf(req: ExpressRequest): 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS' {
  const m = (req.method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'POST' || m === 'PUT' || m === 'DELETE' || m === 'PATCH' || m === 'HEAD' || m === 'OPTIONS') {
    return m;
  }
  return 'GET';
}

function hostOf(req: ExpressRequest): string {
  if (req.hostname) return req.hostname;
  const h = req.headers?.host;
  if (typeof h === 'string') return h;
  return 'unknown';
}

function routeOf(req: ExpressRequest): string | undefined {
  const routePath = req.route?.path;
  const route = Array.isArray(routePath)
    ? routePath.map(String).join('|')
    : routePath != null
      ? String(routePath)
      : undefined;
  if (!route) return undefined;
  return `${req.baseUrl ?? ''}${route}`;
}

function queryOf(req: ExpressRequest): string | undefined {
  const raw = req.originalUrl ?? req.url;
  if (!raw) return undefined;
  const qIdx = raw.indexOf('?');
  return qIdx >= 0 ? raw.substring(qIdx) : undefined;
}

function userAgentOf(req: ExpressRequest): string | undefined {
  return firstHeader(req.headers['user-agent']);
}

function userFromRequest(req: ExpressRequest): { id?: string; email?: string } | null {
  const u = req.user;
  if (!u || typeof u !== 'object') return null;
  const id = u.id != null ? String(u.id) : undefined;
  const email = typeof u.email === 'string' ? u.email : undefined;
  if (!id && !email) return null;
  return { id, email };
}

export const allstakExpress = {
  /**
   * Mount this BEFORE your routes. Opens a root span for the request,
   * captures the inbound HTTP request (with real round-trip timing) when
   * the response finishes, and auto-attaches `req.user` onto subsequent
   * captures.
   */
  requestHandler(options: ExpressRequestHandlerOptions = {}) {
    return function allstakRequestHandler(req: ExpressRequest, res: ExpressResponse, next: NextFn): void {
      const sdk = AllStak._getInstance();
      if (!sdk) {
        next();
        return;
      }

      const start = Date.now();
      const path = pathFromRequest(req);
      const method = methodOf(req);
      const host = hostOf(req);
      const route = routeOf(req);
      const requestId = firstHeader(req.headers['x-allstak-request-id'])
        ?? firstHeader(req.headers['x-request-id'])
        ?? generateRequestId();
      const bodyCapture = resolveBodyCapture(sdk.getOptions().httpBodyCapture, options.bodyCapture);
      const responseCapture = installResponseCapture(res);
      try {
        res.setHeader?.('x-allstak-request-id', requestId);
      } catch {
        /* best effort */
      }

      // Honor a valid upstream W3C traceparent first. Invalid inbound trace
      // headers are ignored so bad custom headers cannot poison the trace.
      const upstream = parseTraceparent(firstHeader(req.headers['traceparent']));
      const upstreamTrace = upstream?.traceId
        ?? validTraceHeader(firstHeader(req.headers['x-allstak-trace-id']))
        ?? validTraceHeader(firstHeader(req.headers['x-trace-id']));
      const upstreamParentSpanId = upstream?.parentSpanId;
      const upstreamSampled = upstream?.sampled;

      sdk.withTraceContext(upstreamTrace, requestId, () => {
        // Surface the inbound sampling decision to a configured tracesSampler.
        sdk.setParentSampled(upstreamSampled);
        const traceId = sdk.getTraceId();
        // Open a root span for this request.
        let rootSpan: Span | null = null;
        try {
          rootSpan = sdk.startSpan(`${method} ${path}`, {
            description: `HTTP ${method} ${path}`,
            op: 'http.server',
            platform: 'node',
            tags: {
              'http.method': method,
              'http.url': path,
              'http.host': host,
              'http.request_id': requestId,
            },
            attributes: {
              'http.method': method,
              'http.route': route || path,
              'http.target': path,
              'http.host': host,
              'http.request_id': requestId,
              'allstak.request_id': requestId,
            },
          });
        } catch {
          /* never break the request */
        }

        let finalized = false;
        const finalize = (): void => {
          if (finalized) return;
          finalized = true;
          try {
            const durationMs = Date.now() - start;
            const u = userFromRequest(req);
            if (u) sdk.setUser(u);

            AllStak.captureRequest({
              traceId,
              requestId,
              spanId: rootSpan?.spanId,
              parentSpanId: upstreamParentSpanId,
              direction: 'inbound',
              method,
              host,
              path,
              statusCode: res.statusCode,
              durationMs,
              requestHeaders: redactHeaders(req.headers, (sdk.getOptions() as any).redactKeys),
              responseHeaders: redactResponseHeaders(res, (sdk.getOptions() as any).redactKeys),
              ...captureInboundBodies(req, responseCapture.body, responseCapture.contentType, bodyCapture),
              userId: u?.id,
              timestamp: new Date(start).toISOString(),
            });

            if (rootSpan) {
              try {
                if (route) {
                  (rootSpan as unknown as { setTag?: (k: string, v: string) => void }).setTag?.(
                    'http.route',
                    route,
                  );
                }
                (rootSpan as unknown as { setTag?: (k: string, v: string) => void }).setTag?.(
                  'http.status_code',
                  String(res.statusCode),
                );
                rootSpan.finish(res.statusCode >= 500 ? 'error' : 'ok');
              } catch {
                /* best effort */
              }
            }
            sdk.resetTrace();
          } catch {
            /* never break the response */
          }
        };
        res.on('finish', finalize);
        res.on('close', finalize);

        next();
      }, upstreamParentSpanId);
    };
  },

  /**
   * Mount this AFTER your routes. Captures any error thrown by an Express
   * route or middleware (including async errors forwarded via `next(err)`).
   */
  errorHandler() {
    return function allstakErrorHandler(
      err: unknown,
      req: ExpressRequest,
      _res: ExpressResponse,
      next: NextFn,
    ): void {
      try {
        const sdk = AllStak._getInstance();
        if (sdk) {
          const u = userFromRequest(req);
          if (u) sdk.setUser(u);
          const e = err instanceof Error ? err : new Error(String(err));
          const method = methodOf(req);
          const path = pathFromRequest(req);
          const host = hostOf(req);
          const route = routeOf(req);
          const requestId = firstHeader(req.headers['x-allstak-request-id'])
            ?? firstHeader(req.headers['x-request-id'])
            ?? sdk.getRequestId()
            ?? undefined;
          AllStak.captureException(e, {
            traceId: sdk.getTraceId(),
            requestId,
            spanId: sdk.getCurrentSpanId() ?? undefined,
            transaction: route ? `${method} ${route}` : `${method} ${path}`,
            requestContext: {
              method,
              path,
              host,
              route,
              query: queryOf(req),
              userAgent: userAgentOf(req),
            },
            'request.method': method,
            'request.path': path,
            'request.host': host,
            ...(requestId ? { 'request.id': requestId } : {}),
            ...(route ? { 'request.route': route } : {}),
          });
        }
      } catch {
        /* never break the error pipeline */
      }
      next(err);
    };
  },
};

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function validTraceHeader(header: string | undefined): string | undefined {
  const value = header?.trim().toLowerCase();
  return isValidTraceId(value) ? value : undefined;
}

function generateRequestId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function resolveBodyCapture(
  globalOption: HttpBodyCaptureOptions | undefined,
  localOption: ExpressRequestHandlerOptions['bodyCapture'],
): HttpBodyCaptureOptions | false {
  const option = localOption === undefined ? globalOption : localOption;
  if (option === true) return { enabled: true };
  if (!option || option.enabled === false) return false;
  return option;
}

function installResponseCapture(res: ExpressResponse): { body: unknown; contentType?: string } {
  const captured: { body: unknown; contentType?: string } = { body: undefined };
  const originalSend = typeof res.send === 'function' ? res.send.bind(res) : null;
  const originalJson = typeof res.json === 'function' ? res.json.bind(res) : null;

  if (originalSend) {
    res.send = (body?: unknown) => {
      captured.body = body;
      captured.contentType = headerToString(res.getHeader('content-type'));
      return originalSend(body);
    };
  }
  if (originalJson) {
    res.json = (body?: unknown) => {
      captured.body = body;
      captured.contentType = headerToString(res.getHeader('content-type')) ?? 'application/json';
      return originalJson(body);
    };
  }
  return captured;
}

function captureInboundBodies(
  req: ExpressRequest,
  responseBody: unknown,
  responseContentType: string | undefined,
  options: HttpBodyCaptureOptions | false,
): {
  requestBody?: string;
  responseBody?: string;
  requestSize?: number;
  responseSize?: number;
  requestBodyCaptureStatus: string;
  responseBodyCaptureStatus: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
} {
  if (!options) {
    return {
      requestBodyCaptureStatus: 'disabled',
      responseBodyCaptureStatus: 'disabled',
      requestBodyCaptureReason: 'HTTP body capture is disabled by SDK configuration.',
      responseBodyCaptureReason: 'HTTP body capture is disabled by SDK configuration.',
    };
  }

  const contentTypes = options.contentTypes ?? ['application/json', 'text/plain'];
  const maxBodySize = Math.max(0, options.maxBodySize ?? 8_192);
  const requestContentType = firstHeader(req.headers['content-type']);
  const requestCapture = sanitizeBodyForTransport(req.body, requestContentType, contentTypes, maxBodySize, options.redactFields);
  const responseCapture = sanitizeBodyForTransport(responseBody, responseContentType, contentTypes, maxBodySize, options.redactFields);

  return {
    requestBody: requestCapture.body,
    responseBody: responseCapture.body,
    requestSize: requestCapture.sizeBytes,
    responseSize: responseCapture.sizeBytes,
    requestBodyCaptureStatus: requestCapture.status,
    responseBodyCaptureStatus: responseCapture.status,
    requestBodyCaptureReason: requestCapture.reason,
    responseBodyCaptureReason: responseCapture.reason,
  };
}

function sanitizeBodyForTransport(
  value: unknown,
  contentType: string | undefined,
  allowedContentTypes: string[],
  maxBodySize: number,
  redactFields?: string[],
): { body?: string; status: string; reason?: string; sizeBytes?: number } {
  if (value == null || value === '') {
    return { status: 'empty', reason: 'Body was empty.', sizeBytes: 0 };
  }
  if (!isAllowedContentType(contentType, allowedContentTypes)) {
    return { status: 'unsupported', reason: 'Content type is not allowlisted for HTTP body capture.' };
  }

  const raw = typeof value === 'string' || Buffer.isBuffer(value)
    ? value.toString()
    : JSON.stringify(redactValue(value, { extraKeys: redactFields }), null, 2);
  const truncated = raw.length > maxBodySize;
  const body = truncated ? raw.slice(0, maxBodySize) + '\n[TRUNCATED]' : raw;
  return {
    body,
    status: truncated ? 'truncated' : 'captured',
    reason: truncated ? `Body exceeded configured max size of ${maxBodySize} bytes.` : undefined,
    sizeBytes: raw.length,
  };
}

function isAllowedContentType(contentType: string | undefined, allowed: string[]): boolean {
  if (!contentType) return false;
  return allowed.some((candidate) => contentType.toLowerCase().includes(candidate.toLowerCase()));
}

function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  extraKeys?: (string | RegExp)[],
): Record<string, string> {
  const redacted = redactHeaderRecord(headers, { extraKeys }) ?? {};
  return Object.fromEntries(
    Object.entries(redacted).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(', ') : value,
    ]),
  );
}

function redactResponseHeaders(
  res: ExpressResponse,
  extraKeys?: (string | RegExp)[],
): Record<string, string> {
  const headers: Record<string, string | string[] | undefined> = {};
  for (const name of ['content-type', 'content-length', 'x-allstak-request-id']) {
    const value = res.getHeader(name);
    if (typeof value === 'string') headers[name] = value;
    else if (typeof value === 'number') headers[name] = String(value);
    else if (Array.isArray(value)) headers[name] = value.map(String);
  }
  return redactHeaders(headers, extraKeys);
}

function headerToString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  return undefined;
}

export default allstakExpress;
