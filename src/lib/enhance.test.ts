import assert from "node:assert/strict";
import test from "node:test";
import {
  ENHANCE_VARIANTS,
  ENHANCE_MAX_OUTPUT,
  accumulateTile,
  countActiveTiles,
  tileHasAlpha,
  planEnhance,
  cropRgba,
  enhanceRgba,
  padReplicate,
  planTiles,
} from "./enhance.ts";

test("planTiles covers the image with fixed-size overlapping tiles", () => {
  const tiles = planTiles(600, 300, 256, 16);
  assert.ok(tiles.every((t) => t.size === 256));
  const maxX = Math.max(...tiles.map((t) => t.x + t.size));
  const maxY = Math.max(...tiles.map((t) => t.y + t.size));
  assert.equal(maxX, 600);
  assert.equal(maxY, 300);
  assert.deepEqual(planTiles(256, 256, 256, 16), [{ x: 0, y: 0, size: 256 }]);
  assert.throws(() => planTiles(100, 256, 256, 16), RangeError);
  // every pixel is inside at least one tile
  const covered = new Uint8Array(600 * 300);
  for (const t of tiles)
    for (let y = t.y; y < t.y + t.size; y += 1)
      for (let x = t.x; x < t.x + t.size; x += 1) covered[y * 600 + x] = 1;
  assert.ok(covered.every((v) => v === 1));
});

test("padReplicate extends the edges and cropRgba cuts a window", () => {
  const src = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255]); // 2x1
  const padded = padReplicate(src, 2, 1, 4, 2);
  assert.deepEqual(
    Array.from(padded.slice(8, 12)),
    [40, 50, 60, 255],
    "column 2 replicates column 1",
  );
  assert.deepEqual(Array.from(padded.slice(16, 20)), [10, 20, 30, 255], "row 1 replicates row 0");
  assert.deepEqual(Array.from(cropRgba(padded, 4, 1, 0, 2, 1)), [40, 50, 60, 255, 40, 50, 60, 255]);
});

test("enhanceRgba with a nearest-neighbour doubler reproduces exact doubling, seams included", async () => {
  const width = 300;
  const height = 280;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgba[i] = (x * 7) & 255;
      rgba[i + 1] = (y * 5) & 255;
      rgba[i + 2] = (x + y) & 255;
      rgba[i + 3] = 255;
    }
  const doubler = async (tile: Uint8ClampedArray, w: number, h: number) => {
    const out = new Uint8ClampedArray(w * h * 16);
    for (let y = 0; y < h * 2; y += 1)
      for (let x = 0; x < w * 2; x += 1) {
        const s = ((y >> 1) * w + (x >> 1)) * 4;
        out.set(tile.subarray(s, s + 4), (y * w * 2 + x) * 4);
      }
    return out;
  };
  const seen: number[] = [];
  const out = await enhanceRgba(rgba, width, height, doubler, {
    tile: 256,
    overlap: 16,
    onTile: (done) => seen.push(done),
  });
  assert.equal(out.length, width * 2 * height * 2 * 4);
  assert.equal(seen.length, planTiles(width, height, 256, 16).length);
  let maxDiff = 0;
  for (let y = 0; y < height * 2; y += 1)
    for (let x = 0; x < width * 2; x += 1) {
      const s = ((y >> 1) * width + (x >> 1)) * 4;
      const o = (y * width * 2 + x) * 4;
      for (let k = 0; k < 3; k += 1)
        maxDiff = Math.max(maxDiff, Math.abs(out[o + k]! - rgba[s + k]!));
    }
  assert.ok(maxDiff <= 1, `blended tiles must reproduce the doubled image, max diff ${maxDiff}`);
});

test("enhanceRgba pads images smaller than a tile and crops the result back", async () => {
  const rgba = new Uint8ClampedArray(40 * 30 * 4).fill(200);
  const out = await enhanceRgba(rgba, 40, 30, async (t, w, h) =>
    new Uint8ClampedArray(w * h * 16).fill(200),
  );
  assert.equal(out.length, 80 * 60 * 4);
  assert.equal(out[3], 255);
  assert.equal(out[0], 200);
});

test("enhanceRgba honours an abort between tiles", async () => {
  const controller = new AbortController();
  const rgba = new Uint8ClampedArray(600 * 300 * 4);
  let calls = 0;
  await assert.rejects(
    enhanceRgba(
      rgba,
      600,
      300,
      async (t, w, h) => {
        calls += 1;
        if (calls === 2) controller.abort();
        return new Uint8ClampedArray(w * h * 16);
      },
      { tile: 256, overlap: 16, signal: controller.signal },
    ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  assert.equal(calls, 2);
});

test("accumulateTile weights blend to the tile value where one tile stands alone", () => {
  const size = 8;
  const acc = new Float32Array(size * size * 3);
  const weight = new Float32Array(size * size);
  const tile = new Uint8ClampedArray(size * size * 4).fill(100);
  accumulateTile(acc, weight, size, tile, size, 0, 0, 4);
  for (let p = 0; p < size * size; p += 1)
    assert.ok(Math.abs(acc[p * 3]! / weight[p]! - 100) < 1e-4);
  assert.equal(ENHANCE_VARIANTS[2].maxSide, 2048);
  assert.equal(ENHANCE_VARIANTS[4].maxSide, 1024);
  assert.equal(ENHANCE_VARIANTS[4].tile, 256);
});

test("enhanceRgba at x4 with a nearest-neighbour quadrupler reproduces exact quadrupling", async () => {
  const width = 300;
  const height = 200;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    rgba[i * 4] = (i * 13) & 255;
    rgba[i * 4 + 1] = (i * 7) & 255;
    rgba[i * 4 + 2] = (i * 3) & 255;
    rgba[i * 4 + 3] = 255;
  }
  const quad = async (tile: Uint8ClampedArray, w: number, h: number) => {
    const out = new Uint8ClampedArray(w * h * 64);
    for (let y = 0; y < h * 4; y += 1)
      for (let x = 0; x < w * 4; x += 1) {
        const s = ((y >> 2) * w + (x >> 2)) * 4;
        out.set(tile.subarray(s, s + 4), (y * w * 4 + x) * 4);
      }
    return out;
  };
  const out = await enhanceRgba(rgba, width, height, quad, { scale: 4, tile: 256, overlap: 16 });
  assert.equal(out.length, width * 4 * height * 4 * 4);
  let maxDiff = 0;
  for (let y = 0; y < height * 4; y += 1)
    for (let x = 0; x < width * 4; x += 1) {
      const s = ((y >> 2) * width + (x >> 2)) * 4;
      const o = (y * width * 4 + x) * 4;
      for (let k = 0; k < 3; k += 1)
        maxDiff = Math.max(maxDiff, Math.abs(out[o + k]! - rgba[s + k]!));
    }
  assert.ok(maxDiff <= 1, `max diff ${maxDiff}`);
});

test("planEnhance reports tiles, output size, caps and an estimate", () => {
  const p = planEnhance(1200, 1600, 2);
  assert.equal(p.allowed, true);
  assert.deepEqual(
    [p.outWidth, p.outHeight, p.finalWidth, p.finalHeight],
    [2400, 3200, 2400, 3200],
  );
  assert.equal(p.capped, false);
  assert.equal(p.tiles, planTiles(1200, 1600, 512, 32).length);
  assert.ok(p.estimatedMs > 0);

  // 2048 x 1536 at x4 exceeds the variant; x2 fits the 4096 output cap exactly
  assert.equal(planEnhance(2048, 1536, 4).allowed, false);
  const wide = planEnhance(2048, 1536, 2);
  assert.equal(wide.allowed, true);
  assert.equal(wide.finalWidth, ENHANCE_MAX_OUTPUT);
  assert.equal(wide.capped, false);

  // 1024 x 1024 at x4 is 4096; a phone with a 16 MP / 4096 px canvas limit scales it down
  const phone = planEnhance(1024, 1024, 4, { side: 4096, pixels: 16_000_000 });
  assert.equal(phone.capped, true);
  assert.ok(phone.finalWidth * phone.finalHeight <= 16_000_000);
  assert.equal(phone.finalWidth, phone.finalHeight);

  // small image: one tile, output well under the cap
  const small = planEnhance(200, 150, 2);
  assert.equal(small.tiles, 1);
  assert.deepEqual([small.finalWidth, small.finalHeight], [400, 300]);
});

test("tile skipping leaves empty tiles out of the run and out of the count", async () => {
  const w = 600,
    h = 300;
  const alpha = new Uint8Array(w * h);
  // subject only in the left 200 px
  for (let y = 0; y < h; y++) for (let x = 0; x < 200; x++) alpha[y * w + x] = 255;
  const counted = countActiveTiles(alpha, w, h, 4);
  assert.equal(counted.total, planTiles(600, 300, 256, 16).length);
  assert.ok(counted.active < counted.total, `${counted.active}/${counted.total}`);
  assert.ok(counted.active >= 1);
  // x4 tiles start at 0, 240, 344 (pulled back): the first column touches the subject
  assert.equal(tileHasAlpha(alpha, w, h, { x: 0, y: 0, size: 256 }), true);
  assert.equal(tileHasAlpha(alpha, w, h, { x: 344, y: 0, size: 256 }), false);

  const rgba = new Uint8ClampedArray(w * h * 4).fill(200);
  let ran = 0;
  const out = await enhanceRgba(
    rgba,
    w,
    h,
    async (tile, tw, th) => {
      ran += 1;
      const up = new Uint8ClampedArray(tw * 4 * th * 4 * 4).fill(255);
      return up;
    },
    { scale: 4, tile: 256, overlap: 16, skip: (t) => !tileHasAlpha(alpha, w, h, t) },
  );
  assert.equal(ran, counted.active);
  // a skipped region stays black in the raw output; the caller masks it anyway
  assert.equal(out[((h * 4 - 1) * (w * 4) + (w * 4 - 1)) * 4], 0);
  assert.equal(out[0], 255);
});

test("enhance refuses oversized accumulation before running a tile", async () => {
  let calls = 0;
  await assert.rejects(
    enhanceRgba(
      new Uint8ClampedArray(64 * 64 * 4),
      64,
      64,
      async (_, w, h) => {
        calls++;
        return new Uint8ClampedArray(w * h * 16);
      },
      { limits: { pixels: 4096, side: 4096 } },
    ),
    /Enhance needs more memory/,
  );
  assert.equal(calls, 0);
});

test("enhance checks cancellation after the last tile before progress and output", async () => {
  const controller = new AbortController();
  let tiles = 0;
  await assert.rejects(
    enhanceRgba(
      new Uint8ClampedArray(64 * 64 * 4),
      64,
      64,
      async (_, w, h) => {
        controller.abort();
        return new Uint8ClampedArray(w * h * 16);
      },
      {
        signal: controller.signal,
        onTile: () => {
          tiles++;
        },
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(tiles, 0);
});

test("cancelling an in-flight Enhance tile releases the caller before the tile settles", async () => {
  let finish!: (data: Uint8ClampedArray) => void;
  const controller = new AbortController();
  const operation = enhanceRgba(
    new Uint8ClampedArray(64 * 64 * 4),
    64,
    64,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    { signal: controller.signal },
  );
  const outcome = operation.then(
    () => "published",
    (error: Error) => error.name,
  );
  controller.abort();
  const result = await Promise.race([
    outcome,
    new Promise((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
  finish(new Uint8ClampedArray(128 * 128 * 4));
  assert.equal(result, "AbortError");
});
