import { describe, expect, it } from "vitest";
import { AdaptivePrefetchController } from "./prefetch-controller";

describe("AdaptivePrefetchController", () => {
  it("returns the floor when decode speed roughly matches playback speed", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 6, maxBufferFrames: 90 });
    expect(controller.targetBufferDepth(30, 30)).toBe(6);
  });

  it("returns the floor when decode is slower than real-time", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 6, maxBufferFrames: 90 });
    expect(controller.targetBufferDepth(15, 30)).toBe(6);
  });

  it("scales the target up proportionally when decode outpaces playback", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 6, maxBufferFrames: 90 });
    // Decode is 2x real-time -> roughly 2x the floor.
    expect(controller.targetBufferDepth(60, 30)).toBe(12);
    // Decode is 4x real-time -> roughly 4x the floor.
    expect(controller.targetBufferDepth(120, 30)).toBe(24);
  });

  it("clamps to maxBufferFrames however fast decode is", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 6, maxBufferFrames: 90 });
    expect(controller.targetBufferDepth(6000, 30)).toBe(90);
  });

  it("falls back to the floor for invalid or non-positive inputs", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 6, maxBufferFrames: 90 });
    expect(controller.targetBufferDepth(NaN, 30)).toBe(6);
    expect(controller.targetBufferDepth(30, 0)).toBe(6);
    expect(controller.targetBufferDepth(-10, 30)).toBe(6);
    expect(controller.targetBufferDepth(30, Infinity)).toBe(6);
  });

  it("uses the configured min/max instead of hardcoded defaults", () => {
    const controller = new AdaptivePrefetchController({ minBufferFrames: 2, maxBufferFrames: 10 });
    expect(controller.targetBufferDepth(30, 30)).toBe(2);
    expect(controller.targetBufferDepth(1000, 30)).toBe(10);
  });
});
