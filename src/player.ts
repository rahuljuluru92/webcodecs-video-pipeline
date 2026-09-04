import { demuxVideoTrack } from "./mp4-demuxer";

export interface PlaybackHandlers {
  onFrame?(framesRendered: number, durationSeconds: number): void;
  onDone?(totalFrames: number): void;
  onError?(error: unknown): void;
}

/** Cap on decoded frames waiting to be drawn, so a long/high-res clip can't
 * pile up uncompressed VideoFrames faster than the canvas can present them. */
const MAX_PENDING_RENDER_FRAMES = 3;
/** Cap on encoded chunks queued inside the decoder itself. */
const MAX_DECODER_QUEUE_SIZE = 2;

/**
 * Demuxes, decodes, and renders an MP4 file to a canvas at (approximately)
 * its native playback rate. No seeking/buffering/worker-offload yet — those
 * are later stages.
 */
export async function playVideoFile(
  file: File,
  canvas: HTMLCanvasElement,
  handlers: PlaybackHandlers = {},
): Promise<void> {
  const maybeCtx = canvas.getContext("2d");
  if (!maybeCtx) throw new Error("Canvas 2D context unavailable.");
  const ctx = maybeCtx;

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

  let framesRendered = 0;
  let firstFrameTimestamp: number | null = null;
  let playbackStartMs = 0;
  let pendingRenderCount = 0;

  // Waiters are notified (and re-check their own condition) whenever a frame
  // finishes drawing, so both a bounded-queue wait and a drain-to-zero wait
  // can share the same mechanism.
  const renderWaiters: Array<() => void> = [];
  function notifyRenderWaiters() {
    const toNotify = renderWaiters.splice(0, renderWaiters.length);
    for (const notify of toNotify) notify();
  }
  async function waitUntilRenders(predicate: () => boolean): Promise<void> {
    while (!predicate()) {
      await new Promise<void>((resolve) => renderWaiters.push(resolve));
    }
  }

  function onFrameDrawn() {
    pendingRenderCount--;
    notifyRenderWaiters();
  }

  function scheduleRender(frame: VideoFrame) {
    pendingRenderCount++;
    if (firstFrameTimestamp === null) {
      firstFrameTimestamp = frame.timestamp;
      playbackStartMs = performance.now();
    }
    const targetMs = playbackStartMs + (frame.timestamp - firstFrameTimestamp) / 1000;
    const delayMs = Math.max(0, targetMs - performance.now());

    setTimeout(() => {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
      ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
      frame.close();
      framesRendered++;
      handlers.onFrame?.(framesRendered, durationSeconds);
      onFrameDrawn();
    }, delayMs);
  }

  async function waitForRenderSlot(): Promise<void> {
    await waitUntilRenders(() => pendingRenderCount < MAX_PENDING_RENDER_FRAMES);
  }

  const decoder = new VideoDecoder({
    output: scheduleRender,
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

  for (const chunk of chunks) {
    await waitForDecodeSlot();
    await waitForRenderSlot();
    decoder.decode(chunk);
  }

  await decoder.flush();
  decoder.close();
  await waitUntilRenders(() => pendingRenderCount === 0);
  handlers.onDone?.(framesRendered);
}
