/**
 * Scope / withScope isolation tests for @allstak/js.
 *
 * Proves that user/tag/extra/context/fingerprint/level set inside
 * `AllStak.withScope(...)` are visible on captures within the callback,
 * do NOT leak to captures made after, layer correctly when nested, and
 * pop on synchronous + asynchronous failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
const cfg = { autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false } as const;

describe('withScope isolation', () => {
  it('user/tag/extra apply inside the callback and not after', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    AllStak.withScope((scope) => {
      scope.setUser({ id: 'u-A', email: 'a@x.com' });
      scope.setTag('feature', 'cart');
      scope.setExtra('cart_id', 'c-42');
      AllStak.captureException(new Error('inside'));
    });
    AllStak.captureException(new Error('outside'));
    await wait(60);
    expect(sent.length).toBe(2);
    const inside = JSON.parse(sent[0].init.body);
    const outside = JSON.parse(sent[1].init.body);
    expect(inside.user).toEqual({ id: 'u-A', email: 'a@x.com' });
    expect(inside.metadata.feature).toBe('cart');
    expect(inside.metadata.cart_id).toBe('c-42');
    expect(outside.user).toBeUndefined();
    expect(outside.metadata.feature).toBeUndefined();
    expect(outside.metadata.cart_id).toBeUndefined();
  });

  it('fingerprint and level apply only inside the callback', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    AllStak.withScope((scope) => {
      scope.setLevel('warning');
      scope.setFingerprint(['feat-a']);
      AllStak.captureException(new Error('a'));
    });
    AllStak.captureException(new Error('b'));
    await wait(60);
    const a = JSON.parse(sent[0].init.body);
    const b = JSON.parse(sent[1].init.body);
    expect(a.level).toBe('warning');
    expect(a.fingerprint).toEqual(['feat-a']);
    expect(b.level).toBe('error');
    expect(b.fingerprint).toBeUndefined();
  });

  it('context bag lands as context.<name> only inside callback', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    AllStak.withScope((scope) => {
      scope.setContext('app', { build: '42' });
      AllStak.captureException(new Error('with-ctx'));
    });
    AllStak.captureException(new Error('without-ctx'));
    await wait(60);
    expect(JSON.parse(sent[0].init.body).metadata['context.app']).toEqual({ build: '42' });
    expect(JSON.parse(sent[1].init.body).metadata['context.app']).toBeUndefined();
  });

  it('nested scopes layer (inner overrides outer on conflict)', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    AllStak.withScope((outer) => {
      outer.setTag('layer', 'outer');
      outer.setTag('only-outer', '1');
      AllStak.withScope((inner) => {
        inner.setTag('layer', 'inner');
        AllStak.captureException(new Error('nested'));
      });
      AllStak.captureException(new Error('back-to-outer'));
    });
    await wait(60);
    const nested = JSON.parse(sent[0].init.body).metadata;
    const backToOuter = JSON.parse(sent[1].init.body).metadata;
    expect(nested.layer).toBe('inner');
    expect(nested['only-outer']).toBe('1');
    expect(backToOuter.layer).toBe('outer');
  });

  it('scope is popped after a synchronous throw', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    expect(() => AllStak.withScope((s) => { s.setTag('bad', 'yes'); throw new Error('boom-sync'); })).toThrow(/boom-sync/);
    AllStak.captureException(new Error('after'));
    await wait(60);
    expect(JSON.parse(sent[0].init.body).metadata.bad).toBeUndefined();
  });

  it('scope is popped after an async rejection', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });
    await expect(
      AllStak.withScope(async (s) => { s.setTag('bad', 'async'); await Promise.reject(new Error('boom-async')); }),
    ).rejects.toThrow(/boom-async/);
    AllStak.captureException(new Error('after-reject'));
    await wait(60);
    expect(JSON.parse(sent[0].init.body).metadata.bad).toBeUndefined();
  });

  it('isolates overlapping async scopes in Node request contexts', async () => {
    const previousNodeFlag = globalThis.__ALLSTAK_NODE__;
    globalThis.__ALLSTAK_NODE__ = true;
    try {
      AllStak.init({ apiKey: 'k', ...cfg });

      const run = (tenant: string, delay: number) =>
        AllStak.withScope(async (scope) => {
          scope.setTag('tenant', tenant);
          await wait(delay);
          AllStak.captureException(new Error(`tenant-${tenant}`));
        });

      await Promise.all([
        run('a', 25),
        run('b', 5),
      ]);
      await wait(80);

      const bodies = sent.map((entry) => JSON.parse(entry.init.body));
      const byMessage = Object.fromEntries(bodies.map((body) => [body.message, body]));
      expect(byMessage['tenant-a'].metadata.tenant).toBe('a');
      expect(byMessage['tenant-b'].metadata.tenant).toBe('b');
    } finally {
      globalThis.__ALLSTAK_NODE__ = previousNodeFlag;
    }
  });

  it('configureScope mutates active scope or global defaults', async () => {
    AllStak.init({ apiKey: 'k', ...cfg });

    AllStak.configureScope((scope) => {
      scope.setTag('global', 'yes');
    });
    AllStak.withScope((scope) => {
      scope.setTag('local', 'yes');
      AllStak.configureScope((current) => {
        expect(current).toBe(scope);
        current.setTag('configured', 'active');
      });
      AllStak.captureException(new Error('inside-configure'));
    });
    AllStak.captureException(new Error('outside-configure'));
    await wait(80);

    const inside = JSON.parse(sent[0].init.body).metadata;
    const outside = JSON.parse(sent[1].init.body).metadata;
    expect(inside.global).toBe('yes');
    expect(inside.local).toBe('yes');
    expect(inside.configured).toBe('active');
    expect(outside.global).toBe('yes');
    expect(outside.local).toBeUndefined();
    expect(outside.configured).toBeUndefined();
  });
});
