import { isSupportedPixelFormat } from "./pixel-mailbox";
import type { MailboxMessage, PixelSlot, PlaneLayoutEntry } from "./pixel-mailbox";

let nextFrameSeq = 1;

/**
 * Lives in the decode worker (see seekable-player.ts). Owns the
 * MessageChannel port to the processing worker and the SharedArrayBuffer
 * pair ("slots") both workers read/write. Frames are processed one at a
 * time — `process()` is only ever called after the previous call's promise
 * has resolved (drawFrame awaits it before moving to the next frame) — so
 * this isn't a pipelined producer/consumer despite having two slots; the
 * second slot is a cheap safety margin against any future concurrent use,
 * not a currently-exploited overlap. See DECISIONS.md for the measured
 * per-frame overhead this adds.
 */
export class PixelProcessorClient {
  private readonly port: MessagePort;
  private slots: [PixelSlot, PixelSlot] | null = null;
  private inputViews: [Uint8Array, Uint8Array] | null = null;
  private outputViews: [Uint8Array, Uint8Array] | null = null;
  private nextSlot: 0 | 1 = 0;
  private readonly pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  constructor(port: MessagePort) {
    this.port = port;
    this.port.onmessage = (event: MessageEvent<MailboxMessage>) => this.handleMessage(event.data);
  }

  static supportsFormat(format: string | null): boolean {
    return format !== null && isSupportedPixelFormat(format);
  }

  private handleMessage(message: MailboxMessage): void {
    if (message.type === "processed") {
      this.pending.get(message.frameSeq)?.resolve();
      this.pending.delete(message.frameSeq);
    } else if (message.type === "error") {
      this.pending.get(message.frameSeq)?.reject(new Error(message.message));
      this.pending.delete(message.frameSeq);
    }
  }

  private ensureSlots(nativeAllocationSize: number, outputAllocationSize: number): void {
    if (this.slots) return;
    const makeSlot = (): PixelSlot => ({
      input: new SharedArrayBuffer(nativeAllocationSize),
      output: new SharedArrayBuffer(outputAllocationSize),
    });
    this.slots = [makeSlot(), makeSlot()];
    this.inputViews = [new Uint8Array(this.slots[0].input), new Uint8Array(this.slots[1].input)];
    this.outputViews = [new Uint8Array(this.slots[0].output), new Uint8Array(this.slots[1].output)];
    this.port.postMessage({ type: "init", slots: this.slots });
  }

  /**
   * Copies the frame's native-format pixels into the shared mailbox, has
   * the processing worker convert+blur them, and returns a fresh (non-
   * shared — required for ImageData, confirmed empirically) RGBA buffer
   * ready for putImageData.
   */
  async process(frame: VideoFrame, radius: number): Promise<Uint8ClampedArray<ArrayBuffer>> {
    const format = frame.format;
    if (!isSupportedPixelFormat(format ?? "")) {
      throw new Error(`Unsupported pixel format for blur processing: ${format}`);
    }

    const width = frame.displayWidth;
    const height = frame.displayHeight;
    this.ensureSlots(frame.allocationSize(), width * height * 4);

    const slot = this.nextSlot;
    this.nextSlot = slot === 0 ? 1 : 0;

    const inputView = this.inputViews![slot];
    const rawLayout = await frame.copyTo(inputView);
    const planeLayout: PlaneLayoutEntry[] = rawLayout.map((plane) => ({
      offset: plane.offset,
      stride: plane.stride,
    }));

    const frameSeq = nextFrameSeq++;
    const done = new Promise<void>((resolve, reject) => {
      this.pending.set(frameSeq, { resolve, reject });
    });

    this.port.postMessage({
      type: "process",
      slot,
      frameSeq,
      format: format as "I420" | "NV12" | "BGRX",
      width,
      height,
      planeLayout,
      radius,
    });

    await done;
    // A genuinely fresh, non-shared buffer — the (buffer-source) constructor
    // overload always copies, but TS's generic typed-array typing doesn't
    // know that, so it needs an explicit cast rather than inferring
    // ArrayBufferLike from the shared-buffer-backed source view.
    return new Uint8ClampedArray(this.outputViews![slot]) as Uint8ClampedArray<ArrayBuffer>;
  }
}
