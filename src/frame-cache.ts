export interface FrameCacheOptions<V> {
  /** Max number of entries kept before the least-recently-used one is
   * evicted. This is the real, fixed memory budget this project's
   * benchmarking rules ask for — bounded regardless of how long the video
   * is or how many seeks happen over a session. */
  capacity: number;
  /** Called for whichever entry is evicted (by capacity or by clear()). The
   * cache itself stays generic/pure — it doesn't know what a VideoFrame is,
   * only that something needs to be released when it drops an entry. */
  onEvict?: (value: V, key: unknown) => void;
}

/**
 * A capacity-bounded LRU cache. Built generic and dependency-free (no
 * WebCodecs/DOM) so its eviction-order logic is directly unit-testable;
 * `src/seekable-player.ts` is the only place that knows it's caching
 * `VideoFrame`s and closes them via `onEvict`.
 *
 * Backed by a `Map`, which iterates in insertion order — re-inserting a key
 * (delete then set) moves it to the "most recently used" end for free,
 * without needing a separate linked-list structure.
 */
export class FrameCache<K, V> {
  private readonly capacity: number;
  private readonly onEvict?: (value: V, key: K) => void;
  private readonly entries = new Map<K, V>();

  constructor(options: FrameCacheOptions<V>) {
    if (options.capacity < 1) throw new Error("FrameCache: capacity must be at least 1.");
    this.capacity = options.capacity;
    this.onEvict = options.onEvict;
  }

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  /** True only if every one of `keys` is currently cached — used to decide
   * whether a whole range (e.g. a GOP) can be served from cache without
   * decoding anything. */
  hasAll(keys: Iterable<K>): boolean {
    for (const key of keys) {
      if (!this.entries.has(key)) return false;
    }
    return true;
  }

  get(key: K): V | undefined {
    if (!this.entries.has(key)) return undefined;
    const value = this.entries.get(key) as V;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value as K;
      const oldestValue = this.entries.get(oldestKey) as V;
      this.entries.delete(oldestKey);
      this.onEvict?.(oldestValue, oldestKey);
    }
  }

  clear(): void {
    for (const [key, value] of this.entries) this.onEvict?.(value, key);
    this.entries.clear();
  }
}
