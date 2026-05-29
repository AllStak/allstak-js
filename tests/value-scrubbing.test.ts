/**
 * Value-pattern PII scrubbing tests (Sentry data-scrubbing parity).
 *
 * Layering under test:
 *   A) ALWAYS scrub (regardless of sendDefaultPii): Luhn-valid credit cards,
 *      dashed US SSNs.
 *   B) Scrub UNLESS sendDefaultPii === true: emails, IPv4 addresses.
 *
 * Conservative invariants verified here:
 *   - A digit run that FAILS Luhn is preserved (order ids / timestamps safe).
 *   - A bare 9-digit number is NOT treated as an SSN (hyphens required).
 *   - Explicit setUser email is never scrubbed (intentional identification).
 *   - Key-based secret redaction still works.
 *   - Stack-frame filename / function / absPath are never corrupted.
 *   - Fail-open on a pathological input.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';
import {
  REDACTED,
  redactObject,
  redactValue,
  scrubStringValue,
  __test,
} from '../src/utils/redact';

const { passesLuhn, scrubAlwaysPii, scrubDefaultPii } = __test;

// A genuine Luhn-valid test card (Visa test number) and a same-length run that
// FAILS Luhn (so it must be preserved).
const LUHN_VALID_CARD = '4111111111111111'; // valid
const LUHN_INVALID_RUN = '4111111111111112'; // fails Luhn — must survive
const ORDER_ID = '1234567890123456'; // 16-digit order id; fails Luhn -> survives
const SSN = '123-45-6789';
const BARE_9 = '123456789'; // NOT an SSN (no hyphens) -> must survive
const EMAIL = 'jane.doe@example.com';
const IPV4 = '192.168.1.100';

describe('value scrubber primitives', () => {
  it('Luhn passes for a valid card and fails for an off-by-one run', () => {
    expect(passesLuhn('4111111111111111')).toBe(true);
    expect(passesLuhn('4111111111111112')).toBe(false);
    expect(passesLuhn('79927398713')).toBe(true); // canonical Luhn example
  });

  it('always-scrub: redacts Luhn-valid card, preserves Luhn-invalid run', () => {
    expect(scrubAlwaysPii(`card ${LUHN_VALID_CARD} ok`)).toBe(`card ${REDACTED} ok`);
    expect(scrubAlwaysPii(`order ${LUHN_INVALID_RUN} ok`)).toBe(`order ${LUHN_INVALID_RUN} ok`);
    expect(scrubAlwaysPii(`order ${ORDER_ID} ok`)).toBe(`order ${ORDER_ID} ok`);
  });

  it('always-scrub: redacts card with space/hyphen separators when Luhn-valid', () => {
    expect(scrubAlwaysPii('4111 1111 1111 1111')).toBe(REDACTED);
    expect(scrubAlwaysPii('4111-1111-1111-1111')).toBe(REDACTED);
  });

  it('always-scrub: redacts dashed SSN, preserves a bare 9-digit number', () => {
    expect(scrubAlwaysPii(`ssn ${SSN}`)).toBe(`ssn ${REDACTED}`);
    expect(scrubAlwaysPii(`id ${BARE_9}`)).toBe(`id ${BARE_9}`);
  });

  it('default-pii layer: redacts email + IPv4, and IPv4 octets are validated', () => {
    expect(scrubDefaultPii(`from ${EMAIL}`)).toBe(`from ${REDACTED}`);
    expect(scrubDefaultPii(`peer ${IPV4}`)).toBe(`peer ${REDACTED}`);
    // 999 is not a valid octet -> not an IP -> preserved
    expect(scrubDefaultPii('version 999.1.1.1')).toBe('version 999.1.1.1');
  });

  it('scrubStringValue is a no-op when scrubValues is false', () => {
    expect(scrubStringValue(`card ${LUHN_VALID_CARD}`, { scrubValues: false })).toBe(
      `card ${LUHN_VALID_CARD}`,
    );
  });

  it('scrubStringValue gates email/IP on sendDefaultPii but always scrubs CC/SSN', () => {
    const text = `card ${LUHN_VALID_CARD} mail ${EMAIL} ip ${IPV4}`;
    const off = scrubStringValue(text, { scrubValues: true, sendDefaultPii: false });
    expect(off).toBe(`card ${REDACTED} mail ${REDACTED} ip ${REDACTED}`);
    const on = scrubStringValue(text, { scrubValues: true, sendDefaultPii: true });
    expect(on).toBe(`card ${REDACTED} mail ${EMAIL} ip ${IPV4}`);
  });

  it('redactObject scrubs string values (and still key-redacts)', () => {
    const out = redactObject(
      { note: `pay ${LUHN_VALID_CARD} to ${EMAIL}`, password: 'x', order_id: ORDER_ID },
      { scrubValues: true, sendDefaultPii: false },
    ) as any;
    expect(out.note).toBe(`pay ${REDACTED} to ${REDACTED}`);
    expect(out.password).toBe(REDACTED); // key-based redaction intact
    expect(out.order_id).toBe(ORDER_ID); // Luhn-invalid run survives
  });

  it('redactValue scrubs scalar strings', () => {
    expect(redactValue(`mail ${EMAIL}`, { scrubValues: true, sendDefaultPii: false })).toBe(
      `mail ${REDACTED}`,
    );
    expect(redactValue(`mail ${EMAIL}`, { scrubValues: true, sendDefaultPii: true })).toBe(
      `mail ${EMAIL}`,
    );
  });

  it('fails open on a pathological input (never throws, returns input)', () => {
    const huge = 'a'.repeat(50_000) + ` ${LUHN_VALID_CARD}`; // exceeds scan cap
    // Over the scan cap: passed through unchanged rather than melting the regex.
    expect(() => scrubStringValue(huge, { scrubValues: true })).not.toThrow();
    expect(scrubStringValue(huge, { scrubValues: true })).toBe(huge);

    // A cyclic object must not throw and must still redact keys.
    const cyclic: any = { authorization: 'X', note: `card ${LUHN_VALID_CARD}` };
    cyclic.self = cyclic;
    const out = redactObject(cyclic, { scrubValues: true }) as any;
    expect(out.authorization).toBe(REDACTED);
    expect(out.note).toBe(`card ${REDACTED}`);
    expect(out.self).toBe('[Circular]');
  });
});

// ─── End-to-end wire-path coverage ──────────────────────────────────────────

interface Captured { url: string; payload: any }

function setupAllStak(overrides: Record<string, unknown> = {}): { captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchSpy = vi.fn(async (url: string, init: RequestInit) => {
    let payload: unknown = null;
    if (typeof init?.body === 'string') {
      try { payload = JSON.parse(init.body); } catch {}
    }
    captured.push({ url: String(url), payload });
    return new Response('{"data":{"id":"test-id"}}', {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchSpy);
  AllStak.init({
    apiKey: 'ask_test',
    host: 'https://api.invalid.example',
    environment: 'test',
    release: 'value-scrub-tests@1',
    ...overrides,
  });
  return { captured };
}

function errorPayload(captured: Captured[]): any {
  return captured.find((c) => c.url.endsWith('/ingest/v1/errors'))?.payload;
}

describe('captureException — value-pattern scrubbing on the wire', () => {
  let captured: Captured[];
  afterEach(() => { AllStak.destroy(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('scrubs CC/SSN/email/IP from message + metadata when sendDefaultPii=false (default)', async () => {
    ({ captured } = setupAllStak());
    AllStak.captureException(new Error(`charge ${LUHN_VALID_CARD} for ${EMAIL}`), {
      note: `ssn ${SSN}`,
      peer: `ip ${IPV4}`,
      order_id: ORDER_ID,
      password: 'super-secret',
    });
    await new Promise((r) => setTimeout(r, 0));
    const p = errorPayload(captured);
    expect(p).toBeTruthy();
    expect(p.message).toBe(`charge ${REDACTED} for ${REDACTED}`);
    expect(p.metadata.note).toBe(`ssn ${REDACTED}`);
    expect(p.metadata.peer).toBe(`ip ${REDACTED}`);
    expect(p.metadata.order_id).toBe(ORDER_ID); // Luhn-invalid run preserved
    expect(p.metadata.password).toBe(REDACTED); // key-based redaction intact
  });

  it('preserves email + IP but STILL scrubs CC/SSN when sendDefaultPii=true', async () => {
    ({ captured } = setupAllStak({ sendDefaultPii: true }));
    AllStak.captureException(new Error(`charge ${LUHN_VALID_CARD} for ${EMAIL} at ${IPV4}`), {
      note: `ssn ${SSN}`,
    });
    await new Promise((r) => setTimeout(r, 0));
    const p = errorPayload(captured);
    expect(p.message).toBe(`charge ${REDACTED} for ${EMAIL} at ${IPV4}`);
    expect(p.metadata.note).toBe(`ssn ${REDACTED}`); // (A) always on
  });

  it('does NOT scrub the explicit setUser email (intentional identification)', async () => {
    ({ captured } = setupAllStak());
    AllStak.setUser({ id: 'u-1', email: EMAIL });
    AllStak.captureException(new Error('boom'));
    await new Promise((r) => setTimeout(r, 0));
    const p = errorPayload(captured);
    expect(p.user).toEqual({ id: 'u-1', email: EMAIL });
  });

  it('does NOT corrupt stack-frame filename / function / absPath', async () => {
    ({ captured } = setupAllStak());
    // Forge a stack whose frames reference a path containing a digit run that
    // would otherwise look card-ish; frames must never be value-scrubbed.
    const err = new Error('frame test');
    err.stack = [
      'Error: frame test',
      '    at handler (/srv/app/v4111111111111111/index.js:10:5)',
      '    at run (/srv/app/main.js:3:1)',
    ].join('\n');
    AllStak.captureException(err);
    await new Promise((r) => setTimeout(r, 0));
    const p = errorPayload(captured);
    const filenames = (p.frames ?? []).map((f: any) => f.filename ?? f.absPath).join('|');
    // The digit-laden path segment must be preserved verbatim on frames.
    expect(filenames).toContain('v4111111111111111');
    expect(JSON.stringify(p.frames)).not.toContain(REDACTED);
  });
});
