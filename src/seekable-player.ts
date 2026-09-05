import { demuxVideoTrack } from "./mp4-demuxer";
import { FrameBuffer } from "./frame-buffer";
import { AdaptivePrefetchController } from "./prefetch-controller";
import { KeyframeIndex } from "./keyframe-index";
import { decodeChunkRange } from "./gop-decoder";
import { FrameCache } from "./frame-cache";

export interface SeekMetrics {
  requestedTimestampSeconds: number;
  actualTimestampSeconds: number;
  latencyMs: number;
  framesDecodedToReachTarget: number;
  /** True if the target GOP was already cached and nothing was decoded. */
  cacheHit: boolean;
}

export interface PlaybackMetrics {
  decodeFps: number;
  targetBufferDepth: number;
}

export interface MemoryStats {
  /** Decoded VideoFrames currently open (not yet closed) anywhere in this
   * player — the direct, code-level measure of the GPU/native memory
   * WebCodecs frames hold, independent of what performance.memory reports. */
  liveFrameCount: number;
  /** How many of those live frames are held by the seek cache specifically. */
  cacheSize: number;
}

export interface SeekablePlayerHandlers {
  onFrame?(currentTimeSeconds: number, durationSeconds: number): void;
  onSeek?(metrics: SeekMetrics): void;
  onPlaybackMetrics?(metrics: PlaybackMetrics): void;
  onStats?(stats: MemoryStats): void;
  onEnded?(): void;
  onError?(error: unknown): void;
}

const MAX_DECODER_QUEUE_SIZE = 2;
/** Frames decoded before the buffer's target depth would first gate the
 * feed loop — see the equivalent constant/comment in the Stage 2 design
 * notes in DECISIONS.md. */
const WARMUP_FRAME_COUNT = 6;
/** Default seek-frame-cache budget: 4 GOPs' worth at this project's fixture
 * GOP size (30). A fixed frame-count budget, not tied to file length, so
 * memory from caching stays bounded across an arbitrarily long/heavily-
 * scrubbed session — see DECISIONS.md for the Stage 5 memory benchmark that
 * exercises this. */
const DEFAULT_FRAME_CACHE_CAPACITY = 120;

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
  private readonly frameCache: FrameCache<number, VideoFrame>;

  /** Decode-order index of the last-displayed frame's chunk. */
  private currentChunkIndex = 0;
  private currentTimestampUs = 0;
  private playbackRate = 1;
  private direction: 1 | -1 = 1;
  /** Bumped on pause/seek/direction-change to cancel any in-flight play loop. */
  private playToken = 0;
  private playing = false;
  /** Every open (not yet closed) VideoFrame this player currently owns,
   * cached or not — see MemoryStats. */
  private liveFrameCount = 0;

  private constructor(
    canvas: OffscreenCanvas,
    config: VideoDecoderConfig,
    chunks: EncodedVideoChunk[],
    durationSeconds: number,
    handlers: SeekablePlayerHandlers,
    frameCacheCapacity: number,
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
    this.frameCache = new FrameCache<number, VideoFrame>({
      capacity: frameCacheCapacity,
      onEvict: (frame) => this.closeFrame(frame),
    });
  }

  /**
   * @param frameCacheCapacity Max frames the seek cache holds at once
   * (default `DEFAULT_FRAME_CACHE_CAPACITY`). Exposed mainly so the Stage 5
   * memory benchmark can also run with an effectively-unbounded cache, to
   * demonstrate the bounded-vs-unbounded contrast the project's
   * benchmarking rules ask for — production code should just use the
   * default.
   */
  static async load(
    arrayBuffer: ArrayBuffer,
    canvas: OffscreenCanvas,
    handlers: SeekablePlayerHandlers = {},
    frameCacheCapacity: number = DEFAULT_FRAME_CACHE_CAPACITY,
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

    const player = new SeekablePlayer(
      canvas,
      config,
      chunks,
      durationSeconds,
      handlers,
      frameCacheCapacity,
    );
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

  /** Releases every resource this player holds (cancels any in-flight play
   * loop, closes every cached frame). Call before dropping a player in
   * favor of a new one — e.g. loading a different file. */
  dispose(): void {
    this.playing = false;
    this.playToken++;
    this.frameCache.clear();
  }

  private trackFrame(frame: VideoFrame): VideoFrame {
    this.liveFrameCount++;
    return frame;
  }

  private closeFrame(frame: VideoFrame): void {
    frame.close();
    this.liveFrameCount--;
  }

  private reportStats(): void {
    this.handlers.onStats?.({ liveFrameCount: this.liveFrameCount, cacheSize: this.frameCache.size });
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
    const gopChunkIndices: number[] = [];
    for (let i = gopStart; i < gopEnd; i++) gopChunkIndices.push(i);

    const cacheHit = this.frameCache.hasAll(gopChunkIndices);
    let framesInOrder: VideoFrame[];

    if (cacheHit) {
      // .get() also refreshes each entry's LRU recency.
      framesInOrder = gopChunkIndices.map((chunkIndex) => this.frameCache.get(chunkIndex)!);
    } else {
      let decoded: VideoFrame[];
      try {
        decoded = await decodeChunkRange(this.chunks, this.config, gopStart, gopEnd);
      } catch (error) {
        this.handlers.onError?.(error);
        return;
      }
      decoded.forEach((frame) => this.trackFrame(frame));

      if (token !== this.playToken) {
        decoded.forEach((frame) => this.closeFrame(frame));
        return;
      }
      framesInOrder = decoded;
    }

    let targetIndex = framesInOrder.findIndex((frame) => frame.timestamp >= targetUs);
    if (targetIndex === -1) targetIndex = framesInOrder.length - 1;
    const targetFrame = framesInOrder[targetIndex];
    const actualTimestampUs = targetFrame.timestamp;

    this.drawFrame(targetFrame);
    this.currentChunkIndex = gopStart + targetIndex;
    this.currentTimestampUs = actualTimestampUs;

    // The cache now owns every frame from a fresh decode (it closes
    // whatever it evicts); cache-hit frames were already its property.
    if (!cacheHit) {
      framesInOrder.forEach((frame, i) => this.frameCache.set(gopStart + i, frame));
    }

    this.handlers.onSeek?.({
      requestedTimestampSeconds: clamped,
      actualTimestampSeconds: actualTimestampUs / 1_000_000,
      latencyMs: performance.now() - startedAt,
      framesDecodedToReachTarget: cacheHit ? 0 : framesInOrder.length,
      cacheHit,
    });
    this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
    this.reportStats();
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
        this.trackFrame(frame);
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
        this.closeFrame(frame);
        break;
      }

      const elapsedVideoMs = (frame.timestamp - anchorTimestampUs) / 1000 / this.playbackRate;
      const targetMs = playbackStartMs + elapsedVideoMs;
      const delayMs = Math.max(0, targetMs - performance.now());
      if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));

      if (token !== this.playToken) {
        this.closeFrame(frame);
        break;
      }

      this.drawFrame(frame);
      this.currentChunkIndex++;
      this.currentTimestampUs = frame.timestamp;
      this.closeFrame(frame);
      this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
      this.reportStats();
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
      frames.forEach((frame) => this.trackFrame(frame));

      if (token !== this.playToken) {
        frames.forEach((frame) => this.closeFrame(frame));
        return;
      }

      let startPlayIndex = 0;
      for (let idx = 0; idx < frames.length; idx++) {
        if (frames[idx].timestamp <= this.currentTimestampUs) startPlayIndex = idx;
      }
      for (let idx = startPlayIndex + 1; idx < frames.length; idx++) this.closeFrame(frames[idx]);

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
        this.closeFrame(frame);
        this.handlers.onFrame?.(this.currentTime, this.durationSeconds);
        this.reportStats();
      }
      // Close whatever's left: either the loop finished normally (i === -1,
      // this is a no-op) or it broke early on cancellation, in which case
      // frames[0..i] are still open.
      for (let j = i; j >= 0; j--) this.closeFrame(frames[j]);

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
