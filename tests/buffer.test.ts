import { describe, it, expect } from 'vitest';
import { EventBuffer } from '../src/transport/buffer';

describe('EventBuffer', () => {
  it('stores and drains events in order', () => {
    const buffer = new EventBuffer();
    buffer.push('a');
    buffer.push('b');
    buffer.push('c');

    const items = buffer.drain();
    expect(items).toEqual(['a', 'b', 'c']);
    expect(buffer.size).toBe(0);
  });

  it('drops oldest when max 100 is exceeded', () => {
    const buffer = new EventBuffer();
    for (let i = 0; i < 105; i++) {
      buffer.push(i);
    }

    expect(buffer.size).toBe(100);

    const items = buffer.drain();
    // Oldest 5 (0-4) should have been dropped
    expect(items[0]).toBe(5);
    expect(items[items.length - 1]).toBe(104);
  });

  it('flushBuffer sends all queued items in order', () => {
    const buffer = new EventBuffer();
    buffer.push('first');
    buffer.push('second');
    buffer.push('third');

    const drained = buffer.drain();
    expect(drained).toEqual(['first', 'second', 'third']);
  });

  it('buffer clears on successful drain', () => {
    const buffer = new EventBuffer();
    buffer.push('x');
    buffer.push('y');

    buffer.drain();
    expect(buffer.size).toBe(0);
    expect(buffer.drain()).toEqual([]);
  });

  it('peek returns copy without clearing', () => {
    const buffer = new EventBuffer();
    buffer.push('a');
    buffer.push('b');

    const peeked = buffer.peek();
    expect(peeked).toEqual(['a', 'b']);
    expect(buffer.size).toBe(2);
  });
});
