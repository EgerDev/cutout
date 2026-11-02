import assert from "node:assert/strict";
import { test } from "node:test";
import { planSheet } from "./sheet.ts";

test("planSheet lays cells out in a near-square grid with a gap and label rows", () => {
  const grid = planSheet(5, 100);
  assert.equal(grid.cols, 3);
  assert.equal(grid.rows, 2);
  assert.equal(grid.gap, 8);
  assert.equal(grid.width, 3 * 108 + 8);
  assert.equal(grid.height, 2 * 108 + 8);
  assert.deepEqual(grid.cellAt(0), { x: 8, y: 8 });
  assert.deepEqual(grid.cellAt(4), { x: 8 + 108, y: 8 + 108 });

  const labelled = planSheet(4, 200, 2, 30);
  assert.equal(labelled.cols, 2);
  assert.equal(labelled.height, 2 * (200 + 30 + 8) + 8);
  assert.deepEqual(labelled.cellAt(3), { x: 8 + 208, y: 8 + 238 });

  // never more columns than items, never zero
  assert.equal(planSheet(1, 64).cols, 1);
  assert.equal(planSheet(2, 64, 10).cols, 2);
});
