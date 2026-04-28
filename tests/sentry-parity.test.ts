/**
 * Sentry-parity API tests for @allstak/js v0.1.4:
 *   - beforeSend (mutate, drop, async, error-safe)
 *   - sampleRate
 *   - setTags / setExtra / setExtras / setContext
 *   - setLevel / setFingerprint
 *   - flush()
 *   - error.name override survives as exceptionClass
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AllStak } from '../src/index';

let sent: Array<{ url: string; init: any }> = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  sent = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }) as any;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  AllStak.destroy();
});

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('beforeSend', () => {
  it('can mutate the event', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      beforeSend: (ev: any) => ({ ...ev, message: `[scrubbed] ${ev.message}` }),
    });
    AllStak.captureException(new Error('secret-token'));
    await wait();
    expect(JSON.parse(sent[0].init.body).message).toMatch(/^\[scrubbed\] /);
  });

  it('can drop the event by returning null', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false, beforeSend: () => null });
    AllStak.captureException(new Error('drop-me'));
    await wait();
    expect(sent.length).toBe(0);
  });

  it('supports async hooks', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      beforeSend: async (ev: any) => { await new Promise((r) => setTimeout(r, 5)); return { ...ev, message: 'async-' + ev.message }; },
    });
    AllStak.captureException(new Error('p'));
    await wait(80);
    expect(JSON.parse(sent[0].init.body).message).toBe('async-p');
  });

  it('a throwing hook never drops telemetry — original payload sent', async () => {
    AllStak.init({
      apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false,
      beforeSend: () => { throw new Error('hook-broken'); },
    });
    AllStak.captureException(new Error('original'));
    await wait();
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0].init.body).message).toBe('original');
  });
});

describe('sampleRate', () => {
  it('=0 drops everything', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false, sampleRate: 0 });
    for (let i = 0; i < 5; i++) AllStak.captureException(new Error(`e${i}`));
    await wait();
    expect(sent.length).toBe(0);
  });
  it('=1 sends everything', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false, sampleRate: 1 });
    for (let i = 0; i < 5; i++) AllStak.captureException(new Error(`e${i}`));
    await wait();
    expect(sent.length).toBe(5);
  });
});

describe('metadata methods', () => {
  it('setTags merges with existing tags', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false, tags: { region: 'eu' } });
    AllStak.setTags({ feature: 'login', tier: 'pro' });
    AllStak.captureException(new Error('e'));
    await wait();
    const meta = JSON.parse(sent[0].init.body).metadata;
    expect(meta.region).toBe('eu');
    expect(meta.feature).toBe('login');
    expect(meta.tier).toBe('pro');
  });
  it('setExtra/setExtras land in metadata', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    AllStak.setExtra('cart_id', 'c-1');
    AllStak.setExtras({ ab: 'B', flag: true });
    AllStak.captureException(new Error('e'));
    await wait();
    const meta = JSON.parse(sent[0].init.body).metadata;
    expect(meta.cart_id).toBe('c-1');
    expect(meta.ab).toBe('B');
    expect(meta.flag).toBe(true);
  });
  it('setContext under metadata["context.<name>"], setContext(name, null) removes it', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    AllStak.setContext('app', { version: '1.0' });
    AllStak.captureException(new Error('e1'));
    await wait();
    expect(JSON.parse(sent[0].init.body).metadata['context.app']).toEqual({ version: '1.0' });

    sent.length = 0;
    AllStak.setContext('app', null);
    AllStak.captureException(new Error('e2'));
    await wait();
    expect(JSON.parse(sent[0].init.body).metadata['context.app']).toBeUndefined();
  });
});

describe('setLevel + setFingerprint + error.name override', () => {
  it('setLevel changes payload.level', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    AllStak.setLevel('warning');
    AllStak.captureException(new Error('warn-me'));
    await wait();
    expect(JSON.parse(sent[0].init.body).level).toBe('warning');
  });
  it('setFingerprint propagates; setFingerprint(null) clears', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    AllStak.setFingerprint(['feat', 'v2']);
    AllStak.captureException(new Error('g'));
    await wait();
    expect(JSON.parse(sent[0].init.body).fingerprint).toEqual(['feat', 'v2']);

    sent.length = 0;
    AllStak.setFingerprint(null);
    AllStak.captureException(new Error('cleared'));
    await wait();
    expect(JSON.parse(sent[0].init.body).fingerprint).toBeUndefined();
  });
  it('error.name override survives as exceptionClass', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    const err = new Error('renamed');
    err.name = 'CustomDomainError';
    AllStak.captureException(err);
    await wait();
    expect(JSON.parse(sent[0].init.body).exceptionClass).toBe('CustomDomainError');
  });
});

describe('flush()', () => {
  it('resolves true when the buffer is idle', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });
    expect(await AllStak.flush(500)).toBe(true);
  });
});
