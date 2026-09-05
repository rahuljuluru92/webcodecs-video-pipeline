import { describe, expect, it, vi } from "vitest";
import { FrameCache } from "./frame-cache";

describe("FrameCache", () => {
  it("stores and retrieves values", () => {
    const cache = new FrameCache<number, string>({ capacity: 3 });
    cache.set(1, "a");
    cache.set(2, "b");

    expect(cache.get(1)).toBe("a");
    expect(cache.get(2)).toBe("b");
    expect(cache.get(3)).toBeUndefined();
    expect(cache.size).toBe(2);
  });

  it("evicts the least-recently-used entry when over capacity", () => {
    const evicted: number[] = [];
    const cache = new FrameCache<number, string>({
      capacity: 2,
      onEvict: (_value, key) => evicted.push(key as number),
    });

    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(3, "c"); // 1 is least-recently-used (never touched again) -> evicted

    expect(evicted).toEqual([1]);
    expect(cache.size).toBe(2);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it("get() refreshes recency, protecting an entry from eviction", () => {
    const evicted: number[] = [];
    const cache = new FrameCache<number, string>({
      capacity: 2,
      onEvict: (_value, key) => evicted.push(key as number),
    });

    cache.set(1, "a");
    cache.set(2, "b");
    cache.get(1); // touch 1 -> now 2 is least-recently-used
    cache.set(3, "c");

    expect(evicted).toEqual([2]);
    expect(cache.has(1)).toBe(true);
    expect(cache.has(3)).toBe(true);
  });

  it("re-setting an existing key updates it without evicting anything", () => {
    const onEvict = vi.fn();
    const cache = new FrameCache<number, string>({ capacity: 2, onEvict });

    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(1, "a-updated");

    expect(onEvict).not.toHaveBeenCalled();
    expect(cache.get(1)).toBe("a-updated");
    expect(cache.size).toBe(2);
  });

  it("hasAll is true only when every given key is present", () => {
    const cache = new FrameCache<number, string>({ capacity: 5 });
    cache.set(1, "a");
    cache.set(2, "b");

    expect(cache.hasAll([1, 2])).toBe(true);
    expect(cache.hasAll([1, 2, 3])).toBe(false);
    expect(cache.hasAll([])).toBe(true);
  });

  it("clear() evicts everything currently cached", () => {
    const evicted: number[] = [];
    const cache = new FrameCache<number, string>({
      capacity: 5,
      onEvict: (_value, key) => evicted.push(key as number),
    });
    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(3, "c");

    cache.clear();

    expect(evicted.sort()).toEqual([1, 2, 3]);
    expect(cache.size).toBe(0);
  });

  it("never exceeds capacity across many insertions", () => {
    const cache = new FrameCache<number, number>({ capacity: 10 });
    for (let i = 0; i < 1000; i++) {
      cache.set(i, i);
      expect(cache.size).toBeLessThanOrEqual(10);
    }
    expect(cache.size).toBe(10);
  });

  it("rejects a capacity below 1", () => {
    expect(() => new FrameCache({ capacity: 0 })).toThrow();
  });
});
