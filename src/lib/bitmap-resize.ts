/**
 * Downscaling that works on every engine. Safari ignores createImageBitmap's
 * resizeWidth/resizeHeight options rather than rejecting them, so a call that
 * "resizes" returns the full bitmap and every memory guard built on it is a no-op
 * on iPhone, iPad and Mac Safari. Probe once, and fall back to canvas scaling.
 */

let supportProbe: Promise<boolean> | null = null;

function bitmapResizeSupported(): Promise<boolean> {
  supportProbe ??= (async () => {
    if (typeof createImageBitmap !== "function" || typeof ImageData === "undefined") return false;
    try {
      const probe = await createImageBitmap(new ImageData(2, 2), {
        resizeWidth: 1,
        resizeHeight: 1,
      });
      const ok = probe.width === 1 && probe.height === 1;
      probe.close();
      return ok;
    } catch {
      return false;
    }
  })();
  return supportProbe;
}

export type ResizeQuality = "pixelated" | "low" | "medium" | "high";

/**
 * Returns a bitmap of exactly width x height from any bitmap source. The source
 * bitmap is not closed. Throws if no scaling path is available.
 */
export async function resizeBitmap(
  source: ImageBitmapSource,
  width: number,
  height: number,
  quality: ResizeQuality = "high",
): Promise<ImageBitmap> {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  if (await bitmapResizeSupported()) {
    const out = await createImageBitmap(source, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: quality,
    });
    if (out.width === w && out.height === h) return out;
    out.close();
  }
  return resizeWithCanvas(source, w, h, quality);
}

function makeCanvas(width: number, height: number) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error("No canvas available to resize the image.");
}

function drawScaled(
  source: CanvasImageSource,
  width: number,
  height: number,
  quality: ResizeQuality,
) {
  const canvas = makeCanvas(width, height);
  const context = canvas.getContext("2d") as
    OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!context) throw new Error("Canvas is unavailable. Try another browser.");
  context.imageSmoothingEnabled = quality !== "pixelated";
  context.imageSmoothingQuality = quality === "pixelated" ? "low" : quality;
  context.drawImage(source, 0, 0, width, height);
  return canvas;
}

/**
 * Halve step by step until within 2x of the target, then finish in one draw: a single
 * bilinear draw from a 12 MP photo to a 96 px probe aliases badly, and Safari's
 * drawImage is bilinear.
 */
export function resizeSteps(fromW: number, fromH: number, toW: number, toH: number) {
  const steps: Array<[number, number]> = [];
  let w = fromW;
  let h = fromH;
  while (w > toW * 2 && h > toH * 2) {
    w = Math.max(toW, Math.floor(w / 2));
    h = Math.max(toH, Math.floor(h / 2));
    steps.push([w, h]);
  }
  if (!steps.length || steps[steps.length - 1]![0] !== toW || steps[steps.length - 1]![1] !== toH)
    steps.push([toW, toH]);
  return steps;
}

async function resizeWithCanvas(
  source: ImageBitmapSource,
  width: number,
  height: number,
  quality: ResizeQuality,
): Promise<ImageBitmap> {
  const owned = !(source instanceof ImageBitmap);
  const bitmap = source instanceof ImageBitmap ? source : await createImageBitmap(source);
  try {
    let current: CanvasImageSource = bitmap;
    let previous: ReturnType<typeof makeCanvas> | null = null;
    for (const [w, h] of resizeSteps(bitmap.width, bitmap.height, width, height)) {
      const canvas = drawScaled(current, w, h, quality);
      if (previous) release(previous);
      previous = canvas;
      current = canvas;
    }
    const out = await createImageBitmap(current as ImageBitmapSource);
    if (previous) release(previous);
    return out;
  } finally {
    if (owned) bitmap.close();
  }
}

function release(canvas: ReturnType<typeof makeCanvas>) {
  canvas.width = 0;
  canvas.height = 0;
}
