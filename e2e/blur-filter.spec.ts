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
  await expect(page.locator("#status")).toContainText(`requested ${seconds.toFixed(2)}s`, {
    timeout: 10_000,
  });
}

test("toggling the blur filter visibly changes the rendered frame, and back again", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") pageErrors.push(msg.text());
  });

  await page.goto("/");
  await page.locator("#file-input").setInputFiles(shortFixture);
  await expect(page.locator("#scrubber")).toBeEnabled({ timeout: 15_000 });

  // Blur is hidden entirely when SharedArrayBuffer/cross-origin-isolation
  // isn't available — this project's dev/test server always provides it
  // (see vite.config.ts), so it should be visible here.
  await expect(page.locator("#blur-button")).toBeVisible();
  await expect(page.locator("#blur-button")).toHaveText("Blur: Off");

  await seekTo(page, 3);
  const sharp = await page.locator("#video-canvas").screenshot();

  await page.locator("#blur-button").click();
  await expect(page.locator("#blur-button")).toHaveText("Blur: On");
  // Seek to a different timestamp first so this isn't a cache-hit re-draw
  // of the exact same already-cached frame reference.
  await seekTo(page, 1);
  await seekTo(page, 3);
  const blurred = await page.locator("#video-canvas").screenshot();

  expect(blurred).not.toEqual(sharp);

  await page.locator("#blur-button").click();
  await expect(page.locator("#blur-button")).toHaveText("Blur: Off");
  await seekTo(page, 1);
  await seekTo(page, 3);
  const sharpAgain = await page.locator("#video-canvas").screenshot();

  expect(sharpAgain).not.toEqual(blurred);
  expect(pageErrors).toEqual([]);
});
