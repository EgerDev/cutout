import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CutoutError } from "./errors.ts";
import {
  CUTOUT_EXPORT_TYPE,
  dropRejectionMessage,
  fileInputAccept,
  FORMAT_LINE,
  decodeOnMainThread,
  HEIC_MAIN_BYTES,
  MAIN_DECODE_BYTES,
  heicDecodesOnMain,
  IMAGE_ACCEPT_ATTRIBUTE,
  IMAGE_ACCEPT_IOS,
  iosSafariFileInput,
  isAcceptedFile,
  isCutoutExportDrag,
  isFileTransfer,
  isHeicFile,
  isTiffFile,
  isSvgFile,
  isWasmFile,
  isoBmffBrand,
  looksLikeAvif,
  looksLikeHeic,
  mimeForFilename,
  resultFilename,
  setCutoutExportDrag,
  toProcessableFile,
  rasterizeSvgFile,
  imageSizeOf,
  exceedsProcessingBudget,
  processingScale,
} from "./files.ts";

test("FORMAT_LINE advertises phone stills and not CAD", () => {
  assert.equal(FORMAT_LINE, "PNG · JPG · WebP · HEIC");
  assert.ok(FORMAT_LINE.includes("HEIC"));
  assert.ok(!FORMAT_LINE.includes("DXF"));
  assert.ok(!FORMAT_LINE.includes("DWG"));
  assert.ok(!FORMAT_LINE.includes("SKP"));
  assert.ok(!FORMAT_LINE.includes("PDF"));
});

test("isAcceptedFile handles extensions case-insensitively and detects image types", () => {
  const pngUpper = new File([], "PHOTO.PNG");
  const jpgUpper = new File([], "IMAGE.JPG");
  const jpegUpper = new File([], "PICTURE.JPEG");
  const webpUpper = new File([], "GRAPHIC.WEBP");
  const heicUpper = new File([], "IMG_0001.HEIC");
  const heif = new File([], "roll.heif", { type: "image/heif" });
  const heics = new File([], "live.heics");
  const avif = new File([], "pixel.AVIF");
  const gif = new File([], "sticker.gif");
  const jfif = new File([], "camera.jfif");
  const tifUpper = new File([], "SCAN.TIF");
  const tiffUpper = new File([], "DOCUMENT.TIFF");
  const svgUpper = new File([], "VECTOR.SVG");
  const noExtImage = new File([], "pasted-item", { type: "image/png" });
  const noExtNoType = new File([], "unknown-file");
  const wasmFile = new File([], "module.wasm", { type: "application/wasm" });

  assert.equal(isAcceptedFile(pngUpper), true);
  assert.equal(isAcceptedFile(jpgUpper), true);
  assert.equal(isAcceptedFile(jpegUpper), true);
  assert.equal(isAcceptedFile(webpUpper), true);
  assert.equal(isAcceptedFile(heicUpper), true);
  assert.equal(isAcceptedFile(heif), true);
  assert.equal(isAcceptedFile(heics), true);
  assert.equal(isAcceptedFile(avif), true);
  assert.equal(isAcceptedFile(gif), true);
  assert.equal(isAcceptedFile(jfif), true);
  assert.equal(isAcceptedFile(tifUpper), true);
  assert.equal(isAcceptedFile(tiffUpper), true);
  assert.equal(isAcceptedFile(svgUpper), true);
  assert.equal(isAcceptedFile(noExtImage), true);
  assert.equal(isAcceptedFile(noExtNoType), true);
  assert.equal(isAcceptedFile(wasmFile), false);
});

test("isAcceptedFile keeps empty-MIME images but skips system metadata files", () => {
  const dotfile = new File([], ".DS_Store", { type: "" });
  const thumbs = new File([], "Thumbs.db", { type: "" });
  const desktopIni = new File([], "desktop.ini", { type: "" });
  const extlessPhoto = new File([], "IMG_0001", { type: "" });
  const hiddenImage = new File([], ".shot.png", { type: "" });
  const plainText = new File([], "notes.txt", { type: "" });

  assert.equal(isAcceptedFile(dotfile), false);
  assert.equal(isAcceptedFile(thumbs), false);
  assert.equal(isAcceptedFile(desktopIni), false);
  assert.equal(isAcceptedFile(extlessPhoto), true);
  assert.equal(isAcceptedFile(hiddenImage), true);
  assert.equal(isAcceptedFile(plainText), false);
});

test("isWasmFile and dropRejectionMessage reject WebAssembly binaries", () => {
  const wasm = new File([new Uint8Array([0x00, 0x61, 0x73, 0x6d])], "payload.wasm");
  assert.equal(isWasmFile(wasm), true);
  assert.ok(dropRejectionMessage([wasm])?.includes("WebAssembly module"));
  assert.equal(dropRejectionMessage([new File([], "test.png", { type: "image/png" })]), null);
});

test("toProcessableFile normalizes image/jpg and empty MIME types to standard formats", async () => {
  const jpgMisnamed = new File([new Uint8Array([1, 2, 3])], "photo.jpg", { type: "image/jpg" });
  const normalizedJpg = await toProcessableFile(jpgMisnamed);
  assert.equal(normalizedJpg.type, "image/jpeg");

  const pjpeg = new File([new Uint8Array([1, 2, 3])], "scan.jpg", { type: "image/pjpeg" });
  assert.equal((await toProcessableFile(pjpeg)).type, "image/jpeg");

  const jfif = new File([new Uint8Array([1, 2, 3])], "camera.jfif", { type: "" });
  assert.equal((await toProcessableFile(jfif)).type, "image/jpeg");

  const noMimeJpg = new File([new Uint8Array([1, 2, 3])], "vacation.JPEG", { type: "" });
  const normalizedNoMimeJpg = await toProcessableFile(noMimeJpg);
  assert.equal(normalizedNoMimeJpg.type, "image/jpeg");

  const noMimePng = new File([new Uint8Array([1, 2, 3])], "screenshot.PNG", { type: "" });
  const normalizedNoMimePng = await toProcessableFile(noMimePng);
  assert.equal(normalizedNoMimePng.type, "image/png");

  const noMimeWebp = new File([new Uint8Array([1, 2, 3])], "sticker.WEBP", { type: "" });
  const normalizedNoMimeWebp = await toProcessableFile(noMimeWebp);
  assert.equal(normalizedNoMimeWebp.type, "image/webp");
});

test("toProcessableFile detects magic bytes for PNG without extension or MIME", async () => {
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const rawPng = new File([pngBytes], "untyped-image", { type: "" });
  const processed = await toProcessableFile(rawPng);
  assert.equal(processed.type, "image/png");
});

test("toProcessableFile detects magic bytes for JPEG without extension or MIME", async () => {
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
  const rawJpeg = new File([jpegBytes], "untyped-jpeg", { type: "" });
  const processed = await toProcessableFile(rawJpeg);
  assert.equal(processed.type, "image/jpeg");
});

function ftypBox(brand: string) {
  const bytes = new Uint8Array(16);
  bytes[3] = 16;
  bytes.set([0x66, 0x74, 0x79, 0x70], 4);
  bytes.set(
    [brand.charCodeAt(0), brand.charCodeAt(1), brand.charCodeAt(2), brand.charCodeAt(3)],
    8,
  );
  return bytes;
}

test("ISO BMFF brands detect iPhone HEIC and Android AVIF", () => {
  assert.equal(isoBmffBrand(ftypBox("heic")), "heic");
  assert.equal(looksLikeHeic(ftypBox("heic")), true);
  assert.equal(looksLikeHeic(ftypBox("mif1")), true);
  assert.equal(looksLikeHeic(ftypBox("heix")), true);
  assert.equal(looksLikeAvif(ftypBox("avif")), true);
  assert.equal(looksLikeAvif(ftypBox("avis")), true);
  assert.equal(looksLikeHeic(ftypBox("avif")), false);
  assert.equal(looksLikeAvif(ftypBox("heic")), false);
  assert.equal(looksLikeHeic(new Uint8Array([0xff, 0xd8, 0xff])), false);
});

test("HEIC decodes on the main thread only if small", () => {
  const small = new File([new Uint8Array(HEIC_MAIN_BYTES)], "snap.heic", { type: "image/heic" });
  const large = new File([new Uint8Array(HEIC_MAIN_BYTES + 1)], "camera.heic", {
    type: "image/heic",
  });
  const jpeg = new File([new Uint8Array(HEIC_MAIN_BYTES + 1)], "photo.jpg", { type: "image/jpeg" });
  const heics = new File([], "live.heics", { type: "image/heic-sequence" });
  const heif = new File([], "roll.HEIF", { type: "image/heif" });
  assert.equal(isHeicFile(small), true);
  assert.equal(isHeicFile(heics), true);
  assert.equal(isHeicFile(heif), true);
  assert.equal(heicDecodesOnMain(small), true);
  assert.equal(heicDecodesOnMain(large), false);
  assert.equal(heicDecodesOnMain(jpeg), false);
  assert.equal(decodeOnMainThread(large), false);
  assert.equal(decodeOnMainThread(small), true);
  const tinyJpeg = new File([new Uint8Array(32)], "snap.jpg", { type: "image/jpeg" });
  const hugeJpeg = new File([new Uint8Array(MAIN_DECODE_BYTES + 1)], "raw.jpg", {
    type: "image/jpeg",
  });
  assert.equal(decodeOnMainThread(tinyJpeg), true);
  assert.equal(decodeOnMainThread(hugeJpeg), false);

  const tinyTiff = new File([new Uint8Array(32)], "small.tif", { type: "image/tiff" });
  assert.equal(isTiffFile(tinyTiff), true);
  assert.equal(decodeOnMainThread(tinyTiff), false);

  const hugeSvg = new File([new Uint8Array(MAIN_DECODE_BYTES + 100)], "huge.svg", {
    type: "image/svg+xml",
  });
  assert.equal(isSvgFile(hugeSvg), true);
  assert.equal(decodeOnMainThread(hugeSvg), true);
});

test("toProcessableFile throws clear CutoutError on HEIC and unreadable binaries", async () => {
  const heic = new File([new Uint8Array([0, 0, 0, 24])], "camera.heic", { type: "image/heic" });
  assert.equal(isHeicFile(heic), true);
  await assert.rejects(toProcessableFile(heic), (err: unknown) => {
    return err !== null && typeof err === "object" && "code" in err && err.code === "heic";
  });

  const corrupt = new File([new Uint8Array([9, 8, 7])], "corrupted.bin", {
    type: "application/octet-stream",
  });
  await assert.rejects(toProcessableFile(corrupt), (err: unknown) => {
    return err !== null && typeof err === "object" && "code" in err && err.code === "decode";
  });
});

test("resultFilename and mimeForFilename correctly format outputs", () => {
  assert.equal(resultFilename("portrait.jpg", "png"), "portrait-cutout.png");
  assert.equal(resultFilename("cat.photo.png", "webp"), "cat.photo-cutout.webp");
  assert.equal(resultFilename("", "png"), "cutout-cutout.png");

  assert.equal(mimeForFilename("file.jpg"), "image/jpeg");
  assert.equal(mimeForFilename("file.jpeg"), "image/jpeg");
  assert.equal(mimeForFilename("file.webp"), "image/webp");
  assert.equal(mimeForFilename("file.png"), "image/png");
});

test("camera capture is a separate input and never on Choose files", () => {
  const workspace = readFileSync(
    new URL("../features/workspace/workspace.tsx", import.meta.url),
    "utf8",
  );
  const idle = readFileSync(
    new URL("../features/workspace/idle-screen.tsx", import.meta.url),
    "utf8",
  );
  const library = workspace.slice(
    workspace.indexOf("ref={fileRef}"),
    workspace.indexOf("ref={cameraRef}"),
  );
  const camera = workspace.slice(
    workspace.indexOf("ref={cameraRef}"),
    workspace.indexOf('aria-label="Take photo"'),
  );
  assert.equal(library.includes("capture"), false);
  assert.match(library, /multiple/);
  assert.match(camera, /capture="environment"/);
  assert.match(camera, /accept="image\/\*"/);
  assert.equal(camera.includes("multiple"), false);
  assert.match(camera, /className="file-input"/);
  assert.match(workspace, /canCamera = client\.ios \|\| client\.android/);
  assert.match(idle, />\s*Take photo\s*</);
});

test("iOS Safari file input uses image/* so Photos opens", () => {
  assert.equal(iosSafariFileInput({ ios: true }), true);
  assert.equal(iosSafariFileInput({ ios: false }), false);
  assert.equal(fileInputAccept({ ios: true }), IMAGE_ACCEPT_IOS);
  assert.equal(fileInputAccept({ ios: true }), "image/*");
  assert.equal(fileInputAccept({ ios: false, android: true }), "image/*");
  assert.equal(fileInputAccept({ ios: false }), IMAGE_ACCEPT_ATTRIBUTE);
  assert.ok(IMAGE_ACCEPT_ATTRIBUTE.includes(".pdf"));
  assert.equal(IMAGE_ACCEPT_IOS.includes(".pdf"), false);
});

test("CAD and HEIC converters load on demand", () => {
  const src = readFileSync(new URL("./files.ts", import.meta.url), "utf8");
  assert.match(src, /await import\("\.\/cad\.ts"\)/);
  assert.match(src, /heic-to\/csp/);
  assert.equal(src.includes('from "./cad.ts"'), false);
});

test("IMAGE_ACCEPT_ATTRIBUTE avoids slow unregistered MIME types and includes standard types and extensions", () => {
  const parts = IMAGE_ACCEPT_ATTRIBUTE.split(",");
  // Should include standard formats
  assert.ok(parts.includes("image/*"));
  assert.ok(parts.includes("image/png"));
  assert.ok(parts.includes("image/jpeg"));
  assert.ok(parts.includes("image/webp"));
  assert.ok(parts.includes("image/heic"));
  assert.ok(parts.includes("image/heif"));
  assert.ok(parts.includes("image/avif"));
  assert.ok(parts.includes(".png"));
  assert.ok(parts.includes(".jpg"));
  assert.ok(parts.includes(".heic"));
  assert.ok(parts.includes(".heics"));
  assert.ok(parts.includes(".avif"));
  assert.ok(parts.includes(".pdf"));
  assert.ok(parts.includes(".dxf"));
  assert.ok(parts.includes(".dwg"));
  assert.ok(parts.includes(".skp"));

  // Must NOT include slow LaunchServices UTI stalling vendor MIME types
  assert.ok(!parts.includes("application/acad"));
  assert.ok(!parts.includes("image/vnd.dxf"));
  assert.ok(!parts.includes("image/vnd.dwg"));
  assert.ok(!parts.includes("application/vnd.sketchup.skp"));
  assert.ok(!parts.includes("image/jpg"));
});

test("isFileTransfer detects file drag operations accurately and efficiently", () => {
  // Direct files list
  assert.equal(
    isFileTransfer({ files: [new File([], "test.png")] } as unknown as DataTransfer),
    true,
  );

  // DOMStringList with includes
  const browserLikeTransfer = {
    files: [],
    types: ["Files"],
  } as unknown as DataTransfer;
  assert.equal(isFileTransfer(browserLikeTransfer), true);

  // Firefox file drag
  const mozTransfer = {
    files: [],
    types: ["application/x-moz-file"],
  } as unknown as DataTransfer;
  assert.equal(isFileTransfer(mozTransfer), true);

  // Text/plain or internal drag is not a file transfer
  const textTransfer = {
    files: [],
    types: ["text/plain"],
  } as unknown as DataTransfer;
  assert.equal(isFileTransfer(textTransfer), false);

  // OS file drags (Safari/Chrome from Finder) often arrive with empty types
  // on the first dragenter — treat that as a file transfer so the drop target
  // arms immediately instead of waiting for the cursor to move.
  assert.equal(isFileTransfer({ files: [], types: [] } as unknown as DataTransfer), true);

  // Image dragged from another page: items report kind=file before "Files" lands in types
  const webImageTransfer = {
    files: [],
    types: ["text/html", "text/uri-list"],
    items: [{ kind: "file", type: "image/jpeg" }],
  } as unknown as DataTransfer;
  assert.equal(isFileTransfer(webImageTransfer), true);
});

test("decode falls back to ImageDecoder then heic-to and skips HEIC types", () => {
  const decode = readFileSync(new URL("./decode-bitmap.ts", import.meta.url), "utf8");
  const files = readFileSync(new URL("./files.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("./decode-worker.ts", import.meta.url), "utf8");
  assert.match(files, /await bitmapFromBlob\(/);
  assert.match(worker, /await bitmapFromBlob\(/);
  assert.equal(files.includes("async function bitmapFromBlob"), false);
  assert.equal(worker.includes("async function bitmapFromBlob"), false);
  const body = decode.slice(
    decode.indexOf("export async function bitmapFromBlob"),
    decode.indexOf("async function bitmapFromImageDecoder"),
  );
  const createFirst = body.indexOf("createImageBitmap(blob)");
  const decoder = body.indexOf("bitmapFromImageDecoder");
  const heic = body.indexOf("heic-to/csp");
  assert.ok(createFirst >= 0 && decoder > createFirst && heic > decoder);
  assert.match(body, /catch \{/);
  assert.match(body, /heicTo\(\{ blob, type: "bitmap" \}\)/);
  const helper = decode.slice(decode.indexOf("async function bitmapFromImageDecoder"));
  assert.match(helper, /if \(!type \|\| HEIC_TYPE\.test\(type\)\) return null;/);
  assert.match(helper, /isTypeSupported/);
  assert.match(helper, /data: blob\.stream\(\)/);
  assert.match(helper, /preferAnimation:\s*false/);
  assert.match(decode, /finally \{\s*image\.close\(\);/s);
  assert.match(decode, /finally \{\s*decoder\?\.close\(\);/s);
});

test("isCutoutExportDrag ignores outbound cutout drags without changing Finder drops", () => {
  assert.equal(isCutoutExportDrag(), false);
  assert.equal(isFileTransfer({ files: [], types: [] } as unknown as DataTransfer), true);
  assert.equal(
    isFileTransfer({ types: [CUTOUT_EXPORT_TYPE, "Files"], files: [] } as unknown as DataTransfer),
    true,
  );
  setCutoutExportDrag(true);
  assert.equal(isCutoutExportDrag(), true);
  setCutoutExportDrag(false);
  assert.equal(isCutoutExportDrag(), false);
});

function pngHeaderBlob(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, 13); // IHDR length
  bytes.set([0x49, 0x48, 0x44, 0x52], 16);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8; // bit depth
  bytes[25] = 6; // RGBA
  return new Blob([bytes], { type: "image/png" });
}

function jpegHeaderBlob(width: number, height: number) {
  const bytes = new Uint8Array(39);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0xff;
  bytes[1] = 0xd8; // SOI
  bytes[2] = 0xff;
  bytes[3] = 0xe0; // APP0
  view.setUint16(4, 16); // segment length
  bytes[20] = 0xff;
  bytes[21] = 0xc0; // SOF0
  view.setUint16(22, 15); // segment length
  bytes[24] = 8; // precision
  view.setUint16(25, height);
  view.setUint16(27, width);
  bytes[29] = 3; // components
  return new Blob([bytes], { type: "image/jpeg" });
}

function webpHeaderBlob(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  bytes.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
  bytes[20] = 21;
  const w = width - 1,
    h = height - 1;
  bytes[24] = w & 0xff;
  bytes[25] = (w >> 8) & 0xff;
  bytes[26] = (w >> 16) & 0xff;
  bytes[27] = h & 0xff;
  bytes[28] = (h >> 8) & 0xff;
  bytes[29] = (h >> 16) & 0xff;
  return new Blob([bytes], { type: "image/webp" });
}

test("imageSizeOf parses PNG, JPEG and WebP headers without decoding", async () => {
  const png = await imageSizeOf(
    new File([pngHeaderBlob(320, 200)], "a.png", { type: "image/png" }),
  );
  assert.deepEqual(png, { width: 320, height: 200 });
  const jpg = await imageSizeOf(
    new File([jpegHeaderBlob(640, 480)], "a.jpg", { type: "image/jpeg" }),
  );
  assert.deepEqual(jpg, { width: 640, height: 480 });
  const webp = await imageSizeOf(
    new File([webpHeaderBlob(1024, 256)], "a.webp", { type: "image/webp" }),
  );
  assert.deepEqual(webp, { width: 1024, height: 256 });
  assert.equal(await imageSizeOf(new File(["nope"], "x.bin", { type: "" })), null);
});

test("imageSizeOf reads JPEG dimensions when legal fill bytes precede a marker", async () => {
  // Given a JPEG with a padding FF before its APP0 marker.
  const original = new Uint8Array(await jpegHeaderBlob(640, 480).arrayBuffer());
  const bytes = new Uint8Array(original.length + 1);
  bytes.set(original.subarray(0, 2));
  bytes[2] = 0xff;
  bytes.set(original.subarray(2), 3);
  // When its dimensions are read to enforce the processing budget.
  const size = await imageSizeOf(new Blob([bytes], { type: "image/jpeg" }));
  // Then marker padding does not hide the image's real size.
  assert.deepEqual(size, { width: 640, height: 480 });
});

test("imageSizeOf finds a JPEG's size behind metadata larger than its first read", async () => {
  // Five 64 KB APP1 segments (XMP, ICC, MPF previews) push the frame header past 256 KB.
  const segment = (fill: number) => {
    const bytes = new Uint8Array(65_535 + 2).fill(fill);
    bytes.set([0xff, 0xe1, 0xff, 0xff]);
    return bytes;
  };
  const sof = new Uint8Array([0xff, 0xc0, 0x00, 0x11, 0x08, 0x1b, 0x58, 0x24, 0x90, 0x03]);
  const file = new File(
    [new Uint8Array([0xff, 0xd8]), ...[1, 2, 3, 4, 5].map(segment), sof, new Uint8Array(64)],
    "lightroom.jpg",
    { type: "image/jpeg" },
  );
  assert.deepEqual(await imageSizeOf(file), { width: 9360, height: 7000 });
});

/** A GIF with a small colour table, a control extension, then its first frame's descriptor. */
function gifHeaderBlob(width: number, height: number, frame: [number, number] = [width, height]) {
  const bytes = new Uint8Array(64);
  bytes.set(new TextEncoder().encode("GIF89a"));
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  bytes[10] = 0x80; // a two-colour global table (6 bytes) follows the screen descriptor
  bytes.set([0x21, 0xf9, 4, 0, 0, 0, 0, 0], 19);
  bytes[27] = 0x2c;
  view.setUint16(32, frame[0], true);
  view.setUint16(34, frame[1], true);
  return new Blob([bytes], { type: "image/gif" });
}

function bmpHeaderBlob(width: number, height: number, core = false) {
  const bytes = new Uint8Array(64);
  bytes.set([0x42, 0x4d]);
  const view = new DataView(bytes.buffer);
  view.setUint32(14, core ? 12 : 40, true);
  if (core) {
    view.setUint16(18, width, true);
    view.setUint16(20, height, true);
  } else {
    view.setInt32(18, width, true);
    view.setInt32(22, height, true);
  }
  return new Blob([bytes], { type: "image/bmp" });
}

/** ISO-BMFF boxes: a 32-bit size, a four-character type, then the payload. */
function box(type: string, ...payload: Uint8Array[]) {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);
  new DataView(bytes.buffer).setUint32(0, size);
  bytes.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of payload) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function ispe(width: number, height: number) {
  const bytes = new Uint8Array(12);
  new DataView(bytes.buffer).setUint32(4, width);
  new DataView(bytes.buffer).setUint32(8, height);
  return box("ispe", bytes);
}

/** A still with a thumbnail: two ispe properties, the image's own the larger. Optionally
 *  behind a media box, which the walk must skip by its size rather than read. */
function heifHeaderBlob(brand: string, width: number, height: number, mdatFirst = 0) {
  const ftyp = box("ftyp", new TextEncoder().encode(`${brand}\0\0\0\0mif1`));
  const meta = box(
    "meta",
    new Uint8Array(4),
    box("hdlr", new Uint8Array(24)),
    box("iprp", box("ipco", ispe(320, 240), ispe(width, height)), box("ipma", new Uint8Array(8))),
  );
  const parts = mdatFirst ? [ftyp, box("mdat", new Uint8Array(mdatFirst)), meta] : [ftyp, meta];
  return new Blob(parts, { type: brand === "avif" ? "image/avif" : "image/heic" });
}

test("imageSizeOf reads GIF, BMP and HEIF/AVIF headers without decoding", async () => {
  assert.deepEqual(await imageSizeOf(gifHeaderBlob(640, 480)), { width: 640, height: 480 });
  // Decoders size a GIF to a first frame that overflows its logical screen.
  assert.deepEqual(await imageSizeOf(gifHeaderBlob(1, 1, [20000, 300])), {
    width: 20000,
    height: 300,
  });
  assert.equal(await imageSizeOf(gifHeaderBlob(0, 480)), null);
  assert.deepEqual(await imageSizeOf(bmpHeaderBlob(800, 600)), { width: 800, height: 600 });
  // A negative height is a top-down BMP, same size.
  assert.deepEqual(await imageSizeOf(bmpHeaderBlob(800, -600)), { width: 800, height: 600 });
  assert.deepEqual(await imageSizeOf(bmpHeaderBlob(320, 200, true)), { width: 320, height: 200 });
  assert.deepEqual(await imageSizeOf(heifHeaderBlob("heic", 4032, 3024)), {
    width: 4032,
    height: 3024,
  });
  assert.deepEqual(await imageSizeOf(heifHeaderBlob("avif", 1200, 900, 300_000)), {
    width: 1200,
    height: 900,
  });
});

const tooLarge = (error: unknown) =>
  error instanceof CutoutError &&
  error.code === "memory" &&
  error.message === "This image is too large for this device. Try a smaller photo.";

test("toProcessableFile refuses a size far over the budget from the header, before any decode", async () => {
  const scope = globalThis as { createImageBitmap?: unknown; document?: unknown };
  let decodes = 0;
  scope.createImageBitmap = () => {
    decodes += 1;
    return Promise.reject(new Error("decoded"));
  };
  scope.document = {};
  try {
    // A ~300 KB flat PNG can declare 16384 x 16384: a 1 GB frame that went straight to the
    // remover, which decoded it in full before scaling it down.
    const bomb = new File([pngHeaderBlob(16384, 16384)], "flat.png", { type: "image/png" });
    await assert.rejects(toProcessableFile(bomb), tooLarge);
    // Every format the header reader knows, typed or not.
    for (const blob of [
      gifHeaderBlob(20000, 20000),
      gifHeaderBlob(1, 1, [16000, 16000]),
      bmpHeaderBlob(30000, -30000),
      heifHeaderBlob("avif", 16384, 16384),
      heifHeaderBlob("heic", 20000, 12000, 1000),
      jpegHeaderBlob(65000, 4000),
      webpHeaderBlob(16384, 16384),
    ]) {
      for (const type of [blob.type, ""])
        await assert.rejects(toProcessableFile(new File([blob], "big", { type })), tooLarge);
    }
    assert.equal(decodes, 0, "nothing was decoded");
    // Just over the budget is still taken in, and scaled down to fit as before.
    const over = new File([pngHeaderBlob(10000, 10000)], "big.png", { type: "image/png" });
    assert.equal(await toProcessableFile(over), over);
    assert.equal(decodes, 0);
  } finally {
    delete scope.createImageBitmap;
    delete scope.document;
  }
});

test("bitmapFromBlob refuses a declared size far over its limits without decoding", async () => {
  const { bitmapFromBlob } = await import("./decode-bitmap.ts");
  const scope = globalThis as { createImageBitmap?: unknown };
  let decodes = 0;
  scope.createImageBitmap = async () => {
    decodes += 1;
    return { width: 1, height: 1, close() {} };
  };
  try {
    await assert.rejects(bitmapFromBlob(pngHeaderBlob(16384, 16384)), tooLarge);
    await assert.rejects(bitmapFromBlob(heifHeaderBlob("heic", 20000, 12000)), tooLarge);
    assert.equal(decodes, 0);
    // Under twice the budget the decode goes ahead and the caller scales the result down.
    await bitmapFromBlob(pngHeaderBlob(10000, 10000));
    assert.equal(decodes, 1);
  } finally {
    delete scope.createImageBitmap;
  }
});

test("processing budget helpers respect device memory and canvas limits", () => {
  assert.equal(exceedsProcessingBudget(4000, 3000), false);
  assert.equal(exceedsProcessingBudget(16000, 12000), true);
  const scale = processingScale(20000, 10000);
  assert.ok(scale < 0.75 && scale > 0.6, `scale ${scale}`);
  assert.equal(processingScale(4000, 3000), 1);
  // Low-memory devices get a third of the budget.
  assert.equal(processingScale(20000, 10000, 3) < processingScale(20000, 10000, 8), true);
});

import { readClient } from "./device.ts";
import { processingLimits } from "./files.ts";

const IPHONE_17 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_18 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_17 =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const PIXEL =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const env = (userAgent: string, maxTouchPoints = 0, pointerCoarse = false) => ({
  userAgent,
  maxTouchPoints,
  pointerCoarse,
  compactViewport: false,
  framed: false,
});

test("processing limits respect the iOS canvas caps and phone memory", () => {
  // iOS 17: canvas area is hard-capped at 16.7 MP and 4096 px per side; no deviceMemory is reported.
  assert.deepEqual(processingLimits(undefined, env(IPHONE_17, 5, true)), {
    pixels: 16_000_000,
    side: 4096,
  });
  // iOS 18 raised the cap to 67 MP / 8192; memory still bounds it.
  assert.deepEqual(processingLimits(undefined, env(IPHONE_18, 5, true)), {
    pixels: 24_000_000,
    side: 8192,
  });
  // iPad with a desktop-class agent is still iOS.
  assert.deepEqual(processingLimits(undefined, env(IPAD_DESKTOP_17, 5, true)), {
    pixels: 16_000_000,
    side: 4096,
  });
  // Android phones report deviceMemory; the phone cap applies on top.
  assert.deepEqual(processingLimits(8, env(PIXEL, 5, true)), { pixels: 24_000_000, side: 16384 });
  assert.equal(processingLimits(3, env(PIXEL, 5, true)).pixels, 24_000_000);
  // Desktops keep the generic budget.
  assert.deepEqual(processingLimits(undefined, env(MAC_CHROME)), {
    pixels: 96_000_000,
    side: 16384,
  });
  assert.equal(processingLimits(4, env(MAC_CHROME)).pixels, 32_000_000);
});

const WIN_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

test("a Windows desktop stays on the desktop budget, including a touchscreen", () => {
  for (const maxTouchPoints of [0, 5]) {
    const client = readClient({
      userAgent: WIN_CHROME,
      maxTouchPoints,
      pointerCoarse: false,
      compactViewport: false,
      framed: false,
    });
    assert.equal(client.ios, false);
    assert.equal(client.android, false);
    assert.equal(client.phone, false);
    assert.equal(client.skipSavePicker, false);
    assert.equal(client.saveViaShare, false);
    for (const memory of [undefined, 8]) {
      assert.deepEqual(processingLimits(memory, env(WIN_CHROME, maxTouchPoints, false)), {
        pixels: 96_000_000,
        side: 16384,
      });
    }
  }
});

test("the processing scale fits large photos to an iPhone canvas", () => {
  const iphone = env(IPHONE_17, 5, true);
  assert.equal(exceedsProcessingBudget(8000, 6000, undefined, iphone), true);
  const scale = processingScale(8000, 6000, undefined, iphone);
  assert.ok(8000 * scale <= 4096 && 8000 * 6000 * scale * scale <= 16_000_000, `scale ${scale}`);
  assert.equal(exceedsProcessingBudget(4032, 3024, undefined, iphone), false);
  // 5000x3000 fits the area but not the iOS 17 side cap.
  assert.equal(exceedsProcessingBudget(5000, 3000, undefined, iphone), true);
  assert.equal(exceedsProcessingBudget(5000, 3000, undefined, env(IPHONE_18, 5, true)), false);
});

test("the predecode ceiling is exactly twice each device pixel and side budget", async () => {
  const { declaresTooMuch, bitmapFromBlob } = await import("./decode-bitmap.ts");
  const cases = [
    ["desktop", processingLimits(undefined, env(MAC_CHROME)), 16000, 12000],
    ["4 GB desktop", processingLimits(4, env(MAC_CHROME)), 8000, 8000],
    ["iOS 17", processingLimits(8, env(IPHONE_17, 5, true)), 8000, 4000],
    ["iOS 18", processingLimits(8, env(IPHONE_18, 5, true)), 8000, 6000],
    ["Android", processingLimits(8, env(PIXEL, 5, true)), 8000, 6000],
  ] as const;
  const original = globalThis.createImageBitmap;
  let decodes = 0;
  globalThis.createImageBitmap = (async () => {
    decodes += 1;
    return { close() {} } as ImageBitmap;
  }) as typeof createImageBitmap;
  try {
    for (const [label, limits, width, height] of cases) {
      for (const size of [
        { width, height: height - 1 },
        { width, height },
        { width: 2 * limits.side - 1, height: 1 },
        { width: 2 * limits.side, height: 1 },
        { width: 1, height: 2 * limits.side },
      ]) {
        assert.equal(declaresTooMuch(size, limits), false, `${label} ${JSON.stringify(size)}`);
        const before = decodes;
        await bitmapFromBlob(pngHeaderBlob(size.width, size.height), limits);
        assert.equal(decodes, before + 1, label);
      }
      for (const size of [
        { width, height: height + 1 },
        { width: 2 * limits.side + 1, height: 1 },
        { width: 1, height: 2 * limits.side + 1 },
      ]) {
        assert.equal(declaresTooMuch(size, limits), true, `${label} ${JSON.stringify(size)}`);
        const before = decodes;
        await assert.rejects(
          bitmapFromBlob(pngHeaderBlob(size.width, size.height), limits),
          tooLarge,
        );
        assert.equal(decodes, before, label);
      }
    }
  } finally {
    globalThis.createImageBitmap = original;
  }
});

test("the common object URL gate refuses oversized rasters before returning them", async () => {
  const original = globalThis.createImageBitmap;
  let decodes = 0;
  globalThis.createImageBitmap = (async () => {
    decodes += 1;
    throw new Error("unexpected decode");
  }) as typeof createImageBitmap;
  try {
    for (const blob of [
      pngHeaderBlob(16384, 16384),
      jpegHeaderBlob(65000, 4000),
      webpHeaderBlob(16384, 16384),
      gifHeaderBlob(1, 1, [16000, 16000]),
      bmpHeaderBlob(30000, 30000),
      heifHeaderBlob("heic", 20000, 12000, 300000),
      heifHeaderBlob("avif", 16384, 16384),
    ]) {
      for (const type of [blob.type, "", "text/html"]) {
        await assert.rejects(rasterizeSvgFile(new File([blob], "upload", { type })), tooLarge);
      }
    }
    const kept = new File([pngHeaderBlob(10000, 10000)], "kept.png", { type: "image/png" });
    assert.equal(await rasterizeSvgFile(kept), kept);
    assert.equal(decodes, 0);
  } finally {
    globalThis.createImageBitmap = original;
  }
});

test("drawings over CAD_MAX_BYTES are refused before their bytes are read", async () => {
  const { CAD_MAX_BYTES } = await import("./cad.ts");
  const { CutoutError } = await import("./errors.ts");
  const file = new File([new Uint8Array(16)], "site-plan.dxf");
  Object.defineProperty(file, "size", { value: CAD_MAX_BYTES + 1 });
  file.arrayBuffer = () => Promise.reject(new Error("read the whole drawing"));
  await assert.rejects(
    toProcessableFile(file),
    (error) => error instanceof CutoutError && error.code === "drawing",
  );
});

test("DXFs over CAD_MAX_DXF_BYTES are refused before reading; other drawings keep the 50 MB cap", async () => {
  const { CAD_MAX_DXF_BYTES } = await import("./cad.ts");
  const { CutoutError } = await import("./errors.ts");
  const oversized = (name: string) => {
    const file = new File([new Uint8Array(16)], name);
    Object.defineProperty(file, "size", { value: CAD_MAX_DXF_BYTES + 1 });
    file.arrayBuffer = () => Promise.reject(new Error("read the whole drawing"));
    return file;
  };
  await assert.rejects(
    toProcessableFile(oversized("site-plan.dxf")),
    (error) =>
      error instanceof CutoutError && error.code === "drawing" && /over 20 MB/.test(error.message),
  );
  // A PDF of the same size is under its 50 MB cap, so its bytes are read.
  await assert.rejects(toProcessableFile(oversized("site-plan.pdf")), /read the whole drawing/);
});

test("a decode that times out terminates the worker, and the next decode gets a fresh one", async (t) => {
  // A fresh module instance: earlier tests ran without a Worker global and left the
  // shared one marked unavailable.
  const fresh = new URL("./files.ts?worker-timeout", import.meta.url).href;
  const { createDisplayPreview } = (await import(fresh)) as typeof import("./files.ts");
  const made: FakeWorker[] = [];
  class FakeWorker extends EventTarget {
    posted: Array<{ maxPixels?: number }> = [];
    terminated = false;
    constructor() {
      super();
      made.push(this);
    }
    postMessage(message: { maxPixels?: number }) {
      this.posted.push(message);
    }
    terminate() {
      this.terminated = true;
    }
  }
  const scope = globalThis as { Worker?: unknown; window?: unknown };
  scope.Worker = FakeWorker;
  scope.window = {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  try {
    const tiff = () => new File([new Uint8Array(8)], "scan.tif", { type: "image/tiff" });
    const first = createDisplayPreview(tiff());
    await flush();
    t.mock.timers.tick(8000);
    assert.equal((await first).bitmap, null);
    assert.equal(made.length, 1);
    assert.equal(made[0]!.terminated, true);
    assert.equal(made[0]!.posted[0]!.maxPixels, processingLimits().pixels);

    const second = createDisplayPreview(tiff());
    await flush();
    assert.equal(made.length, 2, "a stuck worker must not receive the next job");
    t.mock.timers.tick(8000);
    await second;
  } finally {
    delete scope.Worker;
    delete scope.window;
  }
});

test("decodes wait their turn, so a slow one cannot time out the file queued behind it", async (t) => {
  const fresh = new URL("./files.ts?worker-retire", import.meta.url).href;
  const { createDisplayPreview } = (await import(fresh)) as typeof import("./files.ts");
  const made: Array<EventTarget & { posted: number }> = [];
  class SilentWorker extends EventTarget {
    posted = 0;
    constructor() {
      super();
      made.push(this);
    }
    postMessage() {
      this.posted += 1;
    }
    terminate() {}
  }
  const scope = globalThis as { Worker?: unknown; window?: unknown };
  scope.Worker = SilentWorker;
  scope.window = {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const tiff = () => new File([new Uint8Array(8)], "scan.tif", { type: "image/tiff" });
  try {
    const first = createDisplayPreview(tiff());
    let secondDone = false;
    const second = createDisplayPreview(tiff()).then((preview) => {
      secondDone = true;
      return preview;
    });
    await flush();
    assert.equal(made.length, 1);
    assert.equal(made[0]!.posted, 1, "only one decode is in the worker at a time");
    t.mock.timers.tick(8000);
    assert.equal((await first).bitmap, null);
    await flush();
    assert.equal(secondDone, false, "the queued decode's timer had not started");
    assert.equal(made.length, 2, "it runs on a fresh worker once the stuck one is retired");
    t.mock.timers.tick(8000);
    assert.equal((await second).bitmap, null);

    // A crash settles the job it held at once, and later decodes skip workers.
    let thirdDone = false;
    const third = createDisplayPreview(tiff()).then(() => (thirdDone = true));
    await flush();
    assert.equal(made.length, 3);
    made[2]!.dispatchEvent(new Event("error"));
    await flush();
    assert.equal(thirdDone, true, "a crashed worker's job must settle at once");
    await third;
    assert.equal((await createDisplayPreview(tiff())).bitmap, null);
    assert.equal(made.length, 3);
  } finally {
    delete scope.Worker;
    delete scope.window;
  }
});

test("a full-size decode for removal goes ahead of previews still waiting", async (t) => {
  const fresh = new URL("./files.ts?worker-priority", import.meta.url).href;
  const { createDisplayPreview, toProcessableFile: toProcessable } = (await import(
    fresh
  )) as typeof import("./files.ts");
  const made: Array<EventTarget & { edges: number[] }> = [];
  class SilentWorker extends EventTarget {
    edges: number[] = [];
    constructor() {
      super();
      made.push(this);
    }
    postMessage({ maxEdge }: { maxEdge: number }) {
      this.edges.push(maxEdge);
    }
    terminate() {}
  }
  const scope = globalThis as {
    Worker?: unknown;
    window?: unknown;
    document?: unknown;
    createImageBitmap?: unknown;
  };
  scope.Worker = SilentWorker;
  scope.window = {
    setTimeout: (run: () => void, ms: number) => setTimeout(run, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  };
  scope.document = {};
  scope.createImageBitmap = () => Promise.reject(new Error("no main-thread decode"));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flush = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const tiff = () => new File([new Uint8Array(8)], "scan.tif", { type: "image/tiff" });
  try {
    const previews = [createDisplayPreview(tiff()), createDisplayPreview(tiff())];
    await flush();
    const full = toProcessable(tiff()).catch(() => null);
    await flush();
    assert.deepEqual(made[0]!.edges, [1600], "the first preview is in the worker");
    t.mock.timers.tick(8000);
    await flush();
    assert.deepEqual(made[1]!.edges, [0], "the full decode runs before the waiting preview");
    t.mock.timers.tick(8000);
    await flush();
    await full;
    assert.deepEqual(made.at(-1)!.edges, [1600], "then the preview");
    t.mock.timers.tick(8000);
    await Promise.all(previews);
  } finally {
    delete scope.Worker;
    delete scope.window;
    delete scope.document;
    delete scope.createImageBitmap;
  }
});

test("a TIFF the worker refuses as too large is not decoded on the main thread instead", async () => {
  const fresh = new URL("./files.ts?worker-memory", import.meta.url).href;
  const { createDisplayPreview, toProcessableFile: toProcessable } = (await import(
    fresh
  )) as typeof import("./files.ts");
  const { CutoutError } = await import("./errors.ts");
  class RefusingWorker extends EventTarget {
    postMessage({ id }: { id: number }) {
      const data = { id, error: "memory", message: "This image is too large for this device." };
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data })));
    }
    terminate() {}
  }
  let mainThreadDecodes = 0;
  const scope = globalThis as {
    Worker?: unknown;
    window?: unknown;
    document?: unknown;
    createImageBitmap?: unknown;
  };
  scope.Worker = RefusingWorker;
  scope.window = { setTimeout, clearTimeout };
  scope.document = {};
  scope.createImageBitmap = () => {
    mainThreadDecodes += 1;
    return Promise.reject(new Error("main-thread decode"));
  };
  try {
    const tiff = () => new File([new Uint8Array(8)], "scan.tif", { type: "image/tiff" });
    await assert.rejects(
      toProcessable(tiff()),
      (error) =>
        error instanceof CutoutError &&
        error.code === "memory" &&
        error.message === "This image is too large for this device.",
    );
    assert.equal((await createDisplayPreview(tiff())).bitmap, null);
    assert.equal(mainThreadDecodes, 0);
  } finally {
    delete scope.Worker;
    delete scope.window;
    delete scope.document;
    delete scope.createImageBitmap;
  }
});

test("object URL, main preview and worker callers use the current device limits", async () => {
  const { createDisplayPreview } = (await import(
    new URL("./files.ts?device-limits", import.meta.url).href
  )) as typeof import("./files.ts");
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const scope = globalThis as { window?: unknown; Worker?: unknown };
  const original = globalThis.createImageBitmap;
  const posted: Array<{ maxPixels: number; maxSide: number }> = [];
  let decodes = 0;
  class CountingWorker extends EventTarget {
    postMessage(message: { id: number; maxPixels: number; maxSide: number }) {
      posted.push(message);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", { data: { id: message.id, error: "decode" } }),
        ),
      );
    }
    terminate() {}
  }
  scope.Worker = CountingWorker;
  scope.window = { setTimeout, clearTimeout };
  globalThis.createImageBitmap = (async () => {
    decodes++;
    throw new Error("counted decode");
  }) as typeof createImageBitmap;
  try {
    for (const userAgent of [MAC_CHROME, IPHONE_17, IPHONE_18, PIXEL]) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { userAgent, maxTouchPoints: 5 },
      });
      const limits = processingLimits();
      const oversized = new File([pngHeaderBlob(2 * limits.side + 1, 1)], "wide.png", {
        type: "image/png",
      });
      await assert.rejects(rasterizeSvgFile(oversized), tooLarge);
      const before = decodes;
      assert.equal((await createDisplayPreview(oversized)).bitmap, null);
      assert.equal(decodes, before);
      await createDisplayPreview(new File([new Uint8Array(8)], "scan.tif", { type: "image/tiff" }));
      assert.equal(posted.at(-1)?.maxPixels, limits.pixels);
      assert.equal(posted.at(-1)?.maxSide, limits.side);
    }
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else Reflect.deleteProperty(globalThis, "navigator");
    globalThis.createImageBitmap = original;
    delete scope.window;
    delete scope.Worker;
  }
});
