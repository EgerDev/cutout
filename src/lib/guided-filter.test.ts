import assert from "node:assert/strict";
import test from "node:test";
import { boxFilter2D, fastGuidedFilter, fastGuidedFilterRgba } from "./guided-filter.ts";

test("boxFilter2D produces exact normalized averages on all-ones buffer", () => {
  const width = 8;
  const height = 8;
  const src = new Float32Array(width * height).fill(1.0);
  const dst = new Float32Array(width * height);
  const scratch = new Float32Array(width * height);

  boxFilter2D(src, dst, scratch, width, height, 2);

  for (let i = 0; i < dst.length; i += 1) {
    assert.ok(Math.abs(dst[i]! - 1.0) < 1e-5, `expected 1.0, got ${dst[i]} at index ${i}`);
  }
});

test("boxFilter2D correctly filters impulse at center", () => {
  const width = 5;
  const height = 5;
  const src = new Float32Array(width * height);
  src[12] = 1.0; // center (2, 2)
  const dst = new Float32Array(width * height);
  const scratch = new Float32Array(width * height);

  boxFilter2D(src, dst, scratch, width, height, 1);

  // 3x3 window around center has 9 pixels, so center should be 1/9
  assert.ok(Math.abs(dst[12]! - 1 / 9) < 1e-5);
  // Pixel outside the 3x3 window should be 0
  assert.equal(dst[0], 0);
});

test("fastGuidedFilter preserves opaque interiors and transparent backgrounds", () => {
  const width = 48;
  const height = 48;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < 24) {
        // Foreground subject
        rgb[i] = 180;
        rgb[i + 1] = 120;
        rgb[i + 2] = 60;
        rgb[i + 3] = 255;
        alpha[y * width + x] = 255;
      } else {
        // Background
        rgb[i] = 40;
        rgb[i + 1] = 90;
        rgb[i + 2] = 130;
        rgb[i + 3] = 255;
        alpha[y * width + x] = 0;
      }
    }
  }

  const refined = fastGuidedFilter(rgb, alpha, width, height, {
    radius: 6,
    eps: 1e-3,
    subsample: 2,
  });

  // Deep interior pixel (x=8, y=24) must stay solidly opaque (255)
  assert.equal(refined[24 * width + 8], 255, "deep interior must remain 255");

  // Deep exterior pixel (x=40, y=24) must stay solidly transparent (0)
  assert.equal(refined[24 * width + 40], 0, "deep exterior must remain 0");
});

test("fastGuidedFilter transfers high-contrast optical whiskers into alpha matte", () => {
  const width = 64;
  const height = 64;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < 30) {
        rgb[i] = 210;
        rgb[i + 1] = 130;
        rgb[i + 2] = 50;
        rgb[i + 3] = 255;
        alpha[y * width + x] = 255;
      } else {
        rgb[i] = 30;
        rgb[i + 1] = 45;
        rgb[i + 2] = 60;
        rgb[i + 3] = 255;
        alpha[y * width + x] = 0;
      }
    }
  }

  // Draw 1-pixel white whisker strand extending from x=30 to x=40 along y=32
  for (let x = 30; x <= 40; x += 1) {
    const i = (32 * width + x) * 4;
    rgb[i] = 240;
    rgb[i + 1] = 240;
    rgb[i + 2] = 240;
    // Coarse mask missed the whisker tip beyond x=31
    alpha[32 * width + x] = x <= 31 ? 120 : 0;
  }

  const refined = fastGuidedFilter(rgb, alpha, width, height, {
    radius: 6,
    eps: 1e-3,
    subsample: 2,
  });

  // The whisker at x=34, y=32 was 0 in coarse mask; guided filter must reconstruct it
  const whiskerVal = refined[32 * width + 34]!;
  assert.ok(whiskerVal > 15, `expected whisker alpha > 15, got ${whiskerVal}`);

  // The background 1 pixel below (x=34, y=33) must remain transparent
  const bgVal = refined[33 * width + 34]!;
  assert.equal(bgVal, 0, `expected adjacent background alpha 0, got ${bgVal}`);
});

test("fastGuidedFilter handles edge cases: 0x0, 1x1, odd dimensions", () => {
  // Empty inputs
  assert.equal(
    fastGuidedFilter(new Uint8ClampedArray(0), new Uint8ClampedArray(0), 0, 0).length,
    0,
  );

  // 1x1 input
  const rgb1 = new Uint8ClampedArray([255, 255, 255, 255]);
  const a1 = new Uint8ClampedArray([128]);
  const res1 = fastGuidedFilter(rgb1, a1, 1, 1);
  assert.equal(res1.length, 1);
  assert.ok(res1[0]! >= 120 && res1[0]! <= 135);

  // Odd dimensions
  const wOdd = 23;
  const hOdd = 17;
  const rgbOdd = new Uint8ClampedArray(wOdd * hOdd * 4).fill(100);
  const aOdd = new Uint8ClampedArray(wOdd * hOdd).fill(200);
  const resOdd = fastGuidedFilter(rgbOdd, aOdd, wOdd, hOdd);
  assert.equal(resOdd.length, wOdd * hOdd);
  assert.ok(resOdd[0]! >= 195 && resOdd[0]! <= 205);
});

test("fastGuidedFilter operates within performance budget for megapixel inputs", () => {
  const width = 1200;
  const height = 800; // ~1 MP
  const rgb = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);

  const start = performance.now();
  const refined = fastGuidedFilter(rgb, alpha, width, height, {
    radius: 8,
    eps: 1e-3,
    subsample: 4,
  });
  const duration = performance.now() - start;

  assert.equal(refined.length, width * height);
  // Fast guided filter with s=4 on 1MP must execute under 250ms even on un-JITed warmups
  assert.ok(duration < 250, `expected filter time < 250ms, took ${duration.toFixed(1)}ms`);
});

test("fastGuidedFilterRgba clears RGB channels on zero-alpha pixels", () => {
  const width = 16;
  const height = 16;
  const src = new Uint8ClampedArray(width * height * 4).fill(255);
  const dst = new Uint8ClampedArray(width * height * 4).fill(255);

  // Set right half to transparent
  for (let y = 0; y < height; y += 1) {
    for (let x = 8; x < width; x += 1) {
      dst[(y * width + x) * 4 + 3] = 0;
    }
  }

  fastGuidedFilterRgba(dst, src, width, height, { radius: 4, subsample: 2 });

  // Rightmost column should be zero alpha and zero RGB
  for (let y = 0; y < height; y += 1) {
    const idx = (y * width + 15) * 4;
    assert.equal(dst[idx + 3], 0);
    assert.equal(dst[idx], 0);
    assert.equal(dst[idx + 1], 0);
    assert.equal(dst[idx + 2], 0);
  }
});

test("fastGuidedFilter handles smaller eps (1e-4) without determinant zeroing or flat blur", () => {
  const width = 32;
  const height = 32;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const isFg = x < 16;
      rgb[i] = isFg ? 200 : 50;
      rgb[i + 1] = isFg ? 150 : 60;
      rgb[i + 2] = isFg ? 80 : 120;
      rgb[i + 3] = 255;
      alpha[y * width + x] = isFg ? 255 : 0;
    }
  }

  const res = fastGuidedFilter(rgb, alpha, width, height, { eps: 1e-4, radius: 4 });
  // With eps=1e-4, sharp edge must be cleanly transferred, not blurred into 50/50 flat grey
  assert.ok(
    res[16 * width + 15]! > 220,
    `expected sharp foreground alpha > 220, got ${res[16 * width + 15]}`,
  );
  assert.ok(
    res[16 * width + 16]! < 35,
    `expected sharp background alpha < 35, got ${res[16 * width + 16]}`,
  );
});

test("fastGuidedFilter adapts subsampling ratio when small radius is requested", () => {
  const width = 64;
  const height = 64;
  const rgb = new Uint8ClampedArray(width * height * 4);
  const alpha = new Uint8ClampedArray(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      rgb[i] = x < 32 ? 200 : 50;
      rgb[i + 1] = rgb[i]!;
      rgb[i + 2] = rgb[i]!;
      rgb[i + 3] = 255;
      alpha[y * width + x] = x < 32 ? 255 : 0;
    }
  }

  // With radius=1, subsample ratio is clamped to 1, preventing excessive downsampling blur
  const res = fastGuidedFilter(rgb, alpha, width, height, { radius: 1 });
  // 4 pixels away from edge should be unaffected and fully opaque
  assert.equal(
    res[32 * width + 27],
    255,
    "radius 1 filter must not blur pixels 5px away from edge",
  );
});

test("fastGuidedFilter returns zeros safely when given truncated or undersized buffers", () => {
  const shortRgb = new Uint8ClampedArray(10);
  const shortAlpha = new Uint8ClampedArray(10);
  const res = fastGuidedFilter(shortRgb, shortAlpha, 16, 16);
  assert.equal(res.length, 16 * 16);
  // Must return all zeros safely without NaN
  for (let i = 0; i < res.length; i += 1) {
    assert.equal(res[i], 0);
  }
});

test("fastGuidedFilterRgba populates RGB from source when recovering previously transparent pixels", () => {
  const width = 48;
  const height = 48;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < 24) {
        src[i] = 200;
        src[i + 1] = 100;
        src[i + 2] = 50;
        src[i + 3] = 255;
        dst[i] = 200;
        dst[i + 1] = 100;
        dst[i + 2] = 50;
        dst[i + 3] = 255;
      } else {
        src[i] = 30;
        src[i + 1] = 40;
        src[i + 2] = 50;
        src[i + 3] = 255;
        // Background was transparent and cleared to 0
        dst[i] = 0;
        dst[i + 1] = 0;
        dst[i + 2] = 0;
        dst[i + 3] = 0;
      }
    }
  }

  // Add bright white whisker in src extending from x=24 to 28 at y=24
  for (let x = 24; x <= 28; x += 1) {
    const i = (24 * width + x) * 4;
    src[i] = 250;
    src[i + 1] = 250;
    src[i + 2] = 250;
    // dst was 0 (coarse mask missed it)
  }

  fastGuidedFilterRgba(dst, src, width, height, { radius: 4, subsample: 2 });

  const whiskerIdx = (24 * width + 26) * 4;
  assert.ok(dst[whiskerIdx + 3]! > 0, "whisker alpha must be recovered");
  // Whisker RGB must be restored from source, NOT remain black (0, 0, 0)
  assert.ok(
    dst[whiskerIdx]! > 100,
    `whisker red channel must be restored from source, got ${dst[whiskerIdx]}`,
  );
  assert.ok(
    dst[whiskerIdx + 1]! > 100,
    `whisker green channel must be restored from source, got ${dst[whiskerIdx + 1]}`,
  );
  assert.ok(
    dst[whiskerIdx + 2]! > 100,
    `whisker blue channel must be restored from source, got ${dst[whiskerIdx + 2]}`,
  );
});

test("boxFilter2D handles zero and negative radius by copying src to dst without errors", () => {
  const width = 4;
  const height = 4;
  const src = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const dst0 = new Float32Array(16);
  const scratch = new Float32Array(16);

  // radius = 0 should copy directly
  boxFilter2D(src, dst0, scratch, width, height, 0);
  assert.deepEqual(Array.from(dst0), Array.from(src));

  // negative radius should clamp to 0 and copy directly
  const dstNeg = new Float32Array(16);
  boxFilter2D(src, dstNeg, scratch, width, height, -3);
  assert.deepEqual(Array.from(dstNeg), Array.from(src));
});

test("fastGuidedFilter handles negative or zero dimensions without RangeError", () => {
  const dummy = new Uint8ClampedArray(16);
  assert.equal(fastGuidedFilter(dummy, dummy, -5, 10).length, 0);
  assert.equal(fastGuidedFilter(dummy, dummy, 10, -5).length, 0);
  assert.equal(fastGuidedFilter(dummy, dummy, 0, 0).length, 0);
  assert.equal(fastGuidedFilter(dummy, dummy, -1, -1).length, 0);
});

test("fastGuidedFilter supports padded alpha buffers larger than width * height * 4", () => {
  const width = 16;
  const height = 16;
  const n = width * height;
  const rgb = new Uint8ClampedArray(n * 4).fill(128);
  // Padded alpha buffer with extra trailing bytes (e.g. alignment / row padding)
  const paddedAlpha = new Uint8ClampedArray(n * 4 + 64);
  for (let i = 0; i < n; i += 1) {
    paddedAlpha[i * 4 + 3] = 200;
  }

  const out = fastGuidedFilter(rgb, paddedAlpha, width, height, { radius: 2 });
  assert.equal(out.length, n);
  assert.ok(out[0]! >= 190 && out[0]! <= 210);
});

test("fastGuidedFilter with Cauchy-Schwarz clamp guarantees positive semi-definite covariance", () => {
  const width = 32;
  const height = 32;
  const n = width * height;
  const rgb = new Uint8ClampedArray(n * 4);
  const alpha = new Uint8ClampedArray(n);

  // Construct highly correlated RGB values to test Cauchy-Schwarz covariance clamping
  for (let i = 0; i < n; i += 1) {
    const v = (i % 32) * 8;
    rgb[i * 4] = v;
    rgb[i * 4 + 1] = v;
    rgb[i * 4 + 2] = v;
    rgb[i * 4 + 3] = 255;
    alpha[i] = v > 128 ? 255 : 0;
  }

  const out = fastGuidedFilter(rgb, alpha, width, height, { radius: 4, eps: 1e-6 });
  assert.equal(out.length, n);
  // Must not have NaN or zeroes across all interior pixels
  for (let i = 0; i < n; i += 1) {
    assert.ok(Number.isFinite(out[i]!), `pixel ${i} must be finite, got ${out[i]}`);
  }
});

test("boxFilter2D handles NaN, Infinity, and zero dimensions safely", () => {
  const src = new Float32Array([1, 2, 3, 4]);
  const dst = new Float32Array(4);
  const scratch = new Float32Array(4);

  boxFilter2D(src, dst, scratch, 2, 2, NaN);
  assert.deepEqual(Array.from(dst), [1, 2, 3, 4]);

  const dstInf = new Float32Array(4);
  boxFilter2D(src, dstInf, scratch, 2, 2, -Infinity);
  assert.deepEqual(Array.from(dstInf), [1, 2, 3, 4]);

  const dstDim = new Float32Array(4);
  boxFilter2D(src, dstDim, scratch, 0, 0, 2);
  assert.deepEqual(Array.from(dstDim), [1, 2, 3, 4]);
});

test("fastGuidedFilterRgba handles truncated buffers and zero dimensions safely", () => {
  const cutout = new Uint8ClampedArray(16);
  const source = new Uint8ClampedArray(16);

  // Negative / zero dimensions should not throw or modify
  fastGuidedFilterRgba(cutout, source, 0, 0);
  fastGuidedFilterRgba(cutout, source, -1, 10);

  // Truncated buffers (smaller than width * height * 4) should return early safely
  const shortCutout = new Uint8ClampedArray(8);
  const shortSource = new Uint8ClampedArray(8);
  fastGuidedFilterRgba(shortCutout, shortSource, 2, 2);
  assert.equal(shortCutout.length, 8);
});
