import { demuxVideoTrack } from "./mp4-demuxer";
import { FrameBuffer } from "./frame-buffer";
import { AdaptivePrefetchController } from "./prefetch-controller";

export interface PlaybackMetrics {
  /** Measured decode throughput (frames/sec), from an ungated warm-up
   * window at the start of decoding. */
  decodeFps: number;
  /** Buffer depth (frames) the adaptive controller settled on for this
   * file/hardware, based on `decodeFps` vs. the file's nominal fps. */
  targetBufferDepth: number;
  /** Wall time from `playVideoFile` being called to the first frame being
   * drawn to the canvas. */
  timeToFirstFrameMs: number;
}

export interface PlaybackHandlers {
  onFrame?(framesRendered: number, durationSeconds: number): void;
  onMetrics?(metrics: PlaybackMetrics): void;
  onDone?(totalFrames: number): void;
  onError?(error: unknown): void;
}

/** Cap on encoded chunks queued inside the decoder itself — independent of
 * the frame buffer; keeps the decoder from being handed its entire backlog
 * at once regardless of buffer capacity. */
const MAX_DECODER_QUEUE_SIZE = 2;

/** Frames decoded before the buffer's target depth would first gate the
 * feed loop (since it starts empty and grows from 0). Decoding these is
 * inherently backpressure-free, so timing them gives a clean decode-fps
 * measurement without needing a separate blocking warm-up phase. */
const WARMUP_FRAME_COUNT = 6;

/**
 * Demuxes, decodes, and renders an MP4 file to a canvas at (approximately)
 * its native playback rate. Decoding and rendering run as two concurrent
 * loops connected by a `FrameBuffer`: the feed loop decodes chunks ahead of
 * playback up to an adaptively-sized target (see `AdaptivePrefetchController`),
 * and the render loop drains the buffer at real-time pace. Worker offload
 * and true keyframe-seeking are later stages.
 */
export async function playVideoFile(
  file: File,
  canvas: HTMLCanvasElement,
  handlers: PlaybackHandlers = {},
): Promise<void> {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("Canvas 2D context unavailable.");
  const ctx = maybeCtx;

  const playbackRequestedAt = performance.now();
  const arrayBuffer = await file.arrayBuffer();

  let config: VideoDecoderConfig | undefined;
  let durationSeconds = 0;
  const chunks: EncodedVideoChunk[] = [];

  await demuxVideoTrack(
    arrayBuffer,
    (result) => {
      config = result.config;
      durationSeconds = result.durationSeconds;
    },
    (chunk) => {
      chunks.push(chunk);
    },
  );

  if (!config) throw new Error("Failed to determine a decoder config for this file.");
  if (chunks.length === 0) throw new Error("No video frames found in this file.");

  const nominalPlaybackFps = chunks.length / durationSeconds;
  const prefetchController = new AdaptivePrefetchController();
  const buffer = new FrameBuffer<VideoFrame>();

  let bufferCapacity = prefetchController.minBufferFrames;
  let warmupStartMs: number | null = null;
  let warmupFrameCount = 0;
  let decodeFps = 0;
  let hasAdapted = false;

  const decoder = new VideoDecoder({
    output(frame) {
      if (warmupStartMs === null) warmupStartMs = performance.now();
      warmupFrameCount++;

      if (!hasAdapted && warmupFrameCount >= WARMUP_FRAME_COUNT) {
        const elapsedMs = performance.now() - warmupStartMs;
        decodeFps = elapsedMs > 0 ? (warmupFrameCount / elapsedMs) * 1000 : nominalPlaybackFps;
        bufferCapacity = prefetchController.targetBufferDepth(decodeFps, nominalPlaybackFps);
        hasAdapted = true;
      }

      buffer.push(frame);
    },
    error: (error) => handlers.onError?.(error),
  });
  decoder.configure(config);

  async function waitForDecodeSlot(): Promise<void> {
    while (decoder.decodeQueueSize > MAX_DECODER_QUEUE_SIZE) {
      await new Promise<void>((resolve) => {
        decoder.addEventListener("dequeue", () => resolve(), { once: true });
      });
    }
  }

  async function feedLoop(): Promise<void> {
    for (const chunk of chunks) {
      await waitForDecodeSlot();
      await buffer.waitUntilBelow(bufferCapacity);
      decoder.decode(chunk);
    }
    await decoder.flush();
    decoder.close();
  }

  let framesRendered = 0;
  let firstFrameTimestamp: number | null = null;
  let playbackStartMs = 0;
  let timeToFirstFrameMs = 0;

  async function renderLoop(): Promise<void> {
    while (framesRendered < chunks.length) {
      const frame = await buffer.shift();

      if (firstFrameTimestamp === null) {
        firstFrameTimestamp = frame.timestamp;
        playbackStartMs = performance.now();
        timeToFirstFrameMs = playbackStartMs - playbackRequestedAt;
      }

      const targetMs = playbackStartMs + (frame.timestamp - firstFrameTimestamp) / 1000;
      const delayMs = Math.max(0, targetMs - performance.now());
      if (delayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }

      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      framesRendered++;
      handlers.onFrame?.(framesRendered, durationSeconds);
    }
  }

  await Promise.all([feedLoop(), renderLoop()]);

  handlers.onMetrics?.({ decodeFps, targetBufferDepth: bufferCapacity, timeToFirstFrameMs });
  handlers.onDone?.(framesRendered);
}
