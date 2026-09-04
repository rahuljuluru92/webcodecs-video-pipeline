import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const shortFixture = path.join(dirname, "..", "test-media", "short_640x360_10s.mp4");
const longFixture = path.join(dirname, "..", "test-media", "long_1920x1080_60s.mp4");

async function playToEnd(
  page: Page,
  fixturePath: string,
  expectedDurationSeconds: number,
  timeoutMs: number,
): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto("/");
  await page.locator("#file-input").setInputFiles(fixturePath);
  await expect(page.locator("#play-button")).toBeEnabled({ timeout: 15_000 });

  await page.locator("#play-button").click();
  await expect(page.locator("#status")).toContainText("Playback ended.", { timeout: timeoutMs });

  const finalTime = await page
    .locator("#scrubber")
    .evaluate((el: HTMLInputElement) => Number(el.value));
  expect(finalTime).toBeGreaterThan(expectedDurationSeconds - 0.5);

  const isCanvasBlank = await page.locator("#video-canvas").evaluate((canvasEl) => {
    const canvas = canvasEl as HTMLCanvasElement;
    const ctx = canvas.getContext("2d")!;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return data.every((value) => value === 0);
  });
  expect(isCanvasBlank).toBe(false);

  expect(pageErrors).toEqual([]);
}

test("plays the short 640x360 clip start to finish", async ({ page }) => {
  await playToEnd(page, shortFixture, 10, 20_000);
});

test("plays the longer 1920x1080 clip start to finish", async ({ page }) => {
  test.setTimeout(120_000);
  await playToEnd(page, longFixture, 60, 90_000);
});
