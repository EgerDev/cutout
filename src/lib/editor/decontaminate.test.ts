import assert from "node:assert/strict";
import test from "node:test";
import { decontaminatePixels } from "./decontaminate.ts";

function fringe() {
  const width = 8,
    height = 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let x = 0; x < 4; x += 1) {
    const i = x * 4;
    data[i] = 80;
    data[i + 1] = 200;
    data[i + 2] = 80;
    data[i + 3] = 128;
  }
  for (let x = 4; x < 8; x += 1) {
    const i = x * 4;
    data[i] = 40;
    data[i + 1] = 180;
    data[i + 2] = 40;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

test("amount 0 is a no-op", () => {
  const { data, width, height } = fringe();
  const before = data.slice();
  decontaminatePixels(data, width, height, 0, 2, { r: 0, g: 255, b: 0 }, "manual");
  assert.deepEqual(Array.from(data), Array.from(before));
});

test("off mode is a no-op", () => {
  const { data, width, height } = fringe();
  const before = data.slice();
  decontaminatePixels(data, width, height, 100, 2, { r: 0, g: 255, b: 0 }, "off");
  assert.deepEqual(Array.from(data), Array.from(before));
});

test("manual unblend reduces green spill on partial alpha", () => {
  const { data, width, height } = fringe();
  decontaminatePixels(data, width, height, 100, 1, { r: 0, g: 255, b: 0 }, "manual");
  assert.ok((data[1] ?? 0) < 200);
  assert.equal(data[3], 128);
});

test("unblend keeps faint edge pixels in hue when the backdrop estimate is off", () => {
  const alphas = [255, 200, 150, 100, 70, 45, 30, 18];
  const build = () => {
    const data = new Uint8ClampedArray(alphas.length * 4);
    alphas.forEach((a, x) => {
      // warm fur (150,104,62) composited over true white at alpha a
      const t = a / 255;
      data[x * 4] = Math.round(150 * t + 255 * (1 - t));
      data[x * 4 + 1] = Math.round(104 * t + 255 * (1 - t));
      data[x * 4 + 2] = Math.round(62 * t + 255 * (1 - t));
      data[x * 4 + 3] = a;
    });
    return data;
  };

  // Exact estimate: every pixel recovers the fur colour within rounding.
  const exact = build();
  decontaminatePixels(exact, alphas.length, 1, 100, 1, { r: 255, g: 255, b: 255 }, "manual");
  for (let x = 0; x < alphas.length; x += 1) {
    assert.ok(
      Math.abs(exact[x * 4]! - 150) <= 8 &&
        Math.abs(exact[x * 4 + 1]! - 104) <= 8 &&
        Math.abs(exact[x * 4 + 2]! - 62) <= 8,
      `alpha ${alphas[x]} recovers fur, got (${exact[x * 4]},${exact[x * 4 + 1]},${exact[x * 4 + 2]})`,
    );
  }

  // Estimate 15 levels too dark: dividing by a small t amplifies that error. The
  // correction must stay bounded and keep the warm ordering r > g > b rather than
  // clipping channels independently into a neutral white.
  const off = build();
  const before = build();
  decontaminatePixels(off, alphas.length, 1, 100, 1, { r: 240, g: 240, b: 240 }, "manual");
  for (let x = 0; x < alphas.length; x += 1) {
    const r = off[x * 4]!,
      g = off[x * 4 + 1]!,
      b = off[x * 4 + 2]!;
    assert.ok(r > g && g > b, `alpha ${alphas[x]} keeps warm hue ordering, got (${r},${g},${b})`);
  }
  const faint = alphas.length - 1;
  const drift = Math.max(
    Math.abs(off[faint * 4]! - before[faint * 4]!),
    Math.abs(off[faint * 4 + 1]! - before[faint * 4 + 1]!),
    Math.abs(off[faint * 4 + 2]! - before[faint * 4 + 2]!),
  );
  assert.ok(drift <= 8, `alpha 18 moves at most 8 levels from the observed colour, moved ${drift}`);
});

import { edgeBand } from "./decontaminate.ts";
import { dilateSquare } from "../morphology.ts";

function naiveDilate(mark: Uint8Array, width: number, height: number, radius: number) {
  const out = mark.slice();
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      if (mark[y * width + x]) continue;
      let hit = 0;
      for (let oy = -radius; oy <= radius && !hit; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -radius; ox <= radius; ox += 1) {
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          if (mark[ny * width + nx]) {
            hit = 1;
            break;
          }
        }
      }
      if (hit) out[y * width + x] = 1;
    }
  return out;
}

test("dilateSquare matches the per-pixel window scan it replaced", () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (const [width, height] of [
    [37, 23],
    [64, 64],
    [5, 90],
    [90, 5],
    [1, 1],
  ] as const) {
    for (const radius of [2, 3, 5, 9]) {
      const mark = new Uint8Array(width * height);
      for (let i = 0; i < mark.length; i += 1) mark[i] = rand() < 0.04 ? 1 : 0;
      assert.deepEqual(
        dilateSquare(mark, width, height, radius),
        naiveDilate(mark, width, height, radius),
        `${width}x${height} r=${radius}`,
      );
    }
  }
});

test("edgeBand is linear in the pixel count, not in the window area", () => {
  const width = 800;
  const height = 600;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const r = Math.hypot(x - 400, y - 300);
      data[(y * width + x) * 4 + 3] =
        r < 190 ? 255 : r < 200 ? Math.round((255 * (200 - r)) / 10) : 0;
    }
  // Best of five, so a scheduler hiccup while the suite runs in parallel cannot fail it.
  const time = (radius: number) => {
    let best = Infinity;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      edgeBand(data, width, height, radius);
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };
  const small = Math.max(1, time(2));
  const large = time(12);
  assert.ok(
    large < small * 4,
    `radius 12 took ${large.toFixed(1)} ms vs ${small.toFixed(1)} ms at radius 2; the old scan scaled 36x`,
  );
});

test("Auto samples the backdrop when a previous Manual colour remains in settings", () => {
  // Given a warm edge and a faint white pixel for automatic background sampling.
  const expected = new Uint8ClampedArray([200, 160, 130, 128, 255, 255, 255, 32]);
  const previousManual = expected.slice();
  // When Auto runs with and without a retained Manual green colour.
  decontaminatePixels(expected, 2, 1, 100, 1, null, "auto");
  decontaminatePixels(previousManual, 2, 1, 100, 1, { r: 0, g: 255, b: 0 }, "auto");
  // Then a hidden Manual setting cannot change Auto's estimated backdrop.
  assert.deepEqual(previousManual, expected);
});
