export type PaletteEntry = Readonly<{
  r: number;
  g: number;
  b: number;
  hex: string;
  share: number;
}>;

export function hexOf(r: number, g: number, b: number) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The most common visible colours of a cutout: alpha-weighted 5-bit buckets, averaged, then
 * merged when closer than `merge` so anti-aliasing and JPEG noise do not
 * split one ink into several swatches. Ordered by visible coverage so translucent
 * artwork still gets swatches without faint rims outweighing solid ink.
 */
export function quantizePalette(data: Uint8ClampedArray, max = 12, merge = 28): PaletteEntry[] {
  const counts = new Float64Array(32768);
  const sumR = new Float64Array(32768),
    sumG = new Float64Array(32768),
    sumB = new Float64Array(32768);
  let opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const weight = (data[i + 3] ?? 0) / 255;
    if (weight === 0) continue;
    const r = data[i]!,
      g = data[i + 1]!,
      b = data[i + 2]!;
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    counts[key]! += weight;
    sumR[key]! += r * weight;
    sumG[key]! += g * weight;
    sumB[key]! += b * weight;
    opaque += weight;
  }
  if (!opaque) return [];
  const buckets: { r: number; g: number; b: number; n: number }[] = [];
  for (let key = 0; key < 32768; key++) {
    const n = counts[key]!;
    if (!n) continue;
    buckets.push({ r: sumR[key]! / n, g: sumG[key]! / n, b: sumB[key]! / n, n });
  }
  buckets.sort((a, b) => b.n - a.n);
  const merged: { r: number; g: number; b: number; n: number }[] = [];
  const limit = merge * merge;
  for (const bucket of buckets) {
    const near = merged.find(
      (m) => (m.r - bucket.r) ** 2 + (m.g - bucket.g) ** 2 + (m.b - bucket.b) ** 2 <= limit,
    );
    if (near) {
      const total = near.n + bucket.n;
      near.r = (near.r * near.n + bucket.r * bucket.n) / total;
      near.g = (near.g * near.n + bucket.g * bucket.n) / total;
      near.b = (near.b * near.n + bucket.b * bucket.n) / total;
      near.n = total;
    } else merged.push({ ...bucket });
  }
  merged.sort((a, b) => b.n - a.n);
  return merged
    .filter((m) => m.n / opaque >= 0.002)
    .slice(0, max)
    .map((m) => {
      const r = Math.round(m.r),
        g = Math.round(m.g),
        b = Math.round(m.b);
      return { r, g, b, hex: hexOf(r, g, b), share: m.n / opaque };
    });
}

export async function paletteOf(blob: Blob, max = 12): Promise<PaletteEntry[]> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  try {
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return quantizePalette(ctx.getImageData(0, 0, canvas.width, canvas.height).data, max);
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
