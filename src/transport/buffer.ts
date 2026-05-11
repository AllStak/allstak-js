const MAX_BUFFER_SIZE = 100;

export class EventBuffer {
  private queue: unknown[] = [];

  push(event: unknown): boolean {
    let dropped = false;
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      this.queue.shift(); // drop oldest
      dropped = true;
    }
    this.queue.push(event);
    return dropped;
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
