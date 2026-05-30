import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllStak } from '../src/index';
import { allstakExpress } from '../src/integrations/express';

const TEST_DSN = 'https://test-key@localhost:3000';

function createResponse() {
  const finishCallbacks: Array<() => void> = [];
  const headers: Record<string, unknown> = { 'content-type': 'application/json' };
  return {
    statusCode: 201,
    body: undefined as unknown,
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
    },
    on(event: 'finish' | 'close', cb: () => void) {
      if (event === 'finish') finishCallbacks.push(cb);
    },
    json(body?: unknown) {
      this.body = body;
      headers['content-type'] = 'application/json';
      return this;
    },
    finish() {
      for (const cb of finishCallbacks) cb();
    },
  };
}

describe('Express integration', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
    AllStak.init({
      dsn: TEST_DSN,
      environment: 'test',
      release: 'express-test',
      tags: { service: 'express-api' },
      httpBodyCapture: { enabled: true, redactFields: ['cardNumber'] },
    });
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
  });

  it('captures inbound headers/bodies and correlates logs by requestId', async () => {
    const req = {
      method: 'POST',
      originalUrl: '/orders?debug=true',
      path: '/orders',
      baseUrl: '',
      route: { path: '/orders' },
      hostname: 'api.example.test',
      headers: {
        host: 'api.example.test',
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        'user-agent': 'vitest',
      },
      body: { sku: 'desk-lamp', quantity: 2, cardNumber: '4111111111111111' },
      user: { id: 'u_123', email: 'user@example.test' },
    };
    const res = createResponse();

    allstakExpress.requestHandler()(req as any, res as any, () => {
      AllStak.logger.info('order accepted');
      res.json({ ok: true, orderId: 'ord_123' });
      res.finish();
    });

    await AllStak.flush(2000);

    const logCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ingest/v1/logs'));
    const requestCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ingest/v1/http-requests'));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ingest/v1/spans'));
    expect(logCall).toBeDefined();
    expect(requestCall).toBeDefined();
    expect(spanCall).toBeDefined();

    const logBody = JSON.parse(logCall![1].body as string);
    const requestBody = JSON.parse(requestCall![1].body as string);
    const spanBody = JSON.parse(spanCall![1].body as string);
    const captured = requestBody.requests[0];
    const span = spanBody.spans[0];

    expect(captured.requestId).toBeTruthy();
    expect(captured.traceId).toBeTruthy();
    expect(logBody.requestId).toBe(captured.requestId);
    expect(logBody.traceId).toBe(captured.traceId);
    expect(JSON.parse(captured.requestHeaders).authorization).toBe('[REDACTED]');
    expect(captured.requestBody).toContain('"sku": "desk-lamp"');
    expect(captured.requestBody).toContain('"cardNumber": "[REDACTED]"');
    expect(captured.responseBody).toContain('"orderId": "ord_123"');
    expect(captured.requestBodyCaptureStatus).toBe('captured');
    expect(captured.responseBodyCaptureStatus).toBe('captured');
    expect(span.platform).toBe('node');
    expect(span.op).toBe('http.server');
    expect(span.measurements.duration_ms).toEqual(expect.any(Number));
    expect(span.attributes['http.method']).toBe('POST');
    expect(span.attributes['http.route']).toBe('/orders');
    expect(span.attributes['http.status_code']).toBe('201');
    expect(span.attributes['allstak.request_id']).toBe(captured.requestId);
  });

  it('continues a valid W3C traceparent and ignores invalid custom trace headers', async () => {
    const upstreamTraceId = '0af7651916cd43dd8448eb211c80319c';
    const upstreamParentSpanId = 'b7ad6b7169203331';
    const req = {
      method: 'GET',
      originalUrl: '/users',
      path: '/users',
      baseUrl: '',
      route: { path: '/users' },
      hostname: 'api.example.test',
      headers: {
        host: 'api.example.test',
        traceparent: `00-${upstreamTraceId}-${upstreamParentSpanId}-01`,
        'x-allstak-trace-id': 'not-a-valid-trace-id',
      },
    };
    const res = createResponse();

    allstakExpress.requestHandler()(req as any, res as any, () => {
      res.json({ ok: true });
      res.finish();
    });

    await AllStak.flush(2000);

    const requestCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ingest/v1/http-requests'));
    const spanCall = fetchSpy.mock.calls.find(([url]) => String(url).includes('/ingest/v1/spans'));
    expect(requestCall).toBeDefined();
    expect(spanCall).toBeDefined();

    const captured = JSON.parse(requestCall![1].body as string).requests[0];
    const span = JSON.parse(spanCall![1].body as string).spans[0];
    expect(captured.traceId).toBe(upstreamTraceId);
    expect(captured.parentSpanId).toBe(upstreamParentSpanId);
    expect(span.traceId).toBe(upstreamTraceId);
    expect(span.parentSpanId).toBe(upstreamParentSpanId);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});
