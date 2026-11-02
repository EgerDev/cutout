import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRemovalMask, needsSubjectChoice, removalNote } from "./removal-diagnostics.ts";
import { pixelBounds } from "./background-refine.ts";

function mask(
  width: number,
  height: number,
  regions: readonly Readonly<{
    x: number;
    y: number;
    width: number;
    height: number;
    alpha?: number;
  }>[],
) {
  const alpha = new Uint8Array(width * height);
  for (const region of regions)
    for (let y = region.y; y < region.y + region.height; y += 1)
      for (let x = region.x; x < region.x + region.width; x += 1)
        alpha[y * width + x] = region.alpha ?? 255;
  return alpha;
}

test("plans a magnified crop when the detected subject is small", () => {
  // Given a small valid subject in a large global mask.
  const alpha = mask(100, 100, [{ x: 42, y: 40, width: 12, height: 18 }]);

  // When the removal mask is analyzed.
  const report = analyzeRemovalMask(alpha, 100, 100, 2);

  // Then one contextual crop is planned around that subject.
  assert.equal(report.crops.length, 1);
  const crop = report.crops[0];
  assert.ok(crop);
  assert.ok(crop.width < 0.5 && crop.height < 0.5);
  assert.ok(crop.x < 0.42 && crop.x + crop.width > 0.54);
  assert.ok(crop.y < 0.4 && crop.y + crop.height > 0.58);
});

test("does not refine a subject that already occupies most of the frame", () => {
  // Given a subject with ample model resolution in the global pass.
  const alpha = mask(100, 100, [{ x: 8, y: 5, width: 84, height: 90 }]);

  // When the removal mask is analyzed.
  const report = analyzeRemovalMask(alpha, 100, 100, 2);

  // Then no redundant crop inference is planned.
  assert.equal(report.crops.length, 0);
});

test("isolates multiple subjects and respects the refinement budget", () => {
  // Given three separated subjects that survive the global mask.
  const alpha = mask(120, 80, [
    { x: 8, y: 12, width: 12, height: 28 },
    { x: 52, y: 20, width: 10, height: 20 },
    { x: 96, y: 8, width: 14, height: 32 },
  ]);

  // When the device budget permits only two refinements.
  const report = analyzeRemovalMask(alpha, 120, 80, 2);

  // Then two non-overlapping subject crops are selected.
  assert.equal(report.components, 3);
  assert.equal(report.crops.length, 2);
  assert.ok(report.crops[0]);
  assert.ok(report.crops[1]);
  assert.ok(report.crops[0].x + report.crops[0].width <= report.crops[1].x);
});

test("ignores isolated mask noise while reporting soft-edge uncertainty", () => {
  // Given one real subject, two one-pixel specks, and a partially transparent edge.
  const alpha = mask(64, 64, [
    { x: 20, y: 18, width: 18, height: 24 },
    { x: 19, y: 18, width: 1, height: 24, alpha: 128 },
    { x: 2, y: 2, width: 1, height: 1 },
    { x: 61, y: 60, width: 1, height: 1 },
  ]);

  // When the mask is analyzed.
  const report = analyzeRemovalMask(alpha, 64, 64, 3);

  // Then noise does not consume crop slots and uncertainty remains measurable.
  assert.equal(report.components, 1);
  assert.equal(report.crops.length, 1);
  assert.ok(report.uncertainFraction > 0);
});

test("asks the user to choose when several subjects remain", () => {
  const alpha = mask(120, 80, [
    { x: 8, y: 12, width: 12, height: 28 },
    { x: 52, y: 20, width: 10, height: 20 },
    { x: 96, y: 8, width: 14, height: 32 },
  ]);
  const report = analyzeRemovalMask(alpha, 120, 80, 2);
  assert.equal(needsSubjectChoice(report), true);
  assert.equal(removalNote(report, 2), "choose");
});

test("padding cap keeps magnification for large foreground components like a sample cat", () => {
  // Given a large foreground component occupying ~60% of an 800x800 image
  const alpha = mask(800, 800, [{ x: 160, y: 140, width: 480, height: 520 }]);

  // When the mask is analyzed for crop refinement
  const report = analyzeRemovalMask(alpha, 800, 800, 2);

  // Then the padding cap of 18 prevents excessive padding expansion, preserving magnification >= 1.3
  assert.equal(report.crops.length, 1);
  const crop = report.crops[0]!;
  assert.ok(crop.width < 0.72 && crop.height < 0.72);
  const magnification = Math.min(1 / crop.width, 1 / crop.height);
  assert.ok(magnification >= 1.3, `expected magnification >= 1.3, got ${magnification}`);
});

test("downscaled 192px probe keeps scale-invariant padding and magnification >= 1.30 without exceeding 72% crop", () => {
  // Same cat component downscaled to a 192x192 probe (160*192/800 = 38, 140*192/800 = 34, 480*192/800 = 115, 520*192/800 = 125)
  const alpha = mask(192, 192, [{ x: 38, y: 34, width: 115, height: 125 }]);

  const report = analyzeRemovalMask(alpha, 192, 192, 2);

  // Must not drop the crop on a downscaled 192px probe
  assert.equal(report.crops.length, 1);
  const crop = report.crops[0]!;
  assert.ok(crop.width < 0.72, `expected crop.width < 0.72, got ${crop.width}`);
  assert.ok(crop.height < 0.72, `expected crop.height < 0.72, got ${crop.height}`);
  const magnification = Math.min(1 / crop.width, 1 / crop.height);
  assert.ok(magnification >= 1.3, `expected magnification >= 1.3, got ${magnification}`);
});

test("pixelBounds clamps negative crop coordinates to avoid IndexSizeError", () => {
  const bounds = pixelBounds(
    { x: -0.05, y: -0.1, width: 0.5, height: 0.5 },
    100,
    100,
  );
  assert.ok(bounds.x >= 0, `bounds.x must be >= 0, got ${bounds.x}`);
  assert.ok(bounds.y >= 0, `bounds.y must be >= 0, got ${bounds.y}`);
  assert.ok(bounds.width > 0);
  assert.ok(bounds.height > 0);
  assert.ok(bounds.x + bounds.width <= 100);
  assert.ok(bounds.y + bounds.height <= 100);
});

test("pixelBounds handles NaN crop coordinates and zero image dimensions safely", () => {
  const zeroBounds = pixelBounds({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 0, 0);
  assert.deepEqual(zeroBounds, { x: 0, y: 0, width: 0, height: 0 });

  const nanBounds = pixelBounds(
    { x: NaN, y: NaN, width: NaN, height: NaN },
    100,
    100,
  );
  assert.equal(nanBounds.x, 0);
  assert.equal(nanBounds.y, 0);
  assert.ok(nanBounds.width > 0);
  assert.ok(nanBounds.height > 0);
  assert.ok(Number.isFinite(nanBounds.width));
  assert.ok(Number.isFinite(nanBounds.height));
});


