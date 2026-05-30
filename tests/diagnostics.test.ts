import { afterEach, describe, expect, it, vi } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('SDK diagnostics', () => {
  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
  });

  it('exposes a privacy-safe transport and queue snapshot', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    AllStak.init({ dsn: TEST_DSN, environment: 'test' });

    AllStak.addBreadcrumb('custom', 'clicked Save', 'info');
    await AllStak.captureMessage('hello diagnostics');
    await AllStak.flush(500);

    const diagnostics = AllStak.getDiagnostics();
    expect(diagnostics).toBeTruthy();
    expect(diagnostics!.transport.sent).toBeGreaterThan(0);
    expect(diagnostics!.transport.failed).toBe(0);
    expect(diagnostics!.transport.rateLimited).toBe(0);
    expect(diagnostics!.queueSize).toBe(0);
    expect(diagnostics!.breadcrumbs).toBeGreaterThanOrEqual(1);
    expect(diagnostics).not.toHaveProperty('user');
    expect(JSON.stringify(diagnostics)).not.toContain('hello diagnostics');
    expect(JSON.stringify(diagnostics)).not.toContain('clicked Save');
  });

  it('counts failed retry attempts and rate limits', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '1' }),
      }));
      AllStak.init({ dsn: TEST_DSN, environment: 'test', enableOfflineQueue: false });

      await AllStak.captureMessage('rate limited');
      await vi.advanceTimersByTimeAsync(10);

      const diagnostics = AllStak.getDiagnostics();
      expect(diagnostics!.transport.failed).toBeGreaterThan(0);
      expect(diagnostics!.transport.retryAttempts).toBeGreaterThan(0);
      expect(diagnostics!.transport.rateLimited).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
