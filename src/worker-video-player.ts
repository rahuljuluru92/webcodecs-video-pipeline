import type { MemoryStats, PlaybackMetrics, SeekMetrics } from "./seekable-player";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-protocol";
import type { ProcessingWorkerReadyMessage, ProcessingWorkerSetupMessage } from "./pixel-mailbox";

/** SharedArrayBuffer (and therefore the blur filter, which is built on it)
 * only exists in a cross-origin-isolated context — see vite.config.ts for
 * the COOP/COEP headers this requires, and DECISIONS.md for why blur
 * degrades gracefully rather than being load-bearing for core playback. */
export function isBlurSupported(): boolean {
  return typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated === true;
}

export interface WorkerVideoPlayerHandlers {
  onFrame?(currentTimeSeconds: number, durationSeconds: number): void;
  onSeek?(metrics: SeekMetrics): void;
  onPlaybackMetrics?(metrics: PlaybackMetrics): void;
  onStats?(stats: MemoryStats): void;
  onEnded?(): void;
  onError?(error: unknown): void;
}

/**
 * Main-thread-side handle for the video pipeline, which actually runs
 * inside `src/video-worker.ts`. Owns the Worker and the one-time transfer
 * of canvas control to it (`transferControlToOffscreen()` can only be
 * called once per `<canvas>` element, ever — so the worker and the
 * transfer happen once in `create()`, and loading a different file later
 * reuses both rather than re-creating them).
 */
export class WorkerVideoPlayer {
  private readonly worker: Worker;
  /** Kept referenced so it isn't eligible for GC (which could terminate its
   * underlying thread) — null when blur isn't supported in this context. */
  private readonly processingWorker: Worker | null;
  private readonly handlers: WorkerVideoPlayerHandlers;
  private durationSeconds = 0;
  private currentTimeSeconds = 0;
  private isPaused = true;
  private nextRequestId = 1;
  private readonly pendingSeekAcks = new Map<number, () => void>();

  private constructor(canvas: HTMLCanvasElement, handlers: WorkerVideoPlayerHandlers) {
    this.handlers = handlers;
    this.worker = new Worker(new URL("./video-worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", this.handleMessage);

    const offscreen = canvas.transferControlToOffscreen();
    this.post({ type: "init", canvas: offscreen }, [offscreen]);

    if (isBlurSupported()) {
      // Two sibling Workers, linked by a direct MessageChannel this (main)
      // thread sets up once and then steps out of — every per-frame
      // message after this flows decode-worker <-> processing-worker
      // directly, so the main thread stays idle (see DECISIONS.md).
      this.processingWorker = new Worker(new URL("./processing-worker.ts", import.meta.url), {
        type: "module",
      });
      // Must wait for the worker's own "ready" signal before sending
      // anything: posting immediately races its module script's startup
      // (it has a WASM-loading top-level await before it can attach a
      // listener), and a message dispatched before any listener exists is
      // lost outright, not queued — confirmed the hard way (see
      // DECISIONS.md and ProcessingWorkerReadyMessage's doc comment).
      const onReady = (event: MessageEvent<ProcessingWorkerReadyMessage>) => {
        if (event.data.type !== "ready") return;
        this.processingWorker!.removeEventListener("message", onReady);
        const channel = new MessageChannel();
        this.post({ type: "initProcessingPort", port: channel.port1 }, [channel.port1]);
        const setupMessage: ProcessingWorkerSetupMessage = { type: "setPort", port: channel.port2 };
        this.processingWorker!.postMessage(setupMessage, [channel.port2]);
      };
      this.processingWorker.addEventListener("message", onReady);
    } else {
      this.processingWorker = null;
    }
  }

  static create(canvas: HTMLCanvasElement, handlers: WorkerVideoPlayerHandlers = {}): WorkerVideoPlayer {
    return new WorkerVideoPlayer(canvas, handlers);
  }

  /**
   * @param frameCacheCapacity Optional override of the seek cache's
   * capacity — see the same parameter on `SeekablePlayer.load`.
   */
  async loadFile(file: File, frameCacheCapacity?: number): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();

    await new Promise<void>((resolve, reject) => {
      const onMessage = (event: MessageEvent<WorkerToMainMessage>) => {
        if (event.data.type === "loaded") {
          this.worker.removeEventListener("message", onMessage);
          this.durationSeconds = event.data.durationSeconds;
          this.currentTimeSeconds = 0;
          this.isPaused = true;
          resolve();
        } else if (event.data.type === "error") {
          this.worker.removeEventListener("message", onMessage);
          reject(new Error(event.data.message));
        }
      };
      this.worker.addEventListener("message", onMessage);
      this.post({ type: "load", arrayBuffer, frameCacheCapacity }, [arrayBuffer]);
    });
  }

  get duration(): number {
    return this.durationSeconds;
  }

  get currentTime(): number {
    return this.currentTimeSeconds;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  play(): void {
    this.isPaused = false;
    this.post({ type: "play" });
  }

  pause(): void {
    this.isPaused = true;
    this.post({ type: "pause" });
  }

  setPlaybackRate(rate: number): void {
    this.post({ type: "setPlaybackRate", rate });
  }

  setDirection(direction: 1 | -1): void {
    this.post({ type: "setDirection", direction });
  }

  setBlurEnabled(enabled: boolean): void {
    this.post({ type: "setBlurEnabled", enabled });
  }

  seekTo(seconds: number): Promise<void> {
    const requestId = this.nextRequestId++;
    return new Promise<void>((resolve) => {
      this.pendingSeekAcks.set(requestId, resolve);
      this.post({ type: "seekTo", requestId, seconds });
    });
  }

  private post(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }

  private readonly handleMessage = (event: MessageEvent<WorkerToMainMessage>): void => {
    const message = event.data;
    switch (message.type) {
      case "frame":
        this.currentTimeSeconds = message.currentTimeSeconds;
        this.handlers.onFrame?.(message.currentTimeSeconds, message.durationSeconds);
        break;
      case "seek":
        this.handlers.onSeek?.(message.metrics);
        break;
      case "seekAck": {
        const resolve = this.pendingSeekAcks.get(message.requestId);
        if (resolve) {
          resolve();
          this.pendingSeekAcks.delete(message.requestId);
        }
        break;
      }
      case "playbackMetrics":
        this.handlers.onPlaybackMetrics?.(message.metrics);
        break;
      case "stats":
        this.handlers.onStats?.(message.stats);
        break;
      case "ended":
        this.isPaused = true;
        this.handlers.onEnded?.();
        break;
      case "error":
        this.handlers.onError?.(new Error(message.message));
        break;
      case "loaded":
        // Handled by loadFile()'s own one-off listener.
        break;
    }
  };
}
