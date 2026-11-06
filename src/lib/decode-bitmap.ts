import { CutoutError, MEMORY_COPY } from "./errors.ts";
import { sniffImage } from "./formats.ts";
import { PROCESS_PIXEL_BUDGET, PROCESS_SIDE_LIMIT } from "./limits.ts";

const HEIC_TYPE = /heic|heif|hif/i;

type Limits = { pixels: number; side: number };

/** `limits` bound SVG rasterising: vector art has no pixels of its own, and a 200-byte
 *  file can declare 16000 x 16000 (a 1 GB canvas, then a 1 GB bitmap). They also refuse a
 *  raster that declares far more than they allow, before it is decoded. */
export async function bitmapFromBlob(
  blob: Blob,
  limits: Limits = { pixels: PROCESS_PIXEL_BUDGET, side: PROCESS_SIDE_LIMIT },
): Promise<ImageBitmap> {
  await assertDecodableSize(blob, limits);
  try {
    return await createImageBitmap(blob);
  } catch {
    if (blob.type.includes("svg") || (blob instanceof File && /\.svg$/i.test(blob.name))) {
      const rasterized = await bitmapFromSvgElement(blob, limits);
      if (rasterized) return rasterized;
    }
    const decoded = await bitmapFromImageDecoder(blob);
    if (decoded) return decoded;
    // libheif is 3 MB and starts its own worker: only for an ISO-BMFF (ftyp) file.
    if (!HEIC_TYPE.test(blob.type) && !(await isoBmff(blob)))
      throw new Error("This image could not be decoded.");
    const { heicTo } = await import("heic-to/csp");
    return heicTo({ blob, type: "bitmap" });
  }
}

async function isoBmff(blob: Blob) {
  const head = new Uint8Array(await blob.slice(4, 8).arrayBuffer());
  return String.fromCharCode(...head) === "ftyp";
}

/**
 * createImageBitmap and ImageDecoder reject SVG blobs, but an <img> element
 * decodes them everywhere; rasterize at the intrinsic size, then hand the
 * caller a bitmap.
 */
async function bitmapFromSvgElement(blob: Blob, limits: Limits): Promise<ImageBitmap | null> {
  if (typeof document === "undefined" || typeof createImageBitmap !== "function") return null;
  const url = URL.createObjectURL(
    blob.type === "image/svg+xml" ? blob : new Blob([blob], { type: "image/svg+xml" }),
  );
  const image = new Image();
  image.decoding = "async";
  const canvas = document.createElement("canvas");
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("svg"));
    });
    image.src = url;
    await loaded;
    const naturalW = image.naturalWidth;
    const naturalH = image.naturalHeight;
    if (!naturalW || !naturalH) return null;
    const scale = Math.min(
      1,
      Math.sqrt(limits.pixels / (naturalW * naturalH)),
      limits.side / Math.max(naturalW, naturalH),
    );
    const width = Math.max(1, Math.floor(naturalW * scale));
    const height = Math.max(1, Math.floor(naturalH * scale));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, width, height);
    return await createImageBitmap(canvas);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function bitmapFromImageDecoder(blob: Blob): Promise<ImageBitmap | null> {
  const type = blob.type;
  if (!type || HEIC_TYPE.test(type)) return null;
  if (typeof ImageDecoder !== "function") return null;
  if (type === "image/png") {
    // WebKit's streamed decoder can wait forever on a non-PNG declared as PNG. Skip it
    // rather than refuse: a HEIC saved as .png keeps image/png and still needs libheif.
    const head = await blobHeader(blob, 8);
    if (![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => head[i] === byte))
      return null;
  }
  let decoder: ImageDecoder | undefined;
  try {
    if (!(await ImageDecoder.isTypeSupported(type))) return null;
    decoder = new ImageDecoder({
      data: blob.stream(),
      type,
      preferAnimation: false,
    });
    const { image } = await decoder.decode({ frameIndex: 0 });
    try {
      return await createImageBitmap(image);
    } finally {
      image.close();
    }
  } catch {
    return null;
  } finally {
    decoder?.close();
  }
}

type Size = { width: number; height: number };

/**
 * A decode allocates every declared pixel before anything can scale the image down, and
 * Chromium decodes in full even for createImageBitmap's resize options: a 300 KB flat PNG
 * declaring 16384 x 16384 took a tab past 4 GB. Up to twice the budget (and twice the side
 * limit) an image still decodes and is scaled down to fit. Both ceilings use the caller's
 * device limits; the exact 2x boundary is included.
 */
export function declaresTooMuch(size: Size, limits: Limits) {
  const pixels = 2 * limits.pixels;
  const side = Math.max(size.width, size.height);
  return size.width * size.height > pixels || side > 2 * limits.side;
}

/** Refuses oversized headers before decoding; TIFF retains its strict worker pixel budget. */
export async function assertDecodableSize(blob: Blob, limits: Limits) {
  if (sniffImage(await blobHeader(blob, 4).catch(() => new Uint8Array())) === "tiff") {
    // TIFF has a stricter worker pixel budget. Apply its IFD-only guard before the
    // shared ingest/background/restore gate can expose a source to native decoders.
    const { tiffDimensions, assertTiffWithinBudget, assertTiffFileSize } =
      await import("./tiff.ts");
    assertTiffFileSize(blob.size);
    const size = await blob
      .arrayBuffer()
      .then(tiffDimensions)
      .catch(() => null);
    assertTiffWithinBudget(size, limits.pixels);
    if (size && declaresTooMuch(size, limits)) throw new CutoutError("memory", MEMORY_COPY);
    return;
  }
  const size = await declaredSize(blob).catch((error: unknown) => {
    if (error instanceof CutoutError) throw error;
    return null;
  });
  if (size && declaresTooMuch(size, limits)) throw new CutoutError("memory", MEMORY_COPY);
}

const sized = (width: number, height: number): Size | null =>
  width >= 1 && height >= 1 ? { width, height } : null;

/** The size an image's header declares, read without decoding; null when the container is
 *  unknown. PNG, JPEG, WebP, GIF, BMP and HEIF/AVIF; TIFF uses its IFD-only guard
 *  in assertDecodableSize. */
async function declaredSize(blob: Blob): Promise<Size | null> {
  const head = await blobHeader(blob, 64);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const ascii = (at: number, text: string) =>
    String.fromCharCode(...head.subarray(at, at + text.length)) === text;
  const kind = sniffImage(head);
  if (kind === "png")
    return head.length < 24 ? null : sized(view.getUint32(16), view.getUint32(20));
  if (kind === "jpeg") return jpegSize(blob);
  if (kind === "webp") return webpSize(head);
  if (ascii(0, "GIF8")) return gifSize(blob);
  if (ascii(0, "BM")) return bmpSize(head);
  if (ascii(4, "ftyp")) return heifSize(blob);
  return null;
}

/** Cheap image dimensions from file headers; null when the container is unknown. */
export async function imageSizeOf(file: Blob): Promise<Size | null> {
  try {
    const size = await declaredSize(file);
    return size && size.width <= 1e7 && size.height <= 1e7 ? size : null;
  } catch {
    return null;
  }
}

async function blobHeader(file: Blob, bytes: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(0, bytes).arrayBuffer());
}

/** Walks the JPEG segments to the frame header. Segments are skipped by length and read
 *  in windows, so XMP, ICC or MPF data past the first 256 KB (Lightroom, Photoshop, phone
 *  previews) cannot hide the size and slip the photo past the pixel budget. */
async function jpegSize(file: Blob): Promise<{ width: number; height: number } | null> {
  let start = 0;
  let head = await blobHeader(file, 256 * 1024);
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 2;
  let orientation = 1;
  for (let reads = 0; ;) {
    if (pos + 9 >= start + head.length) {
      if (pos + 9 >= file.size) return null;
      if (++reads > 64) throw unreadableSize();
      start = pos;
      head = new Uint8Array(await file.slice(pos, pos + 64 * 1024).arrayBuffer());
      view = new DataView(head.buffer, head.byteOffset, head.byteLength);
      continue;
    }
    const i = pos - start;
    if (head[i] !== 0xff) {
      pos += 1;
      continue;
    }
    const marker = head[i + 1]!;
    // Any number of 0xFF fill bytes may come before a marker.
    if (marker === 0xff) {
      pos += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    const length = view.getUint16(i + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && String.fromCharCode(...head.subarray(i + 4, i + 10)) === "Exif\0\0")
      orientation = exifOrientation(head.subarray(i + 10, i + 2 + length));
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = view.getUint16(i + 5);
      const width = view.getUint16(i + 7);
      // Decoders apply the EXIF orientation: report the size the pixels decode to.
      if (width >= 1 && height >= 1)
        return orientation >= 5 && orientation <= 8
          ? { width: height, height: width }
          : { width, height };
      return null;
    }
    pos += 2 + length;
  }
}

/** IFD0's Orientation tag (0x0112) from an EXIF TIFF block; 1 when absent or unreadable. */
function exifOrientation(tiff: Uint8Array): number {
  if (tiff.length < 8) return 1;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 1;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > tiff.length) return 1;
  for (let k = 0, n = view.getUint16(ifd, le); k < n; k += 1) {
    const entry = ifd + 2 + k * 12;
    if (entry + 12 > tiff.length) break;
    if (view.getUint16(entry, le) === 0x0112) return view.getUint16(entry + 8, le);
  }
  return 1;
}

function webpSize(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 30) return null;
  if (!(head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46)) return null;
  const fourcc = String.fromCharCode(head[12]!, head[13]!, head[14]!, head[15]!);
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (fourcc === "VP8 ") {
    const width = view.getUint16(26, true) & 0x3fff;
    const height = view.getUint16(28, true) & 0x3fff;
    return width && height ? { width, height } : null;
  }
  if (fourcc === "VP8L") {
    const bits = head[21]! | (head[22]! << 8) | (head[23]! << 16) | (head[24]! << 24);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  if (fourcc === "VP8X") {
    const width = 1 + (head[24]! | (head[25]! << 8) | (head[26]! << 16));
    const height = 1 + (head[27]! | (head[28]! << 8) | (head[29]! << 16));
    return { width, height };
  }
  return null;
}

/** BITMAPCOREHEADER has 16-bit sizes; later headers 32-bit, negative when top-down. */
export function bmpSize(head: Uint8Array): Size | null {
  if (head.length < 26) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(14, true) === 12)
    return sized(view.getUint16(18, true), view.getUint16(20, true));
  return sized(Math.abs(view.getInt32(18, true)), Math.abs(view.getInt32(22, true)));
}

/** The logical screen, grown to the first frame: decoders size the image to a first frame
 *  that overflows the screen, so a 1 x 1 screen cannot hide a huge frame. */
export async function gifSize(blob: Blob): Promise<Size | null> {
  // Cache bounded windows, and skip extension payloads by their sub-block lengths. A long
  // comment can put the first frame anywhere in the file, beyond the initial header read.
  let start = 0;
  let bytes = await blobHeader(blob, 64 * 1024);
  const read = async (at: number, length: number) => {
    if (at + length > blob.size) return null;
    if (at < start || at + length > start + bytes.length) {
      start = at;
      bytes = new Uint8Array(await blob.slice(at, at + 64 * 1024).arrayBuffer());
    }
    return bytes.subarray(at - start, at - start + length);
  };
  if (bytes.length < 13) return null;
  const screen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = screen.getUint16(6, true);
  const height = screen.getUint16(8, true);
  let at = 13 + (bytes[10]! & 0x80 ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0);
  for (;;) {
    const marker = await read(at, 1);
    if (!marker) return null;
    if (marker[0] === 0x2c) {
      const frame = await read(at, 10);
      if (!frame) return null;
      const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      return sized(
        Math.max(width, view.getUint16(1, true) + view.getUint16(5, true)),
        Math.max(height, view.getUint16(3, true) + view.getUint16(7, true)),
      );
    }
    // A truncated/unknown scan does not establish the small logical screen as the size.
    if (marker[0] !== 0x21 || !(await read(at, 2))) return null;
    at += 2; // extension introducer and label
    for (;;) {
      const block = await read(at, 1);
      if (!block) return null;
      at += 1 + block[0]!;
      if (block[0] === 0) break;
    }
  }
}

/** The most of a 'meta' box read; item properties come well within it. */
const HEIF_META_BYTES = 4_000_000;

const unreadableSize = () =>
  new CutoutError("memory", "This image's size could not be checked safely. Try a simpler export.");

/** HEIC/AVIF: the largest 'ispe' in meta → iprp → ipco (the full image; the others are
 *  tiles, thumbnails or auxiliary images). Top-level boxes are skipped by their headers, so
 *  an 'mdat' before 'meta', of any size, is never read. */
async function heifSize(blob: Blob): Promise<Size | null> {
  for (let at = 0, boxes = 0; at + 8 <= blob.size; boxes++) {
    if (boxes >= 64) throw unreadableSize();
    const header = new DataView(await blob.slice(at, at + 16).arrayBuffer());
    const box = boxesIn(header, 0, blob.size - at).next().value;
    if (!box) return null;
    if (box.type === "meta") {
      if (box.end > HEIF_META_BYTES) throw unreadableSize();
      const end = at + box.end;
      const meta = new DataView(await blob.slice(at + box.start, end).arrayBuffer());
      // 'meta' is a full box: 4 bytes of version and flags come before its children.
      const iprp = find(meta, 4, meta.byteLength, "iprp");
      const ipco = iprp && find(meta, iprp.start, iprp.end, "ipco");
      if (!ipco) return null;
      let largest: Size | null = null;
      for (const property of boxesIn(meta, ipco.start, ipco.end)) {
        if (property.type !== "ispe" || property.end - property.start < 12) continue;
        const size = sized(meta.getUint32(property.start + 4), meta.getUint32(property.start + 8));
        if (size && (!largest || size.width * size.height > largest.width * largest.height))
          largest = size;
      }
      return largest;
    }
    at += box.end;
  }
  return null;
}

const find = (view: DataView, start: number, end: number, type: string) =>
  [...boxesIn(view, start, end)].find((box) => box.type === type);

/** ISO-BMFF boxes between two offsets: their type and where their payload starts and ends. */
function* boxesIn(view: DataView, start: number, end: number) {
  for (let at = start; at + 8 <= Math.min(end, view.byteLength);) {
    let size = view.getUint32(at);
    let header = 8;
    if (size === 1) {
      if (at + 16 > view.byteLength) return;
      size = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) return;
    const type = String.fromCharCode(...[4, 5, 6, 7].map((i) => view.getUint8(at + i)));
    yield { type, start: at + header, end: at + size };
    at += size;
  }
}
