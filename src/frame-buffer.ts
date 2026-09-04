/**
 * A FIFO queue decoupled from any particular item type (VideoFrame in
 * practice, but kept generic so it can be unit-tested without touching
 * WebCodecs/DOM). `push` is synchronous and never rejects a producer — the
 * decoder's output callback can't be blocked anyway. Backpressure instead
 * comes from `waitUntilBelow`, which a producer awaits *before* asking for
 * more work, so the queue can still grow briefly past that threshold while
 * in-flight work lands, but won't run away unbounded.
 *
 * `close()` unblocks every waiter (a paused/seeked-away consumer isn't
 * going to shift anything else out, and a producer that's mid-`waitUntilBelow`
 * shouldn't be stuck waiting forever once nothing will ever consume from it
 * again) — used when a playback loop is cancelled mid-flight.
 */
export class FrameBuffer<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    this.notifyWaiters();
  }

  /** Resolves with the next item (FIFO order), or `null` once the buffer is
   * closed and drained. */
  async shift(): Promise<T | null> {
    while (this.items.length === 0 && !this.closed) {
      await this.wait();
    }
    if (this.items.length === 0) return null;
    const item = this.items.shift();
    if (item === undefined) throw new Error("FrameBuffer: shift() raced with itself.");
    this.notifyWaiters();
    return item;
  }

  /** Resolves once `size` is below `threshold`, or the buffer is closed. */
  async waitUntilBelow(threshold: number): Promise<void> {
    while (this.items.length >= threshold && !this.closed) {
      await this.wait();
    }
  }

  close(): void {
    this.closed = true;
    this.notifyWaiters();
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private notifyWaiters(): void {
    const toNotify = this.waiters.splice(0, this.waiters.length);
    for (const notify of toNotify) notify();
  }
}
