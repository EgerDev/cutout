import { listComponents, type MaskComponent } from "../removal-diagnostics.ts";

export type CheckKind = "soft" | "speck" | "hole";
/** A place worth a look before exporting, in 0..1 image coordinates. */
export type CheckArea = Readonly<{
  kind: CheckKind;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export const CHECK_LABELS: Readonly<Record<CheckKind, string>> = {
  soft: "Soft edge",
  speck: "Speck",
  hole: "Hole",
};

const FOREGROUND = 8;
const CELL = 12;

/**
 * Where the matte is least certain: leftover specks, transparent holes inside
 * the subject, and edge stretches that are mostly partial alpha (hair the model
 * was unsure about, or a halo). Boxes are normalised so any view can draw them.
 */
export function findCheckAreas(alpha: Uint8Array, width: number, height: number): CheckArea[] {
  if (width <= 0 || height <= 0 || alpha.length !== width * height) return [];
  const pixels = width * height;
  const out: CheckArea[] = [];
  const box = (kind: CheckKind, c: MaskComponent, pad = 2): CheckArea => {
    const left = Math.max(0, c.left - pad),
      top = Math.max(0, c.top - pad);
    const right = Math.min(width, c.right + 1 + pad),
      bottom = Math.min(height, c.bottom + 1 + pad);
    return {
      kind,
      x: left / width,
      y: top / height,
      width: (right - left) / width,
      height: (bottom - top) / height,
    };
  };

  const components = listComponents(alpha, width, height, 1);
  const largest = components.reduce((max, c) => Math.max(max, c.pixels), 0);
  for (const c of components)
    if (c.pixels < largest * 0.02 && c.pixels < pixels * 0.0015 && out.length < 6)
      out.push(box("speck", c));

  // Holes: transparent regions not connected to the border.
  const inverted = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) inverted[i] = alpha[i]! > FOREGROUND ? 0 : 255;
  const border = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let head = 0,
    tail = 0;
  const push = (i: number) => {
    if (border[i] || !inverted[i]) return;
    border[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const i = queue[head++]!;
    const x = i % width;
    if (x > 0) push(i - 1);
    if (x + 1 < width) push(i + 1);
    if (i >= width) push(i - width);
    if (i + width < pixels) push(i + width);
  }
  for (let i = 0; i < pixels; i++) if (border[i]) inverted[i] = 0;
  let holes = 0;
  for (const c of listComponents(inverted, width, height, 3)) {
    if (c.pixels > pixels * 0.04 || holes >= 4) continue;
    out.push(box("hole", c));
    holes += 1;
  }

  // Soft edges: cells where partial alpha dominates the edge band.
  const cols = Math.ceil(width / CELL),
    rows = Math.ceil(height / CELL);
  const soft = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      let partial = 0,
        edge = 0;
      for (let y = cy * CELL; y < Math.min(height, (cy + 1) * CELL); y++)
        for (let x = cx * CELL; x < Math.min(width, (cx + 1) * CELL); x++) {
          const a = alpha[y * width + x]!;
          if (a > FOREGROUND) {
            edge += 1;
            if (a < 200) partial += 1;
          }
        }
      if (edge >= CELL * 2 && partial / edge > 0.45) soft[cy * cols + cx] = 255;
    }
  const softBoxes = listComponents(soft, cols, rows, 2)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, 5);
  for (const c of softBoxes)
    out.push({
      kind: "soft",
      x: (c.left * CELL) / width,
      y: (c.top * CELL) / height,
      width: (Math.min(width, (c.right + 1) * CELL) - c.left * CELL) / width,
      height: (Math.min(height, (c.bottom + 1) * CELL) - c.top * CELL) / height,
    });
  return out;
}
