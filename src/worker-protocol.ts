import type { MemoryStats, PlaybackMetrics, SeekMetrics } from "./seekable-player";

export type MainToWorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "initProcessingPort"; port: MessagePort }
  | { type: "setBlurEnabled"; enabled: boolean }
  | {
      type: "load";
      arrayBuffer: ArrayBuffer;
      /** Optional override of the seek-frame-cache capacity — used by the
       * Stage 5 memory benchmark to run with an effectively-unbounded
       * cache for comparison. Omit to use SeekablePlayer's default. */
      frameCacheCapacity?: number;
    }
  | { type: "play" }
  | { type: "pause" }
  | { type: "seekTo"; requestId: number; seconds: number }
  | { type: "setPlaybackRate"; rate: number }
  | { type: "setDirection"; direction: 1 | -1 };

export type WorkerToMainMessage =
  | { type: "loaded"; durationSeconds: number }
  | { type: "frame"; currentTimeSeconds: number; durationSeconds: number }
  | { type: "seek"; metrics: SeekMetrics }
  | { type: "seekAck"; requestId: number }
  | { type: "playbackMetrics"; metrics: PlaybackMetrics }
  | { type: "stats"; stats: MemoryStats }
  | { type: "ended" }
  | { type: "error"; message: string };
