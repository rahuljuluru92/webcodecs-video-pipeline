// Pixel processing for the video pipeline's optional blur filter, compiled
// to WebAssembly. Handles the three native VideoDecoder output formats this
// project has actually observed across its tested browsers (see DECISIONS.md
// for the empirical findings that drove this — relying on the browser's own
// copyTo() format conversion turned out to be unreliable in WebKit, which
// silently ignores the requested format).
//
// Conversion uses the standard limited-range BT.601 matrix. This is not a
// broadcast-accurate colorimetric pipeline — it's a visually-correct
// conversion for a demo blur effect, not aiming for bit-exact parity across
// browsers with genuinely different YUV range conventions (see DECISIONS.md).

@inline
function clampU8(value: f32): u8 {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return u8(value);
}

@inline
function writeRgbaFromYuv(out: Uint8Array, index: i32, yVal: u8, uVal: u8, vVal: u8): void {
  const c: f32 = f32(yVal) - 16.0;
  const d: f32 = f32(uVal) - 128.0;
  const e: f32 = f32(vVal) - 128.0;
  out[index] = clampU8(1.164 * c + 1.596 * e);
  out[index + 1] = clampU8(1.164 * c - 0.392 * d - 0.813 * e);
  out[index + 2] = clampU8(1.164 * c + 2.017 * d);
  out[index + 3] = 255;
}

/** I420: three planes, Y at full resolution, U/V at quarter resolution
 * (half width, half height) — Chromium's native decode output format. */
export function convertI420ToRgba(
  y: Uint8Array,
  yStride: i32,
  u: Uint8Array,
  uStride: i32,
  v: Uint8Array,
  vStride: i32,
  width: i32,
  height: i32,
): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++) {
    const yRowOffset = row * yStride;
    const chromaRowOffset = (row >> 1) * uStride;
    const chromaRowOffsetV = (row >> 1) * vStride;
    for (let col = 0; col < width; col++) {
      const chromaCol = col >> 1;
      writeRgbaFromYuv(
        out,
        (row * width + col) * 4,
        y[yRowOffset + col],
        u[chromaRowOffset + chromaCol],
        v[chromaRowOffsetV + chromaCol],
      );
    }
  }
  return out;
}

/** NV12: two planes, Y at full resolution, interleaved U/V (U,V,U,V,...) at
 * quarter resolution — WebKit's native decode output format. */
export function convertNV12ToRgba(
  y: Uint8Array,
  yStride: i32,
  uv: Uint8Array,
  uvStride: i32,
  width: i32,
  height: i32,
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

/** BGRX: one packed plane, already full-resolution color (no YUV math
 * needed, just a channel reorder) — Firefox's native decode output format. */
export function convertBgrxToRgba(src: Uint8Array, srcStride: i32, width: i32, height: i32): Uint8Array {
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

/**
 * A deliberately simple/naive box blur (O(radius^2) per pixel, no separable
 * sliding-window optimization) applied to a packed RGBA buffer. Naive on
 * purpose: the JS reference implementation this is benchmarked against uses
 * the identical algorithm, so the comparison isolates "WASM vs JS" rather
 * than "algorithm A vs algorithm B."
 */
export function boxBlur(pixels: Uint8Array, width: i32, height: i32, radius: i32): Uint8Array {
  if (radius <= 0) return pixels;

  const out = new Uint8Array(pixels.length);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      let rSum: i32 = 0;
      let gSum: i32 = 0;
      let bSum: i32 = 0;
      let count: i32 = 0;

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

      const outIndex = (row * width + col) * 4;
      out[outIndex] = u8(rSum / count);
      out[outIndex + 1] = u8(gSum / count);
      out[outIndex + 2] = u8(bSum / count);
      out[outIndex + 3] = 255;
    }
  }
  return out;
}
