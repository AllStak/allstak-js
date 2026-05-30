import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AllStak,
  __resetClickInstrumentationFlagForTest,
} from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

let sent: Array<{ url: string; init: RequestInit }> = [];

function installBrowserGlobals(): void {
  sent = [];
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }));
  __resetClickInstrumentationFlagForTest();
}

function element(
  tagName: string,
  attrs: Record<string, string> = {},
): HTMLElement {
  const node = document.createElement(tagName);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value);
  }
  document.body.appendChild(node);
  return node;
}

function click(target: HTMLElement): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

function errorBody(): any {
  const request = [...sent].reverse().find((item) => /\/ingest\/v1\/errors$/.test(item.url));
  expect(request).toBeTruthy();
  return JSON.parse(String(request!.init.body));
}

const wait = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

describe('privacy-safe click breadcrumbs', () => {
  afterEach(() => {
    AllStak.destroy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('captures safe selector summaries without input values or text', async () => {
    installBrowserGlobals();
    AllStak.init({ dsn: TEST_DSN, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    click(element('BUTTON', {
      id: 'pay-now',
      class: 'primary checkout',
      value: '4111111111111111',
      'data-secret': 'Bearer very-secret-token',
    }));
    AllStak.captureException(new Error('after-click'));
    await wait();

    const body = errorBody();
    const ui = body.breadcrumbs.find((breadcrumb: any) => breadcrumb.type === 'ui');
    expect(ui.message).toBe('click button#pay-now.primary.checkout');
    expect(ui.data).toMatchObject({
      action: 'click',
      selector: 'button#pay-now.primary.checkout',
      tag: 'button',
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('4111111111111111');
    expect(serialized).not.toContain('very-secret-token');
  });

  it('ignores password inputs', async () => {
    installBrowserGlobals();
    AllStak.init({ dsn: TEST_DSN, autoNodeErrorCapture: false, autoDbInstrumentation: false });

    click(element('INPUT', { type: 'password', id: 'account-password' }));
    AllStak.captureException(new Error('after-password-click'));
    await wait();

    expect(errorBody().breadcrumbs).toBeUndefined();
  });

  it('lets beforeBreadcrumb drop click breadcrumbs', async () => {
    installBrowserGlobals();
    AllStak.init({
      dsn: TEST_DSN,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      beforeBreadcrumb: () => null,
    });

    click(element('BUTTON', { id: 'download' }));
    AllStak.captureException(new Error('after-dropped-click'));
    await wait();

    expect(errorBody().breadcrumbs).toBeUndefined();
  });

  it('redacts secrets reintroduced by beforeBreadcrumb', async () => {
    installBrowserGlobals();
    AllStak.init({
      dsn: TEST_DSN,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      beforeBreadcrumb: (breadcrumb) => ({
        ...breadcrumb,
        data: {
          ...breadcrumb.data,
          authorization: 'Bearer hook-secret',
          nested: [{ apiKey: 'ask_live_private' }],
        },
      }),
    });

    click(element('BUTTON', { id: 'save' }));
    AllStak.captureException(new Error('after-mutated-click'));
    await wait();

    const serialized = JSON.stringify(errorBody());
    expect(serialized).not.toContain('hook-secret');
    expect(serialized).not.toContain('ask_live_private');
    expect(serialized).toContain('[REDACTED]');
  });

  it('truncates long selector summaries', async () => {
    installBrowserGlobals();
    AllStak.init({
      dsn: TEST_DSN,
      autoNodeErrorCapture: false,
      autoDbInstrumentation: false,
      clickBreadcrumbMaxSelectorLength: 48,
    });

    click(element('BUTTON', {
      id: 'payment-button-with-a-very-long-generated-identifier',
      class: 'primary checkout elevated enterprise billing',
    }));
    AllStak.captureException(new Error('after-long-click'));
    await wait();

    const ui = errorBody().breadcrumbs.find((breadcrumb: any) => breadcrumb.type === 'ui');
    expect(ui.message.length).toBeLessThanOrEqual('click '.length + 48);
    expect(ui.message).toMatch(/\[truncated]$/);
  });
});
