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

  // The canvas has had its control transferred to the worker (Stage 4), so
  // ctx.getImageData() from the main thread no longer works — a real
  // screenshot of the composited page is the only way left to inspect what
  // it's actually displaying. A blank/black canvas compresses to a tiny PNG;
  // this colorful test pattern doesn't.
  const screenshot = await page.locator("#video-canvas").screenshot();
  expect(screenshot.length).toBeGreaterThan(2000);

  expect(pageErrors).toEqual([]);
}

test("plays the short 640x360 clip start to finish", async ({ page }) => {
  await playToEnd(page, shortFixture, 10, 20_000);
});

test("plays the longer 1920x1080 clip start to finish", async ({ page }) => {
  test.setTimeout(120_000);
  await playToEnd(page, longFixture, 60, 90_000);
});
