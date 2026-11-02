import assert from "node:assert/strict";
import test from "node:test";
import { appCandidates } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { installFake, readFakeLog, runInterceptionSmoke, select } from "./fake-transformers.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

// The real adapter, runtime, engine and finishing run; only Transformers.js is faked (see
// fake-transformers.mjs). Every row fixes its route: no adapter plus 8 GB is BiRefNet on WASM and
// a fake adapter plus 8 GB is BiRefNet on WebGPU, whatever this machine's headless GPU offers.
// The mask functions below are serialised into the fake, so they close over nothing.

/** The refinement fixture's first pass keeps only the small subject (x 40-52, y 30-50); every
 *  later pass (a crop) keeps everything. Raw BiRefNet logits. */
const smallSubjectThenAll = (c, h) =>
  c.n === 1 ? h.rect(c, { x0: 40, y0: 30, x1: 52, y1: 50, inside: 20, outside: -20 }) : 20;
/** Raw logits `[-2, 0, 2]` in vertical thirds; any later run (an optional crop) fails and is
 *  skipped, so the returned pixels are the global cut. */
const logitThirds = (c, h) => (c.n > 1 ? h.fail("crop off") : h.bandsX([-2, 0, 2]));

async function withFakePage(options, run) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await installFake(page, { deviceMemory: 8, ...options });
    await page.goto(appUrl);
    return await run(page);
  } finally {
    await browser.close();
  }
}

const disposals = (log, target) => select(log, { type: "dispose", target }).length;
const modelRuns = (log) => select(log, { type: "run", phase: "model" }).length;

test("interception smoke: a route reaches the dedicated removal worker (step 1 of the worker rows)", async () => {
  const browser = await launchChrome();
  try {
    const smoke = await runInterceptionSmoke(browser, appUrl, { deviceMemory: 6 });
    // If neither page.route nor context.route does, the worker rows are not red-first tests: they
    // go back to the architect for a design revision. No production seam is added to pass them.
    assert.notEqual(smoke.intercepted, null, JSON.stringify(smoke.attempts));
  } finally {
    await browser.close();
  }
});

test("photo removal refines a small subject with a second bounded model pass", async () =>
  withFakePage({ page: { mask: smallSubjectThenAll } }, async (page) => {
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts?refinement-test");
      const { removalRuntime } = await import("/src/lib/removal-runtime.ts");
      const source = await window.__fx.gradientPhoto();
      const removed = await removeBackgroundLocal(source);
      const bitmap = await createImageBitmap(removed.blob);
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, 120, 80).data;
      let opaquePixels = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 240) opaquePixels += 1;
      }
      return { opaquePixels, provider: removed.provider, provenance: removalRuntime.provenance() };
    });
    const log = await readFakeLog(page);
    assert.equal(modelRuns(log), 2);
    assert.equal(result.provider, "wasm");
    assert.equal(result.provenance.cropInferences, 1);
    // One BiRefNet/WASM engine served both passes.
    assert.equal(select(log, { type: "from_pretrained", kind: "model" }).length, 1);
    assert.ok(result.opaquePixels > 240, `expected refined crop, got ${result.opaquePixels} pixels`);
  }));

async function runThirds() {
  return withFakePage({ page: { mask: logitThirds } }, async (page) => {
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts?biref-logit-contract");
      const { removalRuntime } = await import("/src/lib/removal-runtime.ts");
      const source = await window.__fx.gradientPhoto({ subject: false });
      const removed = await removeBackgroundLocal(source, {});
      return {
        alpha: await window.__fx.alphaAt(removed.blob, [[20, 40], [60, 40], [100, 40]]),
        provider: removed.provider,
        size: [removed.width, removed.height],
        provenance: removalRuntime.provenance(),
      };
    });
    return { result, log: await readFakeLog(page) };
  });
}
const closeTo = (actual, expected, label) =>
  actual.forEach((value, index) => {
    assert.ok(Math.abs(value - expected[index]) <= 2, `${label}: ${JSON.stringify({ actual, expected })}`);
  });

test("BiRefNet raw logits are consumed as-is by default", async () => {
  const { result, log } = await runThirds();
  assert.equal(result.provider, "wasm");
  assert.deepEqual(result.size, [120, 80]);
  // Raw [-2, 0, 2]: the rejected single-sigmoid rendering would give [30, 128, 225] here.
  closeTo(result.alpha, [0, 0, 255], "default thirds");
  assert.equal(select(log, { type: "sigmoid" }).length, 0);
  assert.equal(result.provenance.renderPolicy, "cutout-original-matte-v1");
  assert.equal(result.provenance.rawOutputSemantics, "logits");
  // Tensor ownership: every processor input and the one successful output are disposed, nothing else.
  assert.equal(disposals(log, "pixel_values"), select(log, { type: "run", phase: "processor" }).length);
  assert.equal(disposals(log, "output_image"), 1);
  assert.equal(disposals(log, "sigmoid-result"), 0);
});

test("invalid BiRefNet logits still reach the engine non-finite mask error", async () =>
  withFakePage({ page: { mask: (c, h) => h.nonFinite(c) } }, async (page) => {
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts?biref-invalid-contract");
      const source = await window.__fx.gradientPhoto({ subject: false });
      try {
        await removeBackgroundLocal(source, { mode: "quick" });
        return { resolved: true };
      } catch (error) {
        return {
          resolved: false,
          name: error.name,
          message: error.message,
          record: localStorage.getItem("cutout:removal-webgpu-failure:v1"),
        };
      }
    });
    assert.deepEqual(result, {
      resolved: false,
      name: "MaskError",
      message: "The model returned an invalid alpha mask",
      record: null,
    });
    const log = await readFakeLog(page);
    // The adapter rejects the non-finite output, the engine maps it to the retryable MaskError, and
    // the one compatibility attempt reuses the same BiRefNet/WASM engine: two runs, one load.
    assert.equal(modelRuns(log), 2);
    assert.equal(select(log, { type: "from_pretrained", kind: "model" }).length, 1);
    assert.equal(disposals(log, "output_image"), 2);
    assert.equal(disposals(log, "pixel_values"), 2);
  }));

for (const kind of ["small cutout", "sparse high-resolution cutout", "translucent overlay"]) {
  test(`removal preserves the existing alpha of a ${kind}`, async () =>
    // Given intentional alpha and a fake model that must not be needed.
    withFakePage({}, async (page) => {
      const result = await page.evaluate(async (kind) => {
        const { removeBackgroundLocal } = await import("/src/lib/engine.ts?alpha-regression");
        const size = kind === "sparse high-resolution cutout" ? 960 : 96;
        const translucent = kind === "translucent overlay";
        const source = await window.__fx.blob(size, size, (ctx) => {
          ctx.fillStyle = translucent ? "rgba(120, 60, 20, 0.5)" : "#783c14";
          if (translucent) ctx.fillRect(0, 0, size, size);
          else ctx.fillRect(size / 2 - 3, size / 2 - 3, 6, 6);
        });
        // When removing its background through the real engine entry point.
        const cut = await removeBackgroundLocal(source);
        const [center, corner] = await window.__fx.alphaAt(cut.blob, [
          [size / 2, size / 2],
          [0, 0],
        ]);
        return { method: cut.method, center, corner };
      }, kind);
      // Then source coverage survives, without any model load.
      const log = await readFakeLog(page);
      assert.equal(select(log, { type: "from_pretrained" }).length, 0);
      assert.equal(select(log, { type: "run" }).length, 0);
      assert.equal(result.method, "passthrough");
      assert.equal(result.center, kind === "translucent overlay" ? 128 : 255);
      assert.equal(result.corner, kind === "translucent overlay" ? 128 : 0);
    }));
}

test("a successful compatibility result survives failed preferred-engine preparation", async () =>
  // Given a preferred provider that fails to load and a successful WASM fallback.
  withFakePage(
    {
      adapter: true,
      page: {
        mask: (c, h) => h.rect(c, { x0: 40, y0: 30, x1: 52, y1: 50, inside: 20, outside: -20 }),
        load: async (c) => {
          if (c.kind === "model" && c.device === "webgpu") throw new Error("WebGPU device lost");
        },
      },
    },
    async (page) => {
      const result = await page.evaluate(async () => {
        const { removeBackgroundLocal } = await import("/src/lib/engine.ts?retry-regression");
        const { removalRuntime } = await import("/src/lib/removal-runtime.ts");
        const source = await window.__fx.gradientPhoto();
        const messages = [];
        // When the real engine recovers from the preparation failure.
        try {
          const cut = await removeBackgroundLocal(source, {
            onProgress: (progress) => messages.push(progress.message),
          });
          const [alpha] = await window.__fx.alphaAt(cut.blob, [[46, 40]]);
          return {
            provider: cut.provider,
            alpha,
            messages,
            record: localStorage.getItem("cutout:removal-webgpu-failure:v1"),
            compat: removalRuntime.provenance()?.compat,
          };
        } catch (error) {
          return { error: error.message, messages };
        }
      });
      // Then keep the successful matte after exactly one failed WebGPU load and one WASM load.
      const log = await readFakeLog(page);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.provider, "wasm");
      assert.equal(select(log, { type: "from_pretrained", kind: "model", device: "webgpu" }).length, 1);
      assert.equal(select(log, { type: "from_pretrained", kind: "model", device: "wasm" }).length, 1);
      assert.equal(select(log, { type: "from_pretrained", kind: "processor" }).length, 2);
      assert.ok(result.messages.includes("Switching to compatibility mode"), JSON.stringify(result.messages));
      assert.equal(result.record, null, "a lost device at load is not a stored GPU failure");
      assert.equal(result.compat?.attempted, true);
      assert.ok(result.alpha > 240);
    },
  ));

test("lossless logo removal retains faint coverage on off-white paper", async () => {
  const browser = await launchChrome();
  const page = await browser.newPage();
  try {
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts?offwhite-regression");
      // Given a 6% anti-aliased ink edge over off-white paper.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fafafa";
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = "#323232";
      ctx.fillRect(32, 32, 32, 32);
      ctx.fillStyle = "#eeeeee";
      ctx.fillRect(31, 32, 1, 32);
      const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      // When routing through real decoding, graphics classification and WASM keying.
      const cut = await removeBackgroundLocal(source);
      const bitmap = await createImageBitmap(cut.blob);
      ctx.clearRect(0, 0, 96, 96);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        method: cut.method,
        edge: ctx.getImageData(31, 48, 1, 1).data[3],
        center: ctx.getImageData(48, 48, 1, 1).data[3],
        paper: ctx.getImageData(0, 0, 1, 1).data[3],
      };
    });
    // Then preserve known coverage and remove the paper.
    assert.equal(result.method, "logo");
    assert.ok(Math.abs(result.edge - 15) <= 1, JSON.stringify(result));
    assert.equal(result.center, 255);
    assert.equal(result.paper, 0);
  } finally {
    await browser.close();
  }
});

// ---- C4 (b): raw-domain empty-recovery ordering --------------------------------------------
//
// Source: a photo of a shaded subject (x 30-90, y 15-65) on a flat field, so the flood can recover
// it and a wrong order is visible as 255. All rows use `quick` (fast transfer, no crops: exactly
// one model run) with raw BiRefNet values, which the default policy consumes unchanged.
//
// Calibration (design: "values calibrated against the unchanged finishing"): this author could
// not run a browser, so b1 is built from the engine's own thresholds instead of a measured
// number. With the fast transfer a raw 0.18 renders alpha 10: above the raw-empty test (> 8 at the
// stride-61 sample) and below the finished-empty test (> 16 on the 96x96 probe) while finishing
// leaves a flat plateau of 10 untouched. If the first run shows finishing lifted it above 16, the
// row fails with the measured value; pin that value here (and move the plateau down) then.
const SUBJECT = [[60, 40]];
const FIELD = [[2, 2]];

async function recoverRow(options, source, mode = "quick", points = { subject: SUBJECT, field: FIELD }) {
  return withFakePage(options, async (page) => {
    const result = await page.evaluate(
      async ({ source, mode, subject, field }) => {
        const { removeBackgroundLocal } = await import("/src/lib/engine.ts?c4-b");
        const blob = await window.__fx[source.name](...source.args);
        // An engine throw is returned as data so the row fails on an assertion, not on a page.evaluate exception.
        let cut;
        try {
          cut = await removeBackgroundLocal(blob, { mode });
        } catch (error) {
          return { error: `${error?.name}: ${error?.message}` };
        }
        return {
          method: cut.method,
          subject: await window.__fx.alphaAt(cut.blob, subject),
          field: await window.__fx.alphaAt(cut.blob, field),
        };
      },
      { source, mode, ...points },
    );
    assert.equal(result.error, undefined, `the job resolves: ${result.error}`);
    return { result, log: await readFakeLog(page) };
  });
}

test("C4 b1 finished-empty with a nonempty raw cut returns the raw rescue, not the flood", async () => {
  const { result, log } = await recoverRow(
    { page: { mask: (c, h) => h.rect(c, { x0: 30, y0: 15, x1: 90, y1: 65, inside: 0.18, outside: 0 }) } },
    { name: "floodable", args: [] },
  );
  assert.equal(result.method, "model");
  // The raw cut's alpha (fast transfer of 0.18, about 10), not the flood's 255; background stays clear.
  assert.ok(Math.abs(result.subject[0] - 10) <= 1, `raw rescue alpha: ${JSON.stringify(result)}`);
  assert.equal(result.field[0], 0);
  assert.equal(modelRuns(log), 1, "rescue costs no extra model run");
});

test("C4 b2 raw-empty falls back to the flood", async () => {
  // Raw 0.06 is not flat (>= 0.05) but renders alpha 0 under the fast transfer.
  const { result, log } = await recoverRow({ page: { mask: () => 0.06 } }, { name: "floodable", args: [] });
  assert.equal(result.method, "flood");
  assert.equal(result.subject[0], 255);
  assert.equal(result.field[0], 0);
  assert.equal(modelRuns(log), 1);
});

// C4 b3 dropped: graphics after a failed flood is unreachable (same deterministic probe); W3-architect-decisions-G4-v1.md (c)

test("C4 b4 raw-empty, flood and graphics fail: the finished empty blob is returned without throwing", async () => {
  // A uniform field: the flood clears every pixel (so it declines), and nothing classifies as art.
  const { result, log } = await recoverRow(
    { page: { mask: () => 0.06 } },
    { name: "flat", args: [120, 80, "#808890"] },
  );
  assert.equal(result.method, "model");
  assert.equal(result.subject[0], 0);
  assert.equal(result.field[0], 0);
  assert.equal(modelRuns(log), 1);
});

// E01-O-02: both empty checks are fractions of the frame, so a subject the model found but that
// fills under 0.8 % of it was replaced by the border flood, which on a textured field keeps most of
// the photo. Points: the subject's centre, a corner and the open field below it.
const SMALL = { subject: [[420, 315]], field: [[2, 2], [100, 500], [700, 100]] };

test("C4 b5 a solid subject under 0.8 % of the frame keeps the model's cut, not the flood (E01-O-02)", async () => {
  const { result, log } = await recoverRow(
    { page: { mask: (c, h) => h.rect(c, { x0: 400, y0: 300, x1: 440, y1: 330, inside: 20, outside: -20 }) } },
    { name: "smallSubjectPhoto", args: [] },
    "quick",
    SMALL,
  );
  assert.equal(result.method, "model");
  assert.ok(result.subject[0] >= 240, `subject kept: ${JSON.stringify(result)}`);
  assert.deepEqual(result.field, [0, 0, 0], `background cleared: ${JSON.stringify(result)}`);
  assert.equal(modelRuns(log), 1);
});

test("C4 b5 control: an empty mask on the same photo still takes the flood", async () => {
  const { result } = await recoverRow({ page: { mask: () => -20 } }, { name: "smallSubjectPhoto", args: [] }, "quick", SMALL);
  assert.equal(result.method, "flood");
});

test("C4 b5 control: a weak tiny matte still takes the flood", async () => {
  const { result, log } = await recoverRow(
    { page: { mask: (c, h) => h.rect(c, { x0: 400, y0: 300, x1: 440, y1: 330, inside: 0.65, outside: 0 }) } },
    { name: "smallSubjectPhoto", args: [] },
    "quick",
    SMALL,
  );
  assert.equal(result.method, "flood");
  assert.equal(modelRuns(log), 1);
});

test("C4 b5 control: a confident raw core erased by cleaning still takes the flood", async () => {
  await withFakePage({ page: { mask: (c, h) => {
    const box = h.rect(c, { x0: 400, y0: 300, x1: 440, y1: 330, inside: 1, outside: 0 });
    return (u, v) => box(u, v) && Math.floor(u * c.side) % 2 === 0 ? 1 : 0;
  } } }, async (page) => {
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts?cleaned-core");
      const source = await window.__fx.smallSubjectPhoto();
      const encode = HTMLCanvasElement.prototype.toBlob;
      let cleaned;
      HTMLCanvasElement.prototype.toBlob = function (...args) {
        if (!cleaned && this.width === 800 && this.height === 600) {
          const data = this.getContext("2d").getImageData(0, 0, 800, 600).data;
          cleaned = { solid: 0, visible: 0 };
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] >= 239) cleaned.solid++;
            if (data[i] > 16) cleaned.visible++;
          }
        }
        return encode.apply(this, args);
      };
      try {
        const cut = await removeBackgroundLocal(source, { mode: "quick" });
        return { method: cut.method, cleaned };
      } finally { HTMLCanvasElement.prototype.toBlob = encode; }
    });
    assert.ok(result.cleaned.visible > 0 && result.cleaned.solid < 800 * 600 / 2048, JSON.stringify(result));
    assert.equal(result.method, "flood");
    assert.equal(modelRuns(await readFakeLog(page)), 1);
  });
});

// ---- Crops consume raw scores (contract-r2 #3) ------------------------------------------------

async function runCrops() {
  return withFakePage({ page: { mask: smallSubjectThenAll } }, async (page) => {
    const result = await page.evaluate(async () => {
      const { removeBackgroundLocal, refineWithUserCrops } = await import("/src/lib/engine.ts?raw-crops");
      const { removalRuntime } = await import("/src/lib/removal-runtime.ts");
      const source = await window.__fx.gradientPhoto();
      const removed = await removeBackgroundLocal(source, {});
      const provenance = () => (typeof removalRuntime.provenance === "function" ? removalRuntime.provenance() : undefined);
      const auto = provenance();
      // Event `seq` is exact on one page; wall-clock `t` could overshoot inside one clock tick.
      const marker = globalThis.__fakeTfClock.seq;
      const boxes = [
        { x: 0.3, y: 0.3, width: 0.2, height: 0.3 },
        { x: 0.6, y: 0.2, width: 0.2, height: 0.3 },
      ];
      await refineWithUserCrops(source, removed.blob, boxes, {});
      return { auto, manual: provenance(), marker };
    });
    const log = await readFakeLog(page);
    return {
      result,
      automatic: log.filter((event) => event.seq <= result.marker),
      manual: log.filter((event) => event.seq > result.marker),
    };
  });
}

test("crops: the global pass and every automatic and manual crop consume raw scores, no sigmoid", async () => {
  const { result, automatic, manual } = await runCrops();
  const { auto, manual: refined } = result;
  assert.equal(select(automatic, { type: "sigmoid" }).length, 0);
  assert.equal(select(manual, { type: "sigmoid" }).length, 0);
  assert.ok(auto, "removalRuntime.provenance() records the job (S5)");
  assert.ok(refined, "removalRuntime.provenance() records the job (S5)");
  assert.ok(auto.cropInferences >= 1);
  for (const record of [auto, refined]) assert.equal(record.renderPolicy, "cutout-original-matte-v1");
  assert.equal(modelRuns(manual), refined.cropInferences);
});
