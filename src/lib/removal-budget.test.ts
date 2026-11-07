import assert from "node:assert/strict";
import test from "node:test";
import { refinementBudget } from "./removal-budget.ts";

test("skips refinement on memory-constrained devices", () => {
  assert.equal(refinementBudget("webgpu", 3, 500, 1_000_000), 0);
});

test("skips refinement after a slow global pass", () => {
  assert.equal(refinementBudget("wasm", undefined, 12_001, 1_000_000), 0);
});

test("caps sequential work by inference provider", () => {
  assert.equal(refinementBudget("wasm", 8, 1_000, 12_000_000), 1);
  assert.equal(refinementBudget("webgpu", 8, 1_000, 12_000_000), 2);
});

test("avoids a second full-resolution canvas for very large phone photos", () => {
  assert.equal(refinementBudget("webgpu", undefined, 1_000, 48_000_000), 0);
});

test("quick mode never refines and maximum raises the crop cap", () => {
  assert.equal(refinementBudget("webgpu", 8, 1_000, 12_000_000, "quick"), 0);
  assert.equal(refinementBudget("webgpu", 8, 1_000, 12_000_000, "maximum"), 4);
  assert.equal(refinementBudget("wasm", 8, 13_000, 12_000_000, "maximum"), 2);
});

test("fp32 WebGPU keeps the former WASM crop budget while fp16 is unchanged", () => {
  const modes = ["quick", "auto", "maximum"] as const;
  assert.deepEqual(
    modes.map((mode) => refinementBudget("webgpu", 8, 1_000, 1_000_000, mode, "fp32")),
    [0, 1, 2],
  );
  assert.deepEqual(
    modes.map((mode) => refinementBudget("webgpu", 8, 1_000, 1_000_000, mode, "fp16")),
    [0, 2, 4],
  );
  assert.deepEqual(
    modes.map((mode) => refinementBudget("wasm", 8, 1_000, 1_000_000, mode, "fp32")),
    [0, 1, 2],
  );
});

test("fp32 WebGPU preserves WASM size gates at 16 MP and 24 MP", () => {
  for (const pixels of [16_000_000, 16_000_001, 20_000_000, 24_000_000, 24_000_001]) {
    for (const mode of ["quick", "auto", "maximum"] as const) {
      const expected = refinementBudget("wasm", 8, 1_000, pixels, mode, "fp32");
      assert.equal(refinementBudget("webgpu", 8, 1_000, pixels, mode, "fp32"), expected);
    }
  }
  assert.equal(refinementBudget("webgpu", 8, 1_000, 20_000_000, "auto", "fp32"), 0);
  assert.equal(refinementBudget("webgpu", 8, 1_000, 20_000_000, "maximum", "fp32"), 2);
  assert.equal(refinementBudget("webgpu", 8, 1_000, 20_000_000, "auto", "fp16"), 0);
  assert.equal(refinementBudget("webgpu", 8, 1_000, 20_000_000, "maximum", "fp16"), 4);
});

test("fp32 WebGPU preserves WASM slow-inference gates and maximum exemption", () => {
  for (const milliseconds of [12_000, 12_001, 30_000]) {
    for (const mode of ["quick", "auto", "maximum"] as const) {
      const expected = refinementBudget("wasm", 8, milliseconds, 1_000_000, mode, "fp32");
      assert.equal(refinementBudget("webgpu", 8, milliseconds, 1_000_000, mode, "fp32"), expected);
    }
  }
  assert.equal(refinementBudget("webgpu", 8, 12_001, 1_000_000, "auto", "fp32"), 0);
  assert.equal(refinementBudget("webgpu", 8, 12_001, 1_000_000, "maximum", "fp32"), 2);
  assert.equal(refinementBudget("webgpu", 8, 12_001, 1_000_000, "auto", "fp16"), 0);
  assert.equal(refinementBudget("webgpu", 8, 12_001, 1_000_000, "maximum", "fp16"), 4);
});
