import assert from "node:assert/strict";
import { test } from "node:test";
import { findCheckAreas } from "./check-areas.ts";

test("findCheckAreas flags specks, enclosed holes and soft edge runs", () => {
  const w = 120,
    h = 120;
  const alpha = new Uint8Array(w * h);
  // subject: solid block
  for (let y = 20; y < 100; y++) for (let x = 20; x < 100; x++) alpha[y * w + x] = 255;
  // a hole inside it
  for (let y = 50; y < 56; y++) for (let x = 50; x < 56; x++) alpha[y * w + x] = 0;
  // a speck far away
  for (let y = 5; y < 8; y++) for (let x = 110; x < 113; x++) alpha[y * w + x] = 255;
  // a soft run along the right edge: partial alpha column band
  for (let y = 20; y < 100; y++) for (let x = 100; x < 112; x++) alpha[y * w + x] = 90;
  const areas = findCheckAreas(alpha, w, h);
  const kinds = areas.map((a) => a.kind);
  assert.ok(kinds.includes("speck"), kinds.join());
  assert.ok(kinds.includes("hole"), kinds.join());
  assert.ok(kinds.includes("soft"), kinds.join());
  const hole = areas.find((a) => a.kind === "hole")!;
  assert.ok(hole.x < 50 / w && hole.x + hole.width > 56 / w);
  const speck = areas.find((a) => a.kind === "speck")!;
  assert.ok(speck.x > 0.85 && speck.y < 0.1);
  const soft = areas.find((a) => a.kind === "soft")!;
  assert.ok(soft.x >= 0.8, `${soft.x}`);
  // a clean solid subject has nothing to check
  const clean = new Uint8Array(w * h);
  for (let y = 20; y < 100; y++) for (let x = 20; x < 100; x++) clean[y * w + x] = 255;
  assert.deepEqual(findCheckAreas(clean, w, h), []);
});

test("keeps check rectangles inside image coordinates when regions touch the far edge", () => {
  // Given a large subject and a detached speck at the bottom-right corner.
  const width = 120,
    height = 120;
  const alpha = new Uint8Array(width * height);
  for (let y = 20; y < 100; y++) for (let x = 20; x < 100; x++) alpha[y * width + x] = 255;
  alpha[width * height - 1] = 255;
  // When the check areas are normalized.
  const areas = findCheckAreas(alpha, width, height);
  // Then every rectangle stays within the image, including its padding.
  assert.ok(areas.some((area) => area.kind === "speck"));
  for (const area of areas) {
    assert.ok(area.x >= 0 && area.x + area.width <= 1, JSON.stringify(area));
    assert.ok(area.y >= 0 && area.y + area.height <= 1, JSON.stringify(area));
  }
});
