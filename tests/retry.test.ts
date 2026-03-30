import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry } from '../src/utils/retry';

describe('withRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries exactly maxRetries times then throws', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(withRetry(fn, 3, 1)).rejects.toThrow('fail');
    // 1 initial + 3 retries = 4 total calls
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('success on first retry stops further attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('recovered');

    const result = await withRetry(fn, 3, 1);
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('delay doubles on each attempt (exponential backoff)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    await expect(withRetry(fn, 3, 100)).rejects.toThrow('fail');

    // Extract delays passed to setTimeout (filter for our retry delays)
    const delays = setTimeoutSpy.mock.calls
      .map((call) => call[1] as number)
      .filter((d) => d >= 100);

    expect(delays).toEqual([100, 200, 400]);
  });

  it('works with maxRetries = 0 (no retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(withRetry(fn, 0, 1)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
