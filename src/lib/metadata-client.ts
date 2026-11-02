import type { MetadataReport } from "./metadata.ts";

// Blob identity ties cache lifetime to the queue without retaining discarded images.
const reports = new WeakMap<Blob, Promise<MetadataReport>>();

export function inspectImageMetadata(file: Blob): Promise<MetadataReport> {
  const cached = reports.get(file);
  if (cached) return cached;
  const pending = import("./metadata.ts").then((module) => module.inspectImageMetadata(file));
  reports.set(file, pending);
  // A failed chunk load can be retried when the panel is reopened.
  void pending.catch(() => reports.delete(file));
  return pending;
}

// Stripping code loads only when a download asks for it.
export async function stripOriginalMetadata(blob: Blob): Promise<Blob> {
  const module = await import("./metadata.ts");
  return module.stripOriginalMetadata(blob);
}

export async function downscaleNotice(original: Blob, cleaned: Blob): Promise<string | null> {
  const module = await import("./metadata.ts");
  return module.downscaleNotice(original, cleaned);
}

export async function stripExportMetadata(blob: Blob): Promise<Blob> {
  const module = await import("./metadata.ts");
  return module.stripExportMetadata(blob);
}

const CLEANED_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The extension follows the cleaned bytes, never the incoming (possibly hostile) name. */
export function cleanedFilename(name: string, mime: string) {
  const base = name.replace(/\.[^.]+$/, "") || "image";
  return `${base}-cleaned.${CLEANED_EXTENSIONS[mime] ?? "png"}`;
}
