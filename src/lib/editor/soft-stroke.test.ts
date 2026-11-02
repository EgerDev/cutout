import assert from "node:assert/strict";
import test from "node:test";
import { StrokeMask, falloff } from "./soft-stroke.ts";

test("falloff is solid inside the hard core and fades smoothly to the rim", () => {
  assert.equal(falloff(2, 5, 10), 1);
  assert.equal(falloff(10, 5, 10), 0);
  const mid = falloff(7.5, 5, 10);
  assert.ok(mid > 0.4 && mid < 0.6);
  assert.ok(falloff(6, 5, 10) > falloff(9, 5, 10));
});

test("a slow stroke over the same spot never builds up past its edge profile", () => {
  const once = new StrokeMask(0, 0, 40, 40, 10, 0);
  once.add({ x: 20, y: 20 }, { x: 20, y: 20 });
  const many = new StrokeMask(0, 0, 40, 40, 10, 0);
  for (let i = 0; i < 50; i += 1) many.add({ x: 20, y: 20 }, { x: 20.01, y: 20 });
  const edge = 20 * 40 + 27; // 7 px from the centre, in the soft falloff
  assert.ok((once.data[edge] ?? 0) > 0 && (once.data[edge] ?? 0) < 128);
  assert.ok(Math.abs((many.data[edge] ?? 0) - (once.data[edge] ?? 0)) <= 2);
});

test("a long stroke covers its whole length (no stamp budget cut-off)", () => {
  const mask = StrokeMask.around(
    [
      { x: 0, y: 5 },
      { x: 5000, y: 5 },
    ],
    3,
    3,
    5000,
    10,
  );
  mask.addAll([
    { x: 0, y: 5 },
    { x: 5000, y: 5 },
  ]);
  assert.equal(mask.data[5 * mask.width + 4990], 255);
});

test("the mask is clipped to the canvas and reports only what it touched", () => {
  const mask = new StrokeMask(0, 0, 20, 20, 4, 4);
  assert.deepEqual(mask.add({ x: 1, y: 1 }, { x: 1, y: 1 }), { x: 0, y: 0, width: 5, height: 5 });
  assert.equal(mask.add({ x: 100, y: 100 }, { x: 100, y: 100 }), null);
});
