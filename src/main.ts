import "./style.css";
import { playVideoFile } from "./player";

const fileInput = document.querySelector<HTMLInputElement>("#file-input")!;
const playButton = document.querySelector<HTMLButtonElement>("#play-button")!;
const canvas = document.querySelector<HTMLCanvasElement>("#video-canvas")!;
const statusEl = document.querySelector<HTMLParagraphElement>("#status")!;

if (!("VideoDecoder" in window)) {
  statusEl.textContent =
    "WebCodecs is not supported in this browser. Try a recent Chrome/Edge.";
  fileInput.disabled = true;
}

let selectedFile: File | null = null;
let isPlaying = false;

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] ?? null;
  playButton.disabled = !selectedFile || isPlaying;
  statusEl.textContent = selectedFile
    ? `Loaded ${selectedFile.name} (${(selectedFile.size / 1_000_000).toFixed(1)} MB). Ready to play.`
    : "Choose an MP4 file to begin.";
});

playButton.addEventListener("click", async () => {
  if (!selectedFile || isPlaying) return;

  isPlaying = true;
  playButton.disabled = true;
  fileInput.disabled = true;
  statusEl.textContent = "Decoding…";

  const startedAt = performance.now();

  try {
    await playVideoFile(selectedFile, canvas, {
      onFrame(framesRendered, durationSeconds) {
        statusEl.textContent = `Playing — frame ${framesRendered} (duration ${durationSeconds.toFixed(2)}s)`;
      },
      onDone(totalFrames) {
        const elapsedSeconds = (performance.now() - startedAt) / 1000;
        statusEl.textContent = `Done. Rendered ${totalFrames} frames in ${elapsedSeconds.toFixed(2)}s.`;
      },
      onError(error) {
        console.error(error);
        statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
      },
    });
  } catch (error) {
    console.error(error);
    statusEl.textContent = `Error: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    isPlaying = false;
    playButton.disabled = !selectedFile;
    fileInput.disabled = false;
  }
});
