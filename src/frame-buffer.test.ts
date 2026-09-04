import { describe, expect, it } from "vitest";
import { FrameBuffer } from "./frame-buffer";

describe("FrameBuffer", () => {
  it("shifts items out in FIFO order", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);

    expect(buffer.size).toBe(3);
    await expect(buffer.shift()).resolves.toBe(1);
    await expect(buffer.shift()).resolves.toBe(2);
    await expect(buffer.shift()).resolves.toBe(3);
    expect(buffer.size).toBe(0);
  });

  it("shift() waits until an item is pushed", async () => {
    const buffer = new FrameBuffer<string>();
    let resolved = false;

    const pending = buffer.shift().then((value) => {
      resolved = true;
      return value;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    buffer.push("late");
    await expect(pending).resolves.toBe("late");
    expect(resolved).toBe(true);
  });

  it("waitUntilBelow resolves immediately when already under the threshold", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.push(1);

    await expect(buffer.waitUntilBelow(2)).resolves.toBeUndefined();
  });

  it("waitUntilBelow blocks until size drops below the threshold", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.push(1);
    buffer.push(2);

    let resolved = false;
    const pending = buffer.waitUntilBelow(2).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    await buffer.shift();
    await pending;
    expect(resolved).toBe(true);
  });

  it("wakes multiple waiters when an item is pushed", async () => {
    const buffer = new FrameBuffer<number>();

    const first = buffer.shift();
    const second = buffer.shift();

    buffer.push(10);
    buffer.push(20);

    const results = await Promise.all([first, second]);
    expect(results.sort()).toEqual([10, 20]);
  });

  it("close() resolves a pending shift() with null instead of hanging forever", async () => {
    const buffer = new FrameBuffer<number>();
    const pending = buffer.shift();

    buffer.close();

    await expect(pending).resolves.toBeNull();
  });

  it("close() resolves a pending waitUntilBelow() even though the threshold was never reached", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.push(1);
    buffer.push(2);

    const pending = buffer.waitUntilBelow(1);
    buffer.close();

    await expect(pending).resolves.toBeUndefined();
  });

  it("shift() still drains items already queued before close()", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.push(1);
    buffer.close();

    await expect(buffer.shift()).resolves.toBe(1);
    await expect(buffer.shift()).resolves.toBeNull();
  });

  it("push() after close() is a no-op", async () => {
    const buffer = new FrameBuffer<number>();
    buffer.close();
    buffer.push(1);

    expect(buffer.size).toBe(0);
    await expect(buffer.shift()).resolves.toBeNull();
  });
});
