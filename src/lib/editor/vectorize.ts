import tracer, { type TraceOptions } from "imagetracerjs";
import { canvas2d } from "./canvas.ts";

export type VectorOptions = Readonly<{
  /** Palette size; flat art rarely needs more than 16. */
  colors?: number;
  /** Smaller is more faithful, larger is smoother (imagetracer ltres/qtres). */
  smoothing?: number;
  /** Drop speckles with fewer points than this. */
  minPath?: number;
}>;

/**
 * Traces a cutout's pixels into an SVG of filled paths, one layer per palette
 * colour, skipping the transparent layer so the file holds only the subject.
 */
export function vectorizeRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: VectorOptions = {},
): string {
  const colors = Math.max(2, Math.min(64, Math.round(options.colors ?? 16)));
  const smoothing = Math.max(0.2, Math.min(4, options.smoothing ?? 1));
  const traceOptions: TraceOptions = {
    ltres: smoothing,
    qtres: smoothing,
    pathomit: Math.max(0, Math.round(options.minPath ?? 8)),
    // One extra slot so transparency gets its own palette entry and does not
    // pull a subject colour toward black.
    numberofcolors: colors + 1,
    colorquantcycles: 3,
    colorsampling: 2,
    strokewidth: 1,
    roundcoords: 1,
    viewbox: true,
  };
  // The tracer averages transparent pixels' black RGB into rims; give them the
  // colour of their nearest opaque neighbour first so edges keep their hue.
  const work = new Uint8ClampedArray(data);
  bleedEdges(work, width, height);
  const traced = tracer.imagedataToTracedata({ width, height, data: work }, traceOptions);
  const filled = tracer.checkoptions(traceOptions);
  let body = "";
  for (let layer = 0; layer < traced.layers.length; layer++) {
    const color = traced.palette[layer];
    if (!color || color.a < 96) continue;
    const paths = traced.layers[layer] ?? [];
    for (let index = 0; index < paths.length; index++) {
      if (paths[index]?.isholepath) continue;
      body += tracer.svgpathstring(traced, layer, index, filled);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    body +
    "</svg>"
  );
}

/** Copies each opaque rim pixel's colour into its transparent neighbours (one ring). */
function bleedEdges(data: Uint8ClampedArray, width: number, height: number) {
  const src = new Uint8ClampedArray(data);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if ((src[i + 3] ?? 0) > 0) continue;
      let best = -1;
      for (let dy = -1; dy <= 1 && best < 0; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const j = (ny * width + nx) * 4;
          if ((src[j + 3] ?? 0) > 128) {
            best = j;
            break;
          }
        }
      if (best >= 0) {
        data[i] = src[best]!;
        data[i + 1] = src[best + 1]!;
        data[i + 2] = src[best + 2]!;
      }
    }
}

/** Vectorises a cutout blob; traces at most `maxSide` px for speed (SVG scales anyway). */
export async function vectorizeBlob(
  blob: Blob,
  options: VectorOptions & { maxSide?: number } = {},
) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, (options.maxSide ?? 1024) / Math.max(bitmap.width, bitmap.height));
  const { canvas, context } = canvas2d(bitmap.width * scale, bitmap.height * scale);
  try {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const svg = vectorizeRgba(image.data, canvas.width, canvas.height, options);
    return new Blob([svg], { type: "image/svg+xml" });
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}
