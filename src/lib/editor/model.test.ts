import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backgroundPatch,
  defaults,
  placement,
  presetPatch,
  uniqueNames,
  recordHistory,
  historyBytes,
  cycleInspect,
  aspectCanvas,
  trimCanvas,
  historyLabel,
} from "./model.ts";

test("presets create square canvases and transparent assets", () => {
  assert.equal(presetPatch("product").exportWidth, 1600);
  assert.deepEqual(presetPatch("asset").background, { type: "transparent" });
  assert.equal(presetPatch("original").exportWidth, null);
  assert.equal(presetPatch("amazon").exportWidth, 2000);
  assert.deepEqual(presetPatch("amazon").background, { type: "color", color: "#ffffff" });
  assert.equal(presetPatch("ebay").exportWidth, 1600);
});
test("subject framing preserves aspect ratio and padding at both extremes", () => {
  const b = { x: 20, y: 10, width: 100, height: 200 };
  assert.deepEqual(
    placement(b, 400, 400, {
      ...defaults,
      preset: "product",
      padding: 10,
      positionX: 0,
      positionY: 100,
    }),
    { x: 40, y: 40, width: 160, height: 320 },
  );
  const p = placement(b, 400, 400, {
    ...defaults,
    preset: "product",
    padding: 10,
    positionX: 100,
    positionY: 0,
  });
  assert.equal(p.x, 200);
  assert.equal(p.y, 40);
});
test("user scale grows the fitted subject around its center", () => {
  const fitted = placement({ x: 20, y: 10, width: 100, height: 200 }, 400, 400, {
    ...defaults,
    preset: "product",
    padding: 10,
    positionX: 50,
    positionY: 50,
  });
  const scaled = placement({ x: 20, y: 10, width: 100, height: 200 }, 400, 400, {
    ...defaults,
    preset: "product",
    padding: 10,
    positionX: 50,
    positionY: 50,
    scale: 150,
  });
  assert.equal(scaled.width, fitted.width * 1.5);
  assert.equal(scaled.height, fitted.height * 1.5);
  assert.equal(scaled.x + scaled.width / 2, fitted.x + fitted.width / 2);
});
test("archive paths cannot escape and collisions are case insensitive", () => {
  const names = uniqueNames(["../../a.jpg", "A.png", "a.jpeg", "", "x\\y.png"], "png");
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, 5);
  assert.ok(names.every((n) => !/[\\/]/.test(n) && !n.startsWith(".")));
});
test("history is bounded and coalesces a slider gesture without losing its first state", () => {
  const first = { a: defaults };
  let h = recordHistory([], first, "slider", 1000);
  h = recordHistory(h, { a: { ...defaults, feather: 1 } }, "slider", 1100);
  assert.equal(h.length, 1);
  assert.equal(h[0]?.settings, first);
  for (let i = 0; i < 80; i++) h = recordHistory(h, first, "brush", 2000 + i * 1000, false);
  assert.equal(h.length, 40);
});

test("inspection modes cycle and wrap", () => {
  assert.equal(cycleInspect("composite"), "checker");
  assert.equal(cycleInspect("edge"), "composite");
});

test("history releases older large background images at its memory budget", () => {
  const first = { a: { ...defaults, backgroundBlob: new Blob([new Uint8Array(33_000_000)]) } };
  const second = { a: { ...defaults, backgroundBlob: new Blob([new Uint8Array(33_000_000)]) } };
  const history = recordHistory(recordHistory([], first, "first", 0), second, "second", 1000);
  assert.equal(history.length, 1);
  assert.ok(historyBytes(history.map((entry) => entry.settings)) <= 64_000_000);
});

test("aspect presets size the canvas from the source and fit the subject", () => {
  const phone = { width: 3024, height: 4032 };
  assert.deepEqual(aspectCanvas("square", phone), { width: 2048, height: 2048 });
  assert.deepEqual(aspectCanvas("portrait", phone), { width: 1638, height: 2048 });
  assert.deepEqual(aspectCanvas("landscape", phone), { width: 2048, height: 1152 });
  assert.deepEqual(aspectCanvas("story", { width: 300, height: 200 }), { width: 288, height: 512 });
  assert.equal(aspectCanvas("product", phone), null);
  assert.deepEqual(aspectCanvas("square"), { width: 1600, height: 1600 });

  const patch = presetPatch("portrait", { width: 1000, height: 800 });
  assert.equal(patch.exportWidth, 800);
  assert.equal(patch.exportHeight, 1000);
  assert.equal(patch.padding, 8);
  const passport = presetPatch("passport");
  assert.deepEqual([passport.exportWidth, passport.exportHeight], [413, 531]);
  assert.deepEqual(passport.background, { type: "color", color: "#ffffff" });
});
test("trim preset crops to the subject with padding at native scale", () => {
  const bounds = { x: 30, y: 40, width: 100, height: 50 };
  assert.deepEqual(trimCanvas(bounds, { trimPadding: 24 }), { width: 148, height: 98 });
  assert.deepEqual(placement(bounds, 148, 98, { ...defaults, preset: "trim", trimPadding: 24 }), {
    x: 24,
    y: 24,
    width: 100,
    height: 50,
  });
  assert.equal(presetPatch("trim").exportWidth, null);
});
test("historyLabel names steps from their keys", () => {
  assert.equal(historyLabel("item-1:strokes"), "Brush stroke");
  assert.equal(historyLabel("item-1:feather"), "Feather");
  assert.equal(historyLabel("item-1:exportWidth,exportHeight"), "Export size");
  assert.equal(historyLabel("item-1:preset,exportWidth,exportHeight,padding"), "Preset");
  assert.equal(historyLabel("batch"), "Batch settings");
  assert.equal(historyLabel("item-1:somethingNew"), "Something New");
});

test("archive names preserve combining marks, normalize NFC, and deduplicate canonically", () => {
  assert.deepEqual(
    uniqueNames(["फ़ोटो.png", "cafe\u0301.png", "café.jpg", "../Café.jpg", "x\u202e/y.png"], "png"),
    [
      "फ़ोटो-cutout.png",
      "café-cutout.png",
      "café-cutout-2.png",
      "Café-cutout-3.png",
      "xy-cutout.png",
    ],
  );
});

test("transparent backgrounds switch JPEG to PNG and preserve other formats", () => {
  for (const exportFormat of ["jpeg", "png", "webp"] as const) {
    const settings = { ...defaults, exportFormat };
    assert.deepEqual(backgroundPatch(settings, { type: "transparent" }), {
      background: { type: "transparent" },
      exportFormat: exportFormat === "jpeg" ? "png" : exportFormat,
    });
    assert.deepEqual(backgroundPatch(settings, { type: "color", color: "#ff0000" }), {
      background: { type: "color", color: "#ff0000" },
      exportFormat,
    });
  }
});
