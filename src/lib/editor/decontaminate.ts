import type { DecontaminateMode } from "./model.ts";
import { dilateSquare } from "../morphology.ts";

export type SpillColor = Readonly<{ r: number; g: number; b: number }>;

export function decontaminatePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number,
  band: number,
  color: SpillColor | null,
  mode: DecontaminateMode,
) {
  if (mode === "off" || amount <= 0 || width <= 0 || height <= 0) return;
  const mix = Math.min(1, Math.max(0, amount / 100));
  const radius = Math.max(1, Math.round(band));
  const bg = mode === "auto" ? sampleSpillColor(data) : (color ?? sampleSpillColor(data));
  const edge = edgeBand(data, width, height, radius);
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const a = data[i + 3] ?? 0;
    if (a === 0 || (!edge[p] && a >= 250)) continue;
    const t = a / 255;
    const sr = data[i] ?? 0,
      sg = data[i + 1] ?? 0,
      sb = data[i + 2] ?? 0;
    const dr = unblendDelta(sr, bg.r, t),
      dg = unblendDelta(sg, bg.g, t),
      db = unblendDelta(sb, bg.b, t);
    // Move toward the unblended colour only as far as the gamut allows, scaled by the
    // amount: dividing by a small t amplifies any error in the backdrop estimate, and
    // clamping each channel on its own turned faint edge pixels black or white.
    const w = mix * Math.min(gamutLimit(sr, dr), gamutLimit(sg, dg), gamutLimit(sb, db));
    data[i] = sr + w * dr;
    data[i + 1] = sg + w * dg;
    data[i + 2] = sb + w * db;
  }
}

export function parseHexColor(value: string | null): SpillColor | null {
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) return null;
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

/** Correction this channel needs to reach the unblended colour; none when t is degenerate. */
function unblendDelta(channel: number, background: number, t: number) {
  if (t < 0.004) return 0;
  const delta = (channel - (1 - t) * background) / t - channel;
  return Number.isFinite(delta) ? delta : 0;
}

/** Largest weight in [0, 1] keeping base + weight * delta inside [0, 255]. */
function gamutLimit(base: number, delta: number) {
  if (Math.abs(delta) < 1e-6) return 1;
  const headroom = delta > 0 ? 255 - base : -base;
  const limit = headroom / delta;
  return limit <= 0 ? 0 : Math.min(1, limit);
}

function sampleSpillColor(data: Uint8ClampedArray): SpillColor {
  let r = 0,
    g = 0,
    b = 0,
    n = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0 || a > 40) continue;
    r += data[i] ?? 0;
    g += data[i + 1] ?? 0;
    b += data[i + 2] ?? 0;
    n += 1;
  }
  if (!n) return { r: 255, g: 255, b: 255 };
  return { r: r / n, g: g / n, b: b / n };
}

/**
 * Pixels with partial alpha, grown by `radius` in every direction (a square window).
 * Grown with per-row and per-column prefix sums, so the cost is linear in the pixel
 * count whatever the radius: scanning the full window per pixel took 343 ms at the
 * default width on the 1600 px preview and re-ran on every slider tick.
 */
export function edgeBand(data: Uint8ClampedArray, width: number, height: number, radius: number) {
  const mark = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const a = data[(y * width + x) * 4 + 3] ?? 0;
      if (a > 8 && a < 247) mark[y * width + x] = 1;
    }
  if (radius <= 1) return mark;
  return dilateSquare(mark, width, height, radius);
}
