import { defaultExportCaps, type ExportCaps } from "./formats.ts";

let webpProbe: boolean | undefined;
let caps: ExportCaps = defaultExportCaps;
let capsPending: Promise<ExportCaps> | null = null;

export function webpSupported() {
  if (webpProbe != null) return webpProbe;
  webpProbe = canvasMimeSupported("image/webp");
  return webpProbe;
}

export function exportCaps(): ExportCaps {
  return caps;
}

export function prepareExportCaps() {
  if (typeof document === "undefined") return Promise.resolve(caps);
  capsPending ??= (async () => {
    const { codecSupported } = await import("./still-encode.ts");
    caps = {
      webp: webpSupported(),
      avif: canvasMimeSupported("image/avif") || (await codecSupported("av01.0.04M.08")),
      heic: canvasMimeSupported("image/heic") || (await codecSupported("hvc1.1.6.L93.B0")),
    };
    return caps;
  })().catch(() => {
    // Chunk loading can fail before the probes run. Keep catch-free callers safe and
    // release our attempt so a later call can retry (the browser may still cache failure).
    capsPending = null;
    return caps;
  });
  return capsPending;
}

function canvasMimeSupported(mime: string) {
  if (typeof document === "undefined") return mime !== "image/avif" && mime !== "image/heic";
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL(mime).startsWith(`data:${mime}`);
  } catch {
    return false;
  }
}
