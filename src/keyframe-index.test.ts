import { describe, expect, it } from "vitest";
import { KeyframeIndex, type ChunkTimingInfo } from "./keyframe-index";

/** 90 chunks, 1000us apart, a keyframe every 30 (indices 0, 30, 60) —
 * mirrors this project's actual test fixtures (30fps, -g 30). */
function makeChunks(): ChunkTimingInfo[] {
  return Array.from({ length: 90 }, (_, i) => ({
    timestamp: i * 1000,
    type: i % 30 === 0 ? "key" : "delta",
  }));
}

describe("KeyframeIndex", () => {
  it("throws if given no keyframes", () => {
    const chunks: ChunkTimingInfo[] = [{ timestamp: 0, type: "delta" }];
    expect(() => new KeyframeIndex(chunks)).toThrow();
  });

  describe("chunkIndexForSeek", () => {
    it("returns the first keyframe for timestamp 0", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.chunkIndexForSeek(0)).toBe(0);
    });

    it("returns the preceding keyframe for a timestamp mid-GOP", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.chunkIndexForSeek(999)).toBe(0);
      expect(index.chunkIndexForSeek(45_000)).toBe(30);
      expect(index.chunkIndexForSeek(89_000)).toBe(60);
    });

    it("lands exactly on a keyframe's own timestamp", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.chunkIndexForSeek(30_000)).toBe(30);
      expect(index.chunkIndexForSeek(60_000)).toBe(60);
    });

    it("clamps to the last keyframe when the timestamp is past the end", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.chunkIndexForSeek(10_000_000)).toBe(60);
    });
  });

  describe("gopStartForChunkIndex", () => {
    it("returns the containing GOP's keyframe for a mid-GOP index", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.gopStartForChunkIndex(45)).toBe(30);
    });

    it("returns itself for a keyframe index", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.gopStartForChunkIndex(30)).toBe(30);
      expect(index.gopStartForChunkIndex(0)).toBe(0);
    });
  });

  describe("gopEndForChunkIndex", () => {
    it("returns the next keyframe's chunk index", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.gopEndForChunkIndex(0)).toBe(30);
      expect(index.gopEndForChunkIndex(29)).toBe(30);
      expect(index.gopEndForChunkIndex(45)).toBe(60);
    });

    it("returns null for the last GOP", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.gopEndForChunkIndex(60)).toBeNull();
      expect(index.gopEndForChunkIndex(89)).toBeNull();
    });
  });

  describe("previousKeyframeChunkIndex", () => {
    it("steps back one GOP at a time", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.previousKeyframeChunkIndex(60)).toBe(30);
      expect(index.previousKeyframeChunkIndex(30)).toBe(0);
    });

    it("returns null before the first keyframe", () => {
      const index = new KeyframeIndex(makeChunks());
      expect(index.previousKeyframeChunkIndex(0)).toBeNull();
    });
  });
});
