/**
 * AllStak parity API tests for @allstak/js v0.1.4:
 *   - beforeSend (mutate, drop, async, error-safe)
 *   - sampleRate
 *   - setTags / setExtra / setExtras / setContext
 *   - setLevel / setFingerprint
 *   - flush()
 *   - error.name override survives as exceptionClass
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AllStak } from '../src/index';
import { defineIntegration } from '../src/integration';
import { instrumentFetch } from '../src/modules/auto-breadcrumbs';
import { TracingModule } from '../src/modules/tracing';

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

describe('event processors and inbound filters', () => {
  it('eventProcessors can mutate and drop events before beforeSend', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      eventProcessors: [
        (event: any) => ({ ...event, message: `processed:${event.message}` }),
      ],
      beforeSend: (event: any) => ({ ...event, message: `before:${event.message}` }),
    });
    AllStak.addEventProcessor((event: any) => event.message.includes('drop') ? null : event);

    AllStak.captureException(new Error('keep'));
    AllStak.captureException(new Error('drop'));
    await wait();

    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0].init.body).message).toBe('before:processed:keep');
  });

  it('ignoreErrors drops matching errors', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      ignoreErrors: [/ChunkLoadError/, 'ResizeObserver loop limit exceeded'],
    });

    AllStak.captureException(new Error('ChunkLoadError: Loading chunk 42 failed'));
    AllStak.captureException(new Error('real failure'));
    await wait();

    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0].init.body).message).toBe('real failure');
  });

  it('denyUrls and allowUrls filter by stack frame URL', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      denyUrls: [/extensions\.example/],
      allowUrls: [/app\.example/],
    });

    const denied = new Error('extension noise');
    denied.stack = 'Error: extension noise\n    at fn (https://extensions.example/injected.js:1:2)';
    const allowed = new Error('app failure');
    allowed.stack = 'Error: app failure\n    at fn (https://app.example/assets/app.js:3:4)';
    const notAllowed = new Error('other failure');
    notAllowed.stack = 'Error: other failure\n    at fn (https://cdn.example/vendor.js:5:6)';

    AllStak.captureException(denied);
    AllStak.captureException(allowed);
    AllStak.captureException(notAllowed);
    await wait();

    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0].init.body).message).toBe('app failure');
  });

  it('dedupe drops consecutive duplicate events and can be disabled', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    const first = new Error('same');
    first.stack = 'Error: same\n    at fn (https://app.example/assets/app.js:9:10)';
    const second = new Error('same');
    second.stack = first.stack;
    AllStak.captureException(first);
    AllStak.captureException(second);
    await wait();
    expect(sent.length).toBe(1);

    sent.length = 0;
    AllStak.destroy();
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false, dedupe: false });
    AllStak.captureException(first);
    AllStak.captureException(second);
    await wait();
    expect(sent.length).toBe(2);
  });

  it('defaultIntegrations=false disables built-in filters and dedupe', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      defaultIntegrations: false,
      ignoreErrors: ['drop-me'],
    });

    const first = new Error('drop-me');
    first.stack = 'Error: drop-me\n    at fn (https://app.example/assets/app.js:1:2)';
    const second = new Error('drop-me');
    second.stack = first.stack;
    AllStak.captureException(first);
    AllStak.captureException(second);
    await wait();

    expect(sent.length).toBe(2);
  });

  it('custom integrations can process events and replace defaults by name', async () => {
    const CustomFilters = defineIntegration(() => ({
      name: 'EventFilters',
      processEvent(event: any) {
        return { ...event, message: `custom:${event.message}` };
      },
    }));

    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      ignoreErrors: ['drop-me'],
      integrations: (defaults) => [...defaults, CustomFilters()],
    });

    AllStak.captureException(new Error('drop-me'));
    await wait();

    expect(AllStak.getIntegration('EventFilters')?.name).toBe('EventFilters');
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0].init.body).message).toBe('custom:drop-me');
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

  it('waits for pending async error pipeline work before reporting drained', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      beforeSend: async (event: any) => {
        await wait(50);
        return { ...event, message: `flushed:${event.message}` };
      },
    });

    AllStak.captureException(new Error('pipeline'));

    expect(await AllStak.flush(500)).toBe(true);
    const payload = JSON.parse(sent.find((entry) => entry.url.includes('/ingest/v1/errors'))!.init.body);
    expect(payload.message).toBe('flushed:pipeline');
  });

  it('flushes completed spans and waits for transport delivery', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    AllStak.trace('flush.short-lived-script', () => undefined);

    expect(await AllStak.flush(500)).toBe(true);
    const spanRequest = sent.find((entry) => entry.url.includes('/ingest/v1/spans'));
    expect(spanRequest).toBeDefined();
    const body = JSON.parse(spanRequest!.init.body);
    expect(body.spans[0].operation).toBe('flush.short-lived-script');
    expect(['browser', 'node']).toContain(body.spans[0].platform);
    expect(body.spans[0].op).toBe('flush');
    expect(body.spans[0].measurements.duration_ms).toEqual(expect.any(Number));
    expect(body.spans[0].attributes).toEqual({});
  });

  it('uses unref timers so SDK batching does not keep Node scripts alive', () => {
    const unref = vi.fn();
    vi.stubGlobal('setInterval', vi.fn((_handler: unknown, _timeout?: number, ..._args: unknown[]) => {
      return { unref } as unknown as ReturnType<typeof setInterval>;
    }));

    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    expect(unref).toHaveBeenCalled();
  });
});

describe('AllStak-style tracing parity', () => {
  it('trace() finishes sync spans automatically', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    const result = AllStak.trace('unit.work', () => 42);
    expect(result).toBe(42);
    AllStak.destroy();

    await wait();
    const spanRequest = sent.find((entry) => entry.url.includes('/ingest/v1/spans'));
    expect(spanRequest).toBeDefined();
    const body = JSON.parse(spanRequest!.init.body);
    expect(body.spans[0].operation).toBe('unit.work');
    expect(body.spans[0].status).toBe('ok');
  });

  it('trace() marks rejected async work as failed and rethrows', async () => {
    AllStak.init({ apiKey: 'k', autoBreadcrumbs: false, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    await expect(AllStak.trace('unit.fail', async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
    AllStak.destroy();

    await wait();
    const spanRequest = sent.find((entry) => entry.url.includes('/ingest/v1/spans'));
    expect(spanRequest).toBeDefined();
    const body = JSON.parse(spanRequest!.init.body);
    expect(body.spans[0].operation).toBe('unit.fail');
    expect(body.spans[0].status).toBe('error');
  });

  it('fetch propagation preserves existing headers and merges AllStak baggage', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    }) as any;

    try {
      instrumentFetch(
        () => undefined,
        undefined,
        'https://api.allstak.sa',
        () => ({ traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
        undefined,
        ['example.com'],
      );

      await fetch('https://example.com/api', {
        headers: {
          traceparent: '00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01',
          baggage: 'vendor=value',
        },
      });

      const headers = calls[0].init!.headers as Headers;
      expect(headers.get('traceparent')).toBe('00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01');
      expect(headers.get('x-allstak-trace-id')).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(headers.get('allstak-baggage')).toContain('allstak-trace_id=');
      expect(headers.get('baggage')).toContain('vendor=value');
      expect(headers.get('baggage')).toContain('allstak-trace_id=');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('isolates concurrent Node trace contexts', async () => {
    const previousNodeFlag = globalThis.__ALLSTAK_NODE__;
    globalThis.__ALLSTAK_NODE__ = true;
    const sentSpans: any[] = [];
    const tracing = new TracingModule({ send: (_path: string, payload: any) => sentSpans.push(...payload.spans) } as any, {});

    try {
      const run = (traceId: string, delay: number) =>
        tracing.withTraceContext(traceId, async () => {
          const root = tracing.startSpan(`root-${traceId}`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          const child = tracing.startSpan(`child-${traceId}`);
          expect(child.traceId).toBe(traceId);
          child.finish();
          root.finish();
        });

      await Promise.all([
        run('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 25),
        run('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 5),
      ]);
      tracing.destroy();

      const aSpans = sentSpans.filter((span) => span.traceId === 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const bSpans = sentSpans.filter((span) => span.traceId === 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      expect(aSpans.map((span) => span.operation).sort()).toEqual([
        'child-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'root-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ]);
      expect(bSpans.map((span) => span.operation).sort()).toEqual([
        'child-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'root-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ]);
    } finally {
      tracing.destroy();
      globalThis.__ALLSTAK_NODE__ = previousNodeFlag;
    }
  });

  it('processSpan integrations, ignoreSpans, and beforeSendSpan shape emitted spans', async () => {
    const SpanTagger = defineIntegration(() => ({
      name: 'SpanTagger',
      processSpan(span: any) {
        return {
          ...span,
          tags: { ...span.tags, integration: 'span-tagger' },
        };
      },
    }));

    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      ignoreSpans: ['drop.operation'],
      integrations: (defaults) => [...defaults, SpanTagger()],
      beforeSendSpan: (span: any) => ({
        ...span,
        description: `processed:${span.description}`,
      }),
    });

    const kept = AllStak.startSpan('keep.operation', { description: 'keep me' });
    kept.finish();
    const dropped = AllStak.startSpan('drop.operation', { description: 'drop me' });
    dropped.finish();
    AllStak.destroy();

    await wait();
    const spanRequest = sent.find((entry) => entry.url.includes('/ingest/v1/spans'));
    expect(spanRequest).toBeDefined();
    const body = JSON.parse(spanRequest!.init.body);
    expect(body.spans).toHaveLength(1);
    expect(body.spans[0].operation).toBe('keep.operation');
    expect(body.spans[0].description).toBe('processed:keep me');
    expect(body.spans[0].tags.integration).toBe('span-tagger');
  });

  it('addSpanProcessor can drop spans at runtime', async () => {
    AllStak.init({
      apiKey: 'k',
      autoBreadcrumbs: false,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
    });
    AllStak.addSpanProcessor((span) => span.operation === 'drop.runtime' ? null : span);

    AllStak.startSpan('drop.runtime').finish();
    AllStak.startSpan('keep.runtime').finish();
    AllStak.destroy();

    await wait();
    const spanRequest = sent.find((entry) => entry.url.includes('/ingest/v1/spans'));
    expect(spanRequest).toBeDefined();
    const body = JSON.parse(spanRequest!.init.body);
    expect(body.spans.map((span: any) => span.operation)).toEqual(['keep.runtime']);
  });
});
