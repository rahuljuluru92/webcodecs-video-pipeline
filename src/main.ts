import "./style.css";
import { WorkerVideoPlayer, isBlurSupported } from "./worker-video-player";

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const playButton = document.querySelector<HTMLButtonElement>("#play-button")!;
const reverseButton = document.querySelector<HTMLButtonElement>("#reverse-button")!;
const speedSelect = document.querySelector<HTMLSelectElement>("#speed-select")!;
const blurButton = document.querySelector<HTMLButtonElement>("#blur-button")!;
const canvas = document.querySelector<HTMLCanvasElement>("#video-canvas")!;
const scrubber = document.querySelector<HTMLInputElement>("#scrubber")!;
const timeDisplay = document.querySelector<HTMLSpanElement>("#time-display")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const metricsEl = document.querySelector<HTMLParagraphElement>("#metrics")!;
const memoryStatsEl = document.querySelector<HTMLParagraphElement>("#memory-stats")!;

if (!("VideoDecoder" in window) || !("Worker" in window) || !("OffscreenCanvas" in window)) {
  statusEl.textContent =
    "WebCodecs (with Worker + OffscreenCanvas support) is not available in this browser. Try a recent Chrome/Edge.";
  fileInput.disabled = true;
}

// Blur is additive (see DECISIONS.md) — hide it entirely rather than let it
// be toggled somewhere SharedArrayBuffer doesn't exist (needs cross-origin
// isolation; see vite.config.ts).
if (!isBlurSupported()) {
  blurButton.hidden = true;
}

let player: WorkerVideoPlayer | null = null;
let isScrubbing = false;
let reverseEnabled = false;
let blurEnabled = false;

function formatTime(current: number, duration: number): string {
  return `${current.toFixed(2)} / ${duration.toFixed(2)}s`;
}

function setControlsEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  reverseButton.disabled = !enabled;
  speedSelect.disabled = !enabled;
  scrubber.disabled = !enabled;
  if (isBlurSupported()) blurButton.disabled = !enabled;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0] ?? null;
  if (!file) return;

  setControlsEnabled(false);
  playButton.textContent = "Play";
  reverseEnabled = false;
  reverseButton.textContent = "Reverse: Off";
  blurEnabled = false;
  blurButton.textContent = "Blur: Off";
  speedSelect.value = "1";
  metricsEl.textContent = "";
  memoryStatsEl.textContent = "";
  statusEl.textContent = `Loading ${file.name}…`;

  try {
    if (!player) {
      // The Worker + the one-time canvas-control transfer are set up once
      // and reused across every subsequent file load (transferControlToOffscreen
      // can only be called once, ever, per <canvas> element).
      player = WorkerVideoPlayer.create(canvas, {
        onFrame(currentTimeSeconds, durationSeconds) {
          if (!isScrubbing) scrubber.value = String(currentTimeSeconds);
          timeDisplay.textContent = formatTime(currentTimeSeconds, durationSeconds);
        },
        onSeek(metrics) {
          const cacheNote = metrics.cacheHit ? " (cache hit)" : "";
          statusEl.textContent = `Seeked to ${metrics.actualTimestampSeconds.toFixed(2)}s (requested ${metrics.requestedTimestampSeconds.toFixed(2)}s) in ${metrics.latencyMs.toFixed(1)} ms, decoding ${metrics.framesDecodedToReachTarget} frame(s)${cacheNote}.`;
          console.log("[seek]", metrics);
        },
        onPlaybackMetrics(metrics) {
          metricsEl.textContent = `Decode throughput: ${metrics.decodeFps.toFixed(1)} fps · Buffer target: ${metrics.targetBufferDepth} frames`;
          console.log("[benchmark]", metrics);
        },
        onStats(stats) {
          memoryStatsEl.textContent = `Live frames: ${stats.liveFrameCount} · Seek cache: ${stats.cacheSize} frames`;
        },
        onEnded() {
          playButton.textContent = "Play";
          statusEl.textContent = "Playback ended.";
        },
        onError(error) {
          console.error(error);
          statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
        },
      });
    }

    await player.loadFile(file);

    scrubber.min = "0";
    scrubber.max = String(player.duration);
    scrubber.value = "0";
    timeDisplay.textContent = formatTime(0, player.duration);
    statusEl.textContent = `Loaded ${file.name} (${(file.size / 1_000_000).toFixed(1)} MB). Ready.`;
    setControlsEnabled(true);
  } catch (error) {
    console.error(error);
    statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
});

playButton.addEventListener("click", () => {
  if (!player) return;
  if (player.paused) {
    player.play();
    playButton.textContent = "Pause";
  } else {
    player.pause();
    playButton.textContent = "Play";
  }
});

reverseButton.addEventListener("click", () => {
  if (!player) return;
  reverseEnabled = !reverseEnabled;
  player.setDirection(reverseEnabled ? -1 : 1);
  reverseButton.textContent = reverseEnabled ? "Reverse: On" : "Reverse: Off";
});

speedSelect.addEventListener("change", () => {
  if (!player) return;
  player.setPlaybackRate(Number(speedSelect.value));
});

blurButton.addEventListener("click", () => {
  if (!player) return;
  blurEnabled = !blurEnabled;
  player.setBlurEnabled(blurEnabled);
  blurButton.textContent = blurEnabled ? "Blur: On" : "Blur: Off";
});

scrubber.addEventListener("input", () => {
  isScrubbing = true;
  timeDisplay.textContent = formatTime(Number(scrubber.value), player?.duration ?? 0);
});

scrubber.addEventListener("change", async () => {
  if (!player) return;
  const wasPlaying = !player.paused;

  await player.seekTo(Number(scrubber.value));
  isScrubbing = false;

  if (wasPlaying) {
    player.play();
    playButton.textContent = "Pause";
  } else {
    playButton.textContent = "Play";
  }
});
