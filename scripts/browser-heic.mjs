import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright";
import { appCandidates } from "./app-url.mjs";
import { bypassCsp } from "./chrome.mjs";
import { cutoutOrSkip } from "./require-server.mjs";

const root = new URL("../", import.meta.url);
// 64×48, left half red, right half blue; encoded by heif-enc 1.23.5 (x265, quality 90)
// from a generated PNG. Coded as 64×64 with a clean-aperture crop, like camera files.
const fixture = new URL("src/lib/fixtures/tiny.heic", root);

/**
 * libheif and libde265 keep their version strings in the asm.js data segments,
 * which emscripten stores as base64 literals; decode them all and look for the
 * NUL-terminated C strings.
 */
function embeddedStrings(js) {
  const runs = js.match(/[A-Za-z0-9+/]{64,}={0,2}/g) ?? [];
  return runs.map((run) => Buffer.from(run, "base64").toString("latin1")).join("\n");
}

function assertPatchedDecoder(js, where) {
  const data = embeddedStrings(js);
  assert.ok(data.includes("1.23.5\0"), `${where}: libheif 1.23.5 not found`);
  assert.ok(data.includes("1.1.3\0"), `${where}: libde265 1.1.3 not found`);
  assert.ok(!data.includes("1.22.2\0"), `${where}: still carries libheif 1.22.2`);
  assert.ok(!data.includes("1.0.16\0"), `${where}: still carries libde265 1.0.16`);
}

test("the vendored heic-to bundle carries libheif 1.23.5 and libde265 1.1.3", async () => {
  const js = await readFile(new URL("vendor/heic-to/csp.js", root), "latin1");
  assertPatchedDecoder(js, "vendor");
  // The CSP build (DYNAMIC_EXECUTION=0) must run without 'unsafe-eval'.
  assert.doesNotMatch(js, /\bnew Function\(|[^.\w]eval\(/);
});

test("Chromium decodes a HEIC through the app with the rebuilt decoder", async (t) => {
  const appUrl = await cutoutOrSkip(
    t,
    appCandidates("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"),
  );
  if (!appUrl) return;
  // Playwright's own Chromium: Google Chrome may one day decode HEIC natively.
  const browser = bypassCsp(await chromium.launch());
  try {
    const page = await browser.newPage();
    const scripts = [];
    page.on("response", (response) => {
      if (response.request().resourceType() === "script") scripts.push(response);
    });
    await page.goto(new URL("?e2e", appUrl).href);
    const store = () => window.__cutoutTest?.useWorkspace;
    await page.waitForFunction(`(${store})()`);

    const bytes = await readFile(fixture);
    const native = await page.evaluate(async (b64) => {
      const blob = new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], {
        type: "image/heic",
      });
      return createImageBitmap(blob).then(
        () => true,
        () => false,
      );
    }, bytes.toString("base64"));
    assert.equal(native, false, "this browser decodes HEIC natively; the test would prove nothing");

    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({ name: "tiny.heic", mimeType: "image/heic", buffer: bytes });
    const handle = await page.waitForFunction(
      `(() => {
        const item = (${store})().getState().items[0];
        if (!item?.preview) return null;
        const canvas = new OffscreenCanvas(item.preview.width, item.preview.height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(item.preview, 0, 0);
        const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data);
        return { width: item.width, height: item.height, left: px(16, 24), right: px(48, 24) };
      })()`,
      null,
      { timeout: 30_000 },
    );
    const decoded = await handle.jsonValue();
    assert.equal(decoded.width, 64);
    assert.equal(decoded.height, 48);
    // Left half red, right half blue (lossy, so only roughly).
    assert.ok(decoded.left[0] > 200 && decoded.left[2] < 60, `left ${decoded.left}`);
    assert.ok(decoded.right[2] > 200 && decoded.right[0] < 60, `right ${decoded.right}`);

    const bodies = await Promise.all(scripts.map((r) => r.text().catch(() => "")));
    const decoder = bodies.find((js) => embeddedStrings(js).includes("heif_chroma_"));
    assert.ok(decoder, "no HEIC decoder script was loaded");
    assertPatchedDecoder(decoder, "served chunk");
  } finally {
    await browser.close();
  }
});
