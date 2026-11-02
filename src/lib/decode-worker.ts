import { resizeBitmap } from "./bitmap-resize.ts";
import { bitmapFromBlob, declaresTooMuch } from "./decode-bitmap.ts";
import { CutoutError } from "./errors.ts";
import { PROCESS_PIXEL_BUDGET, PROCESS_SIDE_LIMIT } from "./limits.ts";
import { sniffImage } from "./formats.ts";
import { assertTiffFileSize, assertTiffWithinBudget, pageDimensions } from "./tiff.ts";
import UTIF from "utif2";

const EDGE = 1600;

let surface: OffscreenCanvas | null = null;

addEventListener(
  "message",
  (
    event: MessageEvent<{
      id: number;
      file?: Blob;
      type: string;
      maxEdge?: number;
      maxPixels?: number;
      maxSide?: number;
    }>,
  ) => {
    void decode(event.data);
  },
);

function looksLikeTiff(file: Blob | undefined, type: string | undefined) {
  return Boolean(
    (type ?? "").includes("tiff") || (file instanceof File && /\.tiff?$/i.test(file.name)),
  );
}

async function decodeTiff(blob: Blob, maxPixels: number, maxSide: number): Promise<ImageBitmap> {
  assertTiffFileSize(blob.size);
  const buffer = await blob.arrayBuffer();
  const ifds = UTIF.decode(buffer);
  const page = ifds[0];
  if (!page) throw new Error("decode");
  // The pixel budget is checked on the declared size, before decodeImage allocates it.
  const size = pageDimensions(page);
  assertTiffWithinBudget(size, maxPixels);
  if (size && declaresTooMuch(size, { pixels: maxPixels, side: maxSide }))
    throw new CutoutError(
      "memory",
      "This image is too large for this device. Try a smaller photo.",
    );
  // UTIF's runtime signature also takes the IFD list for Exif sub-chains.
  (
    UTIF as unknown as { decodeImage: (b: ArrayBuffer, i: typeof page, s: typeof ifds) => void }
  ).decodeImage(buffer, page, ifds);
  // decodeImage fills width/height on the IFD; only then is pixel data decodable.
  if (!page.width || !page.height) throw new Error("decode");
  const rgba = UTIF.toRGBA8(page);
  const bytes = page.width * page.height * 4;
  if (rgba.length < bytes) throw new Error("decode");
  // The bitmap straight from UTIF's buffer: a copy into ImageData plus a canvas backing
  // store were two more full-size copies (768 MB at the 96 MP budget).
  const bitmap = await createImageBitmap(
    new ImageData(
      new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, bytes),
      page.width,
      page.height,
    ),
  );
  const orientationTag = page["t274"];
  const orientation = Array.isArray(orientationTag) ? orientationTag[0] : 1;
  return orientTiff(bitmap, typeof orientation === "number" ? orientation : 1);
}

async function orientTiff(source: ImageBitmap, orientation: number) {
  const w = source.width;
  const h = source.height;
  if (orientation < 2 || orientation > 8) return source;
  const output = new OffscreenCanvas(orientation >= 5 ? h : w, orientation >= 5 ? w : h);
  const ctx = output.getContext("2d");
  if (!ctx) {
    source.close();
    output.width = 0;
    throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
  }
  switch (orientation) {
    case 2:
      ctx.setTransform(-1, 0, 0, 1, w, 0);
      break;
    case 3:
      ctx.setTransform(-1, 0, 0, -1, w, h);
      break;
    case 4:
      ctx.setTransform(1, 0, 0, -1, 0, h);
      break;
    case 5:
      ctx.setTransform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.setTransform(0, 1, -1, 0, h, 0);
      break;
    case 7:
      ctx.setTransform(0, -1, -1, 0, h, w);
      break;
    case 8:
      ctx.setTransform(0, -1, 1, 0, 0, w);
      break;
  }
  try {
    ctx.drawImage(source, 0, 0);
    return await createImageBitmap(output);
  } finally {
    source.close();
    output.width = 0;
    output.height = 0;
  }
}

async function decode({
  id,
  file,
  type,
  maxEdge,
  // A sender that omits the budget still gets the desktop one, never none.
  maxPixels = PROCESS_PIXEL_BUDGET,
  maxSide = PROCESS_SIDE_LIMIT,
}: {
  id: number;
  file?: Blob;
  type: string;
  maxEdge?: number;
  maxPixels?: number;
  maxSide?: number;
}) {
  let bitmap: ImageBitmap | null = null;
  try {
    const blob = file ?? null;
    if (!blob) {
      postMessage({ id, error: "decode" });
      return;
    }
    // The page's budget, so a size declared far over it is refused before the decode.
    const limits = { pixels: maxPixels, side: maxSide };
    const tiffHint = looksLikeTiff(file, type);
    const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
    if (tiffHint || sniffImage(head) === "tiff") {
      try {
        bitmap = await decodeTiff(blob, maxPixels, maxSide);
      } catch (tiffError) {
        // Over budget is final: the browser decoder would allocate the same pixels.
        if (!tiffHint || tiffError instanceof CutoutError) throw tiffError;
        bitmap = await bitmapFromBlob(blob, limits);
      }
    } else {
      bitmap = await bitmapFromBlob(blob, limits);
    }
    const origW = bitmap.width;
    const origH = bitmap.height;
    const cap = maxEdge === 0 ? Infinity : (maxEdge ?? EDGE);
    const edge = Math.max(origW, origH);
    if (edge > cap) {
      const scale = cap / edge;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));
      const source = bitmap;
      try {
        bitmap = await resizeBitmap(source, width, height, "high");
      } catch {
        bitmap = resizeWithCanvas(source, width, height);
      }
      source.close();
    }
    postMessage({ id, bitmap, width: origW, height: origH }, { transfer: [bitmap] });
    bitmap = null; // The page owns a successfully transferred bitmap.
  } catch (error) {
    // Refusals keep their code, so the page reports "too large" and does not retry the decode itself.
    if (error instanceof CutoutError)
      postMessage({ id, error: error.code, message: error.message });
    else postMessage({ id, error: error instanceof Error ? error.message : "decode" });
  } finally {
    bitmap?.close();
  }
}

function resizeWithCanvas(bitmap: ImageBitmap, width: number, height: number) {
  if (typeof OffscreenCanvas === "undefined")
    throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
  try {
    if (!surface) surface = new OffscreenCanvas(width, height);
    else {
      surface.width = width;
      surface.height = height;
    }
    const ctx = surface.getContext("2d");
    if (!ctx) throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return surface.transferToImageBitmap();
  } finally {
    // Release backing stores on both success and failure; never send an undrawn canvas.
    if (surface) surface.width = surface.height = 0;
  }
}
