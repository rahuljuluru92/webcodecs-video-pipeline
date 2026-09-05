import { describe, expect, it } from "vitest";
import { boxBlur, convertBgrxToRgba, convertI420ToRgba, convertNV12ToRgba } from "./blur-reference";

describe("convertI420ToRgba", () => {
  it("converts limited-range black (Y=16, U=V=128) to RGB black", () => {
    const width = 2;
    const height = 2;
    const y = new Uint8Array([16, 16, 16, 16]);
    const u = new Uint8Array([128]);
    const v = new Uint8Array([128]);
    const rgba = convertI420ToRgba(y, width, u, 1, v, 1, width, height);
    for (let i = 0; i < rgba.length; i += 4) {
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]).toEqual([0, 0, 0, 255]);
    }
  });

  it("converts limited-range white (Y=235, U=V=128) to RGB white", () => {
    const width = 2;
    const height = 2;
    const y = new Uint8Array([235, 235, 235, 235]);
    const u = new Uint8Array([128]);
    const v = new Uint8Array([128]);
    const rgba = convertI420ToRgba(y, width, u, 1, v, 1, width, height);
    for (let i = 0; i < rgba.length; i += 4) {
      expect(rgba[i]).toBeGreaterThan(250);
      expect(rgba[i + 1]).toBeGreaterThan(250);
      expect(rgba[i + 2]).toBeGreaterThan(250);
      expect(rgba[i + 3]).toBe(255);
    }
  });

  it("handles a chroma-stride that differs from a tight quarter-width pack", () => {
    // 4x2 luma, 2x1 chroma per row but with extra stride padding.
    const y = new Uint8Array([16, 16, 16, 16, 16, 16, 16, 16]);
    const u = new Uint8Array([128, 128, 0, 0]); // stride 4, only first 2 bytes used per row
    const v = new Uint8Array([128, 128, 0, 0]);
    const rgba = convertI420ToRgba(y, 4, u, 4, v, 4, 4, 2);
    expect(rgba.length).toBe(4 * 2 * 4);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 255]);
  });
});

describe("convertNV12ToRgba", () => {
  it("converts limited-range black via interleaved UV to RGB black", () => {
    const width = 2;
    const height = 2;
    const y = new Uint8Array([16, 16, 16, 16]);
    const uv = new Uint8Array([128, 128]); // one interleaved U,V pair for the 2x2 block
    const rgba = convertNV12ToRgba(y, width, uv, 2, width, height);
    for (let i = 0; i < rgba.length; i += 4) {
      expect([rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]).toEqual([0, 0, 0, 255]);
    }
  });
});

describe("convertBgrxToRgba", () => {
  it("reorders BGRX to RGBA and forces alpha to 255", () => {
    const src = new Uint8Array([10, 20, 30, 99]); // B=10 G=20 R=30 X=99(ignored)
    const rgba = convertBgrxToRgba(src, 4, 1, 1);
    expect(Array.from(rgba)).toEqual([30, 20, 10, 255]);
  });

  it("respects a stride wider than width * 4", () => {
    // 1x2 image, stride 8 (extra 4 bytes of padding per row).
    const src = new Uint8Array([1, 2, 3, 255, 0, 0, 0, 0, 4, 5, 6, 255, 0, 0, 0, 0]);
    const rgba = convertBgrxToRgba(src, 8, 1, 2);
    expect(Array.from(rgba)).toEqual([3, 2, 1, 255, 6, 5, 4, 255]);
  });
});

describe("boxBlur", () => {
  it("is a no-op when radius is 0", () => {
    const pixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
    const result = boxBlur(pixels, 2, 1, 0);
    expect(result).toBe(pixels);
  });

  it("leaves a uniform image unchanged", () => {
    const width = 5;
    const height = 5;
    const pixels = new Uint8Array(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 100;
      pixels[i + 1] = 150;
      pixels[i + 2] = 200;
      pixels[i + 3] = 255;
    }
    const result = boxBlur(pixels, width, height, 2);
    for (let i = 0; i < result.length; i += 4) {
      expect([result[i], result[i + 1], result[i + 2], result[i + 3]]).toEqual([100, 150, 200, 255]);
    }
  });

  it("averages a single bright pixel into its neighborhood", () => {
    const width = 3;
    const height = 3;
    const pixels = new Uint8Array(width * height * 4);
    // Center pixel (1,1) is white, everything else is black.
    const centerIndex = (1 * width + 1) * 4;
    pixels[centerIndex] = 255;
    pixels[centerIndex + 1] = 255;
    pixels[centerIndex + 2] = 255;
    pixels[centerIndex + 3] = 255;
    for (let i = 0; i < pixels.length; i += 4) pixels[i + 3] = 255;

    const result = boxBlur(pixels, width, height, 1);
    // The center pixel averages itself + 8 neighbors (full 3x3 window fits
    // since it's not on an edge): 255/9 truncated.
    expect(result[centerIndex]).toBe(Math.trunc(255 / 9));
    // A corner pixel only has a 2x2 window (3 neighbors + itself, one of
    // which is the bright center): edge clamping, not wraparound.
    const cornerIndex = 0;
    expect(result[cornerIndex]).toBe(Math.trunc(255 / 4));
  });
});
