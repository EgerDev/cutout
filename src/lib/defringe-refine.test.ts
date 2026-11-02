import assert from "node:assert/strict";
import test from "node:test";
import { clampByte } from "./graphics.ts";
import {
  capToSourceAlpha,
  downsampleRgba,
  processCutout,
  refineTwoStage,
  upsampleAlpha,
  zeroRgbIfTransparent,
} from "./defringe.ts";

test("preserves enclosed detail when a dark grayscale subject has continuous shading", () => {
  // Given a valid model mask for a shaded dark subject with an enclosed white highlight.
  const size = 96;
  const src = new Uint8ClampedArray(size * size * 4).fill(255);
  const dst = new Uint8ClampedArray(src);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const subject = x >= 18 && x < 78 && y >= 18 && y < 78;
      if (subject) {
        const highlight = x >= 44 && x < 52 && y >= 44 && y < 52;
        const shade = highlight ? 255 : 20 + Math.floor(((x - 18) * 28) / 60);
        src[i] = src[i + 1] = src[i + 2] = shade;
      }
      dst[i + 3] = subject ? 255 : 0;
    }
  // When finishing the real matte, then the classifier does not key away subject detail.
  const scene = processCutout(dst, src, size, size, {
    refine: false,
    jpeg: false,
    skipUnblend: true,
  });
  assert.equal(scene.isGraphic, false);
  assert.equal(dst[(48 * size + 48) * 4 + 3], 255);
  assert.equal(dst[3], 0);
});

test("zeroRgbIfTransparent clears RGB on fully transparent pixels and leaves opaque pixels", () => {
  const data = new Uint8ClampedArray([
    255,
    250,
    245,
    0, // leftover original paper under alpha 0
    12,
    34,
    56,
    255, // subject
    9,
    8,
    7,
    1, // fringe — keep rgb
  ]);
  zeroRgbIfTransparent(data);
  assert.equal(data[0], 0);
  assert.equal(data[1], 0);
  assert.equal(data[2], 0);
  assert.equal(data[3], 0);
  assert.equal(data[4], 12);
  assert.equal(data[5], 34);
  assert.equal(data[6], 56);
  assert.equal(data[7], 255);
  assert.equal(data[8], 9);
  assert.equal(data[11], 1);
});

function haloCount(data: Uint8ClampedArray) {
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 40) continue;
    const y = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
    if (y > 180) n += 1;
  }
  return n;
}

function aaLogo() {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  const x0 = 22;
  const x1 = 42;
  const y0 = 22;
  const y1 = 42;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x < x0 ? x0 - x : x >= x1 ? x - (x1 - 1) : 0;
      const dy = y < y0 ? y0 - y : y >= y1 ? y - (y1 - 1) : 0;
      const outside = Math.sqrt(dx * dx + dy * dy);
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      let cover: number;
      if (inside) {
        const edge = Math.min(x - x0 + 0.5, x1 - x - 0.5, y - y0 + 0.5, y1 - y - 0.5);
        cover = edge >= 1 ? 1 : Math.max(0, Math.min(1, edge + 0.5));
      } else {
        cover = Math.max(0, 1 - outside);
      }
      const v = Math.round(8 * cover + 255 * (1 - cover));
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test("processCutout unblends white halos on logos when the mask kept the rim", () => {
  const { data: src, width, height } = aaLogo();
  assert.ok(haloCount(src) > 20, "fixture has a bright paper rim");
  const dst = new Uint8ClampedArray(src);
  for (let i = 0; i < dst.length; i += 4) {
    const y = 0.2126 * src[i]! + 0.7152 * src[i + 1]! + 0.0722 * src[i + 2]!;
    dst[i + 3] = y > 250 ? 0 : 255;
  }
  processCutout(dst, src, width, height, { refine: true, jpeg: false });
  assert.equal(haloCount(dst), 0);
  assert.ok((dst[(32 * width + 32) * 4 + 3] ?? 0) > 200);
});

test("two-stage refine then upsample alpha keeps letter holes", () => {
  const width = 96;
  const height = 96;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x - 48;
      const dy = y - 48;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ring = r >= 16 && r < 28;
      const v = ring ? 12 : 255;
      src[i] = v;
      src[i + 1] = v;
      src[i + 2] = v;
      src[i + 3] = 255;
      dst[i] = v;
      dst[i + 1] = v;
      dst[i + 2] = v;
      dst[i + 3] = r > 28 ? 0 : 255;
    }
  }
  const scene = {
    field: { r: 255, g: 255, b: 255 },
    jpeg: false,
    isGraphic: true,
    hasBlankField: true,
    maskWorked: true,
    exactTol2: 81,
    nearTol2: 28 * 28,
  };
  refineTwoStage(dst, src, width, height, scene, 2000);
  assert.ok((dst[(48 * width + 48) * 4 + 3] ?? 0) < 40, "counter stays open after upsample");
  assert.ok((dst[(48 * width + 22) * 4 + 3] ?? 0) > 160, "stroke stays after upsample");
});

test("processCutout keeps letter holes open when the mask filled the counters", () => {
  const width = 48;
  const height = 48;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x - 24;
      const dy = y - 24;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ring = r >= 8 && r < 16;
      const v = ring ? 12 : 255;
      src[i] = v;
      src[i + 1] = v;
      src[i + 2] = v;
      src[i + 3] = 255;
      dst[i] = v;
      dst[i + 1] = v;
      dst[i + 2] = v;
      dst[i + 3] = r > 16 ? 0 : 255;
    }
  }
  processCutout(dst, src, width, height, { refine: true, jpeg: false });
  assert.equal(dst[(24 * width + 24) * 4 + 3], 0, "counter stays open");
  assert.ok((dst[(24 * width + 12) * 4 + 3] ?? 0) > 180, "stroke stays");
});

test("downsample keeps a solid alpha block", () => {
  const src = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < src.length; i += 4) {
    src[i] = 255;
    src[i + 1] = 255;
    src[i + 2] = 255;
    src[i + 3] = i / 4 < 32 ? 0 : 255;
  }
  const small = downsampleRgba(src, 8, 8, 4, 4);
  assert.equal(small[3], 0);
  assert.equal(small[small.length - 1], 255);
});

test("upsample alpha is bilinear and stays in range", () => {
  const small = new Uint8ClampedArray(2 * 2 * 4);
  small[3] = 0;
  small[7] = 255;
  small[11] = 0;
  small[15] = 255;
  const dest = new Uint8ClampedArray(4 * 4 * 4);
  upsampleAlpha(small, 2, 2, dest, 4, 4);
  for (let i = 3; i < dest.length; i += 4) {
    assert.ok(dest[i]! >= 0 && dest[i]! <= 255);
  }
  assert.ok((dest[3] ?? 0) < 80);
  assert.ok((dest[dest.length - 1] ?? 0) > 180);
});

function createNaturalPhotoScene(width = 64, height = 64) {
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      // Textured photographic background with natural color variations
      const bgR = Math.round(30 + 40 * Math.sin(x * 0.2) + 20 * Math.cos(y * 0.3));
      const bgG = Math.round(90 + 50 * Math.cos(x * 0.15) + 30 * Math.sin(y * 0.25));
      const bgB = Math.round(50 + 35 * Math.sin(x * 0.1 + y * 0.1));

      // Cat fur foreground with chromatic texture
      const fgR = Math.round(180 + 40 * Math.cos(x * 0.3) + 20 * Math.sin(y * 0.2));
      const fgG = Math.round(110 + 30 * Math.sin(x * 0.25) + 20 * Math.cos(y * 0.15));
      const fgB = Math.round(50 + 20 * Math.cos(x * 0.1));

      const isSubject = x < 32;
      src[i] = isSubject ? fgR : bgR;
      src[i + 1] = isSubject ? fgG : bgG;
      src[i + 2] = isSubject ? fgB : bgB;
      src[i + 3] = 255;

      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      // Coarse mask with anti-aliased edge at x=30, 31
      if (x < 30) dst[i + 3] = 255;
      else if (x === 30) dst[i + 3] = 180;
      else if (x === 31) dst[i + 3] = 90;
      else dst[i + 3] = 0;
    }
  }
  return { src, dst, width, height };
}

test("processCutout retains continuous fractional alpha (0.05 < alpha < 0.95) on natural photographic subjects", () => {
  const { src, dst, width, height } = createNaturalPhotoScene(64, 64);
  const scene = processCutout(dst, src, width, height, { refine: true, jpeg: false });

  // Verify scene is correctly classified as a natural photo (not graphic and not blank field)
  assert.equal(scene.isGraphic, false, "natural photo scene must not be classified as graphic");
  assert.equal(scene.hasBlankField, false, "natural photo scene must not have blank field");

  // Verify edge pixels retain fractional anti-aliased alpha without threshold clipping
  let fractionalCount = 0;
  for (let y = 10; y < height - 10; y += 1) {
    for (let x = 28; x <= 33; x += 1) {
      const alpha = dst[(y * width + x) * 4 + 3]!;
      const normalizedAlpha = alpha / 255;
      if (normalizedAlpha > 0.05 && normalizedAlpha < 0.95) {
        fractionalCount += 1;
      }
    }
  }

  // Must preserve continuous anti-aliasing across multiple edge pixels
  assert.ok(
    fractionalCount >= 40,
    `expected >= 40 fractional alpha pixels on photographic edge, found ${fractionalCount}`,
  );
});

test("fur and whisker strands are preserved without stair-stepping", () => {
  const width = 64;
  const height = 64;
  const { src, dst } = createNaturalPhotoScene(width, height);

  // Add fine 1-pixel diagonal whisker strand extending from (28, 28) into the background (38, 33)
  const whiskerCoords: { x: number; y: number }[] = [];
  for (let step = 0; step <= 10; step += 1) {
    const wx = 28 + step;
    const wy = Math.round(28 + step * 0.5);
    whiskerCoords.push({ x: wx, y: wy });
    const wi = (wy * width + wx) * 4;
    // High-contrast bright whisker strand against the darker background
    src[wi] = 245;
    src[wi + 1] = 245;
    src[wi + 2] = 245;
    // Coarse mask dropped off rapidly or missed the thin whisker tip
    dst[wi + 3] = step <= 2 ? 150 : step <= 4 ? 50 : 0;
  }

  processCutout(dst, src, width, height, { refine: true, jpeg: false });

  // Verify that whisker pixels along the strand retain continuous alpha and are not crushed to zero
  const whiskerAlphas = whiskerCoords.map((pt) => dst[(pt.y * width + pt.x) * 4 + 3]!);
  for (let i = 0; i < whiskerAlphas.length; i += 1) {
    const a = whiskerAlphas[i]!;
    assert.ok(
      a > 8,
      `whisker point ${i} at (${whiskerCoords[i]!.x}, ${whiskerCoords[i]!.y}) must have alpha > 8, got ${a}`,
    );
  }

  // Verify that adjacent background pixels above and below the strand do not leak alpha
  for (const pt of whiskerCoords.slice(5)) {
    const above = dst[((pt.y - 2) * width + pt.x) * 4 + 3]!;
    const below = dst[((pt.y + 2) * width + pt.x) * 4 + 3]!;
    assert.equal(above, 0, `background above whisker (${pt.x}, ${pt.y - 2}) must be transparent`);
    assert.equal(below, 0, `background below whisker (${pt.x}, ${pt.y + 2}) must be transparent`);
  }

  // Verify smooth monotonically decreasing transition along the whisker strand (no stair-stepping jumps)
  for (let i = 1; i < whiskerAlphas.length; i += 1) {
    assert.ok(
      whiskerAlphas[i]! <= whiskerAlphas[i - 1]! + 5,
      `whisker strand should smoothly taper without stair-stepping jump at index ${i}`,
    );
  }
});

test("clampByte handles NaN, non-finite values, negatives, overflow, and rounds correctly", () => {
  assert.equal(clampByte(NaN), 0);
  assert.equal(clampByte(-Infinity), 0);
  assert.equal(clampByte(Infinity), 0);
  assert.equal(clampByte(-10), 0);
  assert.equal(clampByte(0), 0);
  assert.equal(clampByte(255), 255);
  assert.equal(clampByte(300), 255);
  assert.equal(clampByte(127.4), 127);
  assert.equal(clampByte(127.6), 128);
});

test("studio photo with blank field routes to fastGuidedFilterRgba preserving fine whisker detail", () => {
  const width = 64;
  const height = 64;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);

  // Pure white studio backdrop (field)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x < 32) {
        // Natural photo subject (varied colors, high chroma)
        src[i] = 180 + (x % 10) * 5;
        src[i + 1] = 120 + (y % 10) * 5;
        src[i + 2] = 60 + ((x + y) % 10) * 5;
        src[i + 3] = 255;
        dst[i] = src[i]!;
        dst[i + 1] = src[i + 1]!;
        dst[i + 2] = src[i + 2]!;
        dst[i + 3] = 255;
      } else {
        // Uniform white studio background
        src[i] = 250;
        src[i + 1] = 250;
        src[i + 2] = 250;
        src[i + 3] = 255;
        dst[i] = 250;
        dst[i + 1] = 250;
        dst[i + 2] = 250;
        dst[i + 3] = 0;
      }
    }
  }

  // Add 1px dark whisker strand projecting from subject into studio white background
  for (let x = 32; x <= 40; x += 1) {
    const wi = (32 * width + x) * 4;
    src[wi] = 30;
    src[wi + 1] = 30;
    src[wi + 2] = 30;
    // Coarse mask missed the whisker
    dst[wi + 3] = 0;
  }

  const scene = processCutout(dst, src, width, height, { refine: true, jpeg: false });
  // Scene has a blank field but is a natural portrait (NOT a graphic logo)
  assert.equal(scene.isGraphic, false, "natural portrait must not be classified as graphic");
  assert.equal(scene.hasBlankField, true, "studio backdrop must be detected as blank field");

  // Whisker strand must be reconstructed by fastGuidedFilter rather than eaten by edgeSnap
  const whiskerMidAlpha = dst[(32 * width + 35) * 4 + 3]!;
  assert.ok(
    whiskerMidAlpha > 10,
    `whisker on studio backdrop must have alpha > 10, got ${whiskerMidAlpha}`,
  );
});

test("refineTwoStage respects cap and downsamples without full-resolution edgeSnap pass", () => {
  const width = 400;
  const height = 400;
  const scene = {
    field: { r: 255, g: 255, b: 255 },
    jpeg: false,
    isGraphic: true,
    hasBlankField: true,
    maskWorked: true,
    exactTol2: 81,
    nearTol2: 784,
  };

  // Dark subject on a white field, where the mask wrongly kept a 4px white halo at alpha 200.
  // A full-resolution edgeSnap recognises that halo as backdrop and hard-zeroes it; the
  // downsampled route cannot resolve it individually and returns a smooth upsampled ramp.
  const build = () => {
    const src = new Uint8ClampedArray(width * height * 4);
    const dst = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 4;
        const inSubject = x >= 120 && x < 280 && y >= 120 && y < 280;
        const inHalo = !inSubject && x >= 116 && x < 284 && y >= 116 && y < 284;
        src[i] = inSubject ? 24 : 255;
        src[i + 1] = inSubject ? 26 : 255;
        src[i + 2] = inSubject ? 30 : 255;
        src[i + 3] = 255;
        dst[i] = src[i]!;
        dst[i + 1] = src[i + 1]!;
        dst[i + 2] = src[i + 2]!;
        dst[i + 3] = inSubject ? 255 : inHalo ? 200 : 0;
      }
    }
    return { src, dst };
  };

  // Largest alpha jump between neighbours: bilinear upsampling from at most 64x64 cannot
  // exceed ~255/(400/64) = 41, while any full-resolution pass leaves 1px cliffs near 255.
  const maxAlphaStep = (alpha: Uint8ClampedArray) => {
    let max = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const a = alpha[(y * width + x) * 4 + 3]!;
        if (x + 1 < width) max = Math.max(max, Math.abs(a - alpha[(y * width + x + 1) * 4 + 3]!));
        if (y + 1 < height)
          max = Math.max(max, Math.abs(a - alpha[((y + 1) * width + x) * 4 + 3]!));
      }
    }
    return max;
  };
  const haloAlphas = (alpha: Uint8ClampedArray) =>
    (
      [
        [118, 200],
        [200, 118],
        [281, 200],
        [200, 281],
      ] as const
    ).map(([x, y]) => alpha[(y * width + x) * 4 + 3]!);

  // 160000 pixels against cap 4000 forces the downsampled route.
  const over = build();
  refineTwoStage(over.dst, over.src, width, height, scene, 4000);

  // Control: the same input under the full-resolution route, proving the assertions below
  // are not vacuous — this is also exactly what the over-cap route produced when edgeSnap
  // still ran at full resolution after upsampling.
  const under = build();
  refineTwoStage(under.dst, under.src, width, height, scene, 1e9);

  assert.equal(maxAlphaStep(under.dst), 255, "full-resolution route must leave 1px alpha cliffs");
  assert.deepEqual(haloAlphas(under.dst), [0, 0, 0, 0], "full-resolution edgeSnap zeroes the halo");

  const overStep = maxAlphaStep(over.dst);
  assert.ok(
    overStep <= 64,
    `over-cap alpha must stay upsample-smooth (no full-resolution pass), got step ${overStep}`,
  );
  assert.ok(
    haloAlphas(over.dst).every((a) => a > 0),
    `over-cap halo must not be hard-zeroed at full resolution, got ${haloAlphas(over.dst).join(",")}`,
  );
});

test("refineTwoStage handles extreme aspect ratio (width < 64) without upscaling width", () => {
  const width = 32;
  const height = 1000;
  const src = new Uint8ClampedArray(width * height * 4).fill(255);
  const dst = new Uint8ClampedArray(width * height * 4).fill(255);

  const scene = {
    field: { r: 255, g: 255, b: 255 },
    jpeg: false,
    isGraphic: true,
    hasBlankField: true,
    maskWorked: true,
    exactTol2: 81,
    nearTol2: 784,
  };

  // cap = 500 forces downsampling on 32x1000 = 32000 pixels
  refineTwoStage(dst, src, width, height, scene, 500);
  assert.equal(dst.length, width * height * 4);
});

test("processCutout skips unblendSpill on complex outdoor scenes without blank field", () => {
  const width = 40;
  const height = 40;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);

  // Textured multi-color outdoor background without blank field
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      src[i] = (x * 7) % 256;
      src[i + 1] = (y * 11) % 256;
      src[i + 2] = ((x + y) * 13) % 256;
      src[i + 3] = 255;
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      dst[i + 3] = x < 20 ? 255 : 50; // semi-transparent edge
    }
  }

  const scene = processCutout(dst, src, width, height, { refine: false, jpeg: false });
  assert.equal(scene.hasBlankField, false, "complex outdoor scene must not have blank field");

  // Since hasBlankField is false, semi-transparent pixels must NOT be distorted by unblendSpill
  const edgeIdx = (10 * width + 25) * 4;
  assert.equal(dst[edgeIdx], src[edgeIdx], "red channel must not be distorted by unblendSpill");
  assert.equal(
    dst[edgeIdx + 1],
    src[edgeIdx + 1],
    "green channel must not be distorted by unblendSpill",
  );
  assert.equal(
    dst[edgeIdx + 2],
    src[edgeIdx + 2],
    "blue channel must not be distorted by unblendSpill",
  );
});

test("downsampleRgba and upsampleAlpha handle non-positive dimensions safely", () => {
  const empty = downsampleRgba(new Uint8ClampedArray(16), 0, 0, 0, 0);
  assert.equal(empty.length, 0);

  const dest = new Uint8ClampedArray(16);
  // Should not throw or crash on 0 dimensions
  upsampleAlpha(new Uint8ClampedArray(16), 0, 0, dest, 0, 0);
  assert.equal(dest.length, 16);
});

test("unblendSpill keeps recovered low-alpha strands in hue instead of crushing them to black", () => {
  const width = 200;
  const height = 140;
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);
  const whiskerRows = [40, 70, 100];

  // Studio scene: seamless near-white backdrop, warm photographic subject, and thin
  // whisker strands the coarse mask missed. The guided filter recovers those strands at
  // low alpha, where unblending divides colour by t and used to drive it past black.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inSubject = x >= 60 && x <= 130 && y >= 30 && y <= 110;
      const onWhisker = whiskerRows.includes(y) && x > 130 && x < 175;
      const backdrop = [244 + ((x + y) % 3), 245 + ((x * 7 + y) % 3), 246 + ((x + y * 5) % 3)];
      const fur = [
        148 + (((x * 13 + y * 7) % 23) - 11),
        104 + (((x * 5 + y * 3) % 19) - 9),
        62 + (((x * 3 + y * 11) % 17) - 8),
      ];
      let colour: number[];
      if (inSubject) colour = fur;
      else if (onWhisker) colour = backdrop.map((c, k) => Math.round(fur[k]! * 0.35 + c * 0.65));
      else colour = backdrop;
      src[i] = colour[0]!;
      src[i + 1] = colour[1]!;
      src[i + 2] = colour[2]!;
      src[i + 3] = 255;
      const inHalo = x >= 56 && x <= 134 && y >= 26 && y <= 114 && !inSubject;
      dst[i] = colour[0]!;
      dst[i + 1] = colour[1]!;
      dst[i + 2] = colour[2]!;
      dst[i + 3] = inSubject ? 255 : inHalo ? 235 : 0;
    }
  }

  const scene = processCutout(dst, src, width, height, { refine: true, jpeg: false });
  assert.equal(scene.hasBlankField, true, "studio backdrop must be detected as a blank field");
  assert.equal(scene.isGraphic, false, "warm photographic subject must not be graphic");

  // The strands must actually be recovered, otherwise there is nothing to crush.
  const whiskerPeak = Math.max(
    ...whiskerRows.map((y) =>
      Math.max(...[135, 140, 150, 160, 170].map((x) => dst[(y * width + x) * 4 + 3]!)),
    ),
  );
  assert.ok(whiskerPeak > 10, `whiskers must survive routing, got peak alpha ${whiskerPeak}`);

  // No visible pixel may be crushed to black, and soft edges must keep the warm fur hue
  // (red above blue) rather than collapsing to a neutral or inverted colour.
  let crushed = 0;
  let hueLost = 0;
  for (let i = 0; i < dst.length; i += 4) {
    const a = dst[i + 3]!;
    if (a === 0) continue;
    const r = dst[i]!;
    const g = dst[i + 1]!;
    const b = dst[i + 2]!;
    if (r === 0 && g === 0 && b === 0) crushed += 1;
    if (a < 200 && r <= b) hueLost += 1;
  }
  assert.equal(crushed, 0, `no visible pixel may be crushed to black, got ${crushed}`);
  assert.equal(hueLost, 0, `soft edges must stay warm like the fur, got ${hueLost} inverted`);
});

test("analyzeScene keeps a black-and-white photo on a white backdrop on the photographic path", () => {
  const width = 200;
  const height = 200;
  const src = new Uint8ClampedArray(width * height * 4).fill(255);
  const dst = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inSubject = x >= 40 && x < 160 && y >= 30 && y < 170;
      if (inSubject) {
        // continuous grey shading with a little grain, as a monochrome portrait has
        const v = Math.max(
          0,
          Math.min(
            225,
            Math.round(
              50 + 140 * ((x - 40) / 120) + 25 * Math.sin(y * 0.2) + ((x * 7 + y * 13) % 5),
            ),
          ),
        );
        src[i] = v;
        src[i + 1] = v;
        src[i + 2] = v;
      }
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      dst[i + 3] = inSubject ? 255 : 0;
    }
  }
  const scene = processCutout(dst, src, width, height, { refine: false, jpeg: false });
  assert.equal(scene.hasBlankField, true, "white backdrop is still a blank field");
  assert.equal(scene.isGraphic, false, "a shaded monochrome subject is a photo, not ink on paper");
});

test("E01-01: the source-alpha cap is the identity on an opaque source, for every alpha", () => {
  const dst = new Uint8ClampedArray(256 * 4);
  for (let a = 0; a < 256; a += 1) dst.set([a, 255 - a, a >> 1, a], a * 4);
  const before = dst.slice();
  capToSourceAlpha(dst, new Uint8ClampedArray(256 * 4).fill(255));
  assert.deepEqual(dst, before);
});

test("E01-01: the source-alpha cap lowers only alpha above the source's, never RGB", () => {
  const dst = new Uint8ClampedArray([9, 8, 7, 237, 9, 8, 7, 90, 9, 8, 7, 40, 9, 8, 7, 255]);
  const src = new Uint8ClampedArray([1, 1, 1, 128, 1, 1, 1, 0, 1, 1, 1, 200, 1, 1, 1, 254]);
  capToSourceAlpha(dst, src);
  assert.deepEqual([...dst], [9, 8, 7, 128, 9, 8, 7, 0, 9, 8, 7, 40, 9, 8, 7, 254]);
});
