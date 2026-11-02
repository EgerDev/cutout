import { clampByte } from "../byte.ts";
import { parseHexColor } from "./decontaminate.ts";

/** Replace `from` with `to`; `to: null` knocks the colour out (transparent). */
export type Recolor = Readonly<{ from: string; to: string | null }>;

/**
 * Applies colour swaps and knock-outs to a cutout's pixels. A pixel closer to
 * `from` than `tolerance` is swapped outright; between one and two tolerances
 * it is treated as a mix of that colour and its neighbour's, so anti-aliased
 * rims and JPEG noise follow the swap without a hard fringe. Knock-outs unmix
 * the rim pixel from the removed colour the way the paper key does, so the
 * remaining colour keeps its own hue at partial alpha.
 */
export function applyRecolors(
  data: Uint8ClampedArray,
  recolors: readonly Recolor[],
  tolerance: number,
) {
  const rules = recolors.flatMap((rule) => {
    const from = parseHexColor(rule.from);
    if (!from) return [];
    const to = rule.to === null ? null : parseHexColor(rule.to);
    if (rule.to !== null && !to) return [];
    return [{ from, to }];
  });
  if (!rules.length) return;
  const tol = Math.max(1, tolerance);
  const inner = tol * tol,
    outer = 4 * tol * tol;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0) continue;
    const r = data[i]!,
      g = data[i + 1]!,
      b = data[i + 2]!;
    for (const { from, to } of rules) {
      const d2 = (r - from.r) ** 2 + (g - from.g) ** 2 + (b - from.b) ** 2;
      if (d2 > outer) continue;
      // Share of this pixel that is the matched colour: 1 inside, fading to 0 at 2x.
      const d = Math.sqrt(d2);
      const t = d2 <= inner ? 1 : Math.max(0, Math.min(1, (2 * tol - d) / tol));
      if (to) {
        data[i] = r + (to.r - from.r) * t;
        data[i + 1] = g + (to.g - from.g) * t;
        data[i + 2] = b + (to.b - from.b) * t;
      } else {
        const keep = 1 - t;
        if (keep <= 0.004) {
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 0;
        } else {
          // Unmix the remaining colour from the removed one at coverage `keep`.
          data[i] = clampByte((r - from.r * t) / keep);
          data[i + 1] = clampByte((g - from.g * t) / keep);
          data[i + 2] = clampByte((b - from.b * t) / keep);
          data[i + 3] = clampByte(a * keep);
        }
      }
      break;
    }
  }
}
