import { Zip, ZipPassThrough } from "fflate";
import { uniqueNames } from "./model.ts";
import { encodeExport } from "./export.ts";
import type { RenderInput } from "./render.ts";
import type { ExportFormat } from "../formats.ts";
import { formatExtension } from "../formats.ts";

export async function createArchive(
  items: readonly (RenderInput & { readonly name: string })[],
  format: ExportFormat,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  if (!items.length) throw new Error("Select at least one ready image.");
  // Blob parts copy each chunk out of the JS heap, so the ZIP is held once, not twice.
  const parts: Blob[] = [];
  let failure: Error | null = null,
    totalBytes = 0;
  const zip = new Zip((error, data) => {
    if (error) {
      failure = error;
      return;
    }
    totalBytes += data.byteLength;
    if (totalBytes > 200_000_000) {
      failure = new Error("This ZIP exceeds 200 MB. Export a smaller selection.");
      return;
    }
    parts.push(new Blob([data]));
  });
  const names = uniqueNames(
    items.map((i) => i.name),
    formatExtension(format),
  );
  try {
    for (const [index, item] of items.entries()) {
      signal.throwIfAborted();
      const encoded = await encodeExport(
        { ...item, settings: { ...item.settings, exportFormat: format } },
        signal,
      );
      if (!encoded.metTarget)
        throw new Error(`${item.name}: increase the target file size before exporting.`);
      if (totalBytes + encoded.blob.size > 200_000_000)
        throw new Error("This ZIP exceeds 200 MB. Export a smaller selection.");
      const entry = new ZipPassThrough(
        names[index] ?? `image-${index + 1}.${formatExtension(format)}`,
      );
      zip.add(entry);
      const reader = encoded.blob.stream().getReader();
      try {
        for (;;) {
          signal.throwIfAborted();
          const part = await reader.read();
          if (part.done) break;
          entry.push(part.value, false);
          if (failure) throw failure;
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      entry.push(new Uint8Array(), true);
      if (failure) throw failure;
      onProgress(index + 1, items.length);
    }
    signal.throwIfAborted();
    zip.end();
    if (failure) throw failure;
    return new Blob(parts, { type: "application/zip" });
  } finally {
    zip.terminate();
  }
}
