// The edit pipeline's preview economics, measured in a real browser. These replace unit
// tests that matched source text in editor/preview.ts, canvas.ts, render.ts and
// quality-live.ts (F-TEST-05). Imports modules from /src, so it needs the Vite dev server.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";

const url = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const base = url.replace(/\/$/, "");

let browser, page;
before(async () => {
  browser = await launchChrome();
  page = await browser.newPage();
  // Count every bitmap the pipeline creates, and how many are larger than the preview cap.
  await page.addInitScript(() => {
    const create = window.createImageBitmap;
    window.__bitmaps = { all: 0, big: 0 };
    window.createImageBitmap = async (...args) => {
      const bitmap = await create(...args);
      window.__bitmaps.all += 1;
      if (Math.max(bitmap.width, bitmap.height) > 1600) window.__bitmaps.big += 1;
      return bitmap;
    };
  });
  await page.goto(e2eUrl(url));
  await page.evaluate(async (base) => {
    window.pipeline = {
      canvas: await import(`${base}/src/lib/editor/canvas.ts`),
      render: await import(`${base}/src/lib/editor/render.ts`),
      quality: await import(`${base}/src/lib/editor/quality-live.ts`),
      model: await import(`${base}/src/lib/editor/model.ts`),
    };
    /** A fresh 3200×1600 cutout (opaque block on transparency) and its source file. */
    window.cutout = async () => {
      const c = new OffscreenCanvas(3200, 1600);
      const x = c.getContext("2d");
      x.fillStyle = "#222";
      x.fillRect(800, 400, 1600, 800);
      const result = await c.convertToBlob({ type: "image/png" });
      x.globalCompositeOperation = "destination-over";
      x.fillStyle = "#8ac";
      x.fillRect(0, 0, 3200, 1600);
      const source = new File([await c.convertToBlob({ type: "image/png" })], "big.png", {
        type: "image/png",
      });
      return { result, source };
    };
    /** Alpha along the middle row of a matte, and its size. */
    window.row = async (matte) => {
      const { bitmap, owned } = await window.pipeline.canvas.matteBitmap(matte);
      const c = new OffscreenCanvas(bitmap.width, bitmap.height);
      const x = c.getContext("2d");
      x.drawImage(bitmap, 0, 0);
      if (owned) bitmap.close();
      const data = x.getImageData(0, Math.floor(c.height / 2), c.width, 1).data;
      const alpha = [];
      for (let i = 3; i < data.length; i += 4) alpha.push(data[i]);
      return { width: c.width, height: c.height, alpha };
    };
    window.ramp = (alpha) => alpha.filter((a) => a > 12 && a < 243).length;
  }, base);
});
after(async () => {
  await browser?.close();
});

test("the live preview mattes a copy capped at 1600 px, with feather and choke scaled to it", async () => {
  const report = await page.evaluate(async () => {
    const { canvas, model } = window.pipeline;
    const settings = { ...model.defaults, feather: 8, choke: 2 };
    const full = await window.row(
      await canvas.editedMatte(
        (await window.cutout()).result,
        (await window.cutout()).source,
        settings,
      ),
    );
    const input = await window.cutout();
    const capped = await window.row(
      await canvas.editedMatte(input.result, input.source, settings, {
        maxSide: canvas.MATTE_PREVIEW_MAX,
      }),
    );
    const aborted = new AbortController();
    aborted.abort();
    let abortName = "resolved";
    try {
      await canvas.editedMatte(
        input.result,
        input.source,
        { ...settings, feather: 9 },
        {
          maxSide: canvas.MATTE_PREVIEW_MAX,
          signal: aborted.signal,
        },
      );
    } catch (error) {
      abortName = error.name;
    }
    return {
      cap: canvas.MATTE_PREVIEW_MAX,
      full: [full.width, full.height, window.ramp(full.alpha)],
      capped: [capped.width, capped.height, window.ramp(capped.alpha)],
      abortName,
    };
  });
  assert.equal(report.cap, 1600);
  assert.deepEqual(report.full.slice(0, 2), [3200, 1600]);
  assert.deepEqual(report.capped.slice(0, 2), [1600, 800], "the preview matte is capped");
  assert.ok(report.full[2] > 4, `feather softens the full-size edge: ${report.full}`);
  // Scaled by the same ratio as the pixels, the soft edge looks the same in the preview.
  assert.ok(
    Math.abs(report.capped[2] - report.full[2] / 2) <= 2,
    `capped ramp ${report.capped[2]} vs full ${report.full[2]}`,
  );
  assert.equal(report.abortName, "AbortError", "a superseded preview can be aborted");
});

test("a tight matte takes its bounds from the edge pass instead of decoding again", async () => {
  const report = await page.evaluate(async () => {
    const { canvas, model } = window.pipeline;
    const settings = { ...model.defaults, feather: 4 };
    const count = async (tight) => {
      const { result, source } = await window.cutout();
      const before = window.__bitmaps.all;
      const matte = await canvas.editedMatte(result, source, settings, { tight });
      return { decodes: window.__bitmaps.all - before, bounds: matte.bounds };
    };
    return { loose: await count(false), tight: await count(true) };
  });
  assert.ok(
    report.tight.decodes <= report.loose.decodes,
    `tight ${report.tight.decodes} decodes, loose ${report.loose.decodes}`,
  );
  const { x, y, width, height } = report.tight.bounds;
  assert.ok(Math.abs(x - 800) <= 8 && Math.abs(y - 400) <= 8, JSON.stringify(report.tight.bounds));
  assert.ok(Math.abs(width - 1600) <= 16 && Math.abs(height - 800) <= 16);
  assert.deepEqual(report.loose.bounds, { x: 0, y: 0, width: 3200, height: 1600 });
});

test("preview renders pass the matte cap through and keep the original frame untrimmed", async () => {
  const report = await page.evaluate(async () => {
    const { render, canvas, model } = window.pipeline;
    const run = async (settings, options) => {
      const { result, source } = await window.cutout();
      const before = window.__bitmaps.big;
      const out = await render.renderCanvas({ result, source, settings }, options);
      const x = out.getContext("2d").getImageData(0, Math.floor(out.height / 2), out.width, 1).data;
      const alphaAt = (fx) => x[Math.round(fx * out.width) * 4 + 3];
      return {
        size: [out.width, out.height],
        big: window.__bitmaps.big - before,
        edge: [alphaAt(0.24), alphaAt(0.26)],
      };
    };
    const settings = { ...model.defaults, feather: 6 };
    return {
      capped: await run(settings, { maxSide: 1200, matteMaxSide: canvas.MATTE_PREVIEW_MAX }),
      uncapped: await run(settings, { maxSide: 1200 }),
    };
  });
  assert.deepEqual(report.capped.size, [1200, 600], "original preset keeps the whole frame");
  assert.ok(
    report.capped.big < report.uncapped.big,
    `capped preview made ${report.capped.big} full-size bitmaps, uncapped ${report.uncapped.big}`,
  );
  const [outside, inside] = report.capped.edge;
  assert.ok(
    outside < 40 && inside > 200,
    `the subject stays where it was in the frame: ${report.capped.edge}`,
  );
});

test("the quality probe reads the capped, untrimmed matte", async () => {
  const report = await page.evaluate(async () => {
    const { quality, model } = window.pipeline;
    const { result, source } = await window.cutout();
    const before = window.__bitmaps.big;
    const alpha = await quality.editedAlpha(result, source, { ...model.defaults, feather: 5 });
    return { width: alpha.width, height: alpha.height, big: window.__bitmaps.big - before };
  });
  assert.deepEqual([report.width, report.height], [256, 128], "full frame, not the subject");
  assert.ok(report.big <= 1, `the probe decoded ${report.big} full-size bitmaps`);
});
