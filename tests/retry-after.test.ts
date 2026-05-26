import { describe, it, expect } from 'vitest';
import { parseRetryAfter } from '../src/transport/http';

describe('parseRetryAfter', () => {
  const NOW = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed reference, no real timers

  it('parses delta-seconds: "2" -> 2000ms', () => {
    expect(parseRetryAfter('2', NOW)).toBe(2000);
  });

  it('parses a future HTTP-date into the correct ms delta', () => {
    const future = new Date(NOW + 45_000).toUTCString(); // 45s ahead
    expect(parseRetryAfter(future, NOW)).toBe(45_000);
  });

  it('returns 0 for an HTTP-date already in the past', () => {
    const past = new Date(NOW - 10_000).toUTCString();
    expect(parseRetryAfter(past, NOW)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(parseRetryAfter(null, NOW)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseRetryAfter('', NOW)).toBe(0);
    expect(parseRetryAfter('   ', NOW)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseRetryAfter('not-a-number', NOW)).toBe(0);
    expect(parseRetryAfter('12abc', NOW)).toBe(0);
  });

  it('clamps a value greater than 300s to 300000ms', () => {
    expect(parseRetryAfter('301', NOW)).toBe(300_000);
    expect(parseRetryAfter('100000', NOW)).toBe(300_000);
  });

  it('clamps a far-future HTTP-date to 300000ms', () => {
    const farFuture = new Date(NOW + 10 * 60 * 1000).toUTCString(); // 600s
    expect(parseRetryAfter(farFuture, NOW)).toBe(300_000);
  });

  it('honours exactly 300s without clamping below', () => {
    expect(parseRetryAfter('300', NOW)).toBe(300_000);
  });
});
