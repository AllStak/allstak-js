const MAX_BUFFER_SIZE = 100;

export class EventBuffer {
  private queue: unknown[] = [];

  push(event: unknown): boolean {
    return this.pushReturningEvicted(event) !== null;
  }

  /**
   * Like {@link push} but returns the OLDEST item that was evicted to make
   * room (or `null` when nothing was dropped). The transport uses the evictee
   * to spill into the persistent offline store instead of losing it.
   */
  pushReturningEvicted(event: unknown): unknown | null {
    let evicted: unknown | null = null;
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      evicted = this.queue.shift() ?? null; // drop oldest
    }
    this.queue.push(event);
    return evicted;
  }

  drain(): unknown[] {
    const items = [...this.queue];
    this.queue = [];
    return items;
  }

  get size(): number {
    return this.queue.length;
  }

  peek(): unknown[] {
    return [...this.queue];
  }
}
