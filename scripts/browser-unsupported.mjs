// npm run dev or a production preview must be running at APP_URL.
// A browser that cannot run removal is told so up front, and downloads no model.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { webkit } from "playwright";
import { bypassCsp, launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout, skipOrFail } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const notice = "This browser can’t run Cutout.";
const sample = readFileSync(new URL("../public/sample.jpg", import.meta.url));

function countModelRequests(page) {
  const seen = { models: 0 };
  page.on("request", (request) => {
    if (/huggingface|\.onnx(?:\?|$)/.test(request.url())) seen.models++;
  });
  return seen;
}

test("Chromium without OffscreenCanvas shows the notice and ignores images", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(15000);
    await page.addInitScript(() => {
      delete globalThis.OffscreenCanvas;
    });
    const seen = countModelRequests(page);
    await page.goto(new URL("/?src=/sample.jpg", appUrl).href, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: notice }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Choose files", exact: true }).count(), 0);
    // A file that still reaches the page (the hidden input, a paste or a drop) is ignored.
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: sample });
    await page.waitForTimeout(3000);
    assert.equal(seen.models, 0);
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 0);
    await page.getByRole("heading", { level: 1, name: notice }).waitFor();
  } finally {
    await browser.close();
  }
});

test("WebKit without OffscreenCanvas shows the notice", async (t) => {
  let browser;
  try {
    browser = bypassCsp(await webkit.launch());
  } catch {
    skipOrFail(t, "WebKit is not installed (npx playwright install webkit)");
    return;
  }
  try {
    const page = await browser.newPage();
    await page.addInitScript(() => {
      delete globalThis.OffscreenCanvas;
    });
    const seen = countModelRequests(page);
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { level: 1, name: notice }).waitFor({ timeout: 30000 });
    assert.equal(seen.models, 0);
  } finally {
    await browser.close();
  }
});
