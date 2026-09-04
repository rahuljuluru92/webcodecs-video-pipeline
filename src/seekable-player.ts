import { demuxVideoTrack } from "./mp4-demuxer";
import { FrameBuffer } from "./frame-buffer";
import { AdaptivePrefetchController } from "./prefetch-controller";
import { KeyframeIndex } from "./keyframe-index";
import { decodeChunkRange } from "./gop-decoder";

export interface SeekMetrics {
  requestedTimestampSeconds: number;
  actualTimestampSeconds: number;
  latencyMs: number;
  framesDecodedToReachTarget: number;
}

export interface PlaybackMetrics {
  decodeFps: number;
  targetBufferDepth: number;
}

export interface SeekablePlayerHandlers {
  onFrame?(currentTimeSeconds: number, durationSeconds: number): void;
  onSeek?(metrics: SeekMetrics): void;
  onPlaybackMetrics?(metrics: PlaybackMetrics): void;
  onEnded?(): void;
  onError?(error: unknown): void;
}

const MAX_DECODER_QUEUE_SIZE = 2;
/** Frames decoded before the buffer's target depth would first gate the
 * feed loop — see the equivalent constant/comment in the Stage 2 design
 * notes in DECISIONS.md. */
const WARMUP_FRAME_COUNT = 6;

/**
 * A persistent, seekable WebCodecs video player: loads a file once, then
 * supports play/pause, frame-accurate seeking (keyframe + decode-forward),
 * variable playback speed, and reverse playback (GOP-buffered, since
 * VideoDecoder only ever decodes forward from a keyframe).
 */
export class SeekablePlayer {
  private readonly canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  private readonly config: VideoDecoderConfig;
  private readonly chunks: EncodedVideoChunk[];
  private readonly keyframeIndex: KeyframeIndex;
  private readonly durationSeconds: number;
  private readonly nominalPlaybackFps: number;
  private readonly prefetchController = new AdaptivePrefetchController();
  private readonly handlers: SeekablePlayerHandlers;

  /** Decode-order index of the last-displayed frame's chunk. */
  private currentChunkIndex = 0;
  private currentTimestampUs = 0;
  private playbackRate = 1;
  private direction: 1 | -1 = 1;
  /** Bumped on pause/seek/direction-change to cancel any in-flight play loop. */
  private playToken = 0;
  private playing = false;

  private constructor(
    canvas: OffscreenCanvas,
    config: VideoDecoderConfig,
    chunks: EncodedVideoChunk[],
    durationSeconds: number,
    handlers: SeekablePlayerHandlers,
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable.");
    this.ctx = ctx;
    this.config = config;
    this.chunks = chunks;
    this.keyframeIndex = new KeyframeIndex(chunks);
    this.durationSeconds = durationSeconds;
    this.nominalPlaybackFps = chunks.length / durationSeconds;
    this.handlers = handlers;
  }

  static async load(
    arrayBuffer: ArrayBuffer,
    canvas: OffscreenCanvas,
    handlers: SeekablePlayerHandlers = {},
  ): Promise<SeekablePlayer> {
    let config: VideoDecoderConfig | undefined;
    let durationSeconds = 0;
    const chunks: EncodedVideoChunk[] = [];

    await demuxVideoTrack(
      arrayBuffer,
      (result) => {
        config = result.config;
        durationSeconds = result.durationSeconds;
      },
      (chunk) => chunks.push(chunk),
    );

    if (!config) throw new Error("Failed to determine a decoder config for this file.");
    if (chunks.length === 0) throw new Error("No video frames found in this file.");

    const player = new SeekablePlayer(canvas, config, chunks, durationSeconds, handlers);
    await player.seekTo(0);
    return player;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  get currentTime(): number {
    return this.currentTimestampUs / 1_000_000;
  }

  get paused(): boolean {
    return !this.playing;
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
  }

  setDirection(direction: 1 | -1): void {
    if (this.direction === direction) return;
    this.direction = direction;
    if (this.playing) this.restartPlayLoop();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.restartPlayLoop();
  }

  pause(): void {
    this.playing = false;
    this.playToken++;
  }

  private restartPlayLoop(): void {
    const token = ++this.playToken;
    if (this.direction === 1) void this.runForward(token);
    else void this.runReverse(token);
  }

  async seekTo(timestampSeconds: number): Promise<void> {
    this.playing = false;
    const token = ++this.playToken;

    const clamped = Math.max(0, Math.min(this.durationSeconds, timestampSeconds));
    const targetUs = Math.round(clamped * 1_000_000);
    const startedAt = performance.now();

    const gopStart = this.keyframeIndex.chunkIndexForSeek(targetUs);
    const gopEnd = this.keyframeIndex.gopEndForChunkIndex(gopStart) ?? this.chunks.length;

    let frames: VideoFrame[];
    try {
      frames = await decodeChunkRange(this.chunks, this.config, gopStart, gopEnd);
    } catch (error) {
      this.handlers.onError?.(error);
      return;
    }

    if (token !== this.playToken) {
      frames.forEach((frame) => frame.close());
      return;
    }

    let targetIndex = frames.findIndex((frame) => frame.timestamp >= targetUs);
    if (targetIndex === -1) targetIndex = frames.length - 1;
    const targetFrame = frames[targetIndex];
    const actualTimestampUs = targetFrame.timestamp;

    this.drawFrame(targetFrame);
    this.currentChunkIndex = gopStart + targetIndex;
    this.currentTimestampUs = actualTimestampUs;

    frames.forEach((frame) => frame.close());

    this.handlers.onSeek?.({
      requestedTimestampSeconds: clamped,
      actualTimestampSeconds: actualTimestampUs / 1_000_000,
      latencyMs: performance.now() - startedAt,
      framesDecodedToReachTarget: frames.length,
    });
    this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
  }

  private drawFrame(frame: VideoFrame): void {
    this.canvas.width = frame.displayWidth;
    this.canvas.height = frame.displayHeight;
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
  }

  private async runForward(token: number): Promise<void> {
    const buffer = new FrameBuffer<VideoFrame>();
    let bufferCapacity = this.prefetchController.minBufferFrames;
    let warmupStartMs: number | null = null;
    let warmupFrameCount = 0;
    let hasAdapted = false;

    // A freshly-configured VideoDecoder requires its first decoded chunk to
    // be a keyframe, but resuming playback can land mid-GOP (e.g. right
    // after a seek). So this always starts feeding from the covering GOP's
    // keyframe, and discards ("catch-up") any output frame at or before
    // what's already on screen rather than re-displaying or re-buffering it.
    const skipAtOrBeforeTimestampUs = this.currentTimestampUs;

    const decoder = new VideoDecoder({
      output: (frame) => {
        if (token !== this.playToken || frame.timestamp <= skipAtOrBeforeTimestampUs) {
          frame.close();
          return;
        }
        if (warmupStartMs === null) warmupStartMs = performance.now();
        warmupFrameCount++;
        if (!hasAdapted && warmupFrameCount >= WARMUP_FRAME_COUNT) {
          const elapsedMs = performance.now() - warmupStartMs;
          const decodeFps =
            elapsedMs > 0 ? (warmupFrameCount / elapsedMs) * 1000 : this.nominalPlaybackFps;
          bufferCapacity = this.prefetchController.targetBufferDepth(decodeFps, this.nominalPlaybackFps);
          hasAdapted = true;
          this.handlers.onPlaybackMetrics?.({ decodeFps, targetBufferDepth: bufferCapacity });
        }
        buffer.push(frame);
      },
      error: (error) => this.handlers.onError?.(error),
    });
    decoder.configure(this.config);

    const resumeFromChunkIndex = this.currentChunkIndex + 1;
    const startIndex = this.keyframeIndex.gopStartForChunkIndex(
      Math.min(resumeFromChunkIndex, this.chunks.length - 1),
    );

    const feedLoop = (async () => {
      for (let i = startIndex; i < this.chunks.length; i++) {
        if (token !== this.playToken) break;
        while (decoder.decodeQueueSize > MAX_DECODER_QUEUE_SIZE) {
          if (token !== this.playToken) break;
          await new Promise<void>((resolve) => {
            decoder.addEventListener("dequeue", () => resolve(), { once: true });
          });
        }
        if (token !== this.playToken) break;
        await buffer.waitUntilBelow(bufferCapacity);
        if (token !== this.playToken) break;
        decoder.decode(this.chunks[i]);
      }
      if (token === this.playToken) {
        try {
          await decoder.flush();
        } catch {
          // decoder was closed out from under us by a cancellation; ignore.
        }
      }
      buffer.close();
      try {
        decoder.close();
      } catch {
        // already closed
      }
    })();

    const playbackStartMs = performance.now();
    const anchorTimestampUs = this.currentTimestampUs;

    while (token === this.playToken) {
      const frame = await buffer.shift();
      if (frame === null) break;
      if (token !== this.playToken) {
        frame.close();
        break;
      }

      const elapsedVideoMs = (frame.timestamp - anchorTimestampUs) / 1000 / this.playbackRate;
      const targetMs = playbackStartMs + elapsedVideoMs;
      const delayMs = Math.max(0, targetMs - performance.now());
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

      if (token !== this.playToken) {
        frame.close();
        break;
      }

      this.drawFrame(frame);
      this.currentChunkIndex++;
      this.currentTimestampUs = frame.timestamp;
      frame.close();
      this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
    }

    await feedLoop;

    if (token === this.playToken) {
      this.playing = false;
      this.handlers.onEnded?.();
    }
  }

  private async runReverse(token: number): Promise<void> {
    let gopStart = this.keyframeIndex.gopStartForChunkIndex(this.currentChunkIndex);

    while (token === this.playToken) {
      const gopEnd = this.keyframeIndex.gopEndForChunkIndex(gopStart) ?? this.chunks.length;

      let frames: VideoFrame[];
      try {
        frames = await decodeChunkRange(this.chunks, this.config, gopStart, gopEnd);
      } catch (error) {
        this.handlers.onError?.(error);
        return;
      }

      if (token !== this.playToken) {
        frames.forEach((frame) => frame.close());
        return;
      }

      let startPlayIndex = 0;
      for (let idx = 0; idx < frames.length; idx++) {
        if (frames[idx].timestamp <= this.currentTimestampUs) startPlayIndex = idx;
      }
      for (let idx = startPlayIndex + 1; idx < frames.length; idx++) frames[idx].close();

      const playbackStartMs = performance.now();
      const anchorTimestampUs = frames[startPlayIndex].timestamp;

      let i = startPlayIndex;
      for (; i >= 0; i--) {
        if (token !== this.playToken) break;
        const frame = frames[i];

        const elapsedVideoMs = (anchorTimestampUs - frame.timestamp) / 1000 / this.playbackRate;
        const targetMs = playbackStartMs + elapsedVideoMs;
        const delayMs = Math.max(0, targetMs - performance.now());
        if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

        this.drawFrame(frame);
        this.currentChunkIndex = gopStart + i;
        this.currentTimestampUs = frame.timestamp;
        frame.close();
        this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
      }
      // Close whatever's left: either the loop finished normally (i === -1,
      // this is a no-op) or it broke early on cancellation, in which case
      // frames[0..i] are still open.
      for (let j = i; j >= 0; j--) frames[j].close();

      if (token !== this.playToken) return;

      const previousGop = this.keyframeIndex.previousKeyframeChunkIndex(gopStart);
      if (previousGop === null) {
        this.playing = false;
        this.handlers.onEnded?.();
        return;
      }
      gopStart = previousGop;
    }
  }
}
