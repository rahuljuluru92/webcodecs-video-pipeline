import { SeekablePlayer } from "./seekable-player";
import type { MainToWorkerMessage, WorkerToMainMessage } from "./worker-protocol";

/**
 * This whole file runs in a dedicated Worker: demuxing, decoding, and
 * rendering (to a transferred OffscreenCanvas) all happen here, off the
 * main thread. The main thread only ever exchanges small control/status
 * messages with it — see `src/worker-video-player.ts` for its counterpart.
 *
 * Typed as a local cast rather than adding "webworker" to the project's
 * tsconfig lib list: that list already includes "DOM" (for the rest of the
 * app, which runs on the main thread), and DOM + WebWorker ambient globals
 * (self, postMessage, etc.) conflict when combined in one TS program. This
 * keeps the whole project on a single tsconfig without that fight, at the
 * cost of losing type-checking on the couple of worker-scope globals used
 * directly below (postMessage/onmessage) — everything else here (VideoDecoder,
 * EncodedVideoChunk, OffscreenCanvas, ...) is already covered by "DOM".
 */
const workerScope = self as unknown as {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
};

let canvas: OffscreenCanvas | null = null;
let player: SeekablePlayer | null = null;
// The processing-worker port is set up once and reused for every file (like
// the canvas); blur itself is NOT persisted here — like direction/speed, a
// freshly-loaded player just defaults to off, so the UI resetting its own
// toggle on every new file load can't silently drift out of sync with
// worker-side state the way it briefly did during development (see
// DECISIONS.md).
let processingPort: MessagePort | null = null;

function post(message: WorkerToMainMessage): void {
  workerScope.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

workerScope.onmessage = async (event) => {
  const message = event.data;

  switch (message.type) {
    case "init":
      canvas = message.canvas;
      break;

    case "initProcessingPort":
      processingPort = message.port;
      player?.setPixelProcessorPort(processingPort);
      break;

    case "setBlurEnabled":
      player?.setBlurEnabled(message.enabled);
      break;

    case "load": {
      if (!canvas) {
        post({ type: "error", message: "Worker received 'load' before 'init' (no canvas)." });
        return;
      }
      // Release any previously-loaded file's player (cancels its in-flight
      // loop and closes its cached frames) before replacing it, so two
      // players never race to draw on the same canvas or leak frames.
      player?.dispose();
      try {
        player = await SeekablePlayer.load(
          message.arrayBuffer,
          canvas,
          {
            onFrame: (currentTimeSeconds, durationSeconds) =>
              post({ type: "frame", currentTimeSeconds, durationSeconds }),
            onSeek: (metrics) => post({ type: "seek", metrics }),
            onPlaybackMetrics: (metrics) => post({ type: "playbackMetrics", metrics }),
            onStats: (stats) => post({ type: "stats", stats }),
            onEnded: () => post({ type: "ended" }),
            onError: (error) => post({ type: "error", message: errorMessage(error) }),
          },
          message.frameCacheCapacity,
        );
        if (processingPort) player.setPixelProcessorPort(processingPort);
        post({ type: "loaded", durationSeconds: player.duration });
      } catch (error) {
        post({ type: "error", message: errorMessage(error) });
      }
      break;
    }

    case "play":
      player?.play();
      break;

    case "pause":
      player?.pause();
      break;

    case "seekTo":
      if (player) await player.seekTo(message.seconds);
      post({ type: "seekAck", requestId: message.requestId });
      break;

    case "setPlaybackRate":
      player?.setPlaybackRate(message.rate);
      break;

    case "setDirection":
      player?.setDirection(message.direction);
      break;
  }
};
