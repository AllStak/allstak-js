/**
 * Auto-instrumentation for Node's `http` and `https` modules.
 *
 * Patches the global `http.request` / `https.request` so any client that goes
 * through them (axios, got, node-fetch, Node's native http, the Java SDK's
 * RestTemplate via http.Agent, etc.) is captured as an outbound HTTP request.
 *
 * Skips requests to the SDK's own ingest base URL to avoid recursion.
 *
 * Behaviour:
 *   - capture(item) is called once per response, with method/host/path/statusCode/durationMs.
 *   - On socket error, capture is called with statusCode=0.
 *   - The original behaviour (callbacks, events, streaming, etc.) is preserved.
 */
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http';

type CaptureRequestFn = (item: {
  direction: 'outbound';
  method: string;
  host: string;
  path: string;
  statusCode: number;
  durationMs: number;
}) => void;

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

const PATCHED_FLAG = Symbol.for('@allstak/node-http/patched');

interface PatchableModule {
  request: (...args: unknown[]) => ClientRequest;
  get: (...args: unknown[]) => ClientRequest;
  [PATCHED_FLAG]?: boolean;
}

function isAlreadyPatched(mod: PatchableModule): boolean {
  return mod[PATCHED_FLAG] === true;
}

function markPatched(mod: PatchableModule): void {
  mod[PATCHED_FLAG] = true;
}

/**
 * Install the patch on both `http` and `https`.
 * Safe in non-Node environments (no-op if `require` doesn't resolve them).
 */
export function instrumentNodeHttp(
  capture: CaptureRequestFn,
  addBreadcrumb: AddBreadcrumbFn | null,
  ownBaseUrl: string,
): () => void {
  const restorers: Array<() => void> = [];

  for (const protocol of ['http', 'https'] as const) {
    let mod: PatchableModule;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      mod = require(`node:${protocol}`) as PatchableModule;
    } catch {
      continue; // not in a Node runtime
    }
    if (isAlreadyPatched(mod)) continue;

    const originalRequest = mod.request.bind(mod);

    mod.request = function patchedRequest(...args: unknown[]): ClientRequest {
      // Normalize: request supports request(url[, options][, cb]) and request(options[, cb]).
      let url: string | undefined;
      let options: RequestOptions = {};
      let callback: ((res: IncomingMessage) => void) | undefined;

      let consumed = 0;
      if (typeof args[consumed] === 'string' || args[consumed] instanceof URL) {
        url = String(args[consumed]);
        consumed++;
      }
      if (args[consumed] && typeof args[consumed] === 'object' && !((args[consumed] as object) instanceof Function)) {
        options = args[consumed] as RequestOptions;
        consumed++;
      }
      if (typeof args[consumed] === 'function') {
        callback = args[consumed] as (res: IncomingMessage) => void;
      }

      // Build a usable URL for filtering / capture.
      const method = (options.method || 'GET').toString().toUpperCase();
      let host = '';
      let path = '/';
      try {
        if (url) {
          const u = new URL(url);
          host = u.host;
          path = (u.pathname || '/') + (options.path && !url.includes('?') ? '' : '');
        } else {
          host = (options.host || options.hostname || '') as string;
          if (options.port) host += `:${options.port}`;
          path = (options.path as string) || '/';
        }
      } catch {
        /* ignore */
      }

      const fullUrl = url || `${protocol}://${host}${path}`;
      const isOwnIngest = ownBaseUrl && fullUrl.startsWith(ownBaseUrl);

      const start = Date.now();
      const req = originalRequest(...(args as Parameters<typeof originalRequest>));

      // Hook the response listener BEFORE the user's callback runs.
      req.on('response', (res: IncomingMessage) => {
        const durationMs = Date.now() - start;
        const status = res.statusCode ?? 0;
        if (addBreadcrumb) {
          addBreadcrumb(
            'http',
            `${method} ${fullUrl.split('?')[0]} -> ${status}`,
            status >= 400 ? 'error' : 'info',
            { method, url: fullUrl.split('?')[0], statusCode: status, durationMs },
          );
        }
        if (!isOwnIngest) {
          try {
            capture({
              direction: 'outbound',
              method,
              host,
              path: path.split('?')[0],
              statusCode: status,
              durationMs,
            });
          } catch {
            /* never break host */
          }
        }
      });

      req.on('error', (err: Error) => {
        const durationMs = Date.now() - start;
        if (addBreadcrumb) {
          addBreadcrumb('http', `${method} ${fullUrl.split('?')[0]} -> failed`, 'error', {
            method, url: fullUrl.split('?')[0], error: err.message, durationMs,
          });
        }
        if (!isOwnIngest) {
          try {
            capture({
              direction: 'outbound',
              method,
              host,
              path: path.split('?')[0],
              statusCode: 0,
              durationMs,
            });
          } catch {
            /* never break host */
          }
        }
      });

      // The user's callback (if any) is already attached by `originalRequest`
      // since we passed `args` through verbatim — don't double-register here.
      void callback; // satisfy lint
      return req;
    } as unknown as PatchableModule['request'];

    // node's `http.get(...)` is a convenience: `request(...).end()`. It
    // captures `module.request` at module-load time, so re-routing it through
    // the patched `mod.request` requires us to also override `mod.get`.
    let originalGet: PatchableModule['get'] | undefined;
    if (typeof mod.get === 'function') {
      originalGet = mod.get.bind(mod) as PatchableModule['get'];
      mod.get = function patchedGet(...args: unknown[]): ClientRequest {
        const req = (mod.request as (...a: unknown[]) => ClientRequest)(...args);
        req.end();
        return req;
      } as unknown as PatchableModule['get'];
    }

    markPatched(mod);
    restorers.push(() => {
      mod.request = originalRequest;
      if (originalGet) mod.get = originalGet;
      mod[PATCHED_FLAG] = false;
    });
  }

  return () => restorers.forEach((r) => r());
}
