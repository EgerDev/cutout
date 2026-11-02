import assert from "node:assert/strict";
import test from "node:test";
import { resizeSteps } from "./bitmap-resize.ts";

test("resizeSteps halves toward the target and ends exactly on it", () => {
  const steps = resizeSteps(4032, 3024, 96, 72);
  assert.deepEqual(steps[steps.length - 1], [96, 72]);
  for (let i = 1; i < steps.length; i += 1) {
    assert.ok(steps[i]![0] <= steps[i - 1]![0] && steps[i]![1] <= steps[i - 1]![1], "monotonic");
    assert.ok(
      steps[i - 1]![0] <= steps[i]![0] * 2 + 1 || steps[i]![0] === 96,
      "no step shrinks by more than half",
    );
  }
  assert.ok(steps.length >= 5, `a 42x reduction takes several halvings, got ${steps.length}`);
});

test("resizeSteps is a single draw when already within 2x", () => {
  assert.deepEqual(resizeSteps(1600, 1200, 1000, 750), [[1000, 750]]);
  assert.deepEqual(resizeSteps(100, 100, 100, 100), [[100, 100]]);
});
