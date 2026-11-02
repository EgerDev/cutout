import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(/\/$/, "");
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { launchChrome } from "./chrome.mjs";

let browser, page;
beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(verifiedAppUrl);
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
});
afterEach(async () => { await browser?.close(); });

async function openPreview() {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 128; canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456"; ctx.fillRect(32, 16, 64, 32);
    return canvas.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await chooser).setFiles({ name: "preview.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace.getState().items[0]?.status === "done");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Quality & file size" }).click();
}

test("downloads the exact inspected file without encoding it again", async () => {
  // Given an encoded export preview.
  await openPreview();
  const dirty = () => page.evaluate(async () => {
    const { hasUnsavedWork } = await import("/src/lib/workspace-saved.ts");
    return hasUnsavedWork(window.__cutoutTest.useWorkspace.getState());
  });
  assert.equal(await dirty(), true);

  await page.getByRole("button", { name: "Preview export", exact: true }).click();
  const image = page.getByAltText("Encoded export preview");
  await image.waitFor();
  const bytes = await image.evaluate(async (img) => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
  const button = page.getByRole("button", { name: "Download preview", exact: true });
  assert.equal(await button.count(), 1, "The inspected export cannot be downloaded");
  await page.evaluate(() => {
    window.previewEncodeCalls = 0;
    const encode = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (...args) { window.previewEncodeCalls++; return encode.apply(this, args); };
  });
  // When the user saves the inspected preview.
  const pending = page.waitForEvent("download");
  await button.click();
  const download = await pending;
  // Then the downloaded bytes match the displayed file, without new canvas encoding.
  assert.equal(download.suggestedFilename(), "preview-cutout.png");
  assert.deepEqual(Array.from(await readFile(await download.path())), bytes);
  assert.equal(await page.evaluate(() => window.previewEncodeCalls), 0);
  assert.equal(await dirty(), false, "the inspected composition is saved");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setExportSize(64, 32));
  assert.equal(await dirty(), true, "editing after saving makes the composition dirty again");
});

test("discards a saved preview when its image settings change", async () => {
  // Given an encoded export preview.
  await openPreview();
  await page.getByRole("button", { name: "Preview export", exact: true }).click();
  await page.getByAltText("Encoded export preview").waitFor();
  assert.equal(await page.getByRole("button", { name: "Download preview", exact: true }).count(), 1);
  // When export dimensions change.
  await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().setExportSize(64, 32));
  // Then the previous file is no longer offered for download.
  await page.getByAltText("Encoded export preview").waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Download preview", exact: true }).count(), 0);
});

test("keeps the inspected file while a size target is being typed, then invalidates on commit", async () => {
  // Given a preview with a committed size target.
  await openPreview();
  await page.getByLabel("Target file size", { exact: true }).check();
  await page.getByRole("button", { name: "Preview export", exact: true }).click();
  await page.getByAltText("Encoded export preview").waitFor();
  // When a different target is drafted without leaving the input.
  const field = page.getByRole("spinbutton", { name: "Maximum size (KB)", exact: true });
  await field.fill("1000");
  // Then full export settings and the already inspected file stay stable until commit.
  assert.equal(await page.evaluate(() => { const s = window.__cutoutTest?.useWorkspace.getState(); return s.settings[s.activeId].targetKB; }), 500);
  assert.equal(await page.getByAltText("Encoded export preview").count(), 1);
  await field.press("Enter");
  await page.getByAltText("Encoded export preview").waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => { const s = window.__cutoutTest?.useWorkspace.getState(); return s.settings[s.activeId].targetKB; }), 1000);
});
