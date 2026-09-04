/**
 * A FIFO queue decoupled from any particular item type (VideoFrame in
 * practice, but kept generic so it can be unit-tested without touching
 * WebCodecs/DOM). `push` is synchronous and never rejects a producer — the
 * decoder's output callback can't be blocked anyway. Backpressure instead
 * comes from `waitUntilBelow`, which a producer awaits *before* asking for
 * more work, so the queue can still grow briefly past that threshold while
 * in-flight work lands, but won't run away unbounded.
 */
export class FrameBuffer<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<() => void> = [];

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.notifyWaiters();
  }

  /** Resolves with the next item once one is available, FIFO order. */
  async shift(): Promise<T> {
    while (this.items.length === 0) {
      await this.wait();
    }
    const item = this.items.shift();
    if (item === undefined) throw new Error("FrameBuffer: shift() raced with itself.");
    this.notifyWaiters();
    return item;
  }

  /** Resolves once `size` is below `threshold`. Used by producers to pace
   * how far ahead of playback they decode. */
  async waitUntilBelow(threshold: number): Promise<void> {
    while (this.items.length >= threshold) {
      await this.wait();
    }
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
