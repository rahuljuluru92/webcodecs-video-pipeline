import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const shortFixture = path.join(dirname, "..", "test-media", "short_640x360_10s.mp4");
const longFixture = path.join(dirname, "..", "test-media", "long_1920x1080_60s.mp4");

test("decodes and renders the short 640x360 clip start to finish", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await page.locator("#play-button").click();

  await expect(page.locator("#status")).toContainText("Done. Rendered 300 frames", {
    timeout: 20_000,
  });

  const isCanvasBlank = await page.locator("#video-canvas").evaluate((canvasEl) => {
    const canvas = canvasEl as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return data.every((value) => value === 0);
  });
  expect(isCanvasBlank).toBe(false);

  expect(pageErrors).toEqual([]);
});

test("decodes and renders the longer 1920x1080 clip start to finish", async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto("/");
  await page.locator("#file-input").setInputFiles(longFixture);
  await page.locator("#play-button").click();

  await expect(page.locator("#status")).toContainText("Done. Rendered 1800 frames", {
    timeout: 90_000,
  });

  expect(pageErrors).toEqual([]);
});
