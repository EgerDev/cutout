import type { ShareResult } from "./share-ready.ts";

const PNG_DOT = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
);

export function canShareFiles() {
  if (typeof navigator === "undefined" || typeof navigator.share !== "function") return false;
  try {
    const file = new File([PNG_DOT], "cutout.png", { type: "image/png" });
    if (typeof navigator.canShare === "function") return navigator.canShare({ files: [file] });
    return true;
  } catch {
    return false;
  }
}

export function mimeForFilename(filename: string) {
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  if (filename.endsWith(".avif")) return "image/avif";
  if (filename.endsWith(".heic") || filename.endsWith(".heif")) return "image/heic";
  if (filename.endsWith(".bmp")) return "image/bmp";
  return "image/png";
}

export function isSaveAbort(error: unknown) {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

export async function shareFiles(files: File[], signal?: AbortSignal): Promise<ShareResult> {
  if (signal?.aborted) return "aborted";
  if (!files.length || !canShareFiles()) return "unsupported";
  try {
    if (typeof navigator.canShare === "function" && !navigator.canShare({ files })) {
      return "unsupported";
    }
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      const { requestShare } = await import("./share-ready.ts");
      return requestShare(files, signal);
    }
    if (signal?.aborted) return "aborted";
    await navigator.share({
      files,
      title:
        files.length === 1 ? files[0]?.name.replace(/\.[^.]+$/, "") : `${files.length} cutouts`,
    });
    if (signal?.aborted) return "aborted";
    return "shared";
  } catch (error) {
    if (signal?.aborted) return "aborted";
    if (isSaveAbort(error)) return "aborted";
    if (error instanceof Error && error.name === "NotAllowedError") {
      const { requestShare } = await import("./share-ready.ts");
      return requestShare(files, signal);
    }
    return "unsupported";
  }
}

export async function shareBlob(blob: Blob, filename: string, signal?: AbortSignal) {
  return shareFiles(
    [new File([blob], filename, { type: blob.type || mimeForFilename(filename) })],
    signal,
  );
}
