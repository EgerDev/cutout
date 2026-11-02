import { MATTE_PREVIEW_MAX } from "./canvas.ts";
import type { EditSettings } from "./model.ts";
import { inspectQuality } from "./quality.ts";

export async function inspectEditedQuality(
  result: Blob,
  source: File,
  settings: EditSettings,
  sourceWidth: number,
  sourceHeight: number,
  encoded?: Readonly<{ width: number; height: number; metTarget: boolean; reduced?: boolean }>,
) {
  const { alpha, width, height } = await editedAlpha(result, source, settings);
  return inspectQuality({ alpha, width, height, sourceWidth, sourceHeight, settings, encoded });
}

export async function editedAlpha(result: Blob, source: File, settings: EditSettings, max = 256) {
  // Framing warnings describe the output. The source matte can touch its original
  // border while fitting comfortably inside a padded preset (or the reverse).
  const { renderCanvas } = await import("./render.ts");
  const canvas = await renderCanvas(
    {
      result,
      source,
      settings: {
        ...settings,
        background: { type: "transparent" },
        exportFormat: "png",
        shadow: false,
        matchBackground: false,
      },
    },
    { maxSide: max, matteMaxSide: MATTE_PREVIEW_MAX },
  );
  try {
    const width = canvas.width,
      height = canvas.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas is unavailable. Try another browser.");
    const pixels = context.getImageData(0, 0, width, height).data;
    const alpha = new Uint8Array(width * height);
    for (let p = 0; p < alpha.length; p++) alpha[p] = pixels[p * 4 + 3] ?? 0;
    return { alpha, width, height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** Areas to check on the current cutout, at 384 px so small specks still register. */
export async function inspectCheckAreas(result: Blob, source: File, settings: EditSettings) {
  const { findCheckAreas } = await import("./check-areas.ts");
  const { alpha, width, height } = await editedAlpha(result, source, settings, 384);
  return findCheckAreas(alpha, width, height);
}
