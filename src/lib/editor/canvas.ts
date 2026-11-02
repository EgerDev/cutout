import { previewSized } from "./preview-bitmap-cache.ts";
import { toProcessableFile } from "../files.ts";
import { decontaminatePixels, parseHexColor } from "./decontaminate.ts";
import { applyHintMask } from "./hints.ts";
import { applyRecolors } from "./recolor.ts";
import { StrokeMask, compositeMask } from "./soft-stroke.ts";
import { resizeBitmap } from "../bitmap-resize.ts";
import { type EditSettings, type Hint, type Rect, type Stroke } from "./model.ts";

export async function pngSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (blob.size < 24) return null;
  try {
    const bytes = new Uint8Array(await blob.slice(0, 24).arrayBuffer());
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47)
      return null;
    if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52)
      return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width < 1 || height < 1 || width > 1e7 || height > 1e7) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export function canvas2d(
  width: number,
  height: number,
  settings?: CanvasRenderingContext2DSettings,
) {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const context = canvas.getContext("2d", settings);
  if (!context) throw new Error("Canvas is unavailable. Try another browser.");
  return { canvas, context };
}
/**
 * Draws `source` at width x height on a fresh CPU-backed canvas and reads its pixels.
 * Null without a 2D context (canvas memory pressure on iOS) so callers keep their fallback.
 */
export function readPixels(source: CanvasImageSource, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(source, 0, 0, width, height);
  return { canvas, context, image: context.getImageData(0, 0, width, height) };
}
/** Draws the bitmap, closes it, and encodes a PNG; null when the canvas cannot be made or encoded. */
export async function bitmapToPng(bitmap: ImageBitmap): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  context?.drawImage(bitmap, 0, 0);
  bitmap.close();
  if (!context) return null;
  try {
    return await encodeCanvas(canvas);
  } catch {
    return null;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
export function encodeCanvas(
  canvas: HTMLCanvasElement,
  mime = "image/png",
  quality?: number,
): Promise<Blob> {
  if (mime === "image/heic" || mime === "image/avif" || mime === "image/bmp")
    return import("../still-encode.ts").then((mod) =>
      mod.encodeStill(canvas, mime, quality ?? 0.92),
    );
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => {
        if (!blob || (blob.type && blob.type !== mime))
          reject(new Error("This browser cannot encode the selected format. Choose PNG."));
        else resolve(blob);
      },
      mime,
      quality,
    ),
  );
}
const sources = new WeakMap<File, Promise<File>>();
export function processable(source: File): Promise<File> {
  let pending = sources.get(source);
  if (!pending) {
    pending = toProcessableFile(source);
    sources.set(source, pending);
    pending.catch(() => sources.delete(source));
  }
  return pending;
}
export function paintStroke(
  ctx: CanvasRenderingContext2D,
  stroke: Stroke,
  source: CanvasImageSource,
  width: number,
  height: number,
) {
  const first = stroke.points[0];
  if (!first) return;
  const hardness = stroke.hardness ?? 100;
  const flow = stroke.flow ?? 100;
  if (hardness < 100 || flow < 100 || stroke.preserveDetails) {
    // At least a pixel wide, as the brush paints it live, however small the render.
    const radius = Math.max(0.5, (stroke.size * Math.min(width, height)) / 2);
    const points = stroke.points.map((p) => ({ x: p.x * width, y: p.y * height }));
    const mask = StrokeMask.around(points, radius, radius * (hardness / 100), width, height);
    mask.addAll(points);
    const rect = { x: mask.left, y: mask.top, width: mask.width, height: mask.height };
    // Flow caps the stroke's strength; the mask keeps overlaps from adding up past it.
    compositeMask(ctx, mask, rect, stroke.mode, source, Math.min(1, Math.max(0.02, flow / 100)));
    return;
  }
  ctx.save();
  ctx.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over";
  ctx.strokeStyle =
    stroke.mode === "erase" ? "#000" : (ctx.createPattern(source, "no-repeat") ?? "#000");
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = Math.max(1, stroke.size * Math.min(width, height));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(first.x * width, first.y * height);
  for (const point of stroke.points.slice(1)) ctx.lineTo(point.x * width, point.y * height);
  if (stroke.points.length === 1) {
    ctx.arc(first.x * width, first.y * height, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fill();
  } else ctx.stroke();
  ctx.restore();
}

export const MATTE_PREVIEW_MAX = 1600;
export { clearSourceBitmapCache } from "./preview-bitmap-cache.ts";
export type { SourceBitmap } from "./preview-bitmap-cache.ts";
/** The original, drawable at `width` x `height` (see previewSized). */
export function sourceBitmap(source: File, width: number, height: number) {
  return previewSized({
    slot: "source",
    key: source,
    open: () => processable(source),
    width,
    height,
    maxSide: MATTE_PREVIEW_MAX,
  });
}

/** A background image, drawable at `width` x `height`: a 12 MP backdrop was decoded
 *  in full on every shadow, scale or position tick. */
export function backgroundBitmap(image: Blob, width: number, height: number) {
  return previewSized({
    slot: "background",
    key: image,
    open: async () => image,
    width,
    height,
    maxSide: MATTE_PREVIEW_MAX,
  });
}
// ponytail: one slot, so a batch export does not keep a painted PNG per image; the
// active item's slider ticks (the case it is for) all hit it.
let brushed: {
  result: Blob;
  source: File;
  strokes: readonly Stroke[];
  pending: Promise<Blob>;
} | null = null;

/**
 * `result` with `strokes` painted in. Feather, choke, colour and decontaminate ticks keep
 * the same strokes array, so they reuse the painted matte instead of replaying up to 500
 * strokes and encoding a PNG on every tick.
 */
export function brushBlob(result: Blob, source: File, strokes: readonly Stroke[]): Promise<Blob> {
  if (strokes.length === 0) return Promise.resolve(result);
  const hit = brushed;
  if (hit?.result === result && hit.source === source && hit.strokes === strokes)
    return hit.pending;
  const pending = paintStrokes(result, source, strokes);
  brushed = { result, source, strokes, pending };
  pending.catch(() => {
    if (brushed?.pending === pending) brushed = null;
  });
  return pending;
}

async function paintStrokes(result: Blob, source: File, strokes: readonly Stroke[]): Promise<Blob> {
  const bitmap = await createImageBitmap(result);
  const { canvas, context } = canvas2d(bitmap.width, bitmap.height);
  try {
    context.drawImage(bitmap, 0, 0);
    const original = await sourceBitmap(source, canvas.width, canvas.height);
    let plate: ReturnType<typeof canvas2d> | undefined;
    try {
      plate = canvas2d(canvas.width, canvas.height);
      plate.context.drawImage(original.bitmap, 0, 0, canvas.width, canvas.height);
      for (const stroke of strokes)
        paintStroke(context, stroke, plate.canvas, canvas.width, canvas.height);
      return await encodeCanvas(canvas);
    } finally {
      original.release();
      if (plate) {
        plate.canvas.width = 0;
        plate.canvas.height = 0;
      }
    }
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
export type Matte = Readonly<{
  empty: boolean;
  /** Set when the matte exists as a file already (nothing edited, or exported before). */
  blob: Blob | null;
  /** Decoded matte, shared by every render of these settings; never close it. */
  bitmap: ImageBitmap | null;
  encode: () => Promise<Blob>;
  bounds: Rect;
  width: number;
  height: number;
}>;

/** The matte as a drawable: its shared bitmap, or a fresh decode the caller owns. */
export async function matteBitmap(matte: Matte): Promise<{ bitmap: ImageBitmap; owned: boolean }> {
  if (matte.bitmap) return { bitmap: matte.bitmap, owned: false };
  return { bitmap: await createImageBitmap(matte.blob ?? (await matte.encode())), owned: true };
}
type Cached = Readonly<{
  settings: EditSettings;
  source: File;
  tight: boolean;
  maxSide: number;
  pending: Promise<Matte>;
}>;
const mattes = new WeakMap<Blob, Cached>();
const matteInputs = new WeakMap<
  Blob,
  { maxSide: number; pending: Promise<{ blob: Blob; ratio: number }> }
>();

async function blobSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  const header = await pngSize(blob);
  if (header) return header;
  if (typeof createImageBitmap !== "function") return null;
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/**
 * One downscaled copy of the cutout per result blob. Live previews only render
 * at ~1200px, so running the full matte pipeline (brush, hints, edge ops,
 * bounds scan) on a 4000px source for every slider tick wasted most of the
 * work. The preview passes maxSide and works on this copy instead; exports
 * never do and stay pixel-exact.
 */
export function matteInputFor(
  result: Blob,
  maxSide: number,
  signal?: AbortSignal,
): Promise<{ blob: Blob; ratio: number }> {
  signal?.throwIfAborted();
  const cached = matteInputs.get(result);
  if (cached && cached.maxSide === maxSide) return cached.pending;
  // No signal inside: this run is shared by every render of `result`.
  const pending = (async () => {
    const size = await blobSize(result);
    if (!size) return { blob: result, ratio: 1 };
    const longest = Math.max(size.width, size.height);
    if (longest <= maxSide) return { blob: result, ratio: 1 };
    const ratio = maxSide / longest;
    const bitmap = await resizeBitmap(
      result,
      Math.max(1, Math.round(size.width * ratio)),
      Math.max(1, Math.round(size.height * ratio)),
      "high",
    );
    const { canvas, context } = canvas2d(bitmap.width, bitmap.height);
    try {
      context.drawImage(bitmap, 0, 0);
      return { blob: await encodeCanvas(canvas), ratio };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  })();
  matteInputs.set(result, { maxSide, pending });
  pending.catch(() => {
    const entry = matteInputs.get(result);
    if (entry?.pending === pending) matteInputs.delete(result);
  });
  return pending;
}

export function editedMatte(
  result: Blob,
  source: File,
  settings: EditSettings,
  options: Readonly<{ tight?: boolean; maxSide?: number; signal?: AbortSignal }> = {},
): Promise<Matte> {
  const wantTight = options.tight !== false;
  const maxSide = options.maxSide ?? 0;
  const signal = options.signal;
  signal?.throwIfAborted();
  const cached = mattes.get(result);
  if (
    cached &&
    cached.source === source &&
    cached.maxSide === maxSide &&
    cached.settings.strokes === settings.strokes &&
    cached.settings.hints === settings.hints &&
    cached.settings.recolors === settings.recolors &&
    cached.settings.recolorTolerance === settings.recolorTolerance &&
    cached.settings.feather === settings.feather &&
    cached.settings.choke === settings.choke &&
    cached.settings.decontaminate === settings.decontaminate &&
    cached.settings.decontaminateAmount === settings.decontaminateAmount &&
    cached.settings.decontaminateWidth === settings.decontaminateWidth &&
    cached.settings.decontaminateColor === settings.decontaminateColor &&
    (cached.tight || !wantTight)
  )
    // The cached run checks the signal of whoever started it; when that render was
    // superseded, this caller (still live) recomputes instead of failing with its abort.
    return cached.pending.catch((error: unknown) => {
      if (signal?.aborted || (error as { name?: string })?.name !== "AbortError") throw error;
      return editedMatte(result, source, settings, options);
    });
  const pending = (async () => {
    let work = result;
    let ratio = 1;
    if (maxSide) {
      const scaled = await matteInputFor(result, maxSide, signal);
      work = scaled.blob;
      ratio = scaled.ratio;
    }
    signal?.throwIfAborted();
    // Edge cleanup is 50 KB of code: load it with the first render, not with the page.
    const { alphaBounds, applyEdgeDetailed } = await import("../defringe.ts");
    const edge = await applyEdgeDetailed(
      await finishMattePixels(await brushBlob(work, source, settings.strokes), settings, ratio),
      Math.round(settings.feather * ratio),
      Math.round(settings.choke * ratio),
    );
    const shared = { blob: edge.blob, bitmap: edge.bitmap, encode: edge.encode };
    if (!wantTight) {
      const size = edge.bitmap
        ? { width: edge.width, height: edge.height }
        : edge.blob
          ? await pngSize(edge.blob)
          : null;
      if (size)
        return {
          ...shared,
          bounds: { x: 0, y: 0, width: size.width, height: size.height },
          empty: false,
          width: size.width,
          height: size.height,
        };
    }
    if (edge.bounds)
      return {
        ...shared,
        bounds: edge.bounds,
        empty: edge.empty,
        width: edge.width,
        height: edge.height,
      };
    // No edge ops ran, so the bounds scan still needs its own decode; renders
    // then share that bitmap instead of decoding the PNG again.
    const bitmap = await createImageBitmap(edge.blob ?? (await edge.encode()));
    const { canvas, context } = canvas2d(bitmap.width, bitmap.height);
    try {
      context.drawImage(bitmap, 0, 0);
      const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        ...shared,
        bitmap,
        ...alphaBounds(data, canvas.width, canvas.height),
        width: canvas.width,
        height: canvas.height,
      };
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  })();
  mattes.set(result, { source, settings, tight: wantTight, maxSide, pending });
  pending.catch(() => {
    if (mattes.get(result)?.pending === pending) mattes.delete(result);
  });
  return pending;
}

async function finishMattePixels(blob: Blob, settings: EditSettings, ratio = 1): Promise<Blob> {
  if (
    settings.hints.length === 0 &&
    settings.recolors.length === 0 &&
    settings.decontaminate === "off"
  )
    return blob;
  const bitmap = await createImageBitmap(blob);
  const { canvas, context } = canvas2d(bitmap.width, bitmap.height);
  try {
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    if (settings.hints.length) applyHintsToImage(image, settings.hints);
    if (settings.recolors.length)
      applyRecolors(image.data, settings.recolors, settings.recolorTolerance);
    if (settings.decontaminate !== "off")
      decontaminatePixels(
        image.data,
        image.width,
        image.height,
        settings.decontaminateAmount,
        Math.max(1, Math.round(settings.decontaminateWidth * ratio)),
        parseHexColor(settings.decontaminateColor),
        settings.decontaminate,
      );
    context.putImageData(image, 0, 0);
    return await encodeCanvas(canvas);
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

function applyHintsToImage(image: ImageData, hints: readonly Hint[]) {
  const alpha = new Uint8Array(image.width * image.height);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) alpha[p] = image.data[i + 3] ?? 0;
  const next = applyHintMask(alpha, image.width, image.height, hints);
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
    const value = next[p] ?? 0;
    image.data[i + 3] = value;
    if (value === 0) {
      image.data[i] = 0;
      image.data[i + 1] = 0;
      image.data[i + 2] = 0;
    }
  }
}
