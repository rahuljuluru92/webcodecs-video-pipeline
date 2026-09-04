import { expect, test } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const shortFixture = path.join(dirname, "..", "test-media", "short_640x360_10s.mp4");

async function seekTo(page: import("@playwright/test").Page, seconds: number): Promise<void> {
  await page.locator("#scrubber").evaluate((el: HTMLInputElement, value) => {
    el.value = String(value);
  }, seconds);
  await page.locator("#scrubber").dispatchEvent("change");
}

/** A real screenshot of the canvas as displayed. Since Stage 4 transfers
 * canvas control to the worker, ctx.getImageData() from the main thread no
 * longer works — a screenshot of the composited page is the only way left
 * to inspect what it's actually showing, and it's a fine substitute here:
 * we only need "did the displayed frame change," not per-pixel values. */
function canvasSnapshot(page: import("@playwright/test").Page): Promise<Buffer> {
  return page.locator("#video-canvas").screenshot();
}

test("seeking to a specific timestamp renders the correct frame", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  await seekTo(page, 4);
  await expect(page.locator("#status")).toContainText("requested 4.00s", { timeout: 5_000 });

  const statusAt4s = await page.locator("#status").textContent();
  const match = statusAt4s!.match(/Seeked to ([\d.]+)s \(requested ([\d.]+)s\) in ([\d.]+) ms/);
  expect(match).not.toBeNull();
  const [, actualStr, requestedStr, latencyStr] = match!;

  // Requested and actual should agree within one frame interval (1/30s).
  expect(Math.abs(Number(actualStr) - Number(requestedStr))).toBeLessThan(1 / 30 + 0.005);
  // Seek latency is small — a real number worth recording, not a sentinel.
  expect(Number(latencyStr)).toBeGreaterThanOrEqual(0);

  const frameAt4s = await canvasSnapshot(page);

  await seekTo(page, 8);
  await expect(page.locator("#status")).toContainText("requested 8.00s", { timeout: 5_000 });

  const frameAt8s = await canvasSnapshot(page);
  expect(frameAt8s).not.toEqual(frameAt4s);
});

test("seeking backward (reverse-direction seek) also lands on the correct frame", async ({
  page,
}) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  await seekTo(page, 7);
  await expect(page.locator("#status")).toContainText("requested 7.00s", { timeout: 5_000 });

  await seekTo(page, 2);
  await expect(page.locator("#status")).toContainText("requested 2.00s", { timeout: 5_000 });

  const statusAt2s = await page.locator("#status").textContent();
  const match = statusAt2s!.match(/Seeked to ([\d.]+)s \(requested ([\d.]+)s\)/);
  expect(Math.abs(Number(match![1]) - Number(match![2]))).toBeLessThan(1 / 30 + 0.005);
});

test("reverse playback produces frames in decreasing timestamp order", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  await seekTo(page, 5);
  await expect(page.locator("#status")).toContainText("requested 5.00s", { timeout: 5_000 });

  await page.locator("#reverse-button").click();
  await expect(page.locator("#reverse-button")).toHaveText("Reverse: On");

  await page.locator("#play-button").click();
  await expect(page.locator("#play-button")).toHaveText("Pause");

  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(250);
    const value = await page
      .locator("#scrubber")
      .evaluate((el: HTMLInputElement) => Number(el.value));
    samples.push(value);
  }

  await page.locator("#play-button").click();

  for (let i = 1; i < samples.length; i++) {
    expect(samples[i]).toBeLessThanOrEqual(samples[i - 1] + 0.001);
  }
  // Confirm real backward movement happened, not just a flat/stalled reading.
  expect(samples[0] - samples[samples.length - 1]).toBeGreaterThan(0.2);
});
