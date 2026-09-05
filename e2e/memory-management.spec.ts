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

test("re-seeking within an already-decoded GOP is served from cache", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  // 2.0s and 2.1s land in the same 1-second-long GOP (30 frames @ 30fps).
  await seekTo(page, 2.0);
  await expect(page.locator("#status")).toContainText("requested 2.00s", { timeout: 5_000 });
  await expect(page.locator("#status")).toContainText("decoding 30 frame(s)");

  await seekTo(page, 2.1);
  await expect(page.locator("#status")).toContainText("requested 2.10s", { timeout: 5_000 });
  await expect(page.locator("#status")).toContainText("decoding 0 frame(s) (cache hit)");
});

test("live frame count and cache size stay bounded across many seeks", async ({ page }) => {
  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  // Seek to many distinct points spread across the whole clip — enough to
  // force the cache well past a single GOP's worth of frames if it weren't
  // bounded.
  for (let i = 0; i < 20; i++) {
    const seconds = (i % 10) + (i / 100); // spread across 0-10s, all distinct
    await seekTo(page, seconds);
    await expect(page.locator("#status")).toContainText("Seeked to", { timeout: 5_000 });
  }

  const statsText = await page.locator("#memory-stats").textContent();
  const match = statsText!.match(/Live frames: (\d+) · Seek cache: (\d+) frames/);
  expect(match).not.toBeNull();
  const liveFrameCount = Number(match![1]);
  const cacheSize = Number(match![2]);

  // Default cache capacity is 120 frames (see DEFAULT_FRAME_CACHE_CAPACITY);
  // 20 distinct-GOP seeks over a 10-keyframe file would, if unbounded,
  // exceed that. Bounded means it never does.
  expect(cacheSize).toBeLessThanOrEqual(120);
  expect(liveFrameCount).toBeLessThanOrEqual(120);
  expect(liveFrameCount).toBeGreaterThan(0);
});
