export interface ChunkTimingInfo {
  /** Presentation timestamp, in the same units as everything else in this
   * module — we use microseconds throughout to match EncodedVideoChunk. */
  timestamp: number;
  type: "key" | "delta";
}

interface KeyframeEntry {
  chunkIndex: number;
  timestamp: number;
}

/**
 * Indexes which chunks (by position in the decode-order chunk array) are
 * keyframes, and answers the questions keyframe-based seeking and reverse
 * playback need: which keyframe to start decoding from to reach a given
 * timestamp, and how to walk GOP boundaries forward/backward. Pure/generic
 * — no WebCodecs or DOM dependency — so it's directly unit-testable.
 */
export class KeyframeIndex {
  private readonly keyframes: KeyframeEntry[] = [];

  constructor(chunks: readonly ChunkTimingInfo[]) {
    chunks.forEach((chunk, chunkIndex) => {
      if (chunk.type === "key") this.keyframes.push({ chunkIndex, timestamp: chunk.timestamp });
    });
    if (this.keyframes.length === 0) {
      throw new Error("KeyframeIndex: no keyframes found in the given chunks.");
    }
  }

  /**
   * Chunk index of the keyframe to start decoding from in order to reach
   * `timestampUs`: the last keyframe at or before it. IDR frames never
   * participate in B-frame reordering, so keyframe decode order and
   * presentation order agree — a straightforward ascending scan is
   * correct. Clamped to the first keyframe if `timestampUs` precedes all
   * of them.
   */
  chunkIndexForSeek(timestampUs: number): number {
    let result = this.keyframes[0].chunkIndex;
    for (const kf of this.keyframes) {
      if (kf.timestamp > timestampUs) break;
      result = kf.chunkIndex;
    }
    return result;
  }

  /** Chunk index of the keyframe that starts the GOP containing `chunkIndex`. */
  gopStartForChunkIndex(chunkIndex: number): number {
    let result = this.keyframes[0].chunkIndex;
    for (const kf of this.keyframes) {
      if (kf.chunkIndex > chunkIndex) break;
      result = kf.chunkIndex;
    }
    return result;
  }

  /** Chunk index of the keyframe just after `chunkIndex`'s GOP — the
   * exclusive end of the range a GOP decode should cover — or `null` if
   * `chunkIndex` is in the last GOP. */
  gopEndForChunkIndex(chunkIndex: number): number | null {
    for (const kf of this.keyframes) {
      if (kf.chunkIndex > chunkIndex) return kf.chunkIndex;
    }
    return null;
  }

  /** Chunk index of the keyframe immediately before `keyframeChunkIndex` (a
   * keyframe's own chunk index), or `null` if it's the first keyframe. Used
   * to step backward GOP by GOP during reverse playback. */
  previousKeyframeChunkIndex(keyframeChunkIndex: number): number | null {
    let previous: number | null = null;
    for (const kf of this.keyframes) {
      if (kf.chunkIndex >= keyframeChunkIndex) break;
      previous = kf.chunkIndex;
    }
    return previous;
  }
}
