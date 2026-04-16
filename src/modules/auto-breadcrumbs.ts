/**
 * Automatic breadcrumb instrumentation for fetch and console in browser environments.
 *
 * These patches are safe: they only wrap if the globals exist and always
 * delegate to the original implementation.
 */

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

/**
 * Wrap `globalThis.fetch` to record HTTP breadcrumbs for every request.
 */
export function instrumentFetch(addBreadcrumb: AddBreadcrumbFn): void {
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

    const start = Date.now();
    try {
      const response = await originalFetch.call(this, input, init);
      const durationMs = Date.now() - start;
      addBreadcrumb(
        'http',
        `${method} ${safePath} -> ${response.status}`,
        response.status >= 400 ? 'error' : 'info',
        { method, url: safePath, statusCode: response.status, durationMs },
      );
      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      addBreadcrumb('http', `${method} ${safePath} -> failed`, 'error', {
        method,
        url: safePath,
        error: String(err),
        durationMs,
      });
      throw err;
    }
  };
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
