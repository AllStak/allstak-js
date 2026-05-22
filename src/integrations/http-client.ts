import { defineIntegration } from '../integration';
import { instrumentFetch } from '../modules/auto-breadcrumbs';
import { instrumentNodeHttp } from '../modules/auto-node-http';

export const httpClientIntegration = defineIntegration(() => ({
  name: 'HttpClient',
  setup(client) {
    const options = client.getOptions();
    if (options.autoBreadcrumbs === false) return;

    const baseUrl = client.getBaseUrl();
    instrumentFetch(
      (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
      (item) => client.captureRequest({ ...item, method: item.method as any }),
      baseUrl,
      () => ({ traceId: client.getTraceId() }),
      options.httpBodyCapture,
      options.tracePropagationTargets,
    );

    if (client.isNodeRuntime()) {
      try {
        instrumentNodeHttp(
          (item) => client.captureRequest({ ...item, method: item.method as any }),
          (type, msg, level, data) => client.addBreadcrumb(type, msg, level, data),
          baseUrl,
        );
      } catch {
        // Optional Node patching must never break SDK init.
      }
    }

    client.onHttpRequestCaptured((item) => {
      client.addBreadcrumb(
        'http',
        `${item.method} ${item.path} -> ${item.statusCode}`,
        item.statusCode >= 400 ? 'error' : 'info',
        { method: item.method, path: item.path, statusCode: item.statusCode, durationMs: item.durationMs },
      );
    });
  },
}));
