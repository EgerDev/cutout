export type ExportFormat = "png" | "webp" | "avif" | "heic" | "jpeg" | "bmp";
export type ExportCaps = Readonly<{ webp: boolean; avif: boolean; heic: boolean }>;
export const defaultExportCaps: ExportCaps = { webp: true, avif: false, heic: false };
export type BackgroundMode =
  | { type: "transparent" }
  | { type: "color"; color: string }
  | { type: "blur" }
  | { type: "gradient"; from: string; to: string; angle: number }
  | { type: "image"; url: string };

/** CSS for a gradient background, shared by the swatch and the live preview. */
export function gradientCss(bg: { from: string; to: string; angle: number }) {
  return `linear-gradient(${bg.angle}deg, ${bg.from}, ${bg.to})`;
}

export function exportFormats(caps: ExportCaps): ExportFormat[] {
  const formats: ExportFormat[] = ["png"];
  if (caps.webp) formats.push("webp");
  if (caps.avif) formats.push("avif");
  if (caps.heic) formats.push("heic");
  formats.push("jpeg", "bmp");
  return formats;
}

export function formatLabel(format: ExportFormat) {
  if (format === "jpeg") return "JPG";
  if (format === "webp") return "WebP";
  if (format === "avif") return "AVIF";
  if (format === "heic") return "HEIC";
  if (format === "bmp") return "BMP";
  return "PNG";
}

export function formatExtension(format: ExportFormat) {
  if (format === "jpeg") return "jpg";
  return format;
}

export function formatMime(format: ExportFormat) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "webp") return "image/webp";
  if (format === "avif") return "image/avif";
  if (format === "heic") return "image/heic";
  if (format === "bmp") return "image/bmp";
  return "image/png";
}

export function formatTrait(format: ExportFormat) {
  return format === "jpeg" || format === "avif" ? "Solid background" : "Transparency";
}

export function formatHasQuality(format: ExportFormat) {
  return format === "jpeg" || format === "webp" || format === "avif" || format === "heic";
}

export function previewBackground(
  background: BackgroundMode,
  format: ExportFormat,
): BackgroundMode {
  if (format === "jpeg" && background.type === "transparent") {
    return { type: "color", color: "#ffffff" };
  }
  return background;
}

/** Container from a file's first bytes, for when its MIME type is missing or wrong. */
export function sniffImage(bytes: Uint8Array): "png" | "jpeg" | "webp" | "tiff" | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  const magic = ascii(0, 4);
  if (magic === "\x89PNG") return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (magic === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  // Classic and BigTIFF, both byte orders.
  if (["II*\0", "II+\0", "MM\0*", "MM\0+"].includes(magic)) return "tiff";
  return null;
}
