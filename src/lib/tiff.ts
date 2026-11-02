import UTIF from "utif2";
import { CutoutError } from "./errors.ts";

/** UTIF needs the complete compressed file, including its directory chains. */
export const TIFF_BYTE_LIMIT = 50 * 1024 * 1024;

export function assertTiffFileSize(bytes: number) {
  if (bytes > TIFF_BYTE_LIMIT)
    throw new CutoutError("memory", "This TIFF is too large. Choose a file under 50 MB.");
}

/** A page's declared size from its IFD tags (ImageWidth, ImageLength); no pixel data. */
export function pageDimensions(page: object | undefined) {
  const tags = page as { t256?: number[]; t257?: number[] } | undefined;
  const width = tags?.t256?.[0];
  const height = tags?.t257?.[0];
  return width && height ? { width, height } : null;
}

/** Declared size of the first page, read from the IFD tags without touching pixel data. */
export function tiffDimensions(buffer: ArrayBuffer): { width: number; height: number } | null {
  try {
    return pageDimensions(UTIF.decode(buffer)[0]);
  } catch {
    return null;
  }
}

/** A 138-byte TIFF can declare 16000×16000; decoding it allocates two 1 GB buffers. */
export function assertTiffWithinBudget(
  dims: { width: number; height: number } | null,
  maxPixels: number,
) {
  if (dims && dims.width * dims.height > maxPixels) {
    throw new CutoutError(
      "memory",
      "This image is too large for this device. Try a smaller photo.",
    );
  }
}
