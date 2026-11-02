import { backgroundBitmap, canvas2d, editedMatte, matteBitmap, sourceBitmap } from "./canvas.ts";
import { inspectFill, type InspectMode } from "./inspect.ts";
import { applyColorMatch, meanOpaque, suggestMatch } from "./match-color.ts";
import { placement, trimCanvas, type EditSettings } from "./model.ts";
import { paintShadow } from "./shadow.ts";
import { gradientCss, previewBackground } from "../formats.ts";

export type RenderMode = "composite" | InspectMode;
export type RenderInput = Readonly<{ result: Blob; source: File; settings: EditSettings }>;

const backgroundBlobs = new Map<string, Promise<Blob>>();

// Live previews re-run this path on every slider tick; without the cache a
// background image without a stored blob would be re-fetched each time.
function fetchBackgroundBlob(url: string): Promise<Blob> {
  let pending = backgroundBlobs.get(url);
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error("Background image is unavailable. Choose it again.");
      return response.blob();
    });
    backgroundBlobs.set(url, pending);
    pending.catch(() => {
      if (backgroundBlobs.get(url) === pending) backgroundBlobs.delete(url);
    });
    if (backgroundBlobs.size > 8) {
      const oldest = backgroundBlobs.keys().next().value;
      if (oldest !== undefined) backgroundBlobs.delete(oldest);
    }
  }
  return pending;
}

export async function renderCanvas(
  input: RenderInput,
  options: Readonly<{
    maxSide?: number;
    matteMaxSide?: number;
    mode?: RenderMode;
    signal?: AbortSignal;
  }> = {},
) {
  const { settings: s, source, result } = input;
  const mode = options.mode ?? "composite";
  options.signal?.throwIfAborted();
  const matte = await editedMatte(result, source, s, {
    tight: s.preset !== "original" || s.shadow,
    maxSide: options.matteMaxSide,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  const trimmed = s.preset === "trim" ? trimCanvas(matte.bounds, s) : null;
  const ow = trimmed?.width ?? s.exportWidth ?? matte.width,
    oh = trimmed?.height ?? s.exportHeight ?? matte.height;
  const ratio = Math.min(1, (options.maxSide ?? Math.max(ow, oh)) / Math.max(ow, oh));
  const { canvas, context: ctx } = canvas2d(ow * ratio, oh * ratio);
  const w = canvas.width,
    h = canvas.height;
  const bounds =
    s.preset === "original"
      ? { x: 0, y: 0, width: matte.width, height: matte.height }
      : matte.bounds;
  const dest = placement(bounds, w, h, s);
  let bitmap: ImageBitmap | undefined;
  let ownsBitmap = true;
  let matched: HTMLCanvasElement | undefined;
  try {
    await paintPlate(ctx, w, h, s, source, mode, options.signal);
    options.signal?.throwIfAborted();
    const shared = await matteBitmap(matte);
    bitmap = shared.bitmap;
    ownsBitmap = shared.owned;
    if (mode !== "overlay") matched = maybeMatchSubject(bitmap, ctx, w, h, s, mode) ?? undefined;
    const drawSource = matched ?? bitmap;
    const bw = drawSource.width / matte.width,
      bh = drawSource.height / matte.height;
    if (
      !matte.empty &&
      s.shadow &&
      (mode === "composite" || mode === "checker" || mode === "white" || mode === "black")
    ) {
      paintShadow(ctx, subjectFoot(matte, dest, s), h, s, drawSource, {
        x: matte.bounds.x * bw,
        y: matte.bounds.y * bh,
        width: matte.bounds.width * bw,
        height: matte.bounds.height * bh,
      });
    }
    ctx.imageSmoothingQuality = "high";
    if (mode === "overlay") {
      const overlay = canvas2d(w, h);
      drawSubject(overlay.context, drawSource, bounds, dest, s, bw, bh);
      paintOverlay(overlay.context, w, h);
      ctx.drawImage(overlay.canvas, 0, 0);
      overlay.canvas.width = 0;
      overlay.canvas.height = 0;
    } else drawSubject(ctx, drawSource, bounds, dest, s, bw, bh);
    if (mode === "mask") paintMask(ctx, w, h);
    if (mode === "edge") paintEdgeBand(ctx, w, h);
    options.signal?.throwIfAborted();
    return canvas;
  } catch (error) {
    canvas.width = 0;
    canvas.height = 0;
    throw error;
  } finally {
    if (ownsBitmap) bitmap?.close();
    if (matched) {
      matched.width = 0;
      matched.height = 0;
    }
  }
}

function subjectFoot(
  matte: {
    bounds: { x: number; y: number; width: number; height: number };
    width: number;
    height: number;
  },
  dest: { x: number; y: number; width: number; height: number },
  s: EditSettings,
) {
  if (s.preset !== "original") return dest;
  return {
    x: dest.x + (matte.bounds.x / matte.width) * dest.width,
    y: dest.y + (matte.bounds.y / matte.height) * dest.height,
    width: (matte.bounds.width / matte.width) * dest.width,
    height: (matte.bounds.height / matte.height) * dest.height,
  };
}

function drawSubject(
  ctx: CanvasRenderingContext2D,
  bitmap: CanvasImageSource & { width: number; height: number },
  bounds: { x: number; y: number; width: number; height: number },
  dest: { x: number; y: number; width: number; height: number },
  s: EditSettings,
  bw: number,
  bh: number,
) {
  ctx.save();
  ctx.translate(dest.x + dest.width / 2, dest.y + dest.height / 2);
  ctx.rotate((s.rotate * Math.PI) / 180);
  ctx.scale(s.flipX ? -1 : 1, 1);
  ctx.drawImage(
    bitmap,
    bounds.x * bw,
    bounds.y * bh,
    bounds.width * bw,
    bounds.height * bh,
    -dest.width / 2,
    -dest.height / 2,
    dest.width,
    dest.height,
  );
  ctx.restore();
}

async function paintPlate(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: EditSettings,
  source: File,
  mode: RenderMode,
  signal?: AbortSignal,
) {
  const fill = inspectFill(mode);
  if (mode === "checker") {
    paintChecker(ctx, w, h);
    return;
  }
  if (mode === "overlay") {
    const { bitmap, release } = await sourceBitmap(source, w, h);
    try {
      const scale = Math.max(w / bitmap.width, h / bitmap.height);
      ctx.drawImage(
        bitmap,
        (w - bitmap.width * scale) / 2,
        (h - bitmap.height * scale) / 2,
        bitmap.width * scale,
        bitmap.height * scale,
      );
    } finally {
      release();
    }
    return;
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  await paintBackground(ctx, w, h, s, source, signal);
}

function paintChecker(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const cell = 16;
  for (let y = 0; y < h; y += cell)
    for (let x = 0; x < w; x += cell) {
      ctx.fillStyle = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2 ? "#e7e3d8" : "#f6f3eb";
      ctx.fillRect(x, y, cell, cell);
    }
}

function paintMask(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "destination-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
}

function paintOverlay(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "rgba(200, 32, 32, 0.45)";
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

function paintEdgeBand(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a > 8 && a < 247) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
      data[i + 3] = 255;
    } else {
      data[i] = 0;
      data[i + 1] = 0;
      data[i + 2] = 0;
      data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function maybeMatchSubject(
  bitmap: ImageBitmap,
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: EditSettings,
  mode: RenderMode,
) {
  if (!s.matchBackground || s.matchStrength <= 0) return null;
  if (s.background.type === "transparent") return null;
  if (mode !== "composite") return null;
  // Average the whole plate, scaled down, rather than its top-left corner: a photo
  // background with sky above and ground below would otherwise match to the sky.
  const sample = canvas2d(Math.min(32, w), Math.min(32, h));
  sample.context.drawImage(ctx.canvas, 0, 0, sample.canvas.width, sample.canvas.height);
  const plate = sample.context.getImageData(0, 0, sample.canvas.width, sample.canvas.height);
  sample.canvas.width = 0;
  sample.canvas.height = 0;
  const { canvas, context } = canvas2d(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const match = suggestMatch(meanOpaque(image.data), meanOpaque(plate.data));
  applyColorMatch(image.data, match, s.matchStrength);
  context.putImageData(image, 0, 0);
  return canvas;
}

async function paintBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  s: EditSettings,
  source: File,
  signal?: AbortSignal,
) {
  const bg = previewBackground(s.background, s.exportFormat);
  if (s.exportFormat === "jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
  }
  if (bg.type === "color") {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (bg.type === "gradient") {
    ctx.fillStyle = canvasGradient(ctx, w, h, bg);
    ctx.fillRect(0, 0, w, h);
    return;
  }
  if (bg.type !== "image" && bg.type !== "blur") return;
  let blob: Blob | null = null;
  if (bg.type === "image") {
    blob = s.backgroundBlob ?? (await fetchBackgroundBlob(bg.url));
    if (!blob) throw new Error("Background image is unavailable. Choose it again.");
  }
  const { bitmap, release } = blob
    ? await backgroundBitmap(blob, w, h)
    : await sourceBitmap(source, w, h);
  try {
    const scale = Math.max(w / bitmap.width, h / bitmap.height) * (bg.type === "blur" ? 1.16 : 1);
    const x = (w - bitmap.width * scale) / 2,
      y = (h - bitmap.height * scale) / 2,
      bw = bitmap.width * scale,
      bh = bitmap.height * scale;
    const radius = (s.blurAmount * w) / Math.max(1, s.exportWidth ?? w);
    if (
      bg.type === "blur" &&
      s.blurDepth &&
      (await paintDepthBlur(ctx, w, h, source, bitmap, radius, x, y, bw, bh, signal))
    )
      return;
    ctx.save();
    if (bg.type === "blur") ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(bitmap, x, y, bw, bh);
    ctx.restore();
  } finally {
    release();
  }
}

/**
 * Blur by distance: three blur strengths of the original, mixed per pixel by
 * the depth map so nearby ground and walls stay more legible than the far
 * background. Falls back to the plain blur when the model is unavailable.
 */
async function paintDepthBlur(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  source: File,
  bitmap: ImageBitmap,
  radius: number,
  x: number,
  y: number,
  bw: number,
  bh: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let depth;
  try {
    const { depthOf } = await import("./depth.ts");
    depth = await depthOf(source, undefined, signal);
  } catch {
    // Abort must not fall through to the plain blur; a live model failure still does.
    signal?.throwIfAborted();
    return false;
  }
  signal?.throwIfAborted();
  const layer = (blur: number) => {
    const { canvas, context } = canvas2d(w, h);
    context.filter = `blur(${Math.max(0.3, blur)}px)`;
    context.drawImage(bitmap, x, y, bw, bh);
    const data = context.getImageData(0, 0, w, h).data;
    canvas.width = 0;
    canvas.height = 0;
    return data;
  };
  const { blendByDepth } = await import("./depth.ts");
  const out = ctx.createImageData(w, h);
  blendByDepth(out.data, layer(radius * 0.25), layer(radius * 0.6), layer(radius), w, h, depth);
  signal?.throwIfAborted();
  ctx.putImageData(out, 0, 0);
  return true;
}

/**
 * Canvas equivalent of `linear-gradient(angle, from, to)`: 0deg points up and
 * angles turn clockwise, and the line spans the corners like CSS does.
 */
export function canvasGradient(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bg: { from: string; to: string; angle: number },
) {
  const rad = ((bg.angle % 360) * Math.PI) / 180;
  const dx = Math.sin(rad),
    dy = -Math.cos(rad);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const cx = w / 2,
    cy = h / 2;
  const gradient = ctx.createLinearGradient(
    cx - dx * half,
    cy - dy * half,
    cx + dx * half,
    cy + dy * half,
  );
  gradient.addColorStop(0, bg.from);
  gradient.addColorStop(1, bg.to);
  return gradient;
}
export { gradientCss };
