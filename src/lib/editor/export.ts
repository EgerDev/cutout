import { formatHasQuality, formatMime } from "../formats.ts";
import { canvas2d, encodeCanvas, pngSize } from "./canvas.ts";
import { renderCanvas, type RenderInput } from "./render.ts";
import type { EditSettings } from "./model.ts";

export type Encoded = Readonly<{
  blob: Blob;
  width: number;
  height: number;
  quality: number | null;
  metTarget: boolean;
}>;
export function unedited(s: EditSettings) {
  return (
    s.background.type === "transparent" &&
    s.preset === "original" &&
    !s.shadow &&
    !s.feather &&
    !s.choke &&
    s.strokes.length === 0 &&
    s.hints.length === 0 &&
    s.recolors.length === 0 &&
    s.decontaminate === "off" &&
    s.scale === 100 &&
    s.rotate === 0 &&
    !s.flipX &&
    !s.matchBackground &&
    s.exportWidth === null &&
    s.exportHeight === null
  );
}

export function passthrough(s: EditSettings) {
  return s.exportFormat === "png" && s.targetKB === null && unedited(s);
}

export async function encodeExport(input: RenderInput, signal?: AbortSignal): Promise<Encoded> {
  signal?.throwIfAborted();
  if (passthrough(input.settings)) {
    const size = (await pngSize(input.result)) ?? (await bitmapSize(input.result));
    if (!size) throw new Error("This image cannot be measured for export.");
    signal?.throwIfAborted();
    return {
      blob: input.result,
      width: size.width,
      height: size.height,
      quality: null,
      metTarget: true,
    };
  }
  const canvas = await renderCanvas(input, { signal });
  const { settings: s } = input,
    mime = formatMime(s.exportFormat),
    target = s.targetKB === null ? null : s.targetKB * 1000;
  try {
    let quality = formatHasQuality(s.exportFormat) ? s.quality / 100 : null;
    let blob = await encodeCanvas(canvas, mime, quality ?? undefined);
    signal?.throwIfAborted();
    for (let resize = 0; target !== null && blob.size > target && resize <= 7; resize++) {
      if (quality !== null) {
        let low = 0.15,
          high = s.quality / 100;
        let candidate = await encodeCanvas(canvas, mime, low),
          selected = low;
        signal?.throwIfAborted();
        if (candidate.size <= target) {
          for (let step = 0; step < 6; step++) {
            const mid = (low + high) / 2,
              encoded = await encodeCanvas(canvas, mime, mid);
            signal?.throwIfAborted();
            if (encoded.size <= target) {
              candidate = encoded;
              selected = mid;
              low = mid;
            } else high = mid;
          }
          blob = candidate;
          quality = selected;
          break;
        }
        blob = candidate;
        quality = low;
      }
      // Search this candidate even after the last permitted resize.
      if (resize === 7 || canvas.width <= 32 || canvas.height <= 32) break;
      const scale = Math.min(0.85, Math.max(0.25, Math.sqrt(target / blob.size) * 0.85));
      const smaller = canvas2d(
        Math.max(1, canvas.width * scale),
        Math.max(1, canvas.height * scale),
      );
      smaller.context.imageSmoothingQuality = "high";
      smaller.context.drawImage(canvas, 0, 0, smaller.canvas.width, smaller.canvas.height);
      canvas.width = smaller.canvas.width;
      canvas.height = smaller.canvas.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas is unavailable");
      ctx.drawImage(smaller.canvas, 0, 0);
      smaller.canvas.width = 0;
      smaller.canvas.height = 0;
      quality = formatHasQuality(s.exportFormat) ? s.quality / 100 : null;
      blob = await encodeCanvas(canvas, mime, quality ?? undefined);
      signal?.throwIfAborted();
    }
    return {
      blob,
      width: canvas.width,
      height: canvas.height,
      quality,
      metTarget: target === null || blob.size <= target,
    };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function bitmapSize(blob: Blob) {
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
