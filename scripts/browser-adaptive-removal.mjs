import assert from "node:assert/strict";
import test from "node:test";
import { launchChrome } from "./chrome.mjs";
import { installFake, readFakeLog, select } from "./fake-transformers.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout([process.env.DEV_URL ?? "http://127.0.0.1:8080/"]);

// `init` runs before navigation: routes and init scripts registered after `goto` would be too late.
async function withPage(run, init) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await init?.(page);
    await page.goto(appUrl);
    return await run(page);
  } finally {
    await browser.close();
  }
}

// The real adapter, runtime and engine run; only Transformers.js is faked. No adapter plus 8 GB is
// the BiRefNet/WASM route, so the headless GPU never decides it.
const fakeBoundary = (page) => installFake(page, { deviceMemory: 8, adapter: false });

test("adaptive refinement crops a small subject and merges the refined pixels", async () =>
  withPage(async (page) => {
    const result = await page.evaluate(async (base) => {
      const { refineRemoval } = await import(`${base}/src/lib/background-refine.ts`);
      const make = async (cutout) => {
        const canvas = document.createElement("canvas");
        canvas.width = 120;
        canvas.height = 80;
        const ctx = canvas.getContext("2d");
        if (!cutout) {
          ctx.fillStyle = "#2468ac";
          ctx.fillRect(0, 0, 120, 80);
        }
        ctx.fillStyle = "#d02020";
        ctx.fillRect(20, 25, 12, 20);
        if (cutout) {
          ctx.globalCompositeOperation = "destination-in";
          ctx.fillStyle = "#fff";
          ctx.fillRect(20, 25, 12, 20);
        }
        return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      };
      const source = await make(false),
        initial = await make(true);
      let cropSize = null;
      const refined = await refineRemoval(source, initial, {
        maxCrops: 1,
        infer: async (crop) => {
          const bitmap = await createImageBitmap(crop);
          cropSize = [bitmap.width, bitmap.height];
          bitmap.close();
          return crop;
        },
      });
      const bitmap = await createImageBitmap(refined.blob),
        canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        cropSize,
        refinements: refined.refinements,
        components: refined.diagnostics.components,
        // The crop's rim is feathered into the base, so sample the subject's
        // centre and a point outside the crop entirely.
        inside: ctx.getImageData(26, 35, 1, 1).data[3],
        outside: ctx.getImageData(2, 2, 1, 1).data[3],
      };
    }, appUrl);
    assert.deepEqual(result.cropSize, [22, 36]);
    assert.equal(result.refinements, 1);
    assert.equal(result.components, 1);
    assert.equal(result.inside, 255);
    assert.equal(result.outside, 0);
  }));

test("adaptive refinement preserves the global result when optional crop inference declines", async () =>
  withPage(async (page) => {
    const result = await page.evaluate(async (base) => {
      const { refineRemoval } = await import(`${base}/src/lib/background-refine.ts`);
      const canvas = document.createElement("canvas");
      canvas.width = 100;
      canvas.height = 100;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(45, 45, 10, 10);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const refined = await refineRemoval(blob, blob, { maxCrops: 1, infer: async () => null });
      return { same: refined.blob === blob, refinements: refined.refinements };
    }, appUrl);
    assert.deepEqual(result, { same: true, refinements: 0 });
  }));

test("adaptive refinement rejects an empty local mask", async () =>
  withPage(async (page) => {
    const result = await page.evaluate(async (base) => {
      const { refineRemoval } = await import(`${base}/src/lib/background-refine.ts`);
      const initialCanvas = document.createElement("canvas");
      initialCanvas.width = initialCanvas.height = 100;
      const context = initialCanvas.getContext("2d");
      context.fillStyle = "#fff";
      context.fillRect(45, 45, 10, 10);
      const initial = await new Promise((resolve) => initialCanvas.toBlob(resolve, "image/png"));
      const emptyCanvas = document.createElement("canvas");
      emptyCanvas.width = emptyCanvas.height = 20;
      const empty = await new Promise((resolve) => emptyCanvas.toBlob(resolve, "image/png"));
      const refined = await refineRemoval(initial, initial, {
        maxCrops: 1,
        infer: async () => empty,
      });
      return { same: refined.blob === initial, refinements: refined.refinements };
    }, appUrl);
    assert.deepEqual(result, { same: true, refinements: 0 });
  }));

test("adaptive refinement honors cancellation before allocating image work", async () =>
  withPage(async (page) => {
    const name = await page.evaluate(async (base) => {
      const { refineRemoval } = await import(`${base}/src/lib/background-refine.ts`);
      const controller = new AbortController();
      controller.abort();
      try {
        await refineRemoval(new Blob(), new Blob(), {
          maxCrops: 1,
          signal: controller.signal,
          infer: async () => null,
        });
        return "resolved";
      } catch (error) {
        return error instanceof DOMException ? error.name : "unknown";
      }
    }, appUrl);
    assert.equal(name, "AbortError");
  }));

test("local removal detects uniform noisy fields across RGB bucket boundaries", async () =>
  withPage(async (page) => {
    // Given lossless logo/illustration images and a model that must not be needed.
    const results = await page.evaluate(async (base) => {
      const { removeBackgroundLocal } = await import(`${base}/src/lib/engine.ts`);
      const results = [];
      for (const [kind, paper] of [
        ["logo", [32, 32, 32]],
        ["logo", [224, 224, 224]],
        ["illustration", [32, 160, 224]],
      ]) {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 96;
        const ctx = canvas.getContext("2d");
        const image = ctx.createImageData(96, 96);
        for (let y = 0; y < 96; y += 1)
          for (let x = 0; x < 96; x += 1) {
            const i = (y * 96 + x) * 4;
            image.data[i] = paper[0] + (x % 2 ? 2 : -2);
            image.data[i + 1] = paper[1] + (y % 2 ? 2 : -2);
            image.data[i + 2] = paper[2] + ((x + y) % 2 ? 2 : -2);
            image.data[i + 3] = 255;
          }
        ctx.putImageData(image, 0, 0);
        ctx.fillStyle = kind === "logo" ? "#040404" : "#dc503c";
        ctx.fillRect(24, 24, 48, 48);
        if (kind === "illustration") {
          ctx.fillStyle = `rgb(${paper.join(" ")})`;
          ctx.fillRect(36, 36, 24, 24);
        }
        const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        // When running the real decode/detection/removal/encode pipeline.
        const removed = await removeBackgroundLocal(source);
        const bitmap = await createImageBitmap(removed.blob);
        ctx.clearRect(0, 0, 96, 96);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        results.push({
          expected: kind,
          method: removed.method,
          size: [removed.width, removed.height],
          corner: ctx.getImageData(0, 0, 1, 1).data[3],
          subject: ctx.getImageData(28, 28, 1, 1).data[3],
          enclosed: ctx.getImageData(48, 48, 1, 1).data[3],
        });
      }
      return results;
    }, appUrl);
    // Then fast graphic removal clears the field and keeps ink/enclosed illustration detail,
    // without loading or running any model (graphics and flood keying are zero-model paths).
    const log = await readFakeLog(page);
    assert.equal(select(log, { type: "from_pretrained" }).length, 0);
    assert.equal(select(log, { type: "run" }).length, 0);
    for (const result of results) {
      assert.equal(result.method, result.expected);
      assert.deepEqual(result.size, [96, 96]);
      assert.equal(result.corner, 0);
      assert.equal(result.subject, 255);
      assert.equal(result.enclosed, 255);
    }
  }, fakeBoundary));

test("ink the 96 px probe blurs is keyed on its own pixels, without a model", async () =>
  withPage(async (page) => {
    // Given hard-edged dark ink on white that the bilinear probe smears below the ink threshold:
    // a 95 px ring and bar (upscaled into the probe) and a 240×80 wordmark (squashed into it).
    const results = await page.evaluate(async (base) => {
      const { removeBackgroundLocal } = await import(`${base}/src/lib/engine.ts`);
      const { blurredInk, classifyGraphic } = await import(`${base}/src/lib/graphics.ts`);
      const { resizeBitmap } = await import(`${base}/src/lib/bitmap-resize.ts`);
      const ringBar = (u, v) => {
        const d = Math.hypot(u - 0.5, v - 0.5);
        return (d > 0.28 && d < 0.36) || (Math.abs(u - 0.5) < 0.05 && v > 0.3 && v < 0.7);
      };
      // Five thin-stroked letters (E, H, F, N-ish, L) built from bars.
      const bars = (u, v) => {
        const s = 0.035;
        if (v < 0.3 || v > 0.7) return false;
        return [0.08, 0.26, 0.44, 0.62, 0.8].some((x0, g) => {
          const x1 = x0 + 0.13;
          if (u < x0 || u > x1) return false;
          const left = u < x0 + s,
            right = u > x1 - s,
            top = v < 0.3 + s * 3;
          const bottom = v > 0.7 - s * 3,
            middle = Math.abs(v - 0.5) < s * 1.5;
          return [
            left || top || bottom,
            left || right || middle,
            left || top || middle,
            left || right || top,
            left || bottom,
          ][g];
        });
      };
      const results = [];
      // The ring is hard-edged; the wordmark is anti-aliased (4×4 coverage), as type is.
      for (const [width, height, ink, ss, probe] of [
        [95, 95, ringBar, 1, [48, 48]],
        [240, 80, bars, 4, [24, 40]],
      ]) {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        const image = ctx.createImageData(width, height);
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1) {
            let hits = 0;
            for (let j = 0; j < ss; j += 1)
              for (let i = 0; i < ss; i += 1)
                hits += ink((x + (i + 0.5) / ss) / width, (y + (j + 0.5) / ss) / height) ? 1 : 0;
            const v = Math.round(255 - (247 * hits) / (ss * ss));
            image.data.set([v, v, v, 255], (y * width + x) * 4);
          }
        ctx.putImageData(image, 0, 0);
        const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        // The fixture must exercise the second look: the probe alone would send it to the model.
        const small = await resizeBitmap(source, 96, 96, "low");
        const read = document.createElement("canvas");
        read.width = read.height = 96;
        read.getContext("2d").drawImage(small, 0, 0);
        small.close();
        const pixels = read.getContext("2d").getImageData(0, 0, 96, 96).data;
        // When running the real decode/detection/removal/encode pipeline.
        const removed = await removeBackgroundLocal(source);
        const bitmap = await createImageBitmap(removed.blob);
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        results.push({
          probeKind: classifyGraphic(pixels, 96, 96),
          probeBlurred: blurredInk(pixels, 96, 96),
          method: removed.method,
          size: [removed.width, removed.height],
          corner: ctx.getImageData(0, 0, 1, 1).data[3],
          ink: ctx.getImageData(probe[0], probe[1], 1, 1).data[3],
        });
      }
      return results;
    }, appUrl);
    // Then the file's own pixels make it a logo: the field is cleared and the ink kept, with no model.
    const log = await readFakeLog(page);
    assert.equal(select(log, { type: "from_pretrained" }).length, 0);
    assert.equal(select(log, { type: "run" }).length, 0);
    assert.deepEqual(results, [
      { probeKind: null, probeBlurred: true, method: "logo", size: [95, 95], corner: 0, ink: 255 },
      { probeKind: null, probeBlurred: true, method: "logo", size: [240, 80], corner: 0, ink: 255 },
    ]);
  }, fakeBoundary));

test("a shaded grayscale subject the probe looks at twice still uses model removal", async () =>
  withPage(async (page) => {
    // Given a lit, grainy grayscale sphere on white: achromatic and on a clean field, so the probe
    // asks for a second look, but continuously shaded at any resolution.
    const result = await page.evaluate(async (base) => {
      const { removeBackgroundLocal } = await import(`${base}/src/lib/engine.ts`);
      const { blurredInk } = await import(`${base}/src/lib/graphics.ts`);
      const { resizeBitmap } = await import(`${base}/src/lib/bitmap-resize.ts`);
      const size = 200;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      const image = ctx.createImageData(size, size);
      for (let y = 0; y < size; y += 1)
        for (let x = 0; x < size; x += 1) {
          const i = (y * size + x) * 4;
          const nx = (x + 0.5 - 100) / 64;
          const ny = (y + 0.5 - 100) / 64;
          const d = nx * nx + ny * ny;
          const grain = ((x * 7919 + y * 104729) % 9) - 4;
          const lit =
            35 + 200 * Math.max(0, -0.45 * nx - 0.35 * ny + 0.82 * Math.sqrt(Math.max(0, 1 - d)));
          const v = d < 1 ? Math.round(lit + grain) : 255;
          image.data.set([v, v, v, 255], i);
        }
      ctx.putImageData(image, 0, 0);
      const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const small = await resizeBitmap(source, 96, 96, "low");
      const probe = document.createElement("canvas");
      probe.width = probe.height = 96;
      probe.getContext("2d").drawImage(small, 0, 0);
      small.close();
      const pixels = probe.getContext("2d").getImageData(0, 0, 96, 96).data;
      const probeBlurred = blurredInk(pixels, 96, 96);
      // When running real detection/removal/finishing with optional crops disabled.
      const removed = await removeBackgroundLocal(source, { mode: "quick" });
      return { probeBlurred, method: removed.method };
    }, appUrl);
    // Then the sharper read finds shading, not ink: exactly one model run.
    const calls = select(await readFakeLog(page), { type: "run", phase: "model" }).length;
    assert.deepEqual({ ...result, calls }, { probeBlurred: true, method: "model", calls: 1 });
  }, (page) =>
    installFake(page, {
      deviceMemory: 8,
      adapter: false,
      page: {
        // Source coordinates of the sphere's bounding box; raw BiRefNet logits.
        mask: (c, h) => h.rect(c, { x0: 36, y0: 36, x1: 164, y1: 164, inside: 20, outside: -20 }),
      },
    }),
  ));

test("dark continuous grayscale shading uses model removal and preserves enclosed detail", async () =>
  withPage(async (page) => {
    // Given a model that keeps the subject, including its enclosed white detail (raw logits).
    const result = await page.evaluate(async (base) => {
      const { removeBackgroundLocal } = await import(`${base}/src/lib/engine.ts`);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const ctx = canvas.getContext("2d");
      const image = ctx.createImageData(96, 96);
      image.data.fill(255);
      for (let y = 18; y < 78; y += 1)
        for (let x = 18; x < 78; x += 1) {
          const i = (y * 96 + x) * 4;
          const shade = 20 + Math.floor(((x - 18) * 28) / 60);
          image.data[i] = image.data[i + 1] = image.data[i + 2] = shade;
        }
      ctx.putImageData(image, 0, 0);
      ctx.fillStyle = "white";
      ctx.fillRect(44, 44, 8, 8);
      const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      // When running real detection/removal/finishing with optional crops disabled.
      const removed = await removeBackgroundLocal(source, { mode: "quick" });
      const bitmap = await createImageBitmap(removed.blob);
      ctx.clearRect(0, 0, 96, 96);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return {
        method: removed.method,
        corner: ctx.getImageData(0, 0, 1, 1).data[3],
        enclosed: ctx.getImageData(48, 48, 1, 1).data[3],
      };
    }, appUrl);
    // Then flat-ink keying cannot erase the enclosed detail before inference: exactly one model run.
    const calls = select(await readFakeLog(page), { type: "run", phase: "model" }).length;
    assert.deepEqual(
      { method: result.method, calls, corner: result.corner, enclosed: result.enclosed },
      { method: "model", calls: 1, corner: 0, enclosed: 255 },
    );
  }, (page) =>
    installFake(page, {
      deviceMemory: 8,
      adapter: false,
      page: {
        // Source coordinates 18-78 in both axes; the model output is raw BiRefNet logits.
        mask: (c, h) => h.rect(c, { x0: 18, y0: 18, x1: 78, y1: 78, inside: 20, outside: -20 }),
      },
    }),
  ));
