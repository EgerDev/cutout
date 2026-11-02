import assert from "node:assert/strict";
import { test } from "node:test";
import { quantizePalette } from "./palette.ts";

test("offers colour swatches when artwork contains only translucent pixels", () => {
  // Given a translucent logo with invisible pixels retaining unrelated RGB.
  const pixels = new Uint8ClampedArray([200, 30, 30, 128, 200, 30, 30, 64, 0, 255, 0, 0]);
  // When the palette is calculated.
  const palette = quantizePalette(pixels);
  // Then the visible ink remains selectable for recolouring and knockout.
  assert.deepEqual(palette, [{ r: 200, g: 30, b: 30, hex: "#c81e1e", share: 1 }]);
});

test("ranks palette colours by visible coverage instead of translucent pixel count", () => {
  // Given one opaque red pixel and four faint blue pixels.
  const pixels = new Uint8ClampedArray([
    255,
    0,
    0,
    255,
    ...Array.from({ length: 4 }, () => [0, 0, 255, 32]).flat(),
  ]);
  // When the palette is calculated.
  const palette = quantizePalette(pixels);
  // Then red dominates visible coverage and blue is still available.
  assert.equal(palette.length, 2);
  assert.equal(palette[0]?.hex, "#ff0000");
  assert.ok(Math.abs((palette[0]?.share ?? 0) - 255 / 383) < 0.0001);
  assert.equal(palette[1]?.hex, "#0000ff");
});
