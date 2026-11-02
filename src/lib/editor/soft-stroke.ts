/** Canvas-pixel point. */
type Px = Readonly<{ x: number; y: number }>;
export type PixelRect = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Coverage 0..1 at distance `d` from the stroke's spine: solid to `inner`, smooth to 0 at `radius`. */
export function falloff(d: number, inner: number, radius: number): number {
  if (d <= inner) return 1;
  if (d >= radius) return 0;
  const t = (radius - d) / Math.max(1e-6, radius - inner);
  return t * t * (3 - 2 * t);
}

/**
 * A soft stroke's coverage over part of the canvas (0..255 per pixel). Each pixel
 * keeps the strongest coverage of any segment, so where segments overlap the
 * stroke never builds up past its edge profile, however slowly it was drawn.
 */
export class StrokeMask {
  readonly data: Uint8ClampedArray;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly inner: number;
  constructor(
    left: number,
    top: number,
    width: number,
    height: number,
    radius: number,
    inner: number,
  ) {
    this.left = left;
    this.top = top;
    this.width = width;
    this.height = height;
    this.radius = radius;
    this.inner = inner;
    this.data = new Uint8ClampedArray(Math.max(0, width * height));
  }

  /** Adds the segment a→b (a dab when a = b); returns the canvas area it changed. */
  add(a: Px, b: Px): PixelRect | null {
    const { radius, inner, left, top, width, height, data } = this;
    const x0 = Math.max(left, Math.floor(Math.min(a.x, b.x) - radius)),
      y0 = Math.max(top, Math.floor(Math.min(a.y, b.y) - radius)),
      x1 = Math.min(left + width, Math.ceil(Math.max(a.x, b.x) + radius)),
      y1 = Math.min(top + height, Math.ceil(Math.max(a.y, b.y) + radius));
    if (x1 <= x0 || y1 <= y0) return null;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      length2 = dx * dx + dy * dy;
    for (let y = y0; y < y1; y += 1) {
      const py = y + 0.5;
      for (let x = x0; x < x1; x += 1) {
        const px = x + 0.5;
        const t = length2
          ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / length2))
          : 0;
        const d = Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
        if (d >= radius) continue;
        const value = falloff(d, inner, radius) * 255;
        const i = (y - top) * width + (x - left);
        if (value > (data[i] ?? 0)) data[i] = value;
      }
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** Every segment of a stroke given in canvas pixels. */
  addAll(points: readonly Px[]) {
    const first = points[0];
    if (!first) return;
    if (points.length === 1) this.add(first, first);
    for (let i = 1; i < points.length; i += 1) this.add(points[i - 1]!, points[i]!);
  }

  /** A mask just big enough for these canvas-pixel points, clipped to the canvas. */
  static around(
    points: readonly Px[],
    radius: number,
    inner: number,
    canvasWidth: number,
    canvasHeight: number,
  ): StrokeMask {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    const left = Math.max(0, Math.floor(minX - radius)),
      top = Math.max(0, Math.floor(minY - radius)),
      right = Math.min(canvasWidth, Math.ceil(maxX + radius)),
      bottom = Math.min(canvasHeight, Math.ceil(maxY + radius));
    return new StrokeMask(
      left,
      top,
      Math.max(0, right - left),
      Math.max(0, bottom - top),
      radius,
      inner,
    );
  }
}

/**
 * Applies `rect` of the mask to the canvas: erase cuts the matte by the mask,
 * restore paints `source` (the original, canvas-sized) back through it.
 * `opacity` caps the whole stroke without letting overlaps add up.
 */
export function compositeMask(
  ctx: CanvasRenderingContext2D,
  mask: StrokeMask,
  rect: PixelRect,
  mode: "erase" | "restore",
  source: CanvasImageSource,
  opacity = 1,
) {
  const { x, y, width, height } = rect;
  if (width <= 0 || height <= 0) return;
  const image = new ImageData(width, height);
  for (let row = 0; row < height; row += 1)
    for (let col = 0; col < width; col += 1) {
      const value = mask.data[(y - mask.top + row) * mask.width + (x - mask.left + col)] ?? 0;
      image.data[(row * width + col) * 4 + 3] = value * opacity;
    }
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const layerCtx = layer.getContext("2d");
  if (!layerCtx) return;
  ctx.save();
  if (mode === "erase") {
    layerCtx.putImageData(image, 0, 0);
    ctx.globalCompositeOperation = "destination-out";
  } else {
    const alpha = document.createElement("canvas");
    alpha.width = width;
    alpha.height = height;
    alpha.getContext("2d")?.putImageData(image, 0, 0);
    layerCtx.drawImage(source, x, y, width, height, 0, 0, width, height);
    layerCtx.globalCompositeOperation = "destination-in";
    layerCtx.drawImage(alpha, 0, 0);
    alpha.width = alpha.height = 0;
    ctx.globalCompositeOperation = "source-over";
  }
  ctx.drawImage(layer, x, y);
  ctx.restore();
  layer.width = layer.height = 0;
}
