import type {
  MailboxMessage,
  PixelSlot,
  ProcessingWorkerReadyMessage,
  ProcessingWorkerSetupMessage,
} from "./pixel-mailbox";
import * as wasmBlur from "../build/blur.release.js";

/**
 * A dedicated Worker whose only job is pixel processing: given raw
 * native-format bytes sitting in a SharedArrayBuffer it was handed once at
 * setup, run the compiled WASM YUV→RGBA conversion + box blur, and write
 * the result into a second SharedArrayBuffer for the decode worker to read
 * back. Never touches the canvas or any WebCodecs objects — see
 * src/video-worker.ts and src/seekable-player.ts for the producer side.
 *
 * Two message paths: this worker's own top-level Worker interface is used
 * only for the initial "ready"/"setPort" handshake with the main thread;
 * every ongoing frame-processing message after that flows over the
 * MessagePort it's handed instead (see pixel-mailbox.ts).
 *
 * Same tsconfig workaround as video-worker.ts: this file lives under the
 * project's shared "DOM"-lib tsconfig (combining "DOM" and "WebWorker" libs
 * in one TS program causes global-declaration conflicts), so worker-scope
 * globals are accessed through a locally-typed cast instead.
 */
const workerScope = self as unknown as {
  postMessage(message: ProcessingWorkerReadyMessage): void;
  onmessage: ((event: MessageEvent<ProcessingWorkerSetupMessage>) => void) | null;
};

let mailboxPort: MessagePort | null = null;
let inputViews: [Uint8Array, Uint8Array] | null = null;
let outputViews: [Uint8Array, Uint8Array] | null = null;

function post(message: MailboxMessage): void {
  mailboxPort?.postMessage(message);
}

function initSlots(slots: [PixelSlot, PixelSlot]): void {
  inputViews = [new Uint8Array(slots[0].input), new Uint8Array(slots[1].input)];
  outputViews = [new Uint8Array(slots[0].output), new Uint8Array(slots[1].output)];
}

function processFrame(message: Extract<MailboxMessage, { type: "process" }>): void {
  if (!inputViews || !outputViews) {
    post({ type: "error", frameSeq: message.frameSeq, message: "'process' received before 'init'." });
    return;
  }

  const input = inputViews[message.slot];
  const output = outputViews[message.slot];
  const { width, height, planeLayout, format, radius } = message;

  let rgba: Uint8Array;
  if (format === "I420") {
    const [yPlane, uPlane, vPlane] = planeLayout;
    rgba = wasmBlur.convertI420ToRgba(
      input.subarray(yPlane.offset, yPlane.offset + yPlane.stride * height),
      yPlane.stride,
      input.subarray(uPlane.offset, uPlane.offset + uPlane.stride * (height >> 1)),
      uPlane.stride,
      input.subarray(vPlane.offset, vPlane.offset + vPlane.stride * (height >> 1)),
      vPlane.stride,
      width,
      height,
    );
  } else if (format === "NV12") {
    const [yPlane, uvPlane] = planeLayout;
    rgba = wasmBlur.convertNV12ToRgba(
      input.subarray(yPlane.offset, yPlane.offset + yPlane.stride * height),
      yPlane.stride,
      input.subarray(uvPlane.offset, uvPlane.offset + uvPlane.stride * (height >> 1)),
      uvPlane.stride,
      width,
      height,
    );
  } else {
    const [packedPlane] = planeLayout;
    rgba = wasmBlur.convertBgrxToRgba(
      input.subarray(packedPlane.offset, packedPlane.offset + packedPlane.stride * height),
      packedPlane.stride,
      width,
      height,
    );
  }

  const finalPixels = radius > 0 ? wasmBlur.boxBlur(rgba, width, height, radius) : rgba;
  output.set(finalPixels);

  post({ type: "processed", slot: message.slot, frameSeq: message.frameSeq });
}

function handleMailboxMessage(message: MailboxMessage): void {
  try {
    if (message.type === "init") {
      initSlots(message.slots);
    } else if (message.type === "process") {
      processFrame(message);
    }
  } catch (error) {
    const frameSeq = message.type === "process" ? message.frameSeq : -1;
    post({ type: "error", frameSeq, message: error instanceof Error ? error.message : String(error) });
  }
}

workerScope.onmessage = (event) => {
  if (event.data.type === "setPort") {
    mailboxPort = event.data.port;
    mailboxPort.onmessage = (portEvent: MessageEvent<MailboxMessage>) => handleMailboxMessage(portEvent.data);
  }
};

// The WASM module import above has a top-level await, so everything in this
// file — including attaching the listener above — only runs once it
// resolves. Only now is it safe to tell the main thread this worker can
// receive "setPort"; see ProcessingWorkerReadyMessage's doc comment.
workerScope.postMessage({ type: "ready" });
