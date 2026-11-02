import { clampByte } from "./byte.ts";
export { clampByte } from "./byte.ts";
import { encodeCanvas, readPixels } from "./editor/canvas.ts";
import { dilateSquare } from "./morphology.ts";

export function opaqueFraction(data: Uint8ClampedArray) {
  if (!data.length) return 0;
  let n = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 16) n += 1;
  return n / (data.length / 4);
}

/**
 * A file that already carries a cutout should pass through untouched. Its transparent
 * area is either substantial or reaches the middle of an edge; partial-alpha art
 * also keeps its intentional translucency. An opaque image whose
 * only transparency is rounded corners does neither, and at a 15% corner radius that
 * alone crossed the old 2% floor and skipped background removal entirely.
 */
export function looksAlreadyTransparent(data: Uint8ClampedArray, width = 0, height = 0) {
  if (!data.length) return false;
  const frac = opaqueFraction(data);
  let partial = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i]! > 16 && data[i]! < 250) partial += 1;
  if (partial / (data.length / 4) > 0.02) return true;
  if (frac >= 0.98) return false;
  if (frac <= 0.85) return true;
  if (width <= 0 || height <= 0 || width * height * 4 !== data.length) return true;
  return transparentAtEdgeMiddle(data, width, height);
}

function transparentAtEdgeMiddle(data: Uint8ClampedArray, width: number, height: number) {
  const cx = width >> 1;
  const cy = height >> 1;
  const reach = Math.max(1, Math.round(Math.min(width, height) * 0.1));
  const clear = (x: number, y: number) => data[(y * width + x) * 4 + 3]! <= 16;
  for (let d = 0; d < reach; d += 1) {
    if (clear(cx, d) || clear(cx, height - 1 - d) || clear(d, cy) || clear(width - 1 - d, cy))
      return true;
  }
  return false;
}

/** JPEG has no alpha; skip the 96px passthrough probe. */
export function skipAlphaProbe(type: string) {
  return /(?:image\/)?(?:pjpeg|jpe?g)$/i.test(type.trim());
}

export type GraphicKind = "logo" | "illustration";

/**
 * Flat art on a uniform field. "logo": ink on paper (achromatic marks, letter
 * counters must open), cut by keying every paper-coloured pixel. "illustration":
 * colourful flat art (clip art, cartoons), cut by flooding paper in from the
 * border so enclosed paper-coloured details (eye highlights, teeth) survive.
 * null: a photograph or shaded art, for the model.
 *
 * The field may be any colour: white paper, a black backdrop, a green key.
 * What separates flat art from a photo is tonal concentration (see
 * tonalConcentration) and a tiny colour palette, not the field's brightness.
 */
export function classifyGraphic(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): GraphicKind | null {
  const e = graphicEvidence(data, width, height);
  if (!e.uniformField) return null;
  if (e.fgSamples < 4) return null;
  if (e.concentration < 0.9) return null;
  // Dark photographs can fit entirely in three coarse luma bands. Within each
  // substantial band, flat ink (including modest JPEG noise) still clusters;
  // continuous shading spreads across most of its sixteen individual tones.
  if (e.shaded) return null;
  // Achromatic marks are ink: key every field-coloured pixel so counters open,
  // whatever the field's colour. Coloured flat art keeps its enclosed field.
  if (e.unique <= 16 && e.chromaticFrac <= 0.1) return "logo";
  // Super-resolved or JPEG flat art picks up ringing colours; photos sit at 55+.
  if (e.unique <= 32) return "illustration";
  return null;
}

/**
 * Ink on paper that a resampled probe blurred: every logo test passes except tonal
 * concentration. The engine's probe is a bilinear 96 px resample, and averaging ink with
 * paper along every edge turns a small or squashed mark's strokes into intermediate tones
 * (a 95 px hard-edged mark, a 240×80 wordmark). Those images deserve a look at their own
 * pixels; a photograph that fails here is shaded or colourful and is never re-read.
 */
export function blurredInk(data: Uint8ClampedArray, width: number, height: number) {
  const e = graphicEvidence(data, width, height);
  return (
    e.uniformField &&
    e.fgSamples >= 4 &&
    e.concentration < 0.9 &&
    !e.shaded &&
    e.unique <= 16 &&
    e.chromaticFrac <= 0.1
  );
}

function graphicEvidence(data: Uint8ClampedArray, width: number, height: number) {
  const field = sampleBorder(data, width, height);
  const seen = new Uint8Array(512);
  let unique = 0;
  let fieldHits = 0;
  let samples = 0;
  let chromaticSamples = 0;
  let fgSamples = 0;
  const fgTones = new Uint32Array(16);
  const fineTones = new Uint32Array(256);
  const near = 36 * 36;
  const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      if (!seen[key]) {
        seen[key] = 1;
        unique += 1;
      }
      const dr = r - field.r;
      const dg = g - field.g;
      const db = b - field.b;
      if (dr * dr + dg * dg + db * db <= near) {
        fieldHits += 1;
      } else {
        fgSamples += 1;
        const chroma = Math.max(r, g, b) - Math.min(r, g, b);
        if (chroma > 18) chromaticSamples += 1;
        const luma = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
        fgTones[luma >> 4] += 1;
        fineTones[luma] += 1;
      }
      samples += 1;
    }
  }
  const fieldFrac = fieldHits / Math.max(1, samples);
  const chromaticFrac = chromaticSamples / Math.max(1, fgSamples);
  return {
    uniformField: fieldFrac >= 0.28 && field.coverage >= 0.4 && field.std <= 14,
    fgSamples,
    concentration: tonalConcentration(fgTones, fgSamples),
    shaded: chromaticFrac <= 0.1 && hasContinuousTonalShading(fineTones, fgSamples),
    unique,
    chromaticFrac,
  };
}

/**
 * Share of foreground samples sitting in the three most common of sixteen luma bands.
 * Ink on paper concentrates in one or two bands (anti-aliasing and JPEG noise only
 * smear the neighbours), while a photograph spreads its shading across most of them.
 * The colour-bucket count alone cannot tell these apart for achromatic images: every
 * grey lies on the r = g = b diagonal, so a black-and-white portrait or a silver product
 * shot on white collapses to a handful of buckets and reads as a logo.
 */
export function tonalConcentration(tones: Uint32Array, total: number) {
  if (total <= 0) return 1;
  let first = 0;
  let second = 0;
  let third = 0;
  for (const count of tones) {
    if (count > first) {
      third = second;
      second = first;
      first = count;
    } else if (count > second) {
      third = second;
      second = count;
    } else if (count > third) {
      third = count;
    }
  }
  return (first + second + third) / total;
}

/** Fine tonal spread distinguishes dark shading from ink within a coarse luma band. */
export function hasContinuousTonalShading(tones: Uint32Array, samples: number) {
  if (samples <= 0) return false;
  for (let band = 0; band < 16; band += 1) {
    const counts = tones.subarray(band * 16, band * 16 + 16);
    let count = 0;
    for (const value of counts) count += value;
    if (count >= samples * 0.1 && tonalConcentration(counts, count) < 0.3) return true;
  }
  return false;
}

export async function cutoutGraphic(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const read = readPixels(bitmap, width, height);
  bitmap.close();
  if (!read) return null;
  const { canvas, context: ctx, image } = read;
  const backup = new Uint8ClampedArray(image.data);
  const field = sampleBorder(image.data, width, height);
  try {
    const wasm = await import("./knock-wasm.ts");
    await wasm.ensureKnockWasm();
    wasm.knockPaperWasm(image.data, width, height, field);
  } catch {
    image.data.set(backup);
  }
  const jpeg = /jpe?g/i.test(file.type);
  stripPaper(image.data, width, height, field, { jpeg });
  if (opaqueFraction(image.data) < 0.002) {
    image.data.set(backup);
    stripPaper(image.data, width, height, field, { jpeg });
  }
  if (opaqueFraction(image.data) < 0.002) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await encodeCanvas(canvas).catch(() => null);
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return { blob, width, height };
}

export type PaperField = { r: number; g: number; b: number };

export function knockPaper(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: { jpeg?: boolean },
) {
  stripPaper(data, width, height, sampleBorder(data, width, height), opts);
}

/** Connected flood from the border. Recovers a matte when the model mask is empty
 *  without punching enclosed holes the way stripPaper does. */
export function floodPaper(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  field?: PaperField,
  opts?: { jpeg?: boolean },
) {
  const paper = field ?? sampleBorder(data, width, height);
  const fr = paper.r;
  const fg = paper.g;
  const fb = paper.b;
  const connect2 = (opts?.jpeg ? 40 : 38) ** 2;
  const n = width * height;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  let top = 0;
  const dist2px = (i: number) => {
    const dr = data[i]! - fr;
    const dg = data[i + 1]! - fg;
    const db = data[i + 2]! - fb;
    return dr * dr + dg * dg + db * db;
  };
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    if (dist2px(p * 4) > connect2) return;
    visited[p] = 1;
    stack[top++] = p;
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  // First pass: mark every border-connected paper-like pixel.
  const flooded = new Uint8Array(n);
  while (top) {
    const p = stack[--top]!;
    flooded[p] = 1;
    const x = p % width;
    const y = (p / width) | 0;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  // Second pass: only the band two pixels either side of the flood boundary
  // holds mixes of paper and ink; unmix it against the ink beside each pixel.
  // Deep in the flood is pure paper and is simply cleared.
  const src = new Uint8ClampedArray(data);
  const minAlpha = opts?.jpeg ? 12 : 6;
  const unflooded = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) unflooded[p] = flooded[p] ? 0 : 1;
  const nearUnflooded = dilateSquare(unflooded, width, height, 2);
  const nearFlood = dilateSquare(flooded, width, height, 2);
  for (let p = 0; p < n; p += 1) {
    const i = p * 4;
    if (flooded[p]) {
      if (!nearUnflooded[p]) {
        data.fill(0, i, i + 4);
        continue;
      }
    } else if (!nearFlood[p]) continue;
    // A transparent source pixel (a pocket the art already cut) is no mix of paper and
    // ink. Unmixing its RGB, (0,0,0) once decoded, made it an opaque black speck.
    if (src[i + 3] === 0) {
      data.fill(0, i, i + 4);
      continue;
    }
    const mixed = unmixRimPixel(
      src,
      width,
      height,
      p % width,
      (p / width) | 0,
      paper,
      minAlpha,
      flooded,
    );
    data[i] = mixed.r;
    data[i + 1] = mixed.g;
    data[i + 2] = mixed.b;
    data[i + 3] = mixed.a;
  }
}

export async function cutoutByFlood(
  file: Blob,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (typeof document === "undefined") return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const width = bitmap.width;
  const height = bitmap.height;
  const read = readPixels(bitmap, width, height);
  bitmap.close();
  if (!read) return null;
  const { canvas, context: ctx, image } = read;
  floodPaper(image.data, width, height, sampleBorder(image.data, width, height), {
    jpeg: /jpe?g/i.test(file.type),
  });
  const frac = opaqueFraction(image.data);
  if (frac < 0.008 || frac > 0.995) {
    canvas.width = 0;
    canvas.height = 0;
    return null;
  }
  ctx.putImageData(image, 0, 0);
  const blob = await encodeCanvas(canvas).catch(() => null);
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) return null;
  return { blob, width, height };
}

/** Knock page color and unblend it out of the anti-aliased rim.
 *  RGB-distance keying leaves gray mix (ink + paper) as opaque white dust.
 *  JPEG clipart also has a warm chroma fringe that is not a mix of ink and paper —
 *  those pixels are assigned to paper or ink by local color, not by CTA alone.
 */
export function stripPaper(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  field: PaperField,
  opts?: { jpeg?: boolean },
) {
  const jpeg = Boolean(opts?.jpeg);
  const minAlpha = jpeg ? 18 : 6;
  const paperDist2 = (jpeg ? 36 : 14) * (jpeg ? 36 : 14);

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 16) {
      data.fill(0, i, i + 4);
      continue;
    }
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const cta = colorToAlpha(r, g, b, field);
    if (dist2(r, g, b, field) <= paperDist2 || cta.a <= minAlpha) data.fill(0, i, i + 4);
  }
  classifyMixedRim(data, width, height, field, { jpeg, minAlpha });
}

/**
 * Pixels next to cleared paper are mixes of paper and the subject's own colour.
 * colorToAlpha assumes the subject is as far from paper as possible, so a pastel
 * subject on white read as dark ink at partial alpha: a beige rabbit lost its rim
 * to alpha 91 and its anti-aliasing to alpha 0. Unmix against the ink colour
 * found nearby instead, which recovers coverage exactly for flat art of any
 * colour and falls back to colorToAlpha only when no ink is in reach.
 */
function classifyMixedRim(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  field: PaperField,
  opts?: { jpeg?: boolean; minAlpha?: number },
) {
  const minAlpha = opts?.minAlpha ?? (opts?.jpeg ? 18 : 6);
  const src = new Uint8ClampedArray(data);
  const clear = new Uint8Array(width * height);
  for (let p = 0, i = 3; p < clear.length; p += 1, i += 4) clear[p] = src[i]! === 0 ? 1 : 0;
  const rim = dilateSquare(clear, width, height, 2);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      if (clear[p] || !rim[p]) continue;
      const i = p * 4;
      const mixed = unmixRimPixel(src, width, height, x, y, field, minAlpha);
      data[i] = mixed.r;
      data[i + 1] = mixed.g;
      data[i + 2] = mixed.b;
      data[i + 3] = mixed.a;
    }
  }
}

const INK_MIN_DIST2 = 40 * 40;

/** The most paper-unlike visible pixel within `radius`: the local ink colour. */
function localInk(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  field: PaperField,
  radius: number,
  skip?: Uint8Array,
): PaperField | null {
  let best = INK_MIN_DIST2;
  let ink: PaperField | null = null;
  for (let oy = -radius; oy <= radius; oy += 1) {
    const ny = y + oy;
    if (ny < 0 || ny >= height) continue;
    for (let ox = -radius; ox <= radius; ox += 1) {
      // The pixel itself is what we are explaining; a lone speck must not be its own ink.
      if (!ox && !oy) continue;
      const nx = x + ox;
      if (nx < 0 || nx >= width) continue;
      const np = ny * width + nx;
      // A transparent pixel is never ink, flooded or not: as (0,0,0) it is the farthest
      // colour from a light field and crushed every rim mix toward black.
      if (skip?.[np] || src[np * 4 + 3]! === 0) continue;
      const ni = np * 4;
      const d = dist2(src[ni]!, src[ni + 1]!, src[ni + 2]!, field);
      if (d > best) {
        best = d;
        ink = { r: src[ni]!, g: src[ni + 1]!, b: src[ni + 2]! };
      }
    }
  }
  return ink;
}

/**
 * Coverage of `ink` over `paper` that best explains the pixel: the projection of
 * (pixel - paper) onto (ink - paper). Pure ink is 1, pure paper is 0.
 */
function mixToward(r: number, g: number, b: number, ink: PaperField, paper: PaperField) {
  const ir = ink.r - paper.r;
  const ig = ink.g - paper.g;
  const ib = ink.b - paper.b;
  const len2 = ir * ir + ig * ig + ib * ib;
  if (len2 < 1) return 1;
  const t = ((r - paper.r) * ir + (g - paper.g) * ig + (b - paper.b) * ib) / len2;
  return Math.max(0, Math.min(1, t));
}

function unmixRimPixel(
  src: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  field: PaperField,
  minAlpha: number,
  skip?: Uint8Array,
) {
  const i = (y * width + x) * 4;
  const sr = src[i]!;
  const sg = src[i + 1]!;
  const sb = src[i + 2]!;
  const ink = localInk(src, width, height, x, y, field, 3, skip);
  if (!ink) {
    // No ink within reach: a faint mark here is paper dust or JPEG ringing, not a
    // subject edge. Only a strong mark of its own survives, by colour-to-alpha.
    const cta = colorToAlpha(sr, sg, sb, field);
    if (cta.a < 60) return { r: 0, g: 0, b: 0, a: 0 };
    const smoothA = Math.min(255, Math.round(((cta.a - minAlpha) / (255 - minAlpha)) * 255));
    return { r: cta.r, g: cta.g, b: cta.b, a: smoothA };
  }
  const t = mixToward(sr, sg, sb, ink, field);
  const a = Math.round(t * 255);
  if (a <= minAlpha) return { r: 0, g: 0, b: 0, a: 0 };
  if (t >= 0.999) return { r: sr, g: sg, b: sb, a: 255 };
  return { ...unblendRgb(sr, sg, sb, field.r, field.g, field.b, t), a };
}

/**
 * Recovers the foreground colour of a pixel composited as src = fg * t + bg * (1 - t).
 *
 * Solving directly gives (src - bg * (1 - t)) / t, which amplifies by 1/t: at low t any
 * noise in src or in the estimated backdrop throws channels far outside [0, 255], where
 * per-channel clamping crushes them toward black and destroys the hue (a recovered hair
 * strand at t = 0.12 turns sooty rather than staying fur-coloured). Instead we travel from
 * the observed colour toward that solution only as far as the gamut cube allows, so the
 * correction keeps its direction and decays to the observed colour as t approaches zero.
 */
export function unblendRgb(
  sr: number,
  sg: number,
  sb: number,
  br: number,
  bg: number,
  bb: number,
  t: number,
) {
  const a = Math.max(t, 0.004);
  const dr = unblendDelta(sr, br, a);
  const dg = unblendDelta(sg, bg, a);
  const db = unblendDelta(sb, bb, a);
  const w = Math.min(gamutLimit(sr, dr), gamutLimit(sg, dg), gamutLimit(sb, db));
  return {
    r: clampByte(sr + w * dr),
    g: clampByte(sg + w * dg),
    b: clampByte(sb + w * db),
  };
}

/** Correction this channel would need to reach the unblended solution, 0 when undefined. */
function unblendDelta(src: number, bg: number, t: number) {
  const delta = (src - bg * (1 - t)) / t - src;
  return Number.isFinite(delta) ? delta : 0;
}

/** Largest weight in [0, 1] keeping base + weight * delta inside [0, 255]. */
function gamutLimit(base: number, delta: number) {
  if (Math.abs(delta) < 1e-6) return 1;
  const headroom = delta > 0 ? 255 - base : -base;
  const limit = headroom / delta;
  return limit <= 0 ? 0 : Math.min(1, limit);
}

export function colorToAlpha(sr: number, sg: number, sb: number, bg: PaperField) {
  const ar = channelAlpha(sr, bg.r);
  const ag = channelAlpha(sg, bg.g);
  const ab = channelAlpha(sb, bg.b);
  const a = Math.max(ar, ag, ab);
  if (a < 0.004) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: unblendChannel(sr, bg.r, a),
    g: unblendChannel(sg, bg.g, a),
    b: unblendChannel(sb, bg.b, a),
    a: clampByte(a * 255),
  };
}

function channelAlpha(src: number, bg: number) {
  if (Math.abs(src - bg) < 0.5) return 0;
  if (src > bg) return (src - bg) / Math.max(1e-6, 255 - bg);
  return (bg - src) / Math.max(1e-6, bg);
}

function unblendChannel(src: number, bg: number, t: number) {
  return clampByte((src - bg * (1 - t)) / t);
}

export function dist2(r: number, g: number, b: number, field: PaperField) {
  const dr = r - field.r;
  const dg = g - field.g;
  const db = b - field.b;
  return dr * dr + dg * dg + db * db;
}

export function sampleBorder(data: Uint8ClampedArray, width: number, height: number) {
  const counts = new Uint32Array(512);
  const sumsR = new Float64Array(512);
  const sumsG = new Float64Array(512);
  const sumsB = new Float64Array(512);
  let total = 0;
  const add = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const r = data[i]!;
    const g = data[i + 1]!;
    const b = data[i + 2]!;
    const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    counts[key] += 1;
    sumsR[key] += r;
    sumsG[key] += g;
    sumsB[key] += b;
    total += 1;
  };
  const stepX = Math.max(1, Math.floor(width / 96));
  const stepY = Math.max(1, Math.floor(height / 96));
  for (let x = 0; x < width; x += stepX) {
    add(x, 0);
    add(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    add(0, y);
    add(width - 1, y);
  }
  let best = 0;
  for (let k = 1; k < counts.length; k += 1) {
    if (counts[k]! > counts[best]!) best = k;
  }
  const n = counts[best] || 1;
  const r = sumsR[best]! / n;
  const g = sumsG[best]! / n;
  const b = sumsB[best]! / n;
  // The winning bucket anchors the field, but nearby samples can straddle its
  // quantization boundaries. Average those samples together and measure their
  // actual coverage/spread so a uniform noisy backdrop remains one field.
  let varSum = 0;
  let varN = 0;
  let fieldR = 0;
  let fieldG = 0;
  let fieldB = 0;
  const note = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    const d = dist2(data[i]!, data[i + 1]!, data[i + 2]!, { r, g, b });
    if (d > 1800) return;
    varSum += d;
    varN += 1;
    fieldR += data[i]!;
    fieldG += data[i + 1]!;
    fieldB += data[i + 2]!;
  };
  for (let x = 0; x < width; x += stepX) {
    note(x, 0);
    note(x, height - 1);
  }
  for (let y = 0; y < height; y += stepY) {
    note(0, y);
    note(width - 1, y);
  }
  const field = varN ? { r: fieldR / varN, g: fieldG / varN, b: fieldB / varN } : { r, g, b };
  const variance = varN ? varSum / varN - dist2(field.r, field.g, field.b, { r, g, b }) : 0;
  return {
    ...field,
    coverage: varN / Math.max(1, total),
    std: Math.sqrt(Math.max(0, variance) / 3),
  };
}
