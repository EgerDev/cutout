import assert from "node:assert/strict";
import test from "node:test";
import { featherBand, featherInto, pixelBounds } from "./background-refine.ts";

test("featherInto ramps from the base at the crop edge to the refined matte inside", () => {
  const width = 60;
  const height = 40;
  const base = new Uint8ClampedArray(width * height * 4);
  const refined = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < base.length; i += 4) {
    // base: opaque red everywhere; refined: opaque blue everywhere but disagrees on alpha
    base[i] = 255;
    base[i + 3] = 255;
    refined[i + 2] = 255;
    refined[i + 3] = 100;
  }
  const band = featherBand(width, height);
  featherInto(base, refined, width, height, band);
  const px = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    return { r: base[i]!, g: base[i + 1]!, b: base[i + 2]!, a: base[i + 3]! };
  };
  assert.deepEqual(px(30, 20), { r: 0, g: 0, b: 255, a: 100 }, "interior is the refined result");
  const edge = px(0, 20);
  assert.ok(
    edge.a > 200 && edge.r > edge.b,
    `outermost pixel stays close to the base, got ${JSON.stringify(edge)}`,
  );
  // alpha must be monotonic across the ramp, with no step larger than one band share
  let previous = px(0, 20).a;
  for (let x = 1; x < band + 2; x += 1) {
    const a = px(x, 20).a;
    assert.ok(a <= previous, `alpha decreases toward the refined value at x=${x}`);
    assert.ok(
      previous - a <= Math.ceil(155 / band) + 1,
      `no seam step at x=${x}: ${previous} -> ${a}`,
    );
    previous = a;
  }
});

test("featherInto never bleeds a transparent side's colour into the blend", () => {
  const width = 30;
  const height = 30;
  const base = new Uint8ClampedArray(width * height * 4);
  const refined = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < base.length; i += 4) {
    base[i + 3] = 0; // base fully transparent (its colour is zeroed)
    refined[i] = 200;
    refined[i + 1] = 150;
    refined[i + 2] = 100;
    refined[i + 3] = 255;
  }
  featherInto(base, refined, width, height, 8);
  const i = (15 * width + 1) * 4; // inside the ramp, weight 2/8
  assert.deepEqual(
    [base[i], base[i + 1], base[i + 2]],
    [200, 150, 100],
    "colour comes only from the visible side",
  );
  assert.equal(base[i + 3], Math.round(255 * (2 / 8)));
});

test("featherBand scales with the crop and stays within 4..24 px", () => {
  assert.equal(featherBand(20, 20), 4);
  assert.equal(featherBand(120, 200), 12);
  assert.equal(featherBand(2000, 3000), 24);
});

test("pixelBounds still clamps hostile crops", () => {
  assert.deepEqual(pixelBounds({ x: -1e-16, y: 0, width: 0.5, height: 0.5 }, 1000, 800), {
    x: 0,
    y: 0,
    width: 500,
    height: 400,
  });
});
