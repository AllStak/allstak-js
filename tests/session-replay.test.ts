import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AllStak } from '../src/index';

const TEST_DSN = 'https://test-key@localhost:3000';

describe('Session Replay Module', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    AllStak.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('session ID is stable within same init', () => {
    AllStak.init({
      dsn: TEST_DSN,
      sessionReplay: { enabled: true },
    });

    const id1 = AllStak.getSessionId();
    const id2 = AllStak.getSessionId();
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('session ID changes on re-init', () => {
    AllStak.init({ dsn: TEST_DSN, sessionReplay: { enabled: true } });
    const id1 = AllStak.getSessionId();

    AllStak.init({ dsn: TEST_DSN, sessionReplay: { enabled: true } });
    const id2 = AllStak.getSessionId();

    expect(id1).not.toBe(id2);
  });

  it('maskAllInputs masks input values in events', async () => {
    vi.useFakeTimers();

    AllStak.init({
      dsn: TEST_DSN,
      environment: 'test',
      sessionReplay: { enabled: true, maskAllInputs: true },
    });

    // Simulate an input event
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'secret-password';
    document.body.appendChild(input);

    const inputEvent = new Event('input', { bubbles: true });
    input.dispatchEvent(inputEvent);

    // Advance timer to trigger flush
    vi.advanceTimersByTime(10_000);

    await vi.waitFor(() => {
      const replayCalls = fetchSpy.mock.calls.filter(
        ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/v1/replay'),
      );
      expect(replayCalls.length).toBeGreaterThan(0);

      const body = JSON.parse(replayCalls[replayCalls.length - 1][1].body);
      const inputEvents = body.events.filter((e: { eventType: string }) => e.eventType === 'input');
      expect(inputEvents.length).toBeGreaterThan(0);
      expect(JSON.parse(inputEvents[0].eventData).value).toBe('***');
    });

    document.body.removeChild(input);
  });

  it('batch uploads on flush interval', async () => {
    vi.useFakeTimers();

    AllStak.init({
      dsn: TEST_DSN,
      environment: 'test',
      sessionReplay: { enabled: true },
    });

    // Trigger a click event on an actual element to generate replay data
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    const clickEvent = new MouseEvent('click', { clientX: 100, clientY: 200, bubbles: true });
    btn.dispatchEvent(clickEvent);

    // Should not have sent yet (within interval)
    const replayCallsBefore = fetchSpy.mock.calls.filter(
      ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/v1/replay'),
    );

    // Advance past flush interval
    vi.advanceTimersByTime(10_000);

    await vi.waitFor(() => {
      const replayCallsAfter = fetchSpy.mock.calls.filter(
        ([url]: [string]) => typeof url === 'string' && url.includes('/ingest/v1/replay'),
      );
      expect(replayCallsAfter.length).toBeGreaterThan(replayCallsBefore.length);
    });
  });
});
