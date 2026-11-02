import assert from "node:assert/strict";
import test from "node:test";
import { applyColorMatch, suggestMatch } from "./match-color.ts";

test("strength 0 leaves pixels unchanged", () => {
  const data = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]);
  applyColorMatch(
    data,
    { exposure: 1, temperature: 0.4, tint: 0.2, saturation: 0.3, contrast: 0.2 },
    0,
  );
  assert.deepEqual(Array.from(data), [10, 20, 30, 255, 0, 0, 0, 0]);
});

test("identity match at full strength is a no-op", () => {
  const data = new Uint8ClampedArray([40, 80, 120, 255]);
  applyColorMatch(data, { exposure: 0, temperature: 0, tint: 0, saturation: 0, contrast: 0 }, 100);
  assert.deepEqual(Array.from(data), [40, 80, 120, 255]);
});

test("suggests warming a cool subject toward a warm background", () => {
  const match = suggestMatch({ r: 80, g: 90, b: 140 }, { r: 200, g: 160, b: 80 });
  assert.ok(match.temperature > 0);
  assert.ok(match.exposure > 0);
});

import { meanOpaque } from "./match-color.ts";

test("weights background colour matching by alpha when many fringe pixels surround opaque ink", () => {
  // Given opaque red surrounded by four faint blue fringe pixels.
  const pixels = new Uint8ClampedArray([
    255,
    0,
    0,
    255,
    ...Array.from({ length: 4 }, () => [0, 0, 255, 32]).flat(),
  ]);
  // When the subject colour is measured for matching.
  const mean = meanOpaque(pixels);
  // Then visible coverage determines the mean instead of the fringe pixel count.
  assert.ok(Math.abs(mean.r - (255 * 255) / 383) < 0.001, JSON.stringify(mean));
  assert.ok(Math.abs(mean.b - (255 * 128) / 383) < 0.001, JSON.stringify(mean));
});
