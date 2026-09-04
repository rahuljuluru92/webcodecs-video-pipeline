import "./style.css";
import { SeekablePlayer } from "./seekable-player";

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const playButton = document.querySelector<HTMLButtonElement>("#play-button")!;
const reverseButton = document.querySelector<HTMLButtonElement>("#reverse-button")!;
const speedSelect = document.querySelector<HTMLSelectElement>("#speed-select")!;
const canvas = document.querySelector<HTMLCanvasElement>("#video-canvas")!;
const scrubber = document.querySelector<HTMLInputElement>("#scrubber")!;
const timeDisplay = document.querySelector<HTMLSpanElement>("#time-display")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;
const metricsEl = document.querySelector<HTMLParagraphElement>("#metrics")!;

if (!("VideoDecoder" in window)) {
  statusEl.textContent =
    "WebCodecs is not supported in this browser. Try a recent Chrome/Edge.";
  fileInput.disabled = true;
}

let player: SeekablePlayer | null = null;
let isScrubbing = false;
let reverseEnabled = false;

function formatTime(current: number, duration: number): string {
  return `${current.toFixed(2)} / ${duration.toFixed(2)}s`;
}

function setControlsEnabled(enabled: boolean): void {
  playButton.disabled = !enabled;
  reverseButton.disabled = !enabled;
  speedSelect.disabled = !enabled;
  scrubber.disabled = !enabled;
}

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0] ?? null;
  if (!file) return;

  setControlsEnabled(false);
  playButton.textContent = "Play";
  reverseEnabled = false;
  reverseButton.textContent = "Reverse: Off";
  metricsEl.textContent = "";
  statusEl.textContent = `Loading ${file.name}…`;

  try {
    player = await SeekablePlayer.load(file, canvas, {
      onFrame(currentTimeSeconds, durationSeconds) {
        if (!isScrubbing) scrubber.value = String(currentTimeSeconds);
        timeDisplay.textContent = formatTime(currentTimeSeconds, durationSeconds);
      },
      onSeek(metrics) {
        statusEl.textContent = `Seeked to ${metrics.actualTimestampSeconds.toFixed(2)}s (requested ${metrics.requestedTimestampSeconds.toFixed(2)}s) in ${metrics.latencyMs.toFixed(1)} ms, decoding ${metrics.framesDecodedToReachTarget} frame(s).`;
        console.log("[seek]", metrics);
      },
      onPlaybackMetrics(metrics) {
        metricsEl.textContent = `Decode throughput: ${metrics.decodeFps.toFixed(1)} fps · Buffer target: ${metrics.targetBufferDepth} frames`;
        console.log("[benchmark]", metrics);
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
