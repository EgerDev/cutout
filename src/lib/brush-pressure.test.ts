import assert from "node:assert/strict";
import { test } from "node:test";
import { penStrokeSize } from "./brush-pressure.ts";

test("penStrokeSize only scales pen pressure and never writes a zero-width stroke", () => {
  assert.equal(penStrokeSize(0.2, "mouse", 0.5), 0.2);
  assert.equal(penStrokeSize(0.2, "touch", 0.8), 0.2);
  assert.equal(penStrokeSize(0.2, "pen", 0.25), 0.05);
  assert.equal(penStrokeSize(0.2, "pen", 0), 0.1);
  assert.equal(penStrokeSize(0.01, "pen", 0.1), 0.002);
  assert.equal(penStrokeSize(0.3, "pen", 1), 0.3);
});
