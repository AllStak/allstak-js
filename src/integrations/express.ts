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

// Minimal Express type-shapes — we don't depend on @types/express to keep
// the SDK install footprint small. Customers who already have @types/express
// installed get full inference automatically.
interface ExpressRequest {
  method: string;
  originalUrl?: string;
  url?: string;
  path?: string;
  hostname?: string;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: { id?: string | number; email?: string; [k: string]: unknown };
  [k: string]: unknown;
}
interface ExpressResponse {
  statusCode: number;
  getHeader(name: string): unknown;
  on(event: 'finish' | 'close', cb: () => void): void;
  [k: string]: unknown;
}
type NextFn = (err?: unknown) => void;

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
  requestHandler() {
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

      // Honor upstream W3C traceparent or AllStak trace headers if present.
      const upstreamTrace = firstHeader(req.headers['x-allstak-trace-id'])
        ?? firstHeader(req.headers['x-trace-id'])
        ?? traceIdFromTraceparent(firstHeader(req.headers['traceparent']));

      sdk.withTraceContext(upstreamTrace, () => {
        // Open a root span for this request.
        let rootSpan: Span | null = null;
        try {
          rootSpan = sdk.startSpan(`${method} ${path}`, {
            description: `HTTP ${method} ${path}`,
            tags: {
              'http.method': method,
              'http.url': path,
              'http.host': host,
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
              direction: 'inbound',
              method,
              host,
              path,
              statusCode: res.statusCode,
              durationMs,
              userId: u?.id,
              timestamp: new Date(start).toISOString(),
            });

            if (rootSpan) {
              try {
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
      });
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
          AllStak.captureException(e, {
            httpMethod: methodOf(req),
            httpPath: pathFromRequest(req),
            httpHost: hostOf(req),
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

function traceIdFromTraceparent(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(header.trim());
  return match?.[1];
}

export default allstakExpress;
