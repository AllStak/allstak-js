import { describe, it, expect } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { instrumentNodeHttp } from '../src/modules/auto-node-http';
import {
  applyTracePropagationToHeaders,
  targetMatches,
  tracePropagationValues,
} from '../src/modules/trace-propagation';

describe('trace-propagation primitives', () => {
  it('produces a W3C traceparent and allstak baggage', () => {
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4');
    expect(v.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(v.baggage).toContain('allstak-trace_id=7f3ac1d9');
    expect(v.baggage).toContain('allstak-request_id=a1b2c3d4');
  });

  it('respects existing headers (set-if-missing) and merges baggage', () => {
    const headers: Record<string, number | string | string[] | undefined> = {
      traceparent: 'EXISTING',
      baggage: 'vendor=1',
    };
    applyTracePropagationToHeaders(headers, 'tid', 'rid');
    expect(headers.traceparent).toBe('EXISTING'); // not overwritten
    expect(String(headers.baggage)).toContain('vendor=1'); // preserved
    expect(String(headers.baggage)).toContain('allstak-trace_id=tid'); // merged
    expect(headers['x-allstak-trace-id']).toBe('tid');
  });

  it('targetMatches: empty = all, string contains, regex', () => {
    expect(targetMatches('https://x', undefined)).toBe(true);
    expect(targetMatches('https://api.example.com/v1', ['example.com'])).toBe(true);
    expect(targetMatches('https://other.test', ['example.com'])).toBe(false);
    expect(targetMatches('https://api.example.com', [/example\.com/])).toBe(true);
  });
});

function requestHeaders(
  ownBaseUrl: string,
  getTraceId: () => string | undefined,
): Promise<http.IncomingHttpHeaders> {
  return new Promise((resolve, reject) => {
    let captured: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      captured = req.headers;
      res.end('ok');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const restore = instrumentNodeHttp(() => {}, null, ownBaseUrl, getTraceId);
      const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => {
          restore();
          server.close();
          resolve(captured);
        });
      });
      r.on('error', (e) => {
        restore();
        server.close();
        reject(e);
      });
      r.end();
    });
  });
}

describe('instrumentNodeHttp trace propagation', () => {
  it('injects traceparent + allstak headers on an outbound http.request', async () => {
    const traceId = '7f3ac1d92b8e4a6f';
    const headers = await requestHeaders('http://ingest.invalid', () => traceId);
    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-allstak-trace-id']).toBe(traceId);
    expect(String(headers['baggage'])).toContain(`allstak-trace_id=${traceId}`);
  });

  it('does not inject when there is no active trace', async () => {
    const headers = await requestHeaders('http://ingest.invalid', () => undefined);
    expect(headers['traceparent']).toBeUndefined();
    expect(headers['x-allstak-trace-id']).toBeUndefined();
  });

  it('does not inject for the SDK own ingest base url', async () => {
    // Point ownBaseUrl at the test server so the request is treated as ingest.
    const headers = await new Promise<http.IncomingHttpHeaders>((resolve, reject) => {
      let captured: http.IncomingHttpHeaders = {};
      const server = http.createServer((req, res) => {
        captured = req.headers;
        res.end('ok');
      });
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        const base = `http://127.0.0.1:${port}`;
        const restore = instrumentNodeHttp(() => {}, null, base, () => 'trace-abc');
        const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (res) => {
          res.resume();
          res.on('end', () => {
            restore();
            server.close();
            resolve(captured);
          });
        });
        r.on('error', (e) => {
          restore();
          server.close();
          reject(e);
        });
        r.end();
      });
    });
    expect(headers['traceparent']).toBeUndefined();
  });
});
