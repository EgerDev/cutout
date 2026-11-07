import assert from "node:assert/strict";
import test from "node:test";
import * as mask_ from "./model-mask.ts";

// Namespace access keeps each new row red on its own (not a link error) before the exports exist.

// ---- design r9 section 6: original rendering (cutout-original-matte-v1) ----

function bytes(values: readonly number[], quality: "quality" | "fast"): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length);
  values.forEach((v, i) => {
    out[i] = mask_.matteByte(v, quality);
  });
  return out;
}

test("matteByte quality is the raw value times 255 with no clamp of its own", () => {
  const raw = [-2, 0, 2].map((v) => mask_.matteByte(v, "quality"));
  assert.deepEqual(raw, [-510, 0, 510]);
});

test("matteByte fast smoothsteps raw values, which clamps by itself", () => {
  const raw = [-2, 0, 2].map((v) => mask_.matteByte(v, "fast"));
  assert.deepEqual(raw, [0, 0, 255]);
});

test("the Uint8ClampedArray store, not matteByte, clamps both transfers to [0,0,255]", () => {
  assert.deepEqual(Array.from(bytes([-2, 0, 2], "quality")), [0, 0, 255]);
  assert.deepEqual(Array.from(bytes([-2, 0, 2], "fast")), [0, 0, 255]);
});

test("matteByte reference points 0.08/0.5/0.92", () => {
  const pts = [0.08, 0.5, 0.92];
  assert.deepEqual(
    pts.map((v) => mask_.matteByte(v, "quality")),
    [20, 128, 235],
  );
  // Design r9 section 6 lists fast as [0,128,255]. With smoothstep moved verbatim, smoothstep(0.08,0.92,0.5)
  // is 0.4999999999999999 in IEEE doubles, so the exact byte is 127. Pinned as computed (design value is +-1).
  assert.deepEqual(
    pts.map((v) => mask_.matteByte(v, "fast")),
    [0, 127, 255],
  );
});

test("matteByte keeps NaN and Infinity visible (no sanitisation)", () => {
  assert.equal(Number.isNaN(mask_.matteByte(Number.NaN, "quality")), true);
  assert.equal(Number.isNaN(mask_.matteByte(Number.NaN, "fast")), true);
  assert.equal(mask_.matteByte(Number.POSITIVE_INFINITY, "quality"), Number.POSITIVE_INFINITY);
  assert.equal(mask_.matteByte(Number.NEGATIVE_INFINITY, "quality"), Number.NEGATIVE_INFINITY);
});

test("smoothstep is exported and matches the engine's clamped cubic", () => {
  assert.equal(mask_.smoothstep(0.08, 0.92, -1), 0);
  assert.equal(mask_.smoothstep(0.08, 0.92, 2), 1);
  assert.ok(Math.abs(mask_.smoothstep(0.08, 0.92, 0.5) - 0.5) < 1e-12);
});
