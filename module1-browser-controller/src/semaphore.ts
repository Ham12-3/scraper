/**
 * Counting semaphore. Limits concurrent access to a shared resource
 * without busy-waiting — waiters are queued as resolved promises.
 */
export class Semaphore {
  private available: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    if (permits < 1) {
      throw new RangeError(`Semaphore permits must be >= 1, got ${permits}`);
    }
    this.available = permits;
  }

  acquire(): Promise<void> {
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next !== undefined) {
      next();
    } else {
      this.available++;
    }
  }

  get waitingCount(): number {
    return this.queue.length;
  }

  get availablePermits(): number {
    return this.available;
  }
}
