import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(/\/$/, "");
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { launchChrome } from "./chrome.mjs";

let browser, page;
const url = verifiedAppUrl;
const base = process.env.MODULE_URL ?? verifiedAppUrl;
beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(url);
});
afterEach(async () => {
  await browser?.close();
});

test("cast silhouette preserves the selected background and tints only its own shadow", async () => {
  // Given a coloured plate and an opaque source silhouette.
  const report = await page.evaluate(async (base) => {
    const { paintShadow } = await import(`${base}/src/lib/editor/shadow.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(0, 0, 128, 128);
    const mask = document.createElement("canvas");
    mask.width = mask.height = 32;
    const m = mask.getContext("2d");
    m.fillStyle = "#ff0000";
    m.fillRect(0, 0, 32, 32);
    // When a blue cast shadow is painted over the plate.
    paintShadow(
      ctx,
      { x: 48, y: 32, width: 32, height: 32 },
      128,
      {
        ...defaults,
        shadow: true,
        shadowKind: "cast",
        shadowColor: "#0000ff",
        shadowOpacity: 100,
        shadowDistance: 0,
        shadowSoftness: 0,
        shadowSpread: 0,
        shadowPerspective: 0,
      },
      mask,
    );
    return {
      corner: [...ctx.getImageData(0, 0, 1, 1).data],
      shadow: [...ctx.getImageData(64, 60, 1, 1).data],
      operation: ctx.globalCompositeOperation,
    };
  }, base);
  // Then the background remains opaque and only the shadow takes the chosen tint.
  assert.deepEqual(report.corner, [18, 52, 86, 255]);
  assert.ok(report.shadow[2] > 200 && report.shadow[0] < 30, JSON.stringify(report));
  assert.equal(report.operation, "source-over");
});

test("export quality checks framed output instead of source edges", async () => {
  // Given a subject touching the source edge.
  const report = await page.evaluate(async (base) => {
    const { inspectEditedQuality } = await import(`${base}/src/lib/editor/quality-live.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#111111";
    ctx.fillRect(0, 0, 48, 48);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const source = new File([blob], "edge.png", { type: "image/png" });
    // When a product preset frames it with padding, and a shifted original clips it.
    const framed = await inspectEditedQuality(
      blob,
      source,
      { ...defaults, preset: "product", exportWidth: 96, exportHeight: 96, padding: 20 },
      96,
      96,
    );
    const clipped = await inspectEditedQuality(
      blob,
      source,
      {
        ...defaults,
        preset: "product",
        exportWidth: 96,
        exportHeight: 96,
        padding: 20,
        scale: 200,
      },
      96,
      96,
    );
    return { framed: framed.map((issue) => issue.id), clipped: clipped.map((issue) => issue.id) };
  }, base);
  // Then padding clears the edge warning and actual clipping still warns.
  assert.ok(!report.framed.includes("edge"), JSON.stringify(report));
  assert.ok(report.clipped.includes("edge"), JSON.stringify(report));
});

test("depth estimation converts HEIC before model inference and caches the converted result", async () => {
  // Given a real 128x64 HEIC fixture and the real Transformers RawImage decoder.
  const fixture =
    "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABwm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5WlwcnAAAADEaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAACAAAAAQAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABwaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAiQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcI+Ie5FlU3AgIGAIKIAAQAJRAHAYXLIQFMkAAAAGWlwbWEAAAAAAAAAAQABBoECAwWGhAAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAJCAAAAOQACAAAAAQAAAfYAAABMAAAAAW1kYXQAAAAAAAAAlQAAAAZFeGlmAABNTQAqAAAACAADARoABQAAAAEAAAAyARsABQAAAAEAAAA6ASgAAwAAAAEAAgAAAAAAAAAAAEgAAAABAAAASAAAAAEAAAA1KAGvo09GxX//FPv/79JyHsHtjPlKiepXv/3p3/8gMn86Jn//Q1tf6eSv0EqAPm4HCZjiqPw=";
  // Only the downloaded model is replaced: conversion and RawImage remain real.
  await page.route("**/src/lib/transformers.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    import * as tf from '/node_modules/.vite/deps/@huggingface_transformers.js';
    export function transformers() { return { ...tf, pipeline: async () => async image => {
      window.depthCalls = (window.depthCalls ?? 0) + 1;
      return { depth: { width: image.width, height: image.height, data: new Uint8Array(image.width * image.height).fill(128) } };
    } }; }
  `,
    }),
  );
  // When depth is requested twice for the same original file.
  const report = await page.evaluate(
    async ({ base, fixture }) => {
      const { depthOf } = await import(`${base}/src/lib/editor/depth.ts`);
      const bytes = Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0));
      const source = new File([bytes], "phone.heic", { type: "image/heic" });
      const first = await depthOf(source);
      const second = await depthOf(source);
      return {
        width: first.width,
        height: first.height,
        value: first.data[0],
        same: first === second,
        calls: window.depthCalls,
      };
    },
    { base, fixture },
  );
  // Then the original format is accepted once, with a cached map at its decoded dimensions.
  assert.deepEqual(
    { ...report, value: undefined },
    { width: 128, height: 64, value: undefined, same: true, calls: 1 },
  );
  assert.ok(Math.abs(report.value - 128 / 255) < 0.0001);
});

test("Auto edge decontamination respects zero and full Amount in rendered pixels", async () => {
  // Given a half-alpha warm edge with a white automatic backdrop estimate.
  const report = await page.evaluate(async (base) => {
    const { renderCanvas } = await import(`${base}/src/lib/editor/render.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray([200, 160, 130, 128, 255, 255, 255, 32]), 2, 1),
      0,
      0,
    );
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const source = new File([blob], "fringe.png", { type: "image/png" });
    const output = {};
    // When the output is rendered at Off, Auto zero and Auto full Amount.
    for (const [name, mode, amount] of [
      ["off", "off", 0],
      ["zero", "auto", 0],
      ["full", "auto", 100],
    ]) {
      const view = await renderCanvas({
        result: blob,
        source,
        settings: { ...defaults, decontaminate: mode, decontaminateAmount: amount },
      });
      output[name] = [...view.getContext("2d").getImageData(0, 0, 1, 1).data];
      view.width = view.height = 0;
    }
    return output;
  }, base);
  // Then zero is unchanged while full strength removes the white contribution.
  assert.deepEqual(report.zero, report.off, JSON.stringify(report));
  assert.ok(
    report.full[0] < report.zero[0] - 30 && report.full[2] < report.zero[2] - 80,
    JSON.stringify(report),
  );
  assert.equal(report.full[3], report.zero[3]);
});

async function uploadGraphic() {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = "black";
    ctx.fillRect(24, 24, 48, 48);
    return canvas.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "advanced.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace?.getState().items[0]?.status === "done");
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
}
async function setSlider(label, value) {
  const slider = page.getByRole("slider", { name: label, exact: true });
  await slider.fill(String(value));
}
async function settings() {
  return page.evaluate(() => {
    const s = window.__cutoutTest?.useWorkspace.getState();
    return s.settings[s.activeId];
  });
}

test("advanced controls apply shadow, colours, edge cleanup, matching and reset through the app", async () => {
  // Given a real uploaded graphic and the open Adjust panel.
  await uploadGraphic();
  await page.getByText("Shadow", { exact: true }).click();
  await page.getByLabel("Add a shadow", { exact: true }).check();
  await page.getByLabel("Shadow kind", { exact: true }).selectOption("cast");
  // When the cast shadow controls are changed through their visible inputs.
  await setSlider("Shadow opacity", 60);
  await setSlider("Shadow softness", 12);
  await setSlider("Shadow distance", 8);
  await setSlider("Direction", 120);
  await setSlider("Spread", 15);
  await setSlider("Perspective", 60);
  await page.getByLabel("Use subject silhouette", { exact: true }).uncheck();
  let s = await settings();
  // Then every control reaches the active image's settings.
  for (const [field, expected] of Object.entries({
    shadow: true,
    shadowKind: "cast",
    shadowOpacity: 60,
    shadowSoftness: 12,
    shadowDistance: 8,
    shadowAngle: 120,
    shadowSpread: 15,
    shadowPerspective: 60,
    shadowSilhouette: false,
  }))
    assert.equal(s[field], expected, field);
  await page.getByLabel("Use subject silhouette", { exact: true }).check();
  await page.getByLabel("Shadow kind", { exact: true }).selectOption("contact");
  assert.equal(await page.getByRole("slider", { name: "Direction", exact: true }).count(), 0);
  await page.getByLabel("Add a shadow", { exact: true }).uncheck();
  assert.equal((await settings()).shadow, false);

  await page.getByText("Edge colour", { exact: true }).click();
  await page.getByLabel("Decontaminate edge colour", { exact: true }).selectOption("manual");
  await setSlider("Amount", 80);
  await setSlider("Edge width", 9);
  await page.getByLabel("Decontaminate colour", { exact: true }).fill("#00ff00");
  s = await settings();
  assert.equal(s.decontaminate, "manual");
  assert.equal(s.decontaminateAmount, 80);
  assert.equal(s.decontaminateWidth, 9);
  assert.equal(s.decontaminateColor, "#00ff00");
  await page.getByLabel("Decontaminate edge colour", { exact: true }).selectOption("auto");
  await setSlider("Amount", 0);
  assert.equal((await settings()).decontaminateAmount, 0);
  await page.getByLabel("Decontaminate edge colour", { exact: true }).selectOption("off");

  await page.getByText("Match background", { exact: true }).click();
  await page.getByLabel("Match subject colour to the background", { exact: true }).check();
  await setSlider("Strength", 35);
  assert.equal((await settings()).matchStrength, 35);
  await page.getByRole("button", { name: "White", exact: true }).click();
  await page.getByLabel("Match subject colour to the background", { exact: true }).uncheck();
  assert.equal((await settings()).matchBackground, false);

  await page.getByText("Colours", { exact: true }).click();
  const replace = page.getByLabel("Replace #000000", { exact: true });
  await replace.waitFor();
  await replace.fill("#ff0000");
  assert.equal((await settings()).recolors[0]?.to, "#ff0000");
  await page.getByRole("button", { name: "Reset #000000", exact: true }).click();
  assert.deepEqual((await settings()).recolors, []);
  await page.getByRole("button", { name: "Remove #000000", exact: true }).click();
  assert.equal((await settings()).recolors[0]?.to, null);
  await page.getByRole("button", { name: "Restore #000000", exact: true }).click();
  assert.deepEqual((await settings()).recolors, []);
  await replace.fill("#0000ff");
  await setSlider("Colour tolerance", 60);
  assert.equal((await settings()).recolorTolerance, 60);
  await page.getByRole("button", { name: "Clear colour edits", exact: true }).click();
  assert.deepEqual((await settings()).recolors, []);

  await page.getByText("Framing & presets", { exact: true }).click();
  await page.getByLabel("Export preset", { exact: true }).selectOption("product");
  await setSlider("Padding", 12);
  await setSlider("Horizontal position", 40);
  await setSlider("Vertical position", 60);
  await setSlider("Scale", 120);
  await setSlider("Rotate", 15);
  await page.getByRole("button", { name: "Flip horizontal", exact: true }).click();
  await page.getByLabel("Show centre and thirds guides", { exact: true }).check();
  const framing = await settings();
  assert.equal(framing.padding, 12);
  assert.equal(framing.positionX, 40);
  assert.equal(framing.positionY, 60);
  assert.equal(framing.scale, 120);
  assert.equal(framing.rotate, 15);
  assert.equal(framing.flipX, true);
  assert.equal(await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().showGuides), true);
  await page.getByRole("button", { name: "Reset transform", exact: true }).click();
  s = await settings();
  assert.equal(s.scale, 100);
  assert.equal(s.rotate, 0);
  assert.equal(s.flipX, false);
  await page.getByLabel("Export preset", { exact: true }).selectOption("trim");
  await setSlider("Padding", 20);
  assert.equal((await settings()).trimPadding, 20);

  await page.getByText("Removal", { exact: true }).click();
  for (const mode of ["quick", "maximum", "auto"]) {
    await page.getByLabel("Removal detail", { exact: true }).selectOption(mode);
    assert.equal(await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().removalMode), mode);
  }
  await page.getByLabel("Show areas to check (specks, holes, soft edges)", { exact: true }).check();
  assert.equal(await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().showCheckAreas), true);
});

test("areas to check follow flipped output coordinates", async () => {
  // Given an asymmetric enclosed hole on the left of an otherwise solid subject.
  const areas = await page.evaluate(async (base) => {
    const { inspectCheckAreas } = await import(`${base}/src/lib/editor/quality-live.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#111111";
    ctx.fillRect(16, 16, 64, 64);
    ctx.clearRect(28, 40, 6, 6);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const source = new File([blob], "hole.png", { type: "image/png" });
    // When the subject is flipped horizontally in the output.
    return inspectCheckAreas(blob, source, { ...defaults, flipX: true });
  }, base);
  // Then the hole's check box follows it to the right-hand side.
  const hole = areas.find((area) => area.kind === "hole");
  assert.ok(hole && hole.x > 0.6, JSON.stringify(areas));
});

test("blur and depth-aware settings publish different rendered pixels without downloading a model in the test", async () => {
  // Given a real uploaded graphic and the real image decoder, with only model inference stubbed.
  await page.route("**/src/lib/transformers.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    import * as tf from '/node_modules/.vite/deps/@huggingface_transformers.js';
    export function transformers() { return { ...tf, pipeline: async () => async image => {
      window.depthCalls = (window.depthCalls ?? 0) + 1;
      return { depth: { width: image.width, height: image.height, data: new Uint8Array(image.width * image.height).fill(128) } };
    } }; }
  `,
    }),
  );
  await uploadGraphic();
  const pixels = async () => {
    await page.waitForFunction(() => {
      const s = window.__cutoutTest?.useWorkspace.getState();
      return (
        !s.previewBusy &&
        Boolean(s.previewBitmap || s.previewUrl) &&
        (s.previewBitmap !== window.previousToolBitmap || s.previewUrl !== window.previousToolUrl)
      );
    });
    return page.evaluate(async () => {
      const s = window.__cutoutTest?.useWorkspace.getState();
      const bitmap =
        s.previewBitmap ??
        (await createImageBitmap(await fetch(s.previewUrl).then((response) => response.blob())));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const output = [...ctx.getImageData(0, 0, canvas.width, canvas.height).data];
      if (!s.previewBitmap) bitmap.close();
      canvas.width = canvas.height = 0;
      window.previousToolBitmap = s.previewBitmap;
      window.previousToolUrl = s.previewUrl;
      return output;
    });
  };
  // When the blur amount and then depth-aware toggle are changed through the UI.
  await page.evaluate(() => {
    const s = window.__cutoutTest?.useWorkspace.getState();
    window.previousToolBitmap = s.previewBitmap;
    window.previousToolUrl = s.previewUrl;
  });
  await page.getByRole("button", { name: "Blur", exact: true }).click();
  await setSlider("Blur amount", 30);
  const plain = await pixels();
  await page.getByLabel(/Depth-aware: nearby surfaces stay sharper/).check();
  await page.waitForFunction(() => window.depthCalls > 0);
  const depth = await pixels();
  // Then depth inference is reached and changes the published bitmap while preserving alpha.
  assert.equal((await settings()).blurAmount, 30);
  assert.equal((await settings()).blurDepth, true);
  assert.ok(
    depth.some((channel, index) => channel !== plain[index]),
    "Depth changes rendered pixels",
  );
  assert.equal(depth.length, plain.length);
  assert.ok(depth.every((channel, index) => index % 4 !== 3 || channel === 255));
  await page.getByLabel(/Depth-aware: nearby surfaces stay sharper/).uncheck();
  const restored = await pixels();
  assert.ok(
    restored.every((channel, index) => channel === plain[index]),
    "Disabling depth restores the same plain blur",
  );
});

test("cast silhouettes use subject bounds when the original has transparent margins", async () => {
  // Given identical square subjects, one tightly cropped and one with transparent margins.
  const report = await page.evaluate(async (base) => {
    const { renderCanvas } = await import(`${base}/src/lib/editor/render.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const output = {};
    for (const [name, size, inset] of [
      ["cropped", 48, 0],
      ["padded", 96, 24],
    ]) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#111111";
      ctx.fillRect(inset, inset, 48, 48);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve));
      // When each is framed identically and receives the same cast silhouette.
      const view = await renderCanvas({
        result: blob,
        source: new File([blob], `${name}.png`, { type: "image/png" }),
        settings: {
          ...defaults,
          preset: "product",
          exportWidth: 128,
          exportHeight: 128,
          padding: 20,
          shadow: true,
          shadowKind: "cast",
          shadowOpacity: 80,
          shadowSoftness: 0,
          shadowSpread: 0,
          shadowAngle: 90,
          shadowDistance: 8,
          shadowPerspective: 50,
        },
      });
      output[name] = [...view.getContext("2d").getImageData(64, 105, 1, 1).data];
      view.width = view.height = 0;
    }
    return output;
  }, base);
  // Then transparent source margins cannot shrink the visible cast silhouette.
  assert.ok(report.cropped[3] > 100, JSON.stringify(report));
  // The crop samples a transparent neighbour at its boundary; allow byte rounding.
  assert.ok(Math.abs(report.padded[3] - report.cropped[3]) <= 4, JSON.stringify(report));
});

test("closing Enhance mid-run stops it, and Cancel works while the model is still loading", async () => {
  // Given every model request held unanswered, so each run stays in its first-time load.
  const held = [];
  const loading = new Set();
  page.context().on("requestfinished", (request) => loading.delete(request));
  page.context().on("requestfailed", (request) => loading.delete(request));
  await page.context().route("**/*", (route) => {
    const { hostname, href } = new URL(route.request().url());
    if (hostname === "127.0.0.1" || hostname === "localhost") return route.continue();
    held.push(href);
    if (/swin2sr/i.test(href)) loading.add(route.request());
  });
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = "black";
    ctx.fillRect(24, 24, 48, 48);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const store = window.__cutoutTest.useWorkspace;
    store.getState().receiveFiles([new File([blob], "graphic.png", { type: "image/png" })]);
    while (store.getState().items[0]?.status !== "done")
      await new Promise((resolve) => setTimeout(resolve, 50));
  });
  const dialog = page.getByRole("dialog", { name: "Enhance" });
  const enhancing = () =>
    page.evaluate(() => window.__cutoutTest.useWorkspace.getState().enhancing);
  async function start() {
    await page.getByRole("button", { name: "Enhance", exact: true }).click();
    await dialog.getByRole("button", { name: /^Enhance \d×$/ }).click();
    await page.waitForFunction(
      () => window.__cutoutTest.useWorkspace.getState().enhancing !== null,
    );
    await dialog.getByRole("progressbar", { name: "Enhancing" }).waitFor();
    // The progress UI precedes the lazy import and request. Reach the held download
    // before closing/cancelling, so this exercises the advertised model-load phase.
    const deadline = Date.now() + 15_000;
    while (loading.size === 0) {
      assert.ok(Date.now() < deadline, "Enhance did not reach a pending model request");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const closes = {
    "the Close button": () => dialog.getByRole("button", { name: "Close", exact: true }).click(),
    "the ✕ button": () => dialog.getByRole("button", { name: "Close enhance" }).click(),
    Escape: () => page.keyboard.press("Escape"),
    "a click outside": () => page.mouse.click(8, 450),
  };
  for (const [how, close] of Object.entries(closes)) {
    // When the dialog is closed mid-run.
    await start();
    await close();
    await dialog.waitFor({ state: "hidden" });
    // Then the run stops at once instead of carrying on out of sight.
    await page
      .waitForFunction(() => window.__cutoutTest.useWorkspace.getState().enhancing === null, null, {
        timeout: 1000,
      })
      .catch(() => {});
    assert.equal(await enhancing(), null, `closing with ${how} left the run going`);
  }
  assert.ok(held.length > 0, "the runs were waiting on the model download");
  // When Cancel is pressed while the model is still loading.
  await start();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  // Then the run stops within a second and the dialog offers Enhance again.
  await page
    .waitForFunction(() => window.__cutoutTest.useWorkspace.getState().enhancing === null, null, {
      timeout: 1000,
    })
    .catch(() => {});
  assert.equal(await enhancing(), null, "Cancel did not stop the model load");
  await dialog.getByRole("button", { name: /^Enhance \d×$/ }).waitFor();
  const item = await page.evaluate(() => {
    const { items } = window.__cutoutTest.useWorkspace.getState();
    return { status: items[0].status, enhanced: items[0].enhanced ?? null };
  });
  assert.deepEqual(item, { status: "done", enhanced: null });
});

test("depth-render cancellation settles while shared inference finishes safely", async () => {
  await page.route("**/src/lib/transformers.ts", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    export function transformers(){return {env:{}, RawImage:{fromBlob:async()=>({width:32,height:32})},
      pipeline:async()=>async()=>{window.depthStarted=true;return new Promise(resolve=>{window.finishDepth=()=>resolve({depth:{width:2,height:2,data:new Uint8Array(4).fill(128)}});});}
    };}
  `,
    }),
  );
  const report = await page.evaluate(async (app) => {
    const { renderCanvas } = await import(app + "/src/lib/editor/render.ts");
    const { defaults } = await import(app + "/src/lib/editor/model.ts");
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = "black";
    ctx.fillRect(8, 8, 16, 16);
    const blob = await new Promise((resolve) => c.toBlob(resolve));
    const controller = new AbortController();
    const reason = new Error("switched-background");
    const operation = renderCanvas(
      {
        result: blob,
        source: new File([blob], "source.png", { type: "image/png" }),
        settings: { ...defaults, background: { type: "blur" }, blurDepth: true },
      },
      { signal: controller.signal },
    ).then(
      (canvas) => {
        canvas.width = 0;
        return "published";
      },
      (error) => error,
    );
    while (!window.depthStarted) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(reason);
    const before = await Promise.race([
      operation,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 100)),
    ]);
    window.finishDepth();
    const after = await operation;
    return {
      before: before === reason ? "reason" : before,
      after: after === reason ? "reason" : after,
    };
  }, base);
  assert.deepEqual(report, { before: "reason", after: "reason" });
});
