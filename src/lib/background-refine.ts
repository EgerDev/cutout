import { canvas2d, encodeCanvas } from "./editor/canvas.ts";
import {
  analyzeRemovalMask,
  type RemovalCrop,
  type RemovalDiagnostics,
} from "./removal-diagnostics.ts";

export type CropInference = (input: Blob, index: number, total: number) => Promise<Blob | null>;

export type RefineRemovalOptions = Readonly<{
  maxCrops: number;
  crops?: readonly RemovalCrop[];
  signal?: AbortSignal;
  infer: CropInference;
}>;

export type RefinedRemoval = Readonly<{
  blob: Blob;
  diagnostics: RemovalDiagnostics;
  refinements: number;
}>;

const PROBE_MAX_SIDE = 192;

export async function refineRemoval(
  source: Blob,
  base: Blob,
  options: RefineRemovalOptions,
): Promise<RefinedRemoval> {
  options.signal?.throwIfAborted();
  const baseBitmap = await createImageBitmap(base);
  const probeScale = Math.min(1, PROBE_MAX_SIDE / Math.max(baseBitmap.width, baseBitmap.height));
  const probe = canvas2d(baseBitmap.width * probeScale, baseBitmap.height * probeScale);
  try {
    probe.context.drawImage(baseBitmap, 0, 0, probe.canvas.width, probe.canvas.height);
    const pixels = probe.context.getImageData(0, 0, probe.canvas.width, probe.canvas.height).data;
    const alpha = new Uint8Array(probe.canvas.width * probe.canvas.height);
    for (let index = 0; index < alpha.length; index += 1) alpha[index] = pixels[index * 4 + 3] ?? 0;
    const diagnostics = analyzeRemovalMask(
      alpha,
      probe.canvas.width,
      probe.canvas.height,
      options.maxCrops,
    );
    const crops = options.crops?.length ? options.crops : diagnostics.crops;
    if (crops.length === 0) return { blob: base, diagnostics, refinements: 0 };

    options.signal?.throwIfAborted();
    const sourceBitmap = await createImageBitmap(source, { imageOrientation: "from-image" });
    try {
      const output = canvas2d(baseBitmap.width, baseBitmap.height);
      try {
        output.context.drawImage(baseBitmap, 0, 0);
        let refinements = 0;
        for (let index = 0; index < crops.length; index += 1) {
          options.signal?.throwIfAborted();
          const crop = crops[index];
          if (!crop) continue;
          const sourceBounds = pixelBounds(crop, sourceBitmap.width, sourceBitmap.height);
          const baseBounds = pixelBounds(crop, output.canvas.width, output.canvas.height);
          const { x, y, width, height } = sourceBounds;
          const input = canvas2d(width, height);
          try {
            input.context.drawImage(sourceBitmap, x, y, width, height, 0, 0, width, height);
            const refinedBlob = await options.infer(
              await encodeCanvas(input.canvas),
              index,
              crops.length,
            );
            options.signal?.throwIfAborted();
            if (!refinedBlob) continue;
            const refinedBitmap = await createImageBitmap(refinedBlob);
            try {
              if (!hasForeground(refinedBitmap)) continue;
              const patch = canvas2d(baseBounds.width, baseBounds.height);
              try {
                patch.context.drawImage(refinedBitmap, 0, 0, baseBounds.width, baseBounds.height);
                const refined = patch.context.getImageData(
                  0,
                  0,
                  baseBounds.width,
                  baseBounds.height,
                );
                const current = output.context.getImageData(
                  baseBounds.x,
                  baseBounds.y,
                  baseBounds.width,
                  baseBounds.height,
                );
                featherInto(current.data, refined.data, baseBounds.width, baseBounds.height);
                output.context.putImageData(current, baseBounds.x, baseBounds.y);
              } finally {
                patch.canvas.width = 0;
                patch.canvas.height = 0;
              }
              refinements += 1;
            } finally {
              refinedBitmap.close();
            }
          } finally {
            input.canvas.width = 0;
            input.canvas.height = 0;
          }
        }
        if (refinements === 0) return { blob: base, diagnostics, refinements };
        return { blob: await encodeCanvas(output.canvas), diagnostics, refinements };
      } finally {
        output.canvas.width = 0;
        output.canvas.height = 0;
      }
    } finally {
      sourceBitmap.close();
    }
  } finally {
    baseBitmap.close();
    probe.canvas.width = 0;
    probe.canvas.height = 0;
  }
}

/**
 * Composites a re-inferred crop over the base cutout, ramping from the base at the
 * crop's edge to the refined result over a band just inside it. Pasting the crop as
 * an opaque rectangle left a visible seam wherever the two mattes disagreed at the
 * boundary, and for user-drawn boxes that cut through the subject it cut the matte.
 * Straight-alpha blending: colour is weighted by each source's alpha so a transparent
 * side never bleeds its (zeroed) colour into the other.
 */
export function featherInto(
  base: Uint8ClampedArray,
  refined: Uint8ClampedArray,
  width: number,
  height: number,
  band = featherBand(width, height),
) {
  for (let y = 0; y < height; y += 1) {
    const wy = Math.min(1, Math.min(y + 1, height - y) / band);
    for (let x = 0; x < width; x += 1) {
      const w = Math.min(wy, Math.min(1, Math.min(x + 1, width - x) / band));
      const i = (y * width + x) * 4;
      if (w >= 1) {
        base[i] = refined[i]!;
        base[i + 1] = refined[i + 1]!;
        base[i + 2] = refined[i + 2]!;
        base[i + 3] = refined[i + 3]!;
        continue;
      }
      const ra = refined[i + 3]! * w;
      const ba = base[i + 3]! * (1 - w);
      const alpha = ra + ba;
      if (alpha <= 0) {
        base.fill(0, i, i + 4);
        continue;
      }
      base[i] = (refined[i]! * ra + base[i]! * ba) / alpha;
      base[i + 1] = (refined[i + 1]! * ra + base[i + 1]! * ba) / alpha;
      base[i + 2] = (refined[i + 2]! * ra + base[i + 2]! * ba) / alpha;
      base[i + 3] = alpha;
    }
  }
}

/** Ramp width: a tenth of the shorter side, kept between 4 and 24 pixels. */
export function featherBand(width: number, height: number) {
  return Math.max(4, Math.min(24, Math.round(Math.min(width, height) * 0.1)));
}

function hasForeground(bitmap: ImageBitmap) {
  const scale = Math.min(1, 64 / Math.max(bitmap.width, bitmap.height));
  const probe = canvas2d(bitmap.width * scale, bitmap.height * scale);
  try {
    probe.context.drawImage(bitmap, 0, 0, probe.canvas.width, probe.canvas.height);
    const pixels = probe.context.getImageData(0, 0, probe.canvas.width, probe.canvas.height).data;
    let foreground = 0;
    for (let index = 3; index < pixels.length; index += 4)
      if ((pixels[index] ?? 0) > 8) foreground += 1;
    return foreground >= Math.max(2, Math.floor((pixels.length / 4) * 0.002));
  } finally {
    probe.canvas.width = 0;
    probe.canvas.height = 0;
  }
}

export function pixelBounds(crop: RemovalCrop, width: number, height: number) {
  if (width <= 0 || height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const cropX = Math.max(0, Math.min(1, Number.isFinite(crop.x) ? crop.x : 0));
  const cropY = Math.max(0, Math.min(1, Number.isFinite(crop.y) ? crop.y : 0));
  const cropW = Math.max(0, Math.min(1 - cropX, Number.isFinite(crop.width) ? crop.width : 0));
  const cropH = Math.max(0, Math.min(1 - cropY, Number.isFinite(crop.height) ? crop.height : 0));
  const x = Math.max(0, Math.min(width - 1, Math.floor(cropX * width)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(cropY * height)));
  const right = Math.max(x + 1, Math.min(width, Math.ceil((cropX + cropW) * width)));
  const bottom = Math.max(y + 1, Math.min(height, Math.ceil((cropY + cropH) * height)));
  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y),
  };
}
