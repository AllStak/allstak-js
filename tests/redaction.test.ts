/**
 * Redaction tests — closes the security gap documented in
 * docs/reports/wizard-full-cycle-e2e-2026-05-18.md (Finding #1).
 *
 * Verifies that sensitive caller-supplied context never reaches the wire
 * via captureException / captureMessage / breadcrumb data.
 *
 * Run alongside sensitive-data-masking.test.ts which covers the HTTP-body
 * capture path (different code).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';
import {
  REDACTED,
  isSensitiveKey,
  redactObject,
  redactValue,
} from '../src/utils/redact';

const CANARY = 'should_not_leak';

interface Captured { url: string; payload: any }

function setupAllStak(config: Record<string, unknown> = {}): { captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    let payload: unknown = null;
    if (typeof init?.body === 'string') {
      try { payload = JSON.parse(init.body); } catch {}
    }
    captured.push({ url: String(url), payload });
    return new Response('{"data":{"id":"test-id"}}', { status: 202, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchSpy);
  AllStak.init({
    apiKey: 'ask_test',
    host: 'https://api.invalid.example',
    environment: 'test',
    release: 'redaction-tests@1',
    serviceName: 'redaction-tests',
    ...config,
  });
  return { captured };
}

function wireBytesContainCanary(captured: Captured[]): boolean {
  return captured.some((c) => JSON.stringify(c.payload).includes(CANARY));
}

describe('redact() primitive', () => {
  it('matches every documented sensitive key', () => {
    const keys = [
      'authorization', 'Authorization', 'AUTHORIZATION',
      'proxy-authorization',
      'cookie', 'set-cookie', 'Set-Cookie',
      'x-api-key', 'X-API-Key', 'X-Auth-Token', 'X-Access-Token', 'X-AllStak-Key',
      'refresh_token', 'access-token', 'id.token',
      'stripe_api_key', 'stripe-api-key',
      'user_password', 'admin.passwd',
      'client_secret',
      'my_session_id',
      'jwt', 'user-jwt', 'bearer',
      'x-csrf',
    ];
    for (const k of keys) expect(isSensitiveKey(k), `expected ${k} to be sensitive`).toBe(true);
  });

  it('does not match unrelated keys', () => {
    for (const k of ['User-Agent', 'Content-Type', 'order_id', 'http.method', 'user.id', 'x-trace-id', 'topic']) {
      expect(isSensitiveKey(k), `expected ${k} public`).toBe(false);
    }
  });

  it('redacts at the top level and preserves the rest', () => {
    const out = redactObject({ authorization: 'X', order_id: 'OK' });
    expect(out).toEqual({ authorization: REDACTED, order_id: 'OK' });
  });

  it('walks nested objects', () => {
    const out = redactObject({
      http: { headers: { Authorization: 'X', 'Content-Type': 'json' } },
      user: { id: 'u-1', password: 'p' },
    });
    expect((out as any).http.headers.Authorization).toBe(REDACTED);
    expect((out as any).http.headers['Content-Type']).toBe('json');
    expect((out as any).user.password).toBe(REDACTED);
    expect((out as any).user.id).toBe('u-1');
  });

  it('walks arrays of objects', () => {
    const out = redactObject({ items: [{ api_key: 'A', name: 'one' }, { api_key: 'B', name: 'two' }] });
    expect((out as any).items[0].api_key).toBe(REDACTED);
    expect((out as any).items[0].name).toBe('one');
    expect((out as any).items[1].api_key).toBe(REDACTED);
  });

  it('does not mutate the input', () => {
    const input = { authorization: 'X', n: { token: 't' } };
    const _out = redactObject(input);
    expect(input.authorization).toBe('X');
    expect(input.n.token).toBe('t');
  });

  it('handles cycles without throwing', () => {
    const a: any = { name: 'a' };
    a.self = a;
    const out = redactObject(a) as any;
    expect(out.name).toBe('a');
    expect(out.self).toBe('[Circular]');
  });

  it('caps depth on pathologically deep objects', () => {
    let deep: any = { leaf: 'ok' };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    const out = redactObject(deep, { maxDepth: 3 }) as any;
    expect(out.nested.nested.nested).toBe('[MaxDepth]');
  });

  it('honours caller-supplied extra patterns (string + RegExp)', () => {
    const out = redactObject({ tenant_id: 'X', public_id: 'OK' }, { extraKeys: ['tenant_id', /^x-internal-/i] }) as any;
    expect(out.tenant_id).toBe(REDACTED);
    expect(out.public_id).toBe('OK');

    const out2 = redactObject({ 'x-internal-flag': 'v' }, { extraKeys: [/^x-internal-/i] }) as any;
    expect(out2['x-internal-flag']).toBe(REDACTED);
  });

  it('passes Date/Error through (non-plain objects)', () => {
    const d = new Date('2024-01-01');
    const e = new Error('boom');
    const out = redactObject({ when: d, why: e }) as any;
    expect(out.when).toBe(d);
    expect(out.why).toBe(e);
  });

  it('redactValue accepts non-object scalars', () => {
    expect(redactValue('plain')).toBe('plain');
    expect(redactValue(42)).toBe(42);
    expect(redactValue(null)).toBe(null);
  });
});

describe('AllStak.captureException — never leaks caller context to the wire', () => {
  let captured: Captured[];
  beforeEach(() => { ({ captured } = setupAllStak()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('redacts authorization / api_key / password / nested.password from per-call context', async () => {
    AllStak.captureException(new Error('test'), {
      authorization: `Bearer ${CANARY}`,
      stripe_api_key: CANARY,
      nested: { password: CANARY, city: 'Riyadh' },
      order_id: 'ORD-42',
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(wireBytesContainCanary(captured)).toBe(false);
    const errorPayload = captured.find((c) => c.url.endsWith('/ingest/v1/errors'))?.payload;
    expect(errorPayload).toBeTruthy();
    expect(errorPayload.metadata.authorization).toBe(REDACTED);
    expect(errorPayload.metadata.stripe_api_key).toBe(REDACTED);
    expect(errorPayload.metadata.nested.password).toBe(REDACTED);
    expect(errorPayload.metadata.nested.city).toBe('Riyadh');
    expect(errorPayload.metadata.order_id).toBe('ORD-42');
  });

  it('redacts breadcrumb.data of the attached crumb on the next captureException', async () => {
    AllStak.addBreadcrumb({ type: 'http', message: 'GET /widgets', data: { Authorization: `Bearer ${CANARY}`, status: 200 } });
    AllStak.captureException(new Error('crumb-test'));
    await new Promise((r) => setTimeout(r, 0));
    expect(wireBytesContainCanary(captured)).toBe(false);
    const errorPayload = captured.find((c) => c.url.endsWith('/ingest/v1/errors'))?.payload;
    const crumb = errorPayload?.breadcrumbs?.[0];
    expect(crumb).toBeTruthy();
    expect(crumb.data.Authorization).toBe(REDACTED);
    expect(crumb.data.status).toBe(200);
  });

  it('runs final sanitization after beforeSend so hooks cannot reintroduce secrets', async () => {
    const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature';
    ({ captured } = setupAllStak({
      beforeSend(event: any) {
        event.metadata = {
          ...event.metadata,
          Authorization: `Bearer ${CANARY}`,
          Cookie: `sid=${CANARY}`,
          nested: {
            password: CANARY,
            apiKey: CANARY,
            jwt: JWT,
            values: [`Bearer ${CANARY}`, { secret: CANARY }],
          },
          card: '4111111111111111',
          beforeSendToken: CANARY,
          beforeSendCookie: `sid=${CANARY}`,
        };
        event.requestContext = {
          ...event.requestContext,
          headers: { 'Set-Cookie': `a=${CANARY}` },
        };
        event.breadcrumbs = [
          ...(event.breadcrumbs ?? []),
          { type: 'default', message: `Bearer ${CANARY}`, data: { token: CANARY } },
        ];
        event.fingerprint = [`Bearer ${CANARY}`];
        return event;
      },
    }));

    AllStak.captureException(new Error('hook-secret-test'), { order_id: 'ORD-77' });
    await new Promise((r) => setTimeout(r, 0));

    const errorPayload = captured.find((c) => c.url.endsWith('/ingest/v1/errors'))?.payload;
    const raw = JSON.stringify(errorPayload);
    expect(errorPayload).toBeTruthy();
    expect(raw).not.toContain(CANARY);
    expect(raw).not.toContain(JWT);
    expect(raw).not.toContain('4111111111111111');
    expect(errorPayload.metadata.Authorization).toBe(REDACTED);
    expect(errorPayload.metadata.Cookie).toBe(REDACTED);
    expect(errorPayload.metadata.nested.password).toBe(REDACTED);
    expect(errorPayload.metadata.nested.apiKey).toBe(REDACTED);
    expect(errorPayload.metadata.nested.jwt).toBe(REDACTED);
    expect(errorPayload.metadata.nested.values[0]).toBe(REDACTED);
    expect(errorPayload.metadata.nested.values[1].secret).toBe(REDACTED);
    expect(errorPayload.metadata.card).toBe(REDACTED);
    expect(errorPayload.metadata.beforeSendToken).toBe(REDACTED);
    expect(errorPayload.metadata.beforeSendCookie).toBe(REDACTED);
    expect(errorPayload.requestContext.headers['Set-Cookie']).toBe(REDACTED);
    expect(errorPayload.breadcrumbs.at(-1).message).toBe(REDACTED);
    expect(errorPayload.breadcrumbs.at(-1).data.token).toBe(REDACTED);
    expect(errorPayload.fingerprint[0]).toBe(REDACTED);
  });

  it('honors config.redactKeys for tenant-specific sensitive fields', async () => {
    AllStak.init({
      apiKey: 'ask_test',
      host: 'https://api.invalid.example',
      environment: 'test',
      release: 'redaction-tests@1',
      // Force a re-init with extra patterns.
      // @ts-expect-error — redactKeys is config-side opt-in
      redactKeys: ['internal_id'],
    });
    AllStak.captureException(new Error('extra-keys'), { internal_id: CANARY, public_id: 'visible' });
    await new Promise((r) => setTimeout(r, 0));
    const errorPayload = captured.find((c) => c.url.endsWith('/ingest/v1/errors'))?.payload;
    expect(errorPayload.metadata.internal_id).toBe(REDACTED);
    expect(errorPayload.metadata.public_id).toBe('visible');
  });
});

describe('AllStak.captureMessage — options.data + options.metadata redaction', () => {
  let captured: Captured[];
  beforeEach(() => { ({ captured } = setupAllStak()); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('options.metadata reaches the logs payload, with secrets redacted', async () => {
    AllStak.captureMessage('hello', 'info', { metadata: { order_id: 'ORD-42', client_secret: CANARY } });
    await new Promise((r) => setTimeout(r, 0));
    expect(wireBytesContainCanary(captured)).toBe(false);
    const logPayload = captured.find((c) => c.url.endsWith('/ingest/v1/logs'))?.payload;
    expect(logPayload).toBeTruthy();
    expect(logPayload.metadata.client_secret).toBe(REDACTED);
    expect(logPayload.metadata.order_id).toBe('ORD-42');
  });

  it('options.data (legacy alias) is honoured and redacted', async () => {
    AllStak.captureMessage('legacy', 'info', { data: { client_secret: CANARY, order_id: 'ORD-99' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(wireBytesContainCanary(captured)).toBe(false);
    const logPayload = captured.find((c) => c.url.endsWith('/ingest/v1/logs'))?.payload;
    expect(logPayload.metadata.client_secret).toBe(REDACTED);
    expect(logPayload.metadata.order_id).toBe('ORD-99');
  });
});
