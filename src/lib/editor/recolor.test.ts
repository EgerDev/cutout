import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRecolors } from "./recolor.ts";
import { quantizePalette } from "./palette.ts";
import { vectorizeRgba } from "./vectorize.ts";

function px(r: number, g: number, b: number, a = 255) {
  return [r, g, b, a];
}

test("applyRecolors swaps a colour, keeps mixes proportional and ignores others", () => {
  const data = new Uint8ClampedArray([
    ...px(200, 30, 30), // the red to swap
    ...px(115, 15, 15), // 50/50 mix of red and black (distance ~86 > tol, < 2tol)
    ...px(0, 0, 0), // black stays
    ...px(0, 0, 0, 0), // transparent stays
  ]);
  applyRecolors(data, [{ from: "#c81e1e", to: "#1e1ec8" }], 48);
  assert.deepEqual([...data.slice(0, 4)], px(30, 30, 200));
  // the mixed pixel moves part way toward the swap, never past it
  assert.ok(data[4]! < 115 && data[6]! > 15, `${data[4]} ${data[6]}`);
  assert.deepEqual([...data.slice(8, 12)], px(0, 0, 0));
  assert.deepEqual([...data.slice(12, 16)], px(0, 0, 0, 0));
});

test("knocking a colour out clears it and unmixes rim pixels at partial alpha", () => {
  const data = new Uint8ClampedArray([
    ...px(255, 255, 255), // white backdrop leftover → gone
    ...px(204, 204, 255), // mostly white rim pixel → bluer, partially transparent
    ...px(0, 0, 255), // blue stays
  ]);
  applyRecolors(data, [{ from: "#ffffff", to: null }], 40);
  assert.deepEqual([...data.slice(0, 4)], px(0, 0, 0, 0));
  const [r, g, b, a] = data.slice(4, 8);
  assert.ok(a! < 255 && a! > 100, `alpha ${a}`);
  assert.ok(b! >= 250 && r! < 204 && g! < 204, `rgb ${r} ${g} ${b}`);
  assert.deepEqual([...data.slice(8, 12)], px(0, 0, 255));
});

test("quantizePalette merges anti-aliasing into one swatch per ink and orders by share", () => {
  const pixels: number[] = [];
  for (let i = 0; i < 300; i++) pixels.push(...px(200, 30, 30 + (i % 3)));
  for (let i = 0; i < 100; i++) pixels.push(...px(20, 20, 20));
  for (let i = 0; i < 50; i++) pixels.push(...px(255, 255, 255, 0)); // transparent ignored
  const palette = quantizePalette(new Uint8ClampedArray(pixels), 8);
  assert.equal(palette.length, 2);
  assert.equal(palette[0]?.hex, "#c81e1f");
  assert.ok(palette[0]!.share > 0.7);
  assert.equal(palette[1]?.hex, "#141414");
});

test("vectorizeRgba emits one filled path per colour and none for transparency", () => {
  const w = 48,
    h = 48;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (x < 8 || x >= 40 || y < 8 || y >= 40) continue; // transparent border
      const red = x < 24;
      data[i] = red ? 220 : 20;
      data[i + 1] = 20;
      data[i + 2] = red ? 20 : 220;
      data[i + 3] = 255;
    }
  const svg = vectorizeRgba(data, w, h, { colors: 4 });
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 48 48"/);
  const fills = [...svg.matchAll(/fill="rgb\((\d+),(\d+),(\d+)\)"/g)].map((m) =>
    m.slice(1, 4).map(Number),
  );
  assert.ok(
    fills.some(([r, , b]) => r! > 180 && b! < 60),
    "red path",
  );
  assert.ok(
    fills.some(([r, , b]) => b! > 180 && r! < 60),
    "blue path",
  );
  assert.ok(
    !fills.some(([r, g, b]) => r! < 30 && g! < 30 && b! < 30),
    "no black (transparent) path",
  );
  assert.ok(!/opacity="0"/.test(svg));
});
