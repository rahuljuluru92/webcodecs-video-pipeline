import { describe, expect, it } from "vitest";
import * as wasmBlur from "../build/blur.release.js";
import * as jsReference from "./blur-reference";

/** Deterministic pseudo-random bytes so every run exercises the same
 * "realistic" (non-uniform) input without needing a checked-in fixture. */
function pseudoRandomBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = state % 256;
  }
  return bytes;
}

describe("wasm-blur matches the JS reference implementation exactly", () => {
  it("convertI420ToRgba", () => {
    const width = 16;
    const height = 12;
    const y = pseudoRandomBytes(width * height, 1);
    const u = pseudoRandomBytes((width / 2) * (height / 2), 2);
    const v = pseudoRandomBytes((width / 2) * (height / 2), 3);

    const expected = jsReference.convertI420ToRgba(y, width, u, width / 2, v, width / 2, width, height);
    const actual = wasmBlur.convertI420ToRgba(y, width, u, width / 2, v, width / 2, width, height);

    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it("convertNV12ToRgba", () => {
    const width = 16;
    const height = 12;
    const y = pseudoRandomBytes(width * height, 4);
    const uv = pseudoRandomBytes(width * (height / 2), 5);

    const expected = jsReference.convertNV12ToRgba(y, width, uv, width, width, height);
    const actual = wasmBlur.convertNV12ToRgba(y, width, uv, width, width, height);

    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it("convertBgrxToRgba", () => {
    const width = 16;
    const height = 12;
    const src = pseudoRandomBytes(width * height * 4, 6);

    const expected = jsReference.convertBgrxToRgba(src, width * 4, width, height);
    const actual = wasmBlur.convertBgrxToRgba(src, width * 4, width, height);

    expect(Array.from(actual)).toEqual(Array.from(expected));
  });

  it("boxBlur", () => {
    const width = 20;
    const height = 16;
    const pixels = pseudoRandomBytes(width * height * 4, 7);
    // Alpha must stay opaque like real decoded video frames, not random noise.
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;

    for (const radius of [0, 1, 3]) {
      const expected = jsReference.boxBlur(pixels, width, height, radius);
      const actual = wasmBlur.boxBlur(pixels, width, height, radius);
      expect(Array.from(actual)).toEqual(Array.from(expected));
    }
  });
});
