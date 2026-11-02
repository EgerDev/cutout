import type { Hint, Point } from "./model.ts";
import { labelComponents, type MaskComponent } from "../removal-diagnostics.ts";

const FOREGROUND = 24;
/** Disc for one clicked piece: a pixel or two at typical render sizes. */
export const PICK_SIZE = 0.002;

/** The cutout's separate pieces: `labels[i]` is 1 + the component index, 0 for background. */
export type Pieces = Readonly<{
  components: readonly MaskComponent[];
  labels: Int32Array;
  width: number;
  height: number;
}>;

export function labelPieces(alpha: Uint8Array, width: number, height: number): Pieces {
  return { ...labelComponents(alpha, width, height), width, height };
}

/** `removed[i]` is true when the hints clear component i (label i + 1). */
export function removedPieces(pieces: Pieces, hints: readonly Hint[]): boolean[] {
  const { components } = pieces;
  const hit = (kind: Hint["kind"]) =>
    components.map((_, index) =>
      hints.some((hint) => hint.kind === kind && hitsComponent(pieces, index, hint)),
    );
  const keep = hit("keep"),
    remove = hit("remove");
  const anyKeep = keep.some(Boolean);
  return components.map((_, index) => Boolean(remove[index] || (anyKeep && !keep[index])));
}

export function applyHintMask(
  alpha: Uint8Array,
  width: number,
  height: number,
  hints: readonly Hint[],
): Uint8Array {
  if (!hints.length || width <= 0 || height <= 0) return alpha;
  const pieces = labelPieces(alpha, width, height);
  if (!pieces.components.length) return alpha;
  const removed = removedPieces(pieces, hints);
  const next = alpha.slice();
  removed.forEach((gone, index) => {
    if (gone) clearComponent(next, pieces, index);
  });
  return next;
}

/**
 * Hints after removing (or bringing back) the picked pieces. Each pick is a
 * label and a point on that piece's own pixels. Bringing a piece back drops the
 * remove points that hit it, then adds a keep point if a keep-only still hides it.
 */
export function setPieces(
  pieces: Pieces,
  hints: readonly Hint[],
  picks: readonly { label: number; point: Point }[],
  remove: boolean,
): readonly Hint[] {
  const removed = removedPieces(pieces, hints);
  // ponytail: a saved hint holds 4096 points; past that, the rest need a second pass.
  const targets = picks.filter((pick) => removed[pick.label - 1] !== remove).slice(0, 4096);
  if (!targets.length) return hints;
  if (remove) return [...hints, pickHint(pieces, "remove", targets)];
  const indices = targets.map((t) => t.label - 1);
  let next: readonly Hint[] = hints.flatMap((hint) => {
    if (hint.kind !== "remove") return [hint];
    const kept = hint.points.flatMap((point, i) => {
      const one = { ...hint, points: [point], areas: hint.areas && [hint.areas[i] ?? 0] };
      return indices.some((index) => hitsComponent(pieces, index, one)) ? [] : [i];
    });
    if (kept.length === hint.points.length) return [hint];
    if (!kept.length) return [];
    const areas = hint.areas;
    return [
      {
        ...hint,
        points: kept.map((i) => hint.points[i]!),
        ...(areas ? { areas: kept.map((i) => areas[i] ?? 0) } : {}),
      },
    ];
  });
  const still = removedPieces(pieces, next);
  const preserved = pieces.components.flatMap((_, index) => {
    if (!removed[index] || still[index] || indices.includes(index)) return [];
    const point = pieceCenter(pieces, index);
    return point ? [{ label: index + 1, point }] : [];
  });
  if (preserved.length) next = [...next, pickHint(pieces, "remove", preserved)];
  const hidden = targets.filter((t) => still[t.label - 1]);
  if (hidden.length) next = [...next, pickHint(pieces, "keep", hidden)];
  return next;
}

/** Keep only the biggest piece: one keep point in its middle, which no speck can steal. */
export function keepLargest(pieces: Pieces): readonly Hint[] {
  let largest = -1;
  pieces.components.forEach((c, i) => {
    if (largest < 0 || c.pixels > (pieces.components[largest]?.pixels ?? 0)) largest = i;
  });
  const point = pieceCenter(pieces, largest);
  return point ? [pickHint(pieces, "keep", [{ label: largest + 1, point }])] : [];
}

function pickHint(
  pieces: Pieces,
  kind: Hint["kind"],
  picks: readonly { label: number; point: Point }[],
): Hint {
  const total = pieces.width * pieces.height;
  return {
    kind,
    size: PICK_SIZE,
    points: picks.map((p) => p.point),
    areas: picks.map((p) => (pieces.components[p.label - 1]?.pixels ?? 0) / total),
  };
}

/** The piece's pixel nearest its box centre: inside the piece, away from its rim. */
function pieceCenter(pieces: Pieces, index: number): Point | null {
  const c = pieces.components[index];
  if (!c) return null;
  const mx = (c.left + c.right) / 2,
    my = (c.top + c.bottom) / 2;
  let best: Point | null = null,
    bestD = Infinity;
  for (let y = c.top; y <= c.bottom; y += 1)
    for (let x = c.left; x <= c.right; x += 1) {
      if (pieces.labels[y * pieces.width + x] !== index + 1) continue;
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bestD) {
        bestD = d;
        best = { x: (x + 0.5) / pieces.width, y: (y + 0.5) / pieces.height };
      }
    }
  return best;
}

/**
 * The piece under (x, y) in pixels, or the nearest one within `reach` pixels,
 * with a point on that piece's own pixels (so the hint lands on it).
 */
export function pieceAt(
  pieces: Pieces,
  x: number,
  y: number,
  reach: number,
): { label: number; point: Point } | null {
  const { labels, width, height } = pieces;
  const cx = Math.floor(x),
    cy = Math.floor(y);
  let best: { label: number; px: number; py: number; d: number } | null = null;
  const r = Math.max(0, Math.ceil(reach));
  for (let py = Math.max(0, cy - r); py <= Math.min(height - 1, cy + r); py += 1)
    for (let px = Math.max(0, cx - r); px <= Math.min(width - 1, cx + r); px += 1) {
      const label = labels[py * width + px] ?? 0;
      if (!label) continue;
      const d = (px - cx) ** 2 + (py - cy) ** 2;
      if (d <= r * r && (!best || d < best.d)) best = { label, px, py, d };
    }
  if (!best) return null;
  return {
    label: best.label,
    point: { x: (best.px + 0.5) / width, y: (best.py + 0.5) / height },
  };
}

/**
 * A hint hits a component when the brush disc covers one of that component's own
 * pixels. Testing against the bounding box instead let a tap in the empty corner of
 * an L-shaped subject select it, and let one subject's box swallow another.
 */
function hitsComponent(pieces: Pieces, index: number, hint: Hint) {
  const { components, labels, width, height } = pieces;
  const component = components[index];
  if (!component) return false;
  const label = index + 1;
  // At least the pixel the point falls in, however small this render is.
  const radius = Math.max(0.75, (hint.size * Math.min(width, height)) / 2);
  const radius2 = radius * radius;
  const share = component.pixels / (width * height);
  for (const [i, point] of hint.points.entries()) {
    const area = hint.areas?.[i];
    // A pick only acts on a piece of about the size it was made on (3x either way).
    if (area !== undefined && (share > area * 3 + 0.0005 || share < area / 3 - 0.0005)) continue;
    const px = point.x * width;
    const py = point.y * height;
    // A saved piece pick belongs to the pixel it lands on; the disc is only a
    // fallback when resizing leaves that pixel transparent.
    const centerLabel =
      px >= 0 && px < width && py >= 0 && py < height
        ? (labels[Math.floor(py) * width + Math.floor(px)] ?? 0)
        : 0;
    if (area !== undefined && centerLabel && centerLabel !== label) continue;
    // Cheap reject on the box before scanning the disc.
    const nearestX = Math.max(component.left + 0.5, Math.min(component.right + 0.5, px));
    const nearestY = Math.max(component.top + 0.5, Math.min(component.bottom + 0.5, py));
    const bx = px - nearestX,
      by = py - nearestY;
    if (bx * bx + by * by > radius2) continue;
    const x0 = Math.max(component.left, Math.floor(px - radius)),
      x1 = Math.min(component.right, Math.ceil(px + radius)),
      y0 = Math.max(component.top, Math.floor(py - radius)),
      y1 = Math.min(component.bottom, Math.ceil(py + radius));
    for (let y = y0; y <= y1; y += 1) {
      const dy = y + 0.5 - py;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x + 0.5 - px;
        if (dx * dx + dy * dy <= radius2 && labels[y * width + x] === label) return true;
      }
    }
  }
  return false;
}

function clearComponent(alpha: Uint8Array, pieces: Pieces, index: number) {
  const { components, labels, width } = pieces;
  const component = components[index];
  if (!component) return;
  const label = index + 1;
  for (let y = component.top; y <= component.bottom; y += 1)
    for (let x = component.left; x <= component.right; x += 1) {
      const i = y * width + x;
      if (labels[i] === label && (alpha[i] ?? 0) > FOREGROUND) alpha[i] = 0;
    }
}
