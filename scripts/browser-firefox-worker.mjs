// The removal worker encodes through a callback-style canvas.toBlob shim. Firefox (the
// default browser on most Linux desktops) ships a legacy Promise-returning
// OffscreenCanvas.toBlob, so a shim that deferred to it hung every cut. A flat logo takes
// the worker's graphic path: it encodes without downloading a model. Requires Vite dev.
//
// Owned engine (W3): the graphic path never reaches the removal runtime or Transformers.js, so the
// cut also records no provenance (`lastRemovalProvenance()` is undefined) and, between the end of
// page load and the end of the cut, no request (the worker's included) names Transformers.js or a
// model file. Authored only; it runs in a browser window with no native measurement active.
import assert from "node:assert/strict";
import test from "node:test";
import { bypassCsp } from "./chrome.mjs";
import { launchFirefox } from "./firefox.mjs";
import { requireCutout, skipOrFail } from "./require-server.mjs";

test("Firefox finishes a cut in the removal worker", async (t) => {
  let browser;
  try {
    browser = bypassCsp(await launchFirefox());
  } catch (error) {
    if (!/Executable doesn't exist/.test(String(error?.message))) throw error;
    skipOrFail(t, "Playwright Firefox is not installed (npx playwright install firefox)");
    return;
  }
  try {
    const context = await browser.newContext();
    // The context sees worker requests too; a page listener would not.
    const requests = [];
    context.on("request", (request) => requests.push(request.url()));
    const page = await context.newPage();
    await page.goto(await requireCutout([process.env.DEV_URL ?? "http://127.0.0.1:8080/"]), {
      waitUntil: "networkidle",
    });
    const requestsBeforeCut = requests.length;
    const result = await page.evaluate(async () => {
      const { lastRemovalProvenance, removeBackgroundAuto, workerRemovalSupported } =
        await import("/src/lib/removal-client.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 240;
      canvas.height = 120;
      const context = canvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 240, 120);
      context.fillStyle = "#111";
      context.fillRect(40, 30, 160, 60);
      const logo = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("hung")), 20_000),
      );
      const removed = await Promise.race([removeBackgroundAuto(logo), timeout]);
      return {
        worker: workerRemovalSupported(),
        method: removed.method,
        type: removed.blob.type,
        provenance: lastRemovalProvenance(),
      };
    });
    assert.equal(result.worker, true, "Firefox should run removal in the worker");
    assert.equal(result.type, "image/png");
    assert.notEqual(result.method, "model");
    // A graphic cut touches no model: nothing was recorded and nothing model-shaped was fetched.
    assert.equal(result.provenance, undefined, "a graphic cut records no provenance");
    const duringCut = requests.slice(requestsBeforeCut);
    assert.deepEqual(
      duringCut.filter((url) => /transformers|huggingface|\.onnx|ort-wasm/i.test(url)),
      [],
      "zero Transformers.js or model fetches during the cut",
    );
  } finally {
    await browser.close();
  }
});
