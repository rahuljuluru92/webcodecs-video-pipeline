import type { PlaybackMetrics, SeekMetrics } from "./seekable-player";

export type MainToWorkerMessage =
  | { type: "init"; canvas: OffscreenCanvas }
  | { type: "load"; arrayBuffer: ArrayBuffer }
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
  | { type: "ended" }
  | { type: "error"; message: string };
