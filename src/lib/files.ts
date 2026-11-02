import { messageFor } from "./errors.ts";
import { resizeBitmap } from "./bitmap-resize.ts";
import { mimeForFilename } from "./sharing.ts";
export { canShareFiles, shareFiles, shareBlob, isSaveAbort, mimeForFilename } from "./sharing.ts";
import {
  assertDecodableSize,
  bitmapFromBlob,
  declaresTooMuch,
  imageSizeOf,
} from "./decode-bitmap.ts";
export { imageSizeOf } from "./decode-bitmap.ts";
import { appleVersion, readClient, readEnv, type ClientEnv } from "./device.ts";
import { CutoutError, MEMORY_COPY } from "./errors.ts";
import { bitmapToPng } from "./editor/canvas.ts";
import { sniffImage } from "./formats.ts";
import { PROCESS_PIXEL_BUDGET, PROCESS_SIDE_LIMIT } from "./limits.ts";

export const CUTOUT_EXPORT_TYPE = "application/x-cutout-export";

let cutoutExportDrag = false;

export function setCutoutExportDrag(active: boolean) {
  cutoutExportDrag = active;
}

export function isCutoutExportDrag() {
  return cutoutExportDrag;
}

export const IMAGE_ACCEPT_ATTRIBUTE = [
  "image/*",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/avif",
  "image/svg+xml",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  ".png",
  ".jpg",
  ".jpeg",
  ".jfif",
  ".webp",
  ".gif",
  ".bmp",
  ".tif",
  ".tiff",
  ".svg",
  ".avif",
  ".heic",
  ".heif",
  ".heics",
  ".hif",
  ".pdf",
  ".dxf",
  ".dwg",
  ".skp",
].join(",");

/** iOS Safari / Android gallery. A custom accept list (esp. .pdf/.dxf) opens Files.app on iOS. */
export const IMAGE_ACCEPT_IOS = "image/*";

export const FORMAT_LINE = "PNG · JPG · WebP · HEIC";

const PHOTO_EXT = /\.(png|jpe?g|jpe|jfif|webp|gif|bmp|tiff?|heics?|heif|hif|avif|svg)$/i;
const HEIC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
  "heif",
]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/** iOS Safari: custom `accept` skips Photos; `clip`/`sr-only` inputs can ignore `.click()`. */
export function iosSafariFileInput(client: { ios: boolean } = readClient()) {
  return client.ios;
}

export function fileInputAccept(client: { ios: boolean; android?: boolean } = readClient()) {
  return client.ios || client.android ? IMAGE_ACCEPT_IOS : IMAGE_ACCEPT_ATTRIBUTE;
}

export function isAcceptedFile(file: File) {
  if (file.type.startsWith("image/")) return true;
  if (PHOTO_EXT.test(file.name) || /\.(pdf|dxf|dwg|skp)$/i.test(file.name)) return true;
  if (
    file.type === "application/pdf" ||
    file.type.includes("dxf") ||
    file.type.includes("dwg") ||
    file.type.includes("sketchup")
  ) {
    return true;
  }
  // Some platforms drop or paste images with an empty MIME type. Accept those
  // only when the name is extensionless or image-like, so system files such
  // as .DS_Store do not enter the queue and fail one by one.
  if (!file.type && (PHOTO_EXT.test(file.name) || !file.name.includes("."))) return true;
  return false;
}

export function isHeicFile(file: File) {
  return /heic|heif|hif/i.test(file.type) || /\.(heic|heif|heics|hif)$/i.test(file.name);
}

export function isTiffFile(file: File) {
  return (file.type ?? "").includes("tiff") || /\.tiff?$/i.test(file.name);
}

export function isSvgFile(file: File) {
  return (file.type ?? "").includes("svg") || /\.svg$/i.test(file.name);
}

export function isoBmffBrand(bytes: Uint8Array) {
  if (bytes.length < 12) return "";
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return "";
  return String.fromCharCode(
    bytes[8] ?? 0,
    bytes[9] ?? 0,
    bytes[10] ?? 0,
    bytes[11] ?? 0,
  ).toLowerCase();
}

export function looksLikeHeic(bytes: Uint8Array) {
  const brand = isoBmffBrand(bytes);
  return brand !== "" && HEIC_BRANDS.has(brand);
}

export function looksLikeAvif(bytes: Uint8Array) {
  const brand = isoBmffBrand(bytes);
  return brand !== "" && AVIF_BRANDS.has(brand);
}

/** HEIC/libheif is too heavy for the UI thread except on small files. */
export const HEIC_MAIN_BYTES = 1_000_000;
export const MAIN_DECODE_BYTES = 3_000_000;

export function heicDecodesOnMain(file: File) {
  return isHeicFile(file) && file.size <= HEIC_MAIN_BYTES;
}

export function decodeOnMainThread(file: File) {
  if (isSvgFile(file)) return true;
  if (isTiffFile(file)) return false;
  return isHeicFile(file) ? file.size <= HEIC_MAIN_BYTES : file.size <= MAIN_DECODE_BYTES;
}

export { PROCESS_PIXEL_BUDGET, PROCESS_SIDE_LIMIT };

/** True when the bitmap exceeds the processing budget or canvas side limits. */
export function exceedsProcessingBudget(
  width: number,
  height: number,
  memory: number | undefined = readDeviceMemory(),
  env: ClientEnv = readEnv(),
): boolean {
  const limits = processingLimits(memory, env);
  return width * height > limits.pixels || Math.max(width, height) > limits.side;
}

/** Longest-side scale that fits the pixel and side budgets for this device. */
export function processingScale(
  width: number,
  height: number,
  memory: number | undefined = readDeviceMemory(),
  env: ClientEnv = readEnv(),
): number {
  const pixels = Math.max(1, width * height);
  const limits = processingLimits(memory, env);
  return Math.min(1, Math.sqrt(limits.pixels / pixels), limits.side / Math.max(width, height));
}

/**
 * Pixel and side budgets for full-size canvases on this device. The generic budget
 * assumes a desktop; phones report no deviceMemory (Safari never does) and iOS
 * caps canvas area outright: 16.7 MP and 4096 px per side through iOS 17, 67 MP
 * and 8192 px from iOS 18. Above that WebKit silently yields a blank canvas, so
 * every full-size stage of the pipeline would produce an empty result. Phone tabs
 * also get about a gigabyte before the OS kills them, and the pipeline holds
 * several full-size RGBA copies, so budgets stay well under the hard caps.
 */
export function processingLimits(
  memory: number | undefined = readDeviceMemory(),
  env: ClientEnv = readEnv(),
): { pixels: number; side: number } {
  const client = readClient(env);
  let pixels =
    typeof memory === "number" && memory <= 4 ? PROCESS_PIXEL_BUDGET / 3 : PROCESS_PIXEL_BUDGET;
  let side = PROCESS_SIDE_LIMIT;
  if (client.ios) {
    const legacy = appleVersion(env.userAgent) < 18;
    pixels = Math.min(pixels, legacy ? 16_000_000 : 24_000_000);
    side = Math.min(side, legacy ? 4096 : 8192);
  } else if (client.phone) {
    pixels = Math.min(pixels, 24_000_000);
  }
  return { pixels, side };
}

function readDeviceMemory(): number | undefined {
  return typeof navigator === "undefined"
    ? undefined
    : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
}

export async function toProcessableFile(file: File): Promise<File> {
  if (isWasmFile(file)) {
    throw new CutoutError("unsupported", "That file is a WebAssembly module, not an image.");
  }
  // PNG, JPEG and WebP go on to the remover undecoded and every other format is decoded
  // here, so a declared size far over the budget is refused now, before either decode.
  await assertDecodableSize(file, processingLimits());
  const lowerName = (file.name || "").toLowerCase();
  const lowerType = (file.type || "").toLowerCase();
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";

  // If already standard png, jpeg, webp with matching mime:
  if (lowerType === "image/png" || lowerType === "image/jpeg" || lowerType === "image/webp") {
    return file;
  }
  if (
    lowerType === "image/jpg" ||
    lowerType === "image/pjpeg" ||
    (lowerType === "" && /\.(jpe?g|jpe|jfif)$/.test(lowerName))
  ) {
    return new File([file], file.name, { type: "image/jpeg" });
  }
  if ((lowerType === "" || lowerType === "image/x-png") && lowerName.endsWith(".png")) {
    return new File([file], file.name, { type: "image/png" });
  }
  if (lowerType === "" && lowerName.endsWith(".webp")) {
    return new File([file], file.name, { type: "image/webp" });
  }

  let head: Uint8Array | null;
  try {
    head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const kind = sniffImage(head);
    if (kind === "png" || kind === "jpeg" || kind === "webp")
      return new File([file], file.name, { type: `image/${kind}` });
  } catch {
    head = null;
  }

  if (head && looksLikeAvif(head)) {
    const png = await rasterToPng(file, baseName);
    if (png) return png;
  }

  // CAD rasterization if drawing
  if (/\.(pdf|dxf|dwg|skp)$/i.test(file.name) || /pdf|dxf|dwg|sketchup/i.test(file.type)) {
    const { rasterizeCad, CAD_MAX_BYTES, CAD_MAX_DXF_BYTES } = await import("./cad.ts");
    // The drawing parsers run on this thread; refuse before reading the bytes.
    const dxf = lowerName.endsWith(".dxf") || lowerType.includes("dxf");
    if (dxf && file.size > CAD_MAX_DXF_BYTES) {
      throw new CutoutError(
        "drawing",
        "This DXF is over 20 MB, too large to open here. Export a PNG or PDF from your CAD app.",
      );
    }
    if (file.size > CAD_MAX_BYTES) {
      throw new CutoutError(
        "drawing",
        "This drawing is over 50 MB, too large to open here. Export a PNG from your CAD app.",
      );
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const raster = await rasterizeCad(file, bytes);
    if (raster && raster.type.startsWith("image/")) return raster;
    throw new CutoutError(
      "drawing",
      "Couldn’t turn that drawing into an image. Try exporting a PNG or PDF from CAD.",
    );
  }

  if (isHeicFile(file) || (head && looksLikeHeic(head))) {
    const converted = await heicToPng(file);
    if (converted) return converted;
    if (isHeicFile(file)) {
      throw new CutoutError(
        "heic",
        "This browser can’t open HEIC. Export a JPG from Photos and drop that.",
      );
    }
  }

  // BMP, GIF, TIFF, SVG, remaining AVIF: convert to PNG so the removal engine gets a standard type.
  const png = await rasterToPng(file, baseName);
  if (png) return png;

  throw new CutoutError("decode", "This image is damaged or in a format this browser can’t read.");
}

const DISPLAY_EDGE = 1600;

type DecodeResponse = {
  id: number;
  bitmap?: ImageBitmap;
  width?: number;
  height?: number;
  error?: string;
  message?: string;
};

let decodeWorker: Worker | null | undefined;
let decodeJob = 0;
/** Jobs waiting on each worker, so retiring it can settle them at once. */
const waiting = new Map<Worker, Set<() => void>>();

/** Stops a worker and hands every job it held to its fallback now, not after its own timer. */
function retire(node: Worker, next: null | undefined) {
  node.terminate();
  if (decodeWorker === node) decodeWorker = next;
  const jobs = waiting.get(node);
  waiting.delete(node);
  jobs?.forEach((abandon) => abandon());
}

function worker() {
  if (decodeWorker === null) return null;
  if (decodeWorker) return decodeWorker;
  try {
    const node = new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" });
    decodeWorker = node;
    // An error event usually means the worker cannot load at all: stop using workers.
    node.addEventListener("error", () => retire(node, null));
    return node;
  } catch {
    decodeWorker = null;
    return null;
  }
}

export type DisplayPreview = {
  bitmap: ImageBitmap | null;
  url: string;
  width: number;
  height: number;
};

/** Transfer file bytes into a worker; get a transferable ImageBitmap back. No JPEG re-encode.
 *  Worker-bound files should already have an object-URL on the item for an instant <img> preview. */
export async function createDisplayPreview(
  file: File,
  stale?: () => boolean,
): Promise<DisplayPreview> {
  if (decodeOnMainThread(file)) {
    // Small files can still declare huge sizes (a 2 MB flat PNG at 20000 x 20000 decodes
    // to 1.6 GB); like a refused TIFF, such a file shows no preview bitmap.
    const size = await imageSizeOf(file);
    if (size && declaresTooMuch(size, processingLimits()))
      return { bitmap: null, url: "", width: size.width, height: size.height };
    return decodeOnMain(file);
  }
  // A preview that fails for any reason, including a refused size, just shows none.
  const decoded = await decodeViaWorker(file, DISPLAY_EDGE, stale).catch(() => null);
  if (decoded)
    return { bitmap: decoded.bitmap, url: "", width: decoded.width, height: decoded.height };
  return { bitmap: null, url: "", width: 0, height: 0 };
}

async function decodeOnMain(file: File): Promise<DisplayPreview> {
  try {
    let bitmap = await bitmapFromBlob(file, processingLimits());
    const origW = bitmap.width;
    const origH = bitmap.height;
    const edge = Math.max(origW, origH);
    if (edge > DISPLAY_EDGE) {
      const scale = DISPLAY_EDGE / edge;
      const width = Math.max(1, Math.round(origW * scale));
      const height = Math.max(1, Math.round(origH * scale));
      try {
        const resized = await resizeBitmap(bitmap, width, height, "high");
        bitmap.close();
        bitmap = resized;
      } catch {
        // No full-size bitmap as a "preview": the item's <img> URL still shows it.
        bitmap.close();
        return { bitmap: null, url: "", width: origW, height: origH };
      }
    }
    return { bitmap, url: "", width: origW, height: origH };
  } catch {
    return { bitmap: null, url: "", width: 0, height: 0 };
  }
}

type DecodeTurn = { full: boolean; run: () => Promise<void> };
const decodeQueue: DecodeTurn[] = [];
let decoding = false;

/** Resolves null when the worker could not decode; rejects with CutoutError("memory") when it
 *  refused the file as too large, so callers do not retry the same decode on the main thread.
 *  One job at a time: a TIFF decode blocks the worker, so a timer started while a job waited
 *  behind others expired, retired the worker, and failed every valid file it held. Full-size
 *  decodes (removal is waiting on them) go ahead of queued previews, and a preview whose drop
 *  was replaced (`stale`) is skipped when its turn comes. */
function decodeViaWorker(file: File, maxEdge: number, stale?: () => boolean) {
  return new Promise<Awaited<ReturnType<typeof decodeOneViaWorker>>>((resolve, reject) => {
    const turn: DecodeTurn = {
      full: maxEdge === 0,
      run: () =>
        (stale?.() ? Promise.resolve(null) : decodeOneViaWorker(file, maxEdge)).then(
          resolve,
          reject,
        ),
    };
    const firstPreview = decodeQueue.findIndex((queued) => !queued.full);
    if (turn.full && firstPreview >= 0) decodeQueue.splice(firstPreview, 0, turn);
    else decodeQueue.push(turn);
    void pumpDecodes();
  });
}

async function pumpDecodes() {
  if (decoding) return;
  decoding = true;
  try {
    for (let turn = decodeQueue.shift(); turn; turn = decodeQueue.shift()) await turn.run();
  } finally {
    decoding = false;
  }
}

async function decodeOneViaWorker(file: File, maxEdge: number) {
  const node = worker();
  if (!node) return null;
  const id = ++decodeJob;
  return await new Promise<{ bitmap: ImageBitmap; width: number; height: number } | null>(
    (resolve, reject) => {
      const jobs = waiting.get(node) ?? new Set<() => void>();
      waiting.set(node, jobs);
      const abandon = () => finish(null);
      jobs.add(abandon);
      const settle = () => {
        node.removeEventListener("message", onMessage);
        window.clearTimeout(timer);
        jobs.delete(abandon);
      };
      const finish = (value: { bitmap: ImageBitmap; width: number; height: number } | null) => {
        settle();
        resolve(value);
      };
      // A decode this slow is stuck; retire the worker so later files get a fresh one.
      // Big files get longer (a 50 MB TIFF: 18 s).
      const timer = window.setTimeout(
        () => retire(node, undefined),
        8000 + Math.floor(file.size / 5000),
      );
      const onMessage = (event: MessageEvent<DecodeResponse>) => {
        if (event.data?.id !== id) return;
        if (event.data.bitmap) {
          finish({
            bitmap: event.data.bitmap,
            width: event.data.width || event.data.bitmap.width,
            height: event.data.height || event.data.bitmap.height,
          });
          return;
        }
        if (event.data.error === "memory") {
          settle();
          // The worker sends the copy; the fallback is the same "memory" copy from errors.ts.
          const copy = event.data.message || MEMORY_COPY;
          reject(new CutoutError("memory", copy));
          return;
        }
        finish(null);
      };
      node.addEventListener("message", onMessage);
      try {
        node.postMessage({
          id,
          file,
          type: file.type,
          maxEdge,
          maxPixels: processingLimits().pixels,
          maxSide: processingLimits().side,
        });
      } catch {
        finish(null);
      }
    },
  );
}

async function rasterToPng(file: File, baseName: string) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  try {
    const bitmap = await bitmapFromAny(file);
    return await fileFromBitmap(bitmap, baseName);
  } catch (error) {
    if (error instanceof CutoutError) throw error;
    return null;
  }
}

/** Bitmap decode that also handles formats the main thread cannot open, by
 *  routing them through the decode worker (TIFF lives there now). */
async function bitmapFromAny(file: File): Promise<ImageBitmap> {
  const tiff = await isTiffBlob(file);
  if (tiff) {
    const decoded = await decodeViaWorker(file, 0);
    if (decoded) return decoded.bitmap;
  }
  return bitmapFromBlob(file, processingLimits());
}

async function isTiffBlob(file: File): Promise<boolean> {
  if (isTiffFile(file)) return true;
  try {
    return sniffImage(new Uint8Array(await file.slice(0, 4).arrayBuffer())) === "tiff";
  } catch {
    return false;
  }
}

/** Exotic formats re-encode to PNG at full size; keep that re-encode inside the
 *  processing budget so converted HD sources stay stable in memory. */
async function fileFromBitmap(bitmap: ImageBitmap, baseName: string) {
  let source = bitmap;
  if (exceedsProcessingBudget(bitmap.width, bitmap.height)) {
    const scale = processingScale(bitmap.width, bitmap.height);
    try {
      source = await resizeBitmap(
        bitmap,
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
        "high",
      );
    } catch {
      source = bitmap;
    }
  }
  if (source !== bitmap) bitmap.close();
  if (typeof document === "undefined") {
    source.close();
    return null;
  }
  const pngBlob = await bitmapToPng(source);
  if (!pngBlob) return null;
  return new File([pngBlob], `${baseName}.png`, { type: "image/png" });
}

async function heicToPng(file: File) {
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  try {
    if (heicDecodesOnMain(file)) {
      const png = await rasterToPng(file, baseName);
      if (png) return png;
    }
    const decoded = await decodeViaWorker(file, 0);
    if (decoded) return await fileFromBitmap(decoded.bitmap, baseName);
    const png = await heicToPngLib(file);
    if (png) return new File([png], `${baseName}.png`, { type: "image/png" });
  } catch (error) {
    if (error instanceof CutoutError) throw error;
    return null;
  }
  return null;
}

async function heicToPngLib(file: File) {
  try {
    const { heicTo } = await import("heic-to/csp");
    const blob = await heicTo({ blob: file, type: "image/png" });
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}

/** The image type a file's first bytes prove, or null. Only this may pass a file on with an
 *  object URL: a type-less blob of markup opened in its own tab renders as a page on the
 *  app's origin, and looking for "<" missed it behind a form feed or 64 spaces. */
export function sniffRasterType(head: Uint8Array): string | null {
  const kind = sniffImage(head);
  if (kind) return `image/${kind}`;
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (ascii(0, 2) === "BM") return "image/bmp";
  const major = isoBmffBrand(head);
  if (major) {
    // Some AVIF writers lead with the generic HEIF brand and list "avif" after it.
    const brands = [major];
    const end = Math.min(head.length, new DataView(head.buffer, head.byteOffset).getUint32(0));
    for (let at = 16; at + 4 <= end; at += 4) brands.push(ascii(at, at + 4).toLowerCase());
    if (brands.some((brand) => AVIF_BRANDS.has(brand))) return "image/avif";
    if (brands.some((brand) => HEIC_BRANDS.has(brand))) return "image/heic";
    return null;
  }
  // ICO and CUR.
  if (head[0] === 0 && head[1] === 0 && (head[2] === 1 || head[2] === 2) && head[3] === 0)
    return "image/x-icon";
  // JPEG XL, bare or in its container (Safari decodes it).
  if ((head[0] === 0xff && head[1] === 0x0a) || ascii(4, 12) === "JXL \r\n\x87\n")
    return "image/jxl";
  return null;
}

/** PDF, DXF, DWG or SKP by name or type, in the order the converter (rasterizeCad) checks. */
function drawingKind(file: File) {
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  if (name.endsWith(".pdf") || type === "application/pdf") return "pdf";
  if (name.endsWith(".dxf") || type.includes("dxf")) return "dxf";
  if (name.endsWith(".dwg") || type.includes("dwg")) return "dwg";
  if (name.endsWith(".skp") || type.includes("sketchup")) return "skp";
  return null;
}

/** SVG by type or name, or anything that is neither a known raster nor a drawing. */
export function needsRasterize(file: File, head: Uint8Array) {
  return isSvgFile(file) || (!sniffRasterType(head) && !drawingKind(file));
}

/** Every file that gets an object URL passes through here first, so markup can never be
 *  opened as a same-origin document. What passes on is typed by its bytes (or as a drawing);
 *  the rest must draw as SVG, or is refused. */
export async function rasterizeSvgFile(file: File): Promise<File> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  if (!needsRasterize(file, head)) {
    const raster = sniffRasterType(head);
    // Ingest, restore and backgrounds all mint source URLs after this gate. Refuse before
    // the stage/thumbnail <img> can decode the original, even if processing would reject it.
    if (raster) await assertDecodableSize(file, processingLimits());
    // A drawing is converted when processed, as before. Until then its object URL gets a type
    // the browser shows itself: WebKit parses one it cannot show (application/dxf, even
    // application/octet-stream) as a page. DXF, DWG and SKP keep their format in the name.
    const kind = raster ? null : drawingKind(file);
    const type = raster ?? (kind === "pdf" ? "application/pdf" : "text/plain");
    const named = !kind || kind === "pdf" || file.name.toLowerCase().endsWith(`.${kind}`);
    const name = named ? file.name : `${file.name}.${kind}`;
    if (file.type === type && name === file.name) return file;
    return new File([file], name, { type, lastModified: file.lastModified });
  }
  const baseName = file.name.replace(/\.[^.]+$/, "") || "image";
  // Retyped so the SVG decoder runs even when the claimed type lied.
  const svg = new File([file], `${baseName}.svg`, { type: "image/svg+xml" });
  const png = await rasterToPng(svg, baseName);
  if (png) return png;
  throw new CutoutError("decode", "This image is damaged or in a format this browser can’t read.");
}

export function isWasmFile(file: File) {
  return /\.wasm$/i.test(file.name) || file.type === "application/wasm";
}

/** Pure drop plan: valid images (capped at 15) plus any user-facing message.
 *  A stray unsupported file must not veto the whole drop — process the valid
 *  images and only explain when nothing usable arrived. */
export function planIngest(files: File[]): {
  images: File[];
  errorMessage: string | null;
} {
  const accepted: File[] = [];
  for (const file of files) {
    if (isAcceptedFile(file)) accepted.push(file);
  }
  if (accepted.length === 0)
    return { images: [], errorMessage: dropRejectionMessage(files) ?? messageFor("sample") };
  return {
    images: accepted.slice(0, 15),
    errorMessage:
      accepted.length > 15
        ? `Loaded the first 15 of ${accepted.length} images. Drop the rest next.`
        : null,
  };
}

export function dropRejectionMessage(files: File[]): string | null {
  if (files.some(isWasmFile)) {
    return "That file is a WebAssembly module, not an image. Drop a PNG, JPG, WebP, HEIC, PDF, DXF, DWG, or SKP file.";
  }
  return null;
}

export function filesFromDrop(data: DataTransfer): File[] {
  const listed = Array.from(data.files ?? []).filter(Boolean);
  if (listed.length) return listed;
  const items: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) items.push(file);
  }
  return items;
}

export function isFileTransfer(data: DataTransfer) {
  if ((data.files?.length ?? 0) > 0) return true;
  const types = data.types;
  // Safari/Chrome from Finder often send an empty types list on the first
  // dragenter. Treat that as a file drag so the page can call preventDefault
  // immediately — otherwise the drop is ignored until the cursor moves.
  if (!types || types.length === 0) return true;
  // "Files", Firefox's "application/x-moz-file", Safari's "public.file-url".
  for (let i = 0; i < types.length; i++) {
    if (types[i]!.toLowerCase().includes("file")) return true;
  }
  try {
    const items = data.items;
    if (items) {
      for (let i = 0; i < items.length; i++) {
        if (items[i]?.kind === "file") return true;
      }
    }
  } catch {
    // Safari can throw if items are read before drop.
  }
  return false;
}

export function fileFromClipboard(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.items)) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

export function resultFilename(name: string, extension: string) {
  const base = name.replace(/\.[^.]+$/, "") || "cutout";
  return `${base}-cutout.${extension}`;
}

type SaveHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
    abort?: () => Promise<void>;
  }>;
};

export function beginSavePicker(filename: string): Promise<SaveHandle> | null {
  const client = readClient();
  if (client.skipSavePicker || client.ios || client.android || client.compact || client.framed)
    return null;
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName?: string;
        types?: Array<{ description: string; accept: Record<string, string[]> }>;
      }) => Promise<SaveHandle>;
    }
  ).showSaveFilePicker;
  if (typeof picker !== "function") return null;
  const mime = mimeForFilename(filename);
  const ext = filename.includes(".") ? filename.slice(filename.lastIndexOf(".")) : ".png";
  try {
    return picker.bind(window)({
      suggestedName: filename,
      types: [{ description: "Image", accept: { [mime]: [ext] } }],
    });
  } catch {
    return null;
  }
}

export async function writeToSaveHandle(
  handlePromise: Promise<SaveHandle>,
  blob: Blob,
  signal?: AbortSignal,
) {
  const handle = await handlePromise;
  signal?.throwIfAborted();
  const writable = await handle.createWritable();
  try {
    signal?.throwIfAborted();
    await writable.write(blob);
    signal?.throwIfAborted();
    await writable.close();
  } catch (error) {
    // A dispatched native operation cannot be recalled. Discard a still-open stream
    // rather than starting its pending write/commit after launch cancellation.
    if (signal?.aborted) await writable.abort?.().catch(() => {});
    throw error;
  }
}

export function downloadBlob(blob: Blob, filename: string): boolean {
  if (typeof document === "undefined" || blob.size < 1) return false;
  const type = blob.type || mimeForFilename(filename);
  const named = new File([blob], filename, { type });
  const url = URL.createObjectURL(named);
  const client = readClient();
  let started = false;
  let previewUrl: string | null = null;

  // Framed preview (Grok iframe, embeds): open a checkerboard HTML page — never a raw
  // PNG tab, which paints transparency as white. Do not pass "noopener" as a window
  // feature; that makes window.open return null even when the tab actually opened.
  if (client.framed && type.startsWith("image/")) {
    try {
      previewUrl = URL.createObjectURL(
        new Blob([downloadPreviewHtml(url, filename)], { type: "text/html" }),
      );
      const popup = window.open(previewUrl, "_blank");
      if (popup) {
        try {
          popup.opener = null;
        } catch {
          // ignore
        }
        started = true;
      }
    } catch {
      started = false;
    }
  }

  if (!started) {
    try {
      const link = document.createElement("a");
      // Framed fallback still uses the checkerboard page — never navigate to a raw PNG.
      link.href = client.framed && previewUrl ? previewUrl : url;
      link.download = filename;
      link.rel = "noopener noreferrer";
      // iOS / phone: Share is preferred (shareBlob); this path is target=_blank + download.
      if (client.ios || client.phone) link.target = "_blank";
      if (client.framed) link.target = "_blank";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
      started = true;
    } catch {
      started = false;
    }
  }

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, 60_000);
  return started;
}

function downloadPreviewHtml(imageUrl: string, filename: string) {
  const name = filename.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  const src = imageUrl.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${name}</title>
<style>
html,body{margin:0;min-height:100%;background:#111;color:#ececec;font:15px/1.4 -apple-system,sans-serif}
.stage{min-height:100dvh;display:grid;place-items:center;padding:3.5rem 1.25rem 6.5rem;background:repeating-conic-gradient(#2a2a2a 0 25%,#1c1c1c 0 50%) 0 0/18px 18px}
img{max-width:min(92vw,1100px);max-height:76dvh}
.bar{position:fixed;left:50%;bottom:1.25rem;transform:translateX(-50%);display:flex;align-items:center;gap:.85rem;padding:.45rem .45rem .45rem 1rem;border-radius:999px;background:rgba(22,22,22,.92)}
a{display:inline-flex;align-items:center;min-height:44px;padding:0 1rem;border-radius:999px;background:#c9d6ea;color:#111;text-decoration:none;font-weight:560}
</style></head><body>
<div class="stage"><img src="${src}" alt="${name}"></div>
<div class="bar"><span>Background removed</span><a href="${src}" download="${name}">Save ${name}</a></div>
</body></html>`;
}
