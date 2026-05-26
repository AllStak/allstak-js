import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TracingModule,
  type SpanData,
  type SamplingContext,
} from '../src/modules/tracing';
import type { HttpTransport } from '../src/transport/http';
import {
  tracePropagationValues,
  applyTracePropagationToHeaders,
} from '../src/modules/trace-propagation';

/** Minimal transport stub that records the spans handed to `send`. */
function fakeTransport(): { transport: HttpTransport; sentSpans: () => SpanData[] } {
  const calls: { path: string; payload: unknown }[] = [];
  const transport = {
    send(path: string, payload: unknown) {
      calls.push({ path, payload });
      return Promise.resolve();
    },
  } as unknown as HttpTransport;
  const sentSpans = () =>
    calls
      .filter((c) => c.path === '/ingest/v1/spans')
      .flatMap((c) => (c.payload as { spans: SpanData[] }).spans);
  return { transport, sentSpans };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('tracesSampleRate — span recording', () => {
  it('tracesSampleRate=0 → spans are NOT recorded/sent', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, { tracesSampleRate: 0 });

    const span = tracing.startSpan('GET /users');
    span.finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(0);
    expect(tracing.getSampled()).toBe(false);
    tracing.destroy();
  });

  it('tracesSampleRate=1 → spans ARE recorded/sent', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, { tracesSampleRate: 1 });

    const span = tracing.startSpan('GET /users');
    span.finish('ok');
    tracing.flush();

    const spans = sentSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].operation).toBe('GET /users');
    expect(tracing.getSampled()).toBe(true);
    tracing.destroy();
  });

  it('unset (back-compat) → tracing stays fully on (spans recorded)', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, {});

    const span = tracing.startSpan('work');
    span.finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(1);
    expect(tracing.getSampled()).toBe(true);
    tracing.destroy();
  });
});

describe('tracesSampler — function form', () => {
  it('is called with the sampling context and its boolean return is honored', () => {
    const { transport, sentSpans } = fakeTransport();
    const sampler = vi.fn<(c: SamplingContext) => boolean>(() => false);
    const tracing = new TracingModule(transport, { tracesSampler: sampler });

    const span = tracing.startSpan('POST /pay', {
      attributes: { 'http.route': '/pay' },
    });
    span.finish('ok');
    tracing.flush();

    expect(sampler).toHaveBeenCalledTimes(1);
    const ctx = sampler.mock.calls[0][0];
    expect(ctx.name).toBe('POST /pay');
    expect(ctx.attributes['http.route']).toBe('/pay');
    expect(sentSpans()).toHaveLength(0); // sampler returned false → dropped
    tracing.destroy();
  });

  it('numeric return is treated as a probability (1 → sampled)', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, { tracesSampler: () => 1 });

    tracing.startSpan('op').finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(1);
    tracing.destroy();
  });

  it('numeric 0 → not sampled', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, { tracesSampler: () => 0 });

    tracing.startSpan('op').finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(0);
    tracing.destroy();
  });

  it('receives parentSampled from the inbound decision', () => {
    const { transport } = fakeTransport();
    const sampler = vi.fn<(c: SamplingContext) => boolean>(() => true);
    const tracing = new TracingModule(transport, { tracesSampler: sampler });

    tracing.setParentSampled(false);
    tracing.startSpan('op').finish('ok');

    expect(sampler.mock.calls[0][0].parentSampled).toBe(false);
    tracing.destroy();
  });

  it('takes precedence over tracesSampleRate', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, {
      tracesSampleRate: 0, // would drop
      tracesSampler: () => true, // wins → recorded
    });

    tracing.startSpan('op').finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(1);
    tracing.destroy();
  });

  it('fails open when the sampler throws', () => {
    const { transport, sentSpans } = fakeTransport();
    const tracing = new TracingModule(transport, {
      tracesSampler: () => {
        throw new Error('boom');
      },
    });

    tracing.startSpan('op').finish('ok');
    tracing.flush();

    expect(sentSpans()).toHaveLength(1);
    tracing.destroy();
  });
});

describe('sticky head-of-trace inheritance', () => {
  it('children inherit the root decision; sampler called once per trace (sampled)', () => {
    const { transport, sentSpans } = fakeTransport();
    const sampler = vi.fn<(c: SamplingContext) => boolean>(() => true);
    const tracing = new TracingModule(transport, { tracesSampler: sampler });

    const root = tracing.startSpan('root');
    const child = tracing.startSpan('child');
    child.finish('ok');
    root.finish('ok');
    tracing.flush();

    expect(sampler).toHaveBeenCalledTimes(1); // decided once at root
    expect(sentSpans()).toHaveLength(2); // both recorded
    tracing.destroy();
  });

  it('children inherit the root decision (unsampled → none recorded)', () => {
    const { transport, sentSpans } = fakeTransport();
    const sampler = vi.fn<(c: SamplingContext) => boolean>(() => false);
    const tracing = new TracingModule(transport, { tracesSampler: sampler });

    const root = tracing.startSpan('root');
    const child = tracing.startSpan('child');
    child.finish('ok');
    root.finish('ok');
    tracing.flush();

    expect(sampler).toHaveBeenCalledTimes(1);
    expect(sentSpans()).toHaveLength(0);
    tracing.destroy();
  });

  it('resetTrace clears the sticky decision so the next trace re-decides', () => {
    const { transport } = fakeTransport();
    const sampler = vi.fn<(c: SamplingContext) => boolean>(() => true);
    const tracing = new TracingModule(transport, { tracesSampler: sampler });

    tracing.startSpan('a').finish('ok');
    tracing.resetTrace();
    tracing.startSpan('b').finish('ok');

    expect(sampler).toHaveBeenCalledTimes(2);
    tracing.destroy();
  });
});

describe('propagation reflects the sampling decision (traceparent flag)', () => {
  it('sampled=true → traceparent ends with -01', () => {
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4', { sampled: true });
    expect(v.traceparent).toMatch(/-01$/);
    expect(v.allstakTrace).toMatch(/-1$/);
  });

  it('sampled=false → traceparent ends with -00', () => {
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4', { sampled: false });
    expect(v.traceparent).toMatch(/-00$/);
    expect(v.allstakTrace).toMatch(/-0$/);
  });

  it('default (no options) stays sampled -01 (back-compat)', () => {
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4');
    expect(v.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('applyTracePropagationToHeaders honors sampled=false', () => {
    const headers: Record<string, unknown> = {};
    applyTracePropagationToHeaders(headers, '7f3ac1d9', 'a1b2c3d4', { sampled: false });
    expect(String(headers.traceparent)).toMatch(/-00$/);
  });
});

describe('propagation uses the active span id (synthetic-id fix)', () => {
  it('uses the provided active span id as the parent span id', () => {
    const activeSpanId = 'abcdef0123456789';
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4', { spanId: activeSpanId });
    // traceparent format: 00-<32 trace>-<16 parent>-<flags>
    expect(v.traceparent.split('-')[2]).toBe(activeSpanId);
    expect(v.baggage).toContain(`allstak-span_id=${activeSpanId}`);
  });

  it('falls back to the requestId-derived parent when no active span is given', () => {
    const requestId = 'a1b2c3d4';
    const derived = requestId.replace(/-/g, '').slice(0, 16).padEnd(16, '0');
    const v = tracePropagationValues('7f3ac1d9', requestId);
    expect(v.traceparent.split('-')[2]).toBe(derived);
  });

  it('normalizes an over-long active span id to 16 hex chars', () => {
    const v = tracePropagationValues('7f3ac1d9', 'a1b2c3d4', {
      spanId: 'abcdef0123456789ffff',
    });
    expect(v.traceparent.split('-')[2]).toBe('abcdef0123456789');
  });
});
