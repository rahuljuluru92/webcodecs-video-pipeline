export interface PrefetchControllerOptions {
  /** Buffer depth (frames) used whenever decode speed can't be measured yet,
   * or is at/below real-time playback speed — buffering further ahead can't
   * outrun a decoder that isn't keeping up, so there's nothing to gain past
   * this floor. */
  minBufferFrames?: number;
  /** Hard ceiling on buffer depth regardless of how much faster decode is
   * than playback, so a very fast decoder on a long clip doesn't try to
   * hold the whole thing in memory (real memory bounding is Stage 5's job —
   * this is just a sane cap for this stage). */
  maxBufferFrames?: number;
}

const DEFAULT_MIN_BUFFER_FRAMES = 6;
const DEFAULT_MAX_BUFFER_FRAMES = 90;

/**
 * Decides how many frames to keep buffered ahead of the playback position,
 * given a measured decode rate and the video's nominal playback rate (both
 * in frames/sec). Pure function of its inputs — no timers, no I/O — so the
 * actual decode-speed measurement lives in the caller (player.ts).
 */
export class AdaptivePrefetchController {
  readonly minBufferFrames: number;
  readonly maxBufferFrames: number;

  constructor(options: PrefetchControllerOptions = {}) {
    this.minBufferFrames = options.minBufferFrames ?? DEFAULT_MIN_BUFFER_FRAMES;
    this.maxBufferFrames = options.maxBufferFrames ?? DEFAULT_MAX_BUFFER_FRAMES;
  }

  targetBufferDepth(decodeFps: number, playbackFps: number): number {
    if (!isPositiveFinite(decodeFps) || !isPositiveFinite(playbackFps)) {
      return this.minBufferFrames;
    }
    const speedRatio = decodeFps / playbackFps;
    const scaled = Math.round(this.minBufferFrames * Math.max(1, speedRatio));
    return Math.min(this.maxBufferFrames, Math.max(this.minBufferFrames, scaled));
  }
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}
