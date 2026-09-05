/**
 * Message protocol for the direct MessageChannel link between the decode
 * worker and the processing worker. The large per-frame payload (raw pixel
 * bytes) never travels in these messages at all — it lives in the
 * SharedArrayBuffers exchanged once via "init"; every message here is tiny.
 */

export type SupportedPixelFormat = "I420" | "NV12" | "BGRX";

export function isSupportedPixelFormat(format: string): format is SupportedPixelFormat {
  return format === "I420" || format === "NV12" || format === "BGRX";
}

export interface PlaneLayoutEntry {
  offset: number;
  stride: number;
}

export interface PixelSlot {
  /** Raw native-format bytes (YUV planes or packed BGRX), written by the
   * decode worker, read by the processing worker. */
  input: SharedArrayBuffer;
  /** Packed RGBA output, written by the processing worker, read back by the
   * decode worker for putImageData. */
  output: SharedArrayBuffer;
}

/** Sent once by the main thread directly to the processing worker (via its
 * own top-level Worker postMessage, not the mailbox port) to hand it its
 * end of the MessageChannel the main thread set up between the two
 * workers. Everything after this flows over that port instead.
 *
 * The main thread must wait for the worker's own "ready" message before
 * sending this — posting to a freshly-created Worker immediately races its
 * script's own startup (this one has a WASM-loading top-level await before
 * it can attach a listener at all), and a message dispatched before any
 * listener is attached is simply lost, not queued. Confirmed empirically:
 * without this handshake, blur processing hung forever. See DECISIONS.md. */
export type ProcessingWorkerSetupMessage = { type: "setPort"; port: MessagePort };
export type ProcessingWorkerReadyMessage = { type: "ready" };

export type MailboxMessage =
  | { type: "init"; slots: [PixelSlot, PixelSlot] }
  | {
      type: "process";
      slot: 0 | 1;
      frameSeq: number;
      format: SupportedPixelFormat;
      width: number;
      height: number;
      planeLayout: PlaneLayoutEntry[];
      radius: number;
    }
  | { type: "processed"; slot: 0 | 1; frameSeq: number }
  | { type: "error"; frameSeq: number; message: string };
