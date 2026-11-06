import assert from "node:assert/strict";
import test from "node:test";
import {
  blurredInk,
  classifyGraphic,
  floodPaper,
  knockPaper,
  looksAlreadyTransparent,
  opaqueFraction,
  sampleBorder,
  skipAlphaProbe,
  tonalConcentration,
} from "./graphics.ts";

const looksLikeGraphic = (data: Uint8ClampedArray, width: number, height: number) =>
  classifyGraphic(data, width, height) === "logo";

function logo() {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const mark = x >= 16 && x < 32 && y >= 16 && y < 32;
      data[i] = mark ? 10 : 255;
      data[i + 1] = mark ? 10 : 255;
      data[i + 2] = mark ? 10 : 255;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

test("white page with a black mark is treated as a graphic", () => {
  const { data, width, height } = logo();
  assert.equal(looksLikeGraphic(data, width, height), true);
});

test("recognizes a logo when uniform paper noise straddles RGB bucket boundaries", () => {
  // Given dark ink on near-uniform paper whose channels cross 32-level buckets.
  const size = 96;
  for (const paper of [32, 64, 128, 192, 224]) {
    const data = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        data[i] = paper + (x % 2 ? 2 : -2);
        data[i + 1] = paper + (y % 2 ? 2 : -2);
        data[i + 2] = paper + ((x + y) % 2 ? 2 : -2);
        data[i + 3] = 255;
      }
    fillRect(data, size, 28, 28, 68, 68, [4, 4, 4]);

    // When detecting the field and image type, then quantization does not split the field.
    const field = sampleBorder(data, size, size);
    assert.ok(field.coverage > 0.99, `paper ${paper}: coverage ${field.coverage}`);
    for (const channel of [field.r, field.g, field.b])
      assert.ok(Math.abs(channel - paper) < 1, `paper ${paper}: field ${channel}`);
    assert.ok(field.std <= 3);
    assert.equal(classifyGraphic(data, size, size), "logo", `paper ${paper}`);
  }
});

function fillRect(
  data: Uint8ClampedArray,
  width: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number],
) {
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = 255;
    }
  }
}

test("a house against sky is not treated as a blank-page graphic", () => {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, 64, 64, [120, 170, 220]);
  fillRect(data, width, 12, 28, 52, 64, [160, 110, 70]);
  fillRect(data, width, 28, 40, 36, 64, [40, 30, 24]);
  fillRect(data, width, 18, 34, 26, 42, [80, 160, 210]);
  assert.equal(looksLikeGraphic(data, width, height), false);
});

test("an animal on grass is not treated as a blank-page graphic", () => {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, 64, 64, [70, 130, 50]);
  fillRect(data, width, 20, 18, 44, 50, [180, 110, 40]);
  fillRect(data, width, 26, 22, 32, 28, [30, 24, 20]);
  assert.equal(looksLikeGraphic(data, width, height), false);
});

test("knockPaper clears the page and keeps the mark", () => {
  const { data, width, height } = logo();
  knockPaper(data, width, height);
  const center = (24 * width + 24) * 4 + 3;
  const corner = 3;
  assert.equal(data[corner], 0);
  assert.ok((data[center] ?? 0) > 200);
  assert.ok(opaqueFraction(data) > 0.05);
  assert.ok(opaqueFraction(data) < 0.5);
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

test("knockPaper unblends the anti-aliased white rim", () => {
  const { data, width, height } = aaLogo();
  assert.ok(haloCount(data) > 20, "fixture has a bright paper rim");
  knockPaper(data, width, height);
  assert.equal(data[3], 0);
  assert.ok((data[(32 * width + 32) * 4 + 3] ?? 0) > 200);
  assert.equal(haloCount(data), 0);
});

test("knockPaper opens letter holes and knocks leftover paper specks", () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x - 24;
      const dy = y - 24;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ring = r >= 8 && r < 16;
      const speck = x === 6 && y === 6;
      const v = ring ? 12 : speck ? 230 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  knockPaper(data, width, height);
  assert.equal(data[(24 * width + 24) * 4 + 3], 0);
  assert.equal(data[(6 * width + 6) * 4 + 3], 0);
  assert.ok((data[(24 * width + 12) * 4 + 3] ?? 0) > 180);
});

test("knockPaper knocks JPEG beige fringe and opens chair-back holes", () => {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) put(x, y, 255, 254, 253);
  }
  for (let y = 14; y < 40; y += 1) {
    for (let x = 18; x < 46; x += 1) put(x, y, 210, 198, 170);
  }
  for (let y = 16; y < 38; y += 1) {
    for (let x = 20; x < 44; x += 1) put(x, y, 82, 56, 24);
  }
  for (let y = 22; y < 30; y += 1) {
    for (let x = 26; x < 38; x += 1) put(x, y, 255, 254, 253);
  }
  for (let y = 38; y < 52; y += 1) {
    for (let x = 16; x < 48; x += 1) put(x, y, 196, 168, 132);
  }
  knockPaper(data, width, height, { jpeg: true });
  assert.equal(data[3], 0);
  assert.equal(data[(26 * width + 32) * 4 + 3], 0, "hole must be open");
  assert.ok((data[(20 * width + 32) * 4 + 3] ?? 0) > 180, "dark wood stays");
  assert.ok((data[(44 * width + 32) * 4 + 3] ?? 0) > 160, "tan seat stays");
  assert.equal(haloCount(data), 0);
  assert.ok(opaqueFraction(data) > 0.08);
  assert.ok(opaqueFraction(data) < 0.7);
});

test("knockPaper does not erase a light gray mark on white", () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const mark = x >= 16 && x < 32 && y >= 16 && y < 32;
      data[i] = mark ? 200 : 255;
      data[i + 1] = mark ? 200 : 255;
      data[i + 2] = mark ? 200 : 255;
      data[i + 3] = 255;
    }
  }
  knockPaper(data, width, height);
  assert.equal(data[3], 0);
  const center = (24 * width + 24) * 4;
  assert.ok((data[center + 3] ?? 0) > 160);
  assert.ok(opaqueFraction(data) > 0.04);
});

test("floodPaper recovers an empty mask from a bordered subject", () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const mark = x >= 14 && x < 34 && y >= 14 && y < 34;
      data[i] = mark ? 40 : 248;
      data[i + 1] = mark ? 36 : 246;
      data[i + 2] = mark ? 30 : 242;
      data[i + 3] = 255;
    }
  }
  floodPaper(data, width, height);
  assert.equal(data[3], 0);
  assert.ok((data[(24 * width + 24) * 4 + 3] ?? 0) > 200);
  assert.ok(opaqueFraction(data) > 0.1);
  assert.ok(opaqueFraction(data) < 0.5);
});

test("already-transparent images have a meaningful alpha mix", () => {
  const data = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 8; i += 1) data[i * 4 + 3] = 255;
  assert.equal(looksAlreadyTransparent(data), true);
  const opaque = new Uint8ClampedArray(16 * 4).fill(255);
  assert.equal(looksAlreadyTransparent(opaque), false);
});

test("already-transparent art passes through when its subject covers less than 2%", () => {
  // Given a small icon with deliberate transparency around it.
  const width = 96;
  const height = 96;
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 45, 45, 51, 51, [120, 60, 20]);
  // When inspecting its alpha, then retain its existing cutout.
  assert.equal(looksAlreadyTransparent(data, width, height), true);
});

test("translucent art passes through when the entire asset has partial alpha", () => {
  // Given a translucent overlay with no completely clear pixels.
  const width = 48;
  const data = new Uint8ClampedArray(width * width * 4).fill(128);
  // When inspecting its alpha, then preserve the intentional translucency.
  assert.equal(looksAlreadyTransparent(data, width, width), true);
});

test("transparent art passes through when downsampling makes its subject nearly invisible", () => {
  // Given a sparse asset whose probe has no alpha above the opaque threshold.
  const width = 96;
  const data = new Uint8ClampedArray(width * width * 4);
  data[(48 * width + 48) * 4 + 3] = 8;
  // When inspecting its probe, then preserve the full-resolution source alpha.
  assert.equal(looksAlreadyTransparent(data, width, width), true);
});

test("knockPaper preserves a clean off-white PNG anti-aliased edge", () => {
  // Given a known 6% blend of dark ink over off-white paper.
  const width = 12;
  const height = 8;
  const data = new Uint8ClampedArray(width * height * 4);
  fillRect(data, width, 0, 0, width, height, [250, 250, 250]);
  fillRect(data, width, 4, 2, 8, 6, [50, 50, 50]);
  fillRect(data, width, 3, 2, 4, 6, [238, 238, 238]);
  // When removing lossless paper, then recover coverage instead of treating it as JPEG noise.
  knockPaper(data, width, height, { jpeg: false });
  assert.ok(Math.abs((data[(3 * width + 3) * 4 + 3] ?? 0) - 15) <= 1);
  assert.equal(data[3], 0);
});

test("JPEG skips the alpha passthrough probe; PNG and WebP do not", () => {
  assert.equal(skipAlphaProbe("image/jpeg"), true);
  assert.equal(skipAlphaProbe("image/jpg"), true);
  assert.equal(skipAlphaProbe("image/pjpeg"), true);
  assert.equal(skipAlphaProbe("image/png"), false);
  assert.equal(skipAlphaProbe("image/webp"), false);
  assert.equal(skipAlphaProbe("image/heic"), false);
});

test("floodPaper does not punch enclosed paper holes", () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dx = x - 24;
      const dy = y - 24;
      const r = Math.sqrt(dx * dx + dy * dy);
      const ring = r >= 8 && r < 16;
      const v = ring ? 12 : 255;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  floodPaper(data, width, height);
  assert.equal(data[3], 0);
  assert.ok((data[(24 * width + 24) * 4 + 3] ?? 0) > 200, "enclosed hole stays");
  assert.ok((data[(24 * width + 12) * 4 + 3] ?? 0) > 180, "ring stays");
});

test("multi-colored illustration with colored features is NOT treated as a graphic", () => {
  const width = 48;
  const height = 48;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      // Plain white background
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
      // Tan body
      if (x >= 12 && x < 36 && y >= 16 && y < 40) {
        data[i] = 226;
        data[i + 1] = 191;
        data[i + 2] = 167;
      }
      // Pink nose
      if (x >= 20 && x < 26 && y >= 24 && y < 28) {
        data[i] = 236;
        data[i + 1] = 75;
        data[i + 2] = 134;
      }
      // Brown ears
      if (x >= 14 && x < 22 && y >= 6 && y < 16) {
        data[i] = 150;
        data[i + 1] = 87;
        data[i + 2] = 60;
      }
    }
  }
  // Must NOT be treated as a graphic — should go to the AI model
  assert.equal(looksLikeGraphic(data, width, height), false);
});

function shadedPortraitOnWhite(width = 96, height = 96, tone: "bw" | "colour" = "bw") {
  // A photograph's subject is continuously shaded; in black and white every grey shares
  // one colour bucket, which used to make it indistinguishable from a two-colour logo.
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 12; y < height - 12; y += 1) {
    for (let x = 12; x < width - 12; x += 1) {
      const i = (y * width + x) * 4;
      const shade =
        40 + 150 * ((x - 12) / (width - 24)) + 30 * Math.sin(y * 0.3) + ((x * 7 + y * 13) % 5);
      const v = Math.max(0, Math.min(230, Math.round(shade)));
      data[i] = tone === "bw" ? v : Math.min(255, v + 30);
      data[i + 1] = tone === "bw" ? v : v;
      data[i + 2] = tone === "bw" ? v : Math.max(0, v - 40);
    }
  }
  return data;
}

test("a black-and-white photograph on white is not treated as a graphic", () => {
  assert.equal(looksLikeGraphic(shadedPortraitOnWhite(96, 96, "bw"), 96, 96), false);
  assert.equal(looksLikeGraphic(shadedPortraitOnWhite(96, 96, "colour"), 96, 96), false);
});

test("routes continuously shaded dark grayscale subjects to the model", () => {
  // Given dark shaded art whose entire foreground fits three coarse luma bands.
  const size = 96;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 18; y < 78; y += 1)
    for (let x = 18; x < 78; x += 1) {
      const i = (y * size + x) * 4;
      const shade = 20 + Math.floor(((x - 18) * 28) / 60);
      data[i] = data[i + 1] = data[i + 2] = shade;
    }
  // When classifying, then continuous shading must not be stripped as flat ink.
  assert.equal(classifyGraphic(data, size, size), null);
});

test("retains JPEG-like multitone grayscale logos with fine tonal noise", () => {
  // Given three flat gray marks with nine levels of compression noise per mark.
  const size = 96;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 24; y < 72; y += 1)
    for (let x = 18; x < 78; x += 1) {
      const i = (y * size + x) * 4;
      const shade = [24, 88, 152][Math.floor((x - 18) / 20)] ?? 24;
      const value = shade + ((x * 7 + y * 13) % 9) - 4;
      data[i] = data[i + 1] = data[i + 2] = value;
    }
  // When classifying, then narrow noisy ink clusters remain a logo.
  assert.equal(classifyGraphic(data, size, size), "logo");
});

test("tonalConcentration separates flat ink from continuous shading", () => {
  const ink = new Uint32Array(16);
  ink[0] = 900;
  ink[1] = 60;
  ink[8] = 40;
  assert.ok(tonalConcentration(ink, 1000) >= 0.9);
  const shaded = new Uint32Array(16).fill(60);
  assert.ok(tonalConcentration(shaded, 960) < 0.5);
  assert.equal(
    tonalConcentration(new Uint32Array(16), 0),
    1,
    "no foreground samples is not evidence against a graphic",
  );
});

function roundedCornerImage(size: number, cornerFrac: number) {
  const r = cornerFrac * size;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = 120;
      data[i + 1] = 90;
      data[i + 2] = 60;
      const cx = x < r ? r - x : x >= size - r ? x - (size - r) + 1 : 0;
      const cy = y < r ? r - y : y >= size - r ? y - (size - r) + 1 : 0;
      data[i + 3] = cx > 0 && cy > 0 && cx * cx + cy * cy > r * r ? 0 : 255;
    }
  }
  return data;
}

test("an opaque image with rounded corners is not treated as an existing cutout", () => {
  for (const corner of [0.15, 0.2, 0.3]) {
    assert.equal(
      looksAlreadyTransparent(roundedCornerImage(96, corner), 96, 96),
      false,
      `corner ${corner}`,
    );
  }
});

test("a real cutout whose transparency reaches an edge still passes through", () => {
  const size = 96;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = 200;
      data[i + 3] = x >= 8 && x < 88 && y >= 3 ? 255 : 0; // subject touches the bottom, clear along the top
    }
  assert.equal(looksAlreadyTransparent(data, size, size), true);
  // a small, subject-shaped transparent notch that reaches an edge midpoint also counts
  const notch = roundedCornerImage(size, 0.05);
  for (let y = 0; y < 6; y += 1) notch[(y * size + (size >> 1)) * 4 + 3] = 0;
  assert.equal(
    looksAlreadyTransparent(notch, size, size),
    false,
    "a 5% corner plus a 6px notch is still under the 2% floor",
  );
  const bigNotch = roundedCornerImage(size, 0.15);
  for (let y = 0; y < 6; y += 1) bigNotch[(y * size + (size >> 1)) * 4 + 3] = 0;
  assert.equal(
    looksAlreadyTransparent(bigNotch, size, size),
    true,
    "transparency reaching an edge midpoint is a cutout",
  );
});

function aaDisc(ink: [number, number, number], paper: [number, number, number], noise = 0) {
  const size = 120;
  const r = 38;
  const coverage = (x: number, y: number) => {
    let n = 0;
    for (let sy = 0; sy < 4; sy += 1)
      for (let sx = 0; sx < 4; sx += 1)
        if (Math.hypot(x + (sx + 0.5) / 4 - 60, y + (sy + 0.5) / 4 - 60) <= r) n += 1;
    return n / 16;
  };
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const c = coverage(x, y);
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        const jitter = noise ? ((x * 7 + y * 13 + k * 5) % (2 * noise + 1)) - noise : 0;
        data[i + k] = Math.max(
          0,
          Math.min(255, Math.round(ink[k]! * c + paper[k]! * (1 - c) + jitter)),
        );
      }
      data[i + 3] = 255;
    }
  return { data, size, coverage };
}

function rimError(
  data: Uint8ClampedArray,
  size: number,
  coverage: (x: number, y: number) => number,
) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const c = coverage(x, y);
      if (c <= 0 || c >= 1) continue;
      sum += Math.abs(data[(y * size + x) * 4 + 3]! - c * 255);
      n += 1;
    }
  return sum / n;
}

test("knockPaper recovers anti-aliased coverage for pastel and dark ink alike", () => {
  // The old colour-to-alpha rim read beige as dark ink at partial alpha: mean error 85.
  for (const [ink, noise, jpeg, bound] of [
    [[232, 196, 160], 0, false, 4],
    [[20, 20, 20], 0, false, 2],
    [[150, 100, 62], 4, true, 10],
  ] as const) {
    const { data, size, coverage } = aaDisc(
      [...ink] as [number, number, number],
      [255, 255, 255],
      noise,
    );
    knockPaper(data, size, size, { jpeg });
    const error = rimError(data, size, coverage);
    assert.ok(
      error < bound,
      `ink ${ink.join(",")}: mean alpha error ${error.toFixed(1)} exceeds ${bound}`,
    );
    assert.equal(data[(60 * size + 60) * 4 + 3], 255, "the interior stays opaque");
  }
});

test("floodPaper keeps enclosed paper-coloured details and unmixes the outer rim", () => {
  const { data, size, coverage } = aaDisc([226, 191, 167], [255, 255, 255]);
  // an enclosed white eye highlight inside the disc must survive a flood
  for (let y = 48; y < 52; y += 1)
    for (let x = 48; x < 52; x += 1) {
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    }
  floodPaper(data, size, size, { r: 255, g: 255, b: 255 });
  assert.equal(data[(50 * size + 50) * 4 + 3], 255, "enclosed highlight is kept");
  assert.equal(data[(5 * size + 5) * 4 + 3], 0, "border-connected paper is cleared");
  assert.ok(rimError(data, size, coverage) < 6, "outer rim is unmixed against the local ink");
});

test("floodPaper leaves a transparent pocket transparent and out of the rim's ink (C32)", () => {
  const clean = aaDisc([230, 120, 30], [255, 255, 255]);
  floodPaper(clean.data, clean.size, clean.size);
  // The disc's right edge on rows 58-61 falls between x = 97 and x = 98.
  const changed: string[] = [];
  for (const left of [94, 95]) {
    const { data, size } = aaDisc([230, 120, 30], [255, 255, 255]);
    const pocket = (x: number, y: number) => x >= left && x < left + 2 && y >= 58 && y < 62;
    for (let y = 58; y < 62; y += 1)
      for (let x = left; x < left + 2; x += 1)
        data.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 4);
    floodPaper(data, size, size);
    for (let y = 0; y < size; y += 1)
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        const got = [...data.subarray(i, i + 4)];
        const want = pocket(x, y) ? [0, 0, 0, 0] : [...clean.data.subarray(i, i + 4)];
        if (got.some((v, k) => v !== want[k]))
          changed.push(`pocket ${left}: ${x},${y} is ${got}, not ${want}`);
      }
  }
  assert.deepEqual(changed, []);
});

function cartoon(paper: [number, number, number], noise = 0) {
  const size = 96;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      let c: [number, number, number] = paper;
      if (Math.hypot(x - 48, y - 58) < 24) c = [226, 191, 167];
      if (Math.hypot(x - 38, y - 30) < 7 || Math.hypot(x - 58, y - 30) < 7) c = [150, 87, 60];
      if (Math.hypot(x - 48, y - 62) < 3) c = [236, 75, 134];
      if (Math.hypot(x - 41, y - 52) < 2.5) c = [20, 20, 20];
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k += 1) {
        const jitter = noise ? ((x * 7 + y * 13) % (2 * noise + 1)) - noise : 0;
        data[i + k] = Math.max(0, Math.min(255, c[k]! + jitter));
      }
      data[i + 3] = 255;
    }
  return { data, size };
}

test("colourful flat art is an illustration on white, black, grey and a green key; photos are not", () => {
  for (const paper of [
    [255, 255, 255],
    [10, 10, 10],
    [235, 235, 235],
    [0, 177, 64],
  ] as const) {
    const { data, size } = cartoon([...paper] as [number, number, number]);
    assert.equal(classifyGraphic(data, size, size), "illustration", `paper ${paper.join(",")}`);
    assert.equal(looksLikeGraphic(data, size, size), false, "it is not ink-on-paper");
  }
  const noisy = cartoon([252, 252, 252], 4);
  assert.equal(classifyGraphic(noisy.data, noisy.size, noisy.size), "illustration", "JPEG noise");
  assert.equal(classifyGraphic(shadedPortraitOnWhite(96, 96, "colour"), 96, 96), null);
  assert.equal(classifyGraphic(shadedPortraitOnWhite(96, 96, "bw"), 96, 96), null);
  const { data, width, height } = logo();
  assert.equal(classifyGraphic(data, width, height), "logo");
  // white mark on a black field is still ink on paper: counters must open
  const inverted = new Uint8ClampedArray(data);
  for (let i = 0; i < inverted.length; i += 4) {
    inverted[i] = 255 - inverted[i]!;
    inverted[i + 1] = 255 - inverted[i + 1]!;
    inverted[i + 2] = 255 - inverted[i + 2]!;
  }
  assert.equal(classifyGraphic(inverted, width, height), "logo");
});

// E10-01 (M14): intentional translucency above 2 % of the probe is returned as-is; at or below, it is cut.
test("E10-S M14: partial alpha uses strict 2 percent boundary", () => {
  const width = 100,
    height = 100;
  const paint = (partial: number) => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++)
      data.set([200, 80, 40, i < partial ? 128 : 255], i * 4);
    return data;
  };
  for (const [count, expected] of [
    [199, false],
    [200, false],
    [201, true],
    [1000, true],
  ] as const)
    assert.equal(
      looksAlreadyTransparent(paint(count), width, height),
      expected,
      `${count}/10000 partial pixels`,
    );
});

/** A hard-edged ring and bar, dark ink on white, at its own size. */
function ringBar(size: number) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const d = Math.hypot(u - 0.5, v - 0.5);
      const ink = (d > 0.28 && d < 0.36) || (Math.abs(u - 0.5) < 0.05 && v > 0.3 && v < 0.7);
      data.set(ink ? [8, 8, 8, 255] : [255, 255, 255, 255], (y * size + x) * 4);
    }
  return data;
}

/** The engine's probe: a bilinear resample to 96×96 (pixel centres aligned, edges clamped). */
function bilinearProbe(src: Uint8ClampedArray, sw: number, sh: number) {
  const dst = new Uint8ClampedArray(96 * 96 * 4);
  for (let y = 0; y < 96; y += 1)
    for (let x = 0; x < 96; x += 1) {
      const fx = Math.min(sw - 1, Math.max(0, ((x + 0.5) * sw) / 96 - 0.5));
      const fy = Math.min(sh - 1, Math.max(0, ((y + 0.5) * sh) / 96 - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = fx - x0;
      const ty = fy - y0;
      for (let c = 0; c < 4; c += 1) {
        const at = (px: number, py: number) => src[(py * sw + px) * 4 + c]!;
        dst[(y * 96 + x) * 4 + c] =
          at(x0, y0) * (1 - tx) * (1 - ty) +
          at(x1, y0) * tx * (1 - ty) +
          at(x0, y1) * (1 - tx) * ty +
          at(x1, y1) * tx * ty;
      }
    }
  return dst;
}

test("a mark the 96 px probe blurs is blurred ink, and its own pixels are a logo", () => {
  // Given hard-edged marks one pixel either side of the probe size and a few beyond it.
  for (const size of [95, 97, 101]) {
    const native = ringBar(size);
    const probe = bilinearProbe(native, size, size);
    // When the probe resamples them, then averaging ink with paper fails tonal concentration
    // alone, and the file's own pixels classify as the logo they are.
    assert.equal(classifyGraphic(probe, 96, 96), null, `${size}: probe`);
    assert.equal(blurredInk(probe, 96, 96), true, `${size}: blurred ink`);
    assert.equal(classifyGraphic(native, size, size), "logo", `${size}: native`);
  }
});

test("blurredInk never asks for a second look at photographs or at what the probe already decided", () => {
  // Shaded black-and-white and colour subjects on white: tone fails, but they are shaded or colourful.
  assert.equal(blurredInk(shadedPortraitOnWhite(96, 96, "bw"), 96, 96), false);
  assert.equal(blurredInk(shadedPortraitOnWhite(96, 96, "colour"), 96, 96), false);
  // Dark continuous shading inside three coarse bands is caught by the shading guard, not tone.
  const size = 96;
  const dark = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let y = 18; y < 78; y += 1)
    for (let x = 18; x < 78; x += 1) {
      const i = (y * size + x) * 4;
      dark[i] = dark[i + 1] = dark[i + 2] = 20 + Math.floor(((x - 18) * 28) / 60);
    }
  assert.equal(blurredInk(dark, size, size), false);
  // A photo with no uniform field.
  const noisy = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < noisy.length; i += 4)
    noisy.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i);
  assert.equal(blurredInk(noisy, size, size), false);
  // A mark the probe already reads as a logo needs no second look.
  const { data, width, height } = logo();
  assert.equal(blurredInk(data, width, height), false);
});
