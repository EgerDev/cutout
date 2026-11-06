// Run with a Vite dev server: node --test scripts/browser-engine-cancellation.mjs
//
// The graphics rows need no model. The three model rows replace only the Transformers.js
// boundary (scripts/fake-transformers.mjs, design section 7) and run the real owned engine,
// runtime, pool and adapter. Each row pins the route (no WebGPU adapter, 8 GB) so the primary
// is BiRefNet on WASM; event counts come from the fake's sorted event log.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appCandidates } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { installFake, readFakeLog } from "./fake-transformers.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

let browser;
let page;

before(async () => {
  browser = await launchChrome();
  page = await browser.newPage();
  await page.goto(appUrl, { waitUntil: "networkidle" });
});

after(async () => {
  await browser?.close();
});

async function runGraphic(scenario) {
  return page.evaluate(async (scenario) => {
    const { removeBackgroundLocal } = await import("/src/lib/engine.ts");
    // Given a real graphic that takes the local color-key path without ML downloads.
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = "black";
    ctx.fillRect(16, 16, 32, 32);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const controller = new AbortController();
    const reason = new DOMException("Superseded image", "AbortError");
    const progress = [];
    let decodes = 0;
    const decode = window.createImageBitmap;
    const encode = HTMLCanvasElement.prototype.toBlob;
    window.createImageBitmap = (...args) => {
      decodes += 1;
      return decode(...args);
    };
    HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
      return encode.call(
        this,
        (output) => {
          if (scenario === "encoding") controller.abort(reason);
          callback(output);
        },
        ...args,
      );
    };
    if (scenario === "pre-aborted") controller.abort(reason);
    if (scenario === "custom-reason") controller.abort("superseded");
    try {
      // When cancellation happens before or during the real graphics pipeline.
      const result = await removeBackgroundLocal(blob, {
        signal: controller.signal,
        onProgress: (event) => {
          progress.push(event.progress);
          if (scenario === "progress") controller.abort(reason);
        },
      });
      return { outcome: "resolved", provider: result.provider, decodes, progress };
    } catch (error) {
      return {
        outcome: "rejected",
        sameReason: error === controller.signal.reason,
        decodes,
        progress,
      };
    } finally {
      window.createImageBitmap = decode;
      HTMLCanvasElement.prototype.toBlob = encode;
      canvas.width = canvas.height = 0;
    }
  }, scenario);
}

for (const scenario of ["pre-aborted", "custom-reason", "progress", "encoding"]) {
  test(`graphics job rejects cancellation when ${scenario}`, async () => {
    const result = await runGraphic(scenario);
    // Then cancellation wins over a successful result and emits no completion.
    assert.equal(result.outcome, "rejected");
    assert.equal(result.sameReason, true);
    assert.equal(result.progress.includes(1), false);
    if (scenario !== "encoding") assert.equal(result.decodes, 0);
    if (scenario === "pre-aborted" || scenario === "custom-reason") {
      assert.deepEqual(result.progress, []);
    }
  });
}

test("graphics job succeeds when the signal is live", async () => {
  const result = await runGraphic("live");
  assert.equal(result.outcome, "resolved");
  assert.equal(result.provider, "fallback");
  assert.equal(result.progress.at(-1), 1);
});

// ---- the model rows: the real owned engine over the faked Transformers.js boundary ------------------

// The page environment (deviceMemory 8, requestAdapter -> null) is pinned by the fake's own installFake,
// before any app script, so the route is BiRefNet/WASM (the primary) whatever hardware runs the test
// (design section 7).

// The fake's merged, time-sorted event log (page and worker). Model inferences only: the fake also
// logs a `run` for every processor() call.
const readLog = (page) => readFakeLog(page);
const loadsOf = (log, kind) => log.filter((e) => e.type === "from_pretrained" && e.kind === kind);
const runsOf = (log) => log.filter((e) => e.type === "run" && e.phase === "model");

// What the faked model does on each run, as function sources the fake inlines. The load hook keeps the
// progress_callback the pool subscribed with; the mask hook counts the run, then cancels the job
// mid-inference and keeps delivering shared load progress through that callback, as a download that
// outlives its job does.
const LOAD_HOOK = `(call) => {
  if (call.kind === "model") call.state.progress = call.progress;
}`;
function maskHook(scenario) {
  return `async (call) => {
    globalThis.engineCalls = (globalThis.engineCalls || 0) + 1;
    const scenario = ${JSON.stringify(scenario)};
    if (scenario === "wasm-retry" && globalThis.engineCalls === 1) throw new Error("WebGPU device lost");
    globalThis.abortEngineJob();
    call.state.progress?.({ status: "progress", file: "onnx/model.onnx", progress: 50 });
    globalThis.sharedProgressSurvived = true;
    if (scenario !== "model-result") throw new Error("Model failed after cancellation");
    return 20;
  }`;
}

for (const scenario of ["model-result", "model-error", "wasm-retry"]) {
  test(`cancellation takes precedence over ${scenario} without breaking shared progress`, async () => {
    const context = await browser.newContext();
    try {
      await installFake(context, {
        deviceMemory: 8,
        adapter: false,
        page: { mask: maskHook(scenario), load: LOAD_HOOK },
      });
      const modelPage = await context.newPage();
      await modelPage.goto(appUrl);
      const result = await modelPage.evaluate(async () => {
        const { removeBackgroundLocal } = await import("/src/lib/engine.ts");
        // A colored image bypasses the monochrome graphics shortcut.
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "red";
        ctx.fillRect(0, 0, 64, 64);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const controller = new AbortController();
        const reason = new DOMException("Replaced job", "AbortError");
        window.abortEngineJob = () => controller.abort(reason);
        let staleProgress = 0;
        try {
          await removeBackgroundLocal(blob, {
            signal: controller.signal,
            onProgress: () => {
              if (controller.signal.aborted) staleProgress++;
            },
          });
          return { rejected: false };
        } catch (error) {
          return {
            rejected: error === reason,
            staleProgress,
            sharedProgressSurvived: window.sharedProgressSurvived,
            calls: window.engineCalls,
          };
        } finally {
          canvas.width = canvas.height = 0;
        }
      });
      // Then cancellation wins over the model's result or error, with the caller's own reason.
      assert.equal(result.rejected, true);
      assert.equal(result.sharedProgressSurvived, true);
      assert.equal(result.staleProgress, 0);
      // The wasm-retry row: the primary throws, the same-target compatibility pass reuses the one
      // session (Q4 e) and is the run that is cancelled, so two runs and a single model load.
      assert.equal(result.calls, scenario === "wasm-retry" ? 2 : 1);
      const log = await readLog(modelPage);
      assert.equal(
        runsOf(log).length,
        result.calls,
        "the event log and the hook count the same runs",
      );
      assert.equal(
        loadsOf(log, "model").length,
        1,
        "one BiRefNet session serves the primary and the retry",
      );
      assert.equal(loadsOf(log, "processor").length, 1);
      assert.ok(
        loadsOf(log, "model").every((e) => e.device === "wasm"),
        "the pinned route loads BiRefNet on WASM only",
      );
    } finally {
      await context.close();
    }
  });
}
