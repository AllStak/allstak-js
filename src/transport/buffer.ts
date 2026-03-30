const MAX_BUFFER_SIZE = 100;

export class EventBuffer {
  private queue: unknown[] = [];

  push(event: unknown): void {
    if (this.queue.length >= MAX_BUFFER_SIZE) {
      this.queue.shift(); // drop oldest
    }
    this.queue.push(event);
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
