/**
 * Pure TypeScript reference implementation of the exact same algorithms as
 * `assembly/index.ts` (YUV→RGBA conversion for this project's three
 * observed native decode formats, plus a naive box blur). Serves three
 * purposes: a correctness oracle the compiled WASM module is unit-tested
 * against, the JS side of the WASM-vs-JS benchmark, and a usable fallback
 * path if the WASM module ever fails to load.
 */

function clampU8(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return value | 0;
}

function writeRgbaFromYuv(out: Uint8Array, index: number, yVal: number, uVal: number, vVal: number): void {
  const c = yVal - 16;
  const d = uVal - 128;
  const e = vVal - 128;
  out[index] = clampU8(1.164 * c + 1.596 * e);
  out[index + 1] = clampU8(1.164 * c - 0.392 * d - 0.813 * e);
  out[index + 2] = clampU8(1.164 * c + 2.017 * d);
  out[index + 3] = 255;
}

export function convertI420ToRgba(
  y: Uint8Array,
  yStride: number,
  u: Uint8Array,
  uStride: number,
  v: Uint8Array,
  vStride: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const yRowOffset = row * yStride;
    const uRowOffset = (row >> 1) * uStride;
    const vRowOffset = (row >> 1) * vStride;
    for (let col = 0; col < width; col++) {
      const chromaCol = col >> 1;
      writeRgbaFromYuv(
        out,
        (row * width + col) * 4,
        y[yRowOffset + col],
        u[uRowOffset + chromaCol],
        v[vRowOffset + chromaCol],
      );
    }
  }
  return out;
}

export function convertNV12ToRgba(
  y: Uint8Array,
  yStride: number,
  uv: Uint8Array,
  uvStride: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const yRowOffset = row * yStride;
    const uvRowOffset = (row >> 1) * uvStride;
    for (let col = 0; col < width; col++) {
      const uvIndex = uvRowOffset + (col >> 1) * 2;
      writeRgbaFromYuv(out, (row * width + col) * 4, y[yRowOffset + col], uv[uvIndex], uv[uvIndex + 1]);
    }
  }
  return out;
}

export function convertBgrxToRgba(
  src: Uint8Array,
  srcStride: number,
  width: number,
  height: number,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const srcRowOffset = row * srcStride;
    for (let col = 0; col < width; col++) {
      const srcIndex = srcRowOffset + col * 4;
      const outIndex = (row * width + col) * 4;
      out[outIndex] = src[srcIndex + 2];
      out[outIndex + 1] = src[srcIndex + 1];
      out[outIndex + 2] = src[srcIndex];
      out[outIndex + 3] = 255;
    }
  }
  return out;
}

export function boxBlur(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return pixels;

  const out = new Uint8Array(pixels.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let count = 0;

      for (let dy = -radius; dy <= radius; dy++) {
        const sy = row + dy;
        if (sy < 0 || sy >= height) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const sx = col + dx;
          if (sx < 0 || sx >= width) continue;
          const index = (sy * width + sx) * 4;
          rSum += pixels[index];
          gSum += pixels[index + 1];
          bSum += pixels[index + 2];
          count++;
        }
      }

      // Integer (truncating) division, matching AssemblyScript's i32 `/`
      // operator exactly — see assembly/index.ts's boxBlur.
      const outIndex = (row * width + col) * 4;
      out[outIndex] = (rSum / count) | 0;
      out[outIndex + 1] = (gSum / count) | 0;
      out[outIndex + 2] = (bSum / count) | 0;
      out[outIndex + 3] = 255;
    }
  }
  return out;
}
