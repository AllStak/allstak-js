import { H as HttpBodyCaptureOptions } from './auto-breadcrumbs-DRB0ieVv.mjs';

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

interface ExpressRequest {
    method: string;
    originalUrl?: string;
    url?: string;
    path?: string;
    route?: {
        path?: string | RegExp | Array<string | RegExp>;
    };
    baseUrl?: string;
    hostname?: string;
    headers: Record<string, string | string[] | undefined>;
    ip?: string;
    user?: {
        id?: string | number;
        email?: string;
        [k: string]: unknown;
    };
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
declare const allstakExpress: {
    /**
     * Mount this BEFORE your routes. Opens a root span for the request,
     * captures the inbound HTTP request (with real round-trip timing) when
     * the response finishes, and auto-attaches `req.user` onto subsequent
     * captures.
     */
    requestHandler(options?: ExpressRequestHandlerOptions): (req: ExpressRequest, res: ExpressResponse, next: NextFn) => void;
    /**
     * Mount this AFTER your routes. Captures any error thrown by an Express
     * route or middleware (including async errors forwarded via `next(err)`).
     */
    errorHandler(): (err: unknown, req: ExpressRequest, _res: ExpressResponse, next: NextFn) => void;
};

export { allstakExpress, allstakExpress as default };
