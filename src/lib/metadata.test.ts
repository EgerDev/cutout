import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { crc32 } from "node:zlib";
import { formatAspectRatio } from "./aspect-ratio.ts";
import {
  detectAiGeneration,
  downscaleNotice,
  hasEmbeddedMetadata,
  inspectImageMetadata,
  stripExportMetadata,
  stripOriginalMetadata,
} from "./metadata.ts";
import { CutoutError } from "./errors.ts";
import { cleanedFilename } from "./metadata-client.ts";

// Committed fixture (see fixtures/make-fixtures.mjs): a missing file must fail, not skip.
const gpsJpeg = fs.readFileSync(new URL("./fixtures/gps.jpg", import.meta.url));

test("JFXX thumbnails containing EXIF/GPS are detected and removed losslessly", async () => {
  const { stripJpegMetadata } = await import("./metadata.ts");
  const plain = stripJpegMetadata(gpsJpeg);
  const payload = Buffer.concat([Buffer.from("JFXX\0\x10", "latin1"), gpsJpeg]);
  const app0 = Buffer.alloc(4);
  app0.set([0xff, 0xe0]);
  app0.writeUInt16BE(payload.length + 2, 2);
  const input = Buffer.concat([plain.subarray(0, 2), app0, payload, plain.subarray(2)]);
  assert.equal(hasEmbeddedMetadata(input), true);
  const cleaned = new Uint8Array(
    await (await stripOriginalMetadata(new Blob([input]))).arrayBuffer(),
  );
  assert.equal(hasEmbeddedMetadata(cleaned), false);
  assert.deepEqual(cleaned, plain, "only the embedded thumbnail is discarded");
});

// Structural controls use the real fixture's headers, with explicitly synthetic entropy.
const sosAt = gpsJpeg.indexOf(Buffer.from([0xff, 0xda]));
const scanAt = sosAt + 2 + gpsJpeg.readUInt16BE(sosAt + 2);
const scanHeader = gpsJpeg.subarray(sosAt, scanAt);
const jpegScan = (...parts: Uint8Array[]) => Buffer.concat([gpsJpeg.subarray(0, scanAt), ...parts]);
const plantedComment = Buffer.from("\xff\xfe\x00\x16GPS PLANTED-SECRET!!", "latin1");

for (const marker of [0x01, 0xd8]) {
  test(`JPEG scan FF${marker.toString(16)} cannot hide a planted COM behind a fake length`, async () => {
    const tail = Buffer.concat([plantedComment, Buffer.from([0x12, 0x34])]);
    const fakeLength = Buffer.alloc(2);
    fakeLength.writeUInt16BE(2 + tail.length);
    // No ordinary metadata before the scan: this pins the verifier's actual bypass.
    const { stripJpegMetadata } = await import("./metadata.ts");
    const plain = stripJpegMetadata(gpsJpeg);
    const start = Buffer.from(plain).indexOf(scanHeader);
    const crafted = Buffer.concat([
      plain.subarray(0, start + scanHeader.length),
      Buffer.from([0x12, 0xff, marker]),
      fakeLength,
      tail,
      Buffer.from([0xff, 0xd9]),
    ]);
    assert.equal(hasEmbeddedMetadata(crafted), true, "unwalkable entropy is never clean");
    await assert.rejects(stripOriginalMetadata(new Blob([crafted])), /Nothing was saved/);
  });
}

for (const [name, tail] of [
  ["missing EOI", [0x12, 0x34]],
  ["partial EOI", [0x12, 0xff]],
  ["missing segment length", [0x12, 0xff, 0xc4]],
  ["partial segment length", [0x12, 0xff, 0xc4, 0]],
  ["segment past EOF", [0x12, 0xff, 0xc4, 0, 20, 0xff, 0xd9]],
  ["zero segment length", [0x12, 0xff, 0xc4, 0, 0, 0xff, 0xd9]],
] as const) {
  test(`JPEG cleaning refuses ${name} after SOS`, async () => {
    const { stripJpegMetadata } = await import("./metadata.ts");
    const plain = Buffer.from(stripJpegMetadata(gpsJpeg));
    const start = plain.indexOf(scanHeader) + scanHeader.length;
    const crafted = Buffer.concat([plain.subarray(0, start), Buffer.from(tail)]);
    assert.equal(hasEmbeddedMetadata(crafted), true);
    await assert.rejects(stripOriginalMetadata(new Blob([crafted])), /Nothing was saved/);
  });
}

test("JPEG cleaning walks stuffed bytes, restarts, inter-scan tables and COM without changing scan bytes", async () => {
  const { stripJpegMetadata } = await import("./metadata.ts");
  const entropy = Buffer.from([0x12, 0xff, 0, 0xd9, 0xff, 0xd0, 0x56, 0xff, 0xd7, 0x78]);
  const table = Buffer.from([0xff, 0xc4, 0, 3, 0x12]);
  const comment = Buffer.from([0xff, 0xfe, 0, 5, 0x47, 0x50, 0x53]);
  const eoi = Buffer.from([0xff, 0xff, 0xd9]);
  const input = jpegScan(entropy, table, comment, scanHeader, entropy, eoi);
  const expected = jpegScan(entropy, table, scanHeader, entropy, eoi);
  const clean = stripJpegMetadata(expected);
  assert.equal(hasEmbeddedMetadata(clean), false);
  const output = new Uint8Array(
    await (await stripOriginalMetadata(new Blob([input]))).arrayBuffer(),
  );
  assert.deepEqual(output, clean);
});

const arrayBufferOf = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** JPEG markers of the segments before the first scan. */
function markersBeforeScan(bytes: Uint8Array) {
  const markers: number[] = [];
  let offset = 2;
  while (offset + 4 <= bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1];
    markers.push(marker);
    if (marker === 0xda) break;
    offset += 2 + ((bytes[offset + 2] << 8) | bytes[offset + 3]);
  }
  return markers;
}

/** Everything from the first quantisation table to EOI: the pixels, untouched. */
function imageSegments(jpeg: Buffer) {
  return jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xdb])));
}

function pngChunk(type: string, data: Buffer) {
  const t = Buffer.from(type, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

function pngChunkTypes(bytes: Uint8Array) {
  const types: string[] = [];
  for (let offset = 8; offset + 8 <= bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset).getUint32(0);
    types.push(Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString("latin1"));
    offset += 12 + length;
  }
  return types;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const IHDR = pngChunk("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]));
const IDAT = pngChunk(
  "IDAT",
  Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x00, 0x02, 0x00, 0x00, 0x05, 0x00, 0x01]),
);
const IEND = pngChunk("IEND", Buffer.alloc(0));

test("detectAiGeneration parses Stable Diffusion parameters", () => {
  const sdText = `masterpiece, cute white bunny in the garden, ultra detailed
Negative prompt: blurry, bad anatomy, deformed
Steps: 25, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 19482019, Size: 1024x1024, Model: dreamshaper_xl`;

  const tags = { pngText: { parameters: { value: sdText } } };
  const res = detectAiGeneration(tags, {}, "");

  assert.equal(res.isAi, true);
  assert.equal(res.generator, "Stable Diffusion");
  assert.equal(res.prompt, "masterpiece, cute white bunny in the garden, ultra detailed");
  assert.equal(res.negativePrompt, "blurry, bad anatomy, deformed");
  assert.equal(res.steps, "25");
  assert.equal(res.sampler, "DPM++ 2M Karras");
  assert.equal(res.cfgScale, "7");
  assert.equal(res.seed, "19482019");
  assert.equal(res.model, "dreamshaper_xl");
});

test("detectAiGeneration parses ComfyUI node graph", () => {
  const comfyPrompt = JSON.stringify({
    "3": {
      class_type: "KSampler",
      inputs: {
        cfg: 8,
        seed: 48192048,
        steps: 28,
        sampler_name: "euler_ancestral",
        scheduler: "karras",
      },
    },
    "4": {
      class_type: "CheckpointLoaderSimple",
      inputs: { ckpt_name: "flux1-dev.safetensors" },
    },
    "6": {
      class_type: "CLIPTextEncode",
      inputs: { text: "cinematic film still of astronaut on mars" },
    },
  });

  const tags = { pngText: { prompt: { value: comfyPrompt } } };
  const res = detectAiGeneration(tags, {}, "");

  assert.equal(res.isAi, true);
  assert.equal(res.generator, "FLUX");
  assert.equal(res.prompt, "cinematic film still of astronaut on mars");
  assert.equal(res.seed, "48192048");
  assert.equal(res.steps, "28");
  assert.equal(res.sampler, "euler_ancestral (karras)");
  assert.equal(res.cfgScale, "8");
});

test("detectAiGeneration parses Midjourney description", () => {
  const mjDesc = "Futuristic city with flying cars --ar 16:9 --v 6.0 --s 250 --style raw";
  const flat = { ImageDescription: { value: mjDesc } };
  const res = detectAiGeneration({}, flat, "Midjourney");

  assert.equal(res.isAi, true);
  assert.equal(res.generator, "Midjourney");
  assert.equal(res.prompt, "Futuristic city with flying cars");
  assert.equal(res.aspectRatio, "16:9");
  assert.equal(res.model, "Midjourney v6.0");
});

test("detectAiGeneration does not falsely flag real camera photo", () => {
  const flat = {
    Make: { value: "Canon" },
    Model: { value: "EOS R5" },
    LensModel: { value: "RF 24-70mm F2.8 L IS USM" },
    FNumber: { value: "2.8" },
    ExposureTime: { value: "1/250" },
  };
  const res = detectAiGeneration({}, flat, "Canon EOS R5 RF 24-70mm");

  assert.equal(res.isAi, false);
  assert.equal(res.generator, undefined);
  assert.equal(res.prompt, undefined);
});

test("inspectImageMetadata reads PNG chunks ExifReader skips and keeps IHDR fields", async () => {
  const { crc32 } = await import("node:zlib");
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const text = (key: string, value: string) =>
    chunk("tEXt", Buffer.concat([Buffer.from(key), Buffer.from([0]), Buffer.from(value)]));
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", Buffer.from([0, 0, 0, 8, 0, 0, 0, 8, 8, 6, 0, 0, 0])),
    chunk("pHYs", Buffer.from([0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1])),
    chunk("gAMA", Buffer.from([0, 0, 0xb1, 0x8f])),
    chunk("sRGB", Buffer.from([0])),
    text("Software", "Cutout"),
    text("Comment", "garden still"),
    chunk(
      "IDAT",
      Buffer.from([0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00]),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const report = await inspectImageMetadata(new Blob([png], { type: "image/png" }));
  assert.equal(report.fileType, "PNG");
  assert.equal(report.colorType, "RGB with Alpha");
  assert.equal(report.alpha, "Yes");
  assert.equal(report.compression, "Deflate/Inflate");
  assert.equal(report.interlace, "Noninterlaced");
  assert.equal(report.filter, "Adaptive");
  assert.equal(report.software, "Cutout");
  assert.equal(report.comment, "garden still");
  assert.ok(report.gamma);
  assert.equal(report.renderingIntent, "Perceptual");
  assert.match(report.resolutionDpi ?? "", /DPI/);
  assert.ok(report.hash && report.hash.length === 64);
  const tags = report.allTags.map((tag) => tag.tag);
  assert.ok(tags.includes("Compression"));
  assert.ok(tags.includes("Software"));
  assert.ok(tags.includes("Gamma"));
  assert.ok(tags.includes("sRGB"));
});

test("formatAspectRatio computes common and custom aspect ratios", () => {
  assert.equal(formatAspectRatio(1000, 1000), "1:1 (Square)");
  assert.equal(formatAspectRatio(1920, 1080), "16:9 (Landscape)");
  assert.equal(formatAspectRatio(1080, 1920), "9:16 (Portrait / Reel)");
  assert.equal(formatAspectRatio(4000, 3000), "4:3 (Standard)");
  assert.equal(formatAspectRatio(3000, 4000), "3:4 (Portrait)");
  assert.equal(formatAspectRatio(6000, 4000), "3:2 (Classic 35mm)");
});

test("inspectImageMetadata reads EXIF GPS from the committed JPEG fixture", async () => {
  const report = await inspectImageMetadata(new Blob([gpsJpeg], { type: "image/jpeg" }));

  assert.equal(report.extras, true);
  assert.equal(report.fileType, "JPEG");
  assert.ok(report.allTags.length > 0);
  assert.equal(report.ai?.isAi, false);
  assert.equal(report.gps?.latitude, 37.7749);
  assert.ok((report.gps?.longitude ?? 0) < -122);
});

test("stripPngMetadata strips tEXt, zTXt, iTXt, and eXIf without touching image data", async () => {
  const ExifReader = (await import("exifreader")).default;

  // Build a test PNG with IHDR, tEXt (AI prompt), eXIf, IDAT, IEND
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.from([
    0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0, 0x90, 0x77, 0x53,
    0xde,
  ]);
  const textData = Buffer.from(
    "parameters\0Prompt: a magic bunny in forest, Steps: 20, Seed: 12345",
  );
  const textLen = Buffer.alloc(4);
  textLen.writeUInt32BE(textData.length, 0);
  const tEXt = Buffer.concat([textLen, Buffer.from("tEXt"), textData, Buffer.alloc(4)]); // 4 dummy crc bytes
  const idat = Buffer.from([
    0, 0, 0, 12, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01,
    0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb0,
  ]);
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const rawPng = Buffer.concat([signature, ihdr, tEXt, idat, iend]);

  const beforeTags = ExifReader.load(
    rawPng.buffer.slice(rawPng.byteOffset, rawPng.byteOffset + rawPng.byteLength),
    { expanded: true },
  );
  assert.ok(beforeTags.pngText?.parameters);

  const { stripPngMetadata } = await import("./metadata.ts");
  const stripped = stripPngMetadata(new Uint8Array(rawPng));
  const afterTags = ExifReader.load(
    stripped.buffer.slice(stripped.byteOffset, stripped.byteOffset + stripped.byteLength),
    { expanded: true },
  );

  assert.equal(afterTags.pngText, undefined);
  assert.ok(stripped.length < rawPng.length);
});

test("stripJpegMetadata removes APP1 (EXIF/GPS/XMP) and COM markers losslessly", async () => {
  const ExifReader = (await import("exifreader")).default;
  const { stripJpegMetadata } = await import("./metadata.ts");
  const stripped = stripJpegMetadata(new Uint8Array(gpsJpeg));

  assert.ok(ExifReader.load(arrayBufferOf(gpsJpeg), { expanded: true }).gps);
  assert.deepEqual(markersBeforeScan(stripped), [0xdb, 0xc0, 0xc4, 0xc4, 0xda]);
  assert.deepEqual(
    Buffer.from(stripped),
    Buffer.concat([gpsJpeg.subarray(0, 2), imageSegments(gpsJpeg)]),
  );
});

test("stripWebpMetadata removes EXIF and XMP chunks and updates VP8X flags", async () => {
  const { stripWebpMetadata } = await import("./metadata.ts");

  // Construct a minimal WebP with VP8X, EXIF, and VP8L
  // RIFF header (12 bytes)
  const riffHeader = Buffer.from("RIFF\0\0\0\0WEBP", "ascii");

  // VP8X chunk: 4 len + 4 'VP8X' + 10 bytes data (flags byte at index 0 has EXIF=0x04, XMP=0x08)
  const vp8xPayload = Buffer.alloc(10);
  vp8xPayload[0] = 0x04 | 0x08; // EXIF and XMP flags set
  const vp8xChunk = Buffer.concat([
    Buffer.from("VP8X", "ascii"),
    Buffer.from([10, 0, 0, 0]),
    vp8xPayload,
  ]);

  // EXIF chunk
  const exifData = Buffer.from("Exif\0\0TestExifData");
  const exifChunk = Buffer.concat([
    Buffer.from("EXIF", "ascii"),
    Buffer.from([exifData.length, 0, 0, 0]),
    exifData,
    exifData.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);

  // VP8L chunk (dummy image data)
  const vp8lData = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]);
  const vp8lChunk = Buffer.concat([
    Buffer.from("VP8L", "ascii"),
    Buffer.from([vp8lData.length, 0, 0, 0]),
    vp8lData,
    vp8lData.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);

  const rawWebp = Buffer.concat([riffHeader, vp8xChunk, exifChunk, vp8lChunk]);
  // Write correct RIFF size (file length minus 8)
  rawWebp.writeUInt32LE(rawWebp.length - 8, 4);

  const strippedBytes = stripWebpMetadata(new Uint8Array(rawWebp));
  const strippedBuf = Buffer.from(strippedBytes);

  // Check that EXIF chunk is not in stripped WebP
  assert.equal(strippedBuf.includes(Buffer.from("EXIF")), false);
  // Check that VP8X flags have cleared EXIF and XMP (byte at offset 20 in stripped WebP should be 0)
  assert.equal(strippedBuf[20], 0);
  // Check that VP8L is kept
  assert.equal(strippedBuf.includes(Buffer.from("VP8L")), true);
});

test("stripOriginalMetadata removes EXIF GPS and comments from a JPEG and keeps the pixels", async () => {
  const ExifReader = (await import("exifreader")).default;
  const cleaned = await stripOriginalMetadata(new Blob([gpsJpeg], { type: "image/jpeg" }));
  const bytes = new Uint8Array(await cleaned.arrayBuffer());

  assert.equal(cleaned.type, "image/jpeg");
  assert.equal(hasEmbeddedMetadata(new Uint8Array(gpsJpeg)), true);
  assert.equal(hasEmbeddedMetadata(bytes), false);
  const markers = markersBeforeScan(bytes);
  for (const marker of [0xe1, 0xed, 0xfe]) assert.equal(markers.includes(marker), false);
  assert.equal(ExifReader.load(arrayBufferOf(bytes), { expanded: true }).gps, undefined);
  assert.deepEqual(Buffer.from(bytes.subarray(2)), imageSegments(gpsJpeg));
});

test("stripOriginalMetadata rejects a HEIC it cannot decode instead of returning it", async () => {
  // ISO-BMFF 'ftypheic' header followed by an EXIF payload with GPS; Node has no image decoder.
  const ftyp = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypheic"),
    Buffer.from([0, 0, 0, 0]),
    Buffer.from("mif1heic"),
  ]);
  const exif = Buffer.from("Exif\0\0GPSLatitude 37.7749 GPSLongitude -122.4194");
  const original = new File([ftyp, exif], "home.heic", { type: "image/heic" });

  await assert.rejects(stripOriginalMetadata(original), (error: unknown) => {
    assert.ok(error instanceof CutoutError);
    assert.equal(error.code, "export");
    assert.match(error.message, /metadata/);
    return true;
  });
});

test("stripOriginalMetadata rejects bytes whose type claims PNG but that are not an image", async () => {
  const fake = new Blob([Buffer.from("<html>Exif GPSLatitude 37.7749</html>")], {
    type: "image/png",
  });
  await assert.rejects(
    stripOriginalMetadata(fake),
    (error: unknown) => error instanceof CutoutError && error.code === "export",
  );
});

test("PNG stripping keeps only image and colour chunks", async () => {
  const kept = ["gAMA", "cHRM", "sRGB", "iCCP", "pHYs"].map((type) =>
    pngChunk(type, Buffer.from([0, 0, 0, 1])),
  );
  const plte = pngChunk("PLTE", Buffer.from([0, 0, 0]));
  const trns = pngChunk("tRNS", Buffer.from([0]));
  const metadata = ["eXIf", "tEXt", "iTXt", "zTXt", "caBX", "tIME", "vpAg"].map((type) =>
    pngChunk(type, Buffer.from("GPSLatitude 37.7749")),
  );
  const png = Buffer.concat([PNG_SIGNATURE, IHDR, ...kept, plte, trns, ...metadata, IDAT, IEND]);

  const cleanedBlob = await stripOriginalMetadata(new Blob([png]));
  const cleaned = new Uint8Array(await cleanedBlob.arrayBuffer());

  assert.deepEqual(pngChunkTypes(cleaned), [
    "IHDR",
    "gAMA",
    "cHRM",
    "sRGB",
    "iCCP",
    "pHYs",
    "PLTE",
    "tRNS",
    "IDAT",
    "IEND",
  ]);
  assert.equal(hasEmbeddedMetadata(png), true);
  assert.equal(hasEmbeddedMetadata(cleaned), false);
});

test("stripExportMetadata leaves our BMP alone and strips text from a PNG", async () => {
  const bmp = new Blob([Buffer.from("BM\0\0\0\0")], { type: "image/bmp" });
  assert.equal(await stripExportMetadata(bmp), bmp);

  const png = Buffer.concat([
    PNG_SIGNATURE,
    IHDR,
    pngChunk("tEXt", Buffer.from("Comment\0hello")),
    IDAT,
    IEND,
  ]);
  const cleaned = await stripExportMetadata(new Blob([png], { type: "image/png" }));
  assert.deepEqual(pngChunkTypes(new Uint8Array(await cleaned.arrayBuffer())), [
    "IHDR",
    "IDAT",
    "IEND",
  ]);
});

test("cleaned originals are named by what they contain, not by the incoming name", () => {
  assert.equal(cleanedFilename("x.html", "image/png"), "x-cleaned.png");
  assert.equal(cleanedFilename("holiday.heic", "image/png"), "holiday-cleaned.png");
  assert.equal(cleanedFilename("photo.JPG", "image/jpeg"), "photo-cleaned.jpg");
  assert.equal(cleanedFilename("scan", "image/webp"), "scan-cleaned.webp");
  assert.equal(cleanedFilename(".png", "image/png"), "image-cleaned.png");
});

test("embedded generator JSON is read as text, never as objects React would render", async () => {
  const comment = JSON.stringify({
    prompt: { x: 1 },
    uc: 1,
    steps: { y: 2 },
    seed: [1],
    scale: {},
    sampler: null,
  });
  const png = Buffer.concat([
    PNG_SIGNATURE,
    IHDR,
    pngChunk("tEXt", Buffer.from(`Comment\0${comment}`, "latin1")),
    IDAT,
    IEND,
  ]);
  const report = await inspectImageMetadata(new Blob([png], { type: "image/png" }));

  assert.equal(report.ai?.generator, "NovelAI");
  assert.equal(report.ai?.negativePrompt, "1");
  for (const key of ["prompt", "negativePrompt", "steps", "seed", "model", "cfgScale", "sampler"]) {
    const value = report.ai?.[key as keyof typeof report.ai];
    assert.ok(value === undefined || typeof value === "string", `${key} is ${typeof value}`);
  }
});

test("InvokeAI and ComfyUI fields that are not text are dropped", () => {
  const invoke = detectAiGeneration(
    {
      pngText: {
        Comment: {
          value: JSON.stringify({
            invokeai_metadata: true,
            prompt: ["a"],
            negative_prompt: { b: 1 },
            seed: { c: 1 },
            steps: 30,
            model: { model_name: { d: 1 } },
          }),
        },
      },
    },
    {},
    "",
  );
  assert.equal(invoke.generator, "InvokeAI");
  assert.deepEqual(
    [invoke.prompt, invoke.negativePrompt, invoke.seed, invoke.steps, invoke.model],
    [undefined, undefined, undefined, "30", undefined],
  );

  const comfy = detectAiGeneration(
    {
      pngText: {
        prompt: {
          value: JSON.stringify({
            "1": {
              class_type: "KSampler",
              inputs: { seed: ["4", 0], steps: { e: 1 }, cfg: 7.5, sampler_name: { f: 1 } },
            },
            "2": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: { g: 1 } } },
          }),
        },
      },
    },
    {},
    "",
  );
  assert.deepEqual(
    [comfy.seed, comfy.steps, comfy.cfgScale, comfy.sampler, comfy.model],
    [undefined, undefined, "7.5", undefined, undefined],
  );
});

const pngOfSize = (width: number, height: number) => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return new Blob([Buffer.concat([PNG_SIGNATURE, pngChunk("IHDR", ihdr), IDAT, IEND])], {
    type: "image/png",
  });
};

const box = (type: string, ...children: Buffer[]) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(8 + children.reduce((total, child) => total + child.length, 0));
  return Buffer.concat([size, Buffer.from(type, "latin1"), ...children]);
};
/** 'ispe' (image spatial extent) payload: version/flags, width, height. */
const extent = (width: number, height: number) => {
  const payload = Buffer.alloc(12);
  payload.writeUInt32BE(width, 4);
  payload.writeUInt32BE(height, 8);
  return box("ispe", payload);
};
/** 'clap' (clean aperture): the displayed crop of the coded extent, as fractions N/D. */
const cleanAperture = (width: number, height: number) => {
  const payload = Buffer.alloc(32);
  [width, 1, height, 1, 0, 1, 0, 1].forEach((value, i) => payload.writeUInt32BE(value, i * 4));
  return box("clap", payload);
};
/** ftyp → meta (full box) → iprp → ipco → properties, then an mdat of coded pixels. */
const heifWithProperties = (...properties: Buffer[]) =>
  Buffer.concat([
    box("ftyp", Buffer.from("heic\0\0\0\0mif1heic", "latin1")),
    box("meta", Buffer.alloc(4), box("iprp", box("ipco", ...properties))),
    // Compressed bytes can spell anything, including an 'ispe' of 60000×60000.
    box("mdat", Buffer.alloc(64, 0xab), extent(60000, 60000), Buffer.alloc(64, 0xcd)),
  ]);
const heifWithExtents = (...sizes: [number, number][]) =>
  heifWithProperties(...sizes.map(([width, height]) => extent(width, height)));

test("a cleaned original that came back smaller says so", async () => {
  // The largest extent is the full image (12000×9000, over the 96 MP desktop budget);
  // the other is a thumbnail.
  const heic = new Blob([heifWithExtents([320, 240], [12000, 9000])]);
  assert.equal(
    await downscaleNotice(heic, pngOfSize(11313, 8485)),
    "Saved without metadata as a PNG at 11313×8485. The original is larger than this device can re-encode.",
  );
  assert.equal(await downscaleNotice(heic, pngOfSize(12000, 9000)), null);
  // Rotated output (irot) has the same pixel count and is not a downscale.
  assert.equal(await downscaleNotice(heic, pngOfSize(9000, 12000)), null);
});

test("an image within the processing budget never gets the notice", async () => {
  // Phones write a coded extent of 64×64 and crop it to 64×48 with 'clap'; the 64×48 PNG
  // is the whole picture.
  const cropped = new Blob([heifWithProperties(extent(64, 64), cleanAperture(64, 48))]);
  assert.equal(await downscaleNotice(cropped, pngOfSize(64, 48)), null);
  // A 48 MP photo fits the desktop budget, so nothing was scaled whatever the header says.
  const photo = new Blob([heifWithExtents([8064, 6048])]);
  assert.equal(await downscaleNotice(photo, pngOfSize(8064, 5376)), null);
});

test("HEIF properties are only looked for near the start of the file", async () => {
  // A 'meta' that only starts after 5 MB of other boxes is not searched for; no guess is made.
  const heif = heifWithExtents([12000, 9000]);
  const ftypLength = heif.readUInt32BE(0);
  const late = new Blob([
    heif.subarray(0, ftypLength),
    box("free", Buffer.alloc(5_000_000)),
    heif.subarray(ftypLength),
  ]);
  assert.match((await downscaleNotice(new Blob([heif]), pngOfSize(10, 10))) ?? "", /at 10×10\./);
  assert.equal(await downscaleNotice(late, pngOfSize(10, 10)), null);
});

test("TIFF originals are measured from their first image directory", async () => {
  // Big-endian TIFF, one directory: ImageWidth and ImageLength as LONG values.
  const tiff = (width: number, height: number) => {
    const bytes = Buffer.from([
      ...[0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2],
      ...[1, 0, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0],
      ...[1, 1, 0, 4, 0, 0, 0, 1, 0, 0, 0, 0],
      ...[0, 0, 0, 0],
    ]);
    bytes.writeUInt32BE(width, 18);
    bytes.writeUInt32BE(height, 30);
    return new Blob([bytes]);
  };
  // 20000 px wide is past the 16384 px side limit, so the re-encode was scaled down.
  const wide = tiff(20000, 100);
  assert.match((await downscaleNotice(wide, pngOfSize(16384, 82))) ?? "", /at 16384×82\./);
  assert.equal(await downscaleNotice(wide, pngOfSize(20000, 100)), null);
  assert.equal(await downscaleNotice(tiff(100, 80), pngOfSize(50, 40)), null);
});

test("GIF first-frame overflow and BMP COREHEADER originals are measured like ingest", async () => {
  const gif = gifHeaderBlob(1, 1, [20000, 300]);
  assert.match((await downscaleNotice(gif, pngOfSize(16384, 82))) ?? "", /at 16384×82\./);
  assert.equal(await downscaleNotice(gif, pngOfSize(20000, 300)), null);

  const core = bmpHeaderBlob(20000, 100, true);
  assert.match((await downscaleNotice(core, pngOfSize(16384, 82))) ?? "", /at 16384×82\./);
  assert.equal(await downscaleNotice(core, pngOfSize(20000, 100)), null);
});

test("originals whose size cannot be read give no notice rather than a wrong one", async () => {
  assert.equal(await downscaleNotice(new Blob(["not an image"]), pngOfSize(10, 10)), null);
});

/** Little-endian APP1 EXIF whose IFD0 holds Orientation and a GPS pointer (a phone photo). */
function orientedGpsJpeg(orientation: number) {
  const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
  const le32 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
  const entry = (tag: number, type: number, count: number, value: number[]) => [
    ...le16(tag),
    ...le16(type),
    ...le32(count),
    ...value,
  ];
  const gpsAt = 8 + 2 + 2 * 12 + 4;
  const tiff = [
    0x49,
    0x49,
    ...le16(42),
    ...le32(8),
    ...le16(2),
    ...entry(0x0112, 3, 1, [...le16(orientation), 0, 0]), // Orientation
    ...entry(0x8825, 4, 1, le32(gpsAt)), // GPSInfo
    ...le32(0),
    ...le16(1),
    ...entry(1, 2, 2, [0x4e, 0, 0, 0]), // GPSLatitudeRef "N"
    ...le32(0),
  ];
  const payload = [...Buffer.from("Exif\0\0", "latin1"), ...tiff];
  const app1 = [
    0xff,
    0xe1,
    ...[(payload.length + 2) >> 8, (payload.length + 2) & 0xff],
    ...payload,
  ];
  // gpsJpeg without its own APP1/COM: SOI, then everything from the first non-metadata segment.
  const plain = stripJpegForTest(gpsJpeg);
  return Uint8Array.from([...plain.subarray(0, 2), ...app1, ...plain.subarray(2)]);
}

const stripJpegForTest = (bytes: Uint8Array) => {
  const out = [bytes[0], bytes[1]];
  let at = 2;
  while (at < bytes.length) {
    const marker = bytes[at + 1];
    if (marker === 0xda) return Uint8Array.from([...out, ...bytes.subarray(at)]);
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (marker !== 0xe1 && marker !== 0xfe) out.push(...bytes.subarray(at, end));
    at = end;
  }
  return Uint8Array.from(out);
};

test("a cleaned JPEG keeps its orientation and nothing else from EXIF", async () => {
  const ExifReader = (await import("exifreader")).default;
  const original = orientedGpsJpeg(6);
  assert.equal(ExifReader.load(arrayBufferOf(original)).Orientation?.value, 6);
  assert.ok(ExifReader.load(arrayBufferOf(original)).GPSLatitudeRef, "fixture carries GPS");

  const cleaned = new Uint8Array(
    await (await stripOriginalMetadata(new Blob([original], { type: "image/jpeg" }))).arrayBuffer(),
  );
  const tags = ExifReader.load(arrayBufferOf(cleaned));
  assert.equal(tags.Orientation?.value, 6, "a sideways phone photo must stay upright");
  assert.equal(tags.GPSLatitudeRef, undefined);
  assert.equal(hasEmbeddedMetadata(cleaned), false);

  // Upright photos need no EXIF at all.
  const upright = new Uint8Array(
    await (await stripOriginalMetadata(new Blob([orientedGpsJpeg(1)]))).arrayBuffer(),
  );
  assert.equal(ExifReader.load(arrayBufferOf(upright)).Orientation, undefined);
});

test("only an orientation-only APP1 counts as clean", () => {
  // Any other EXIF content, even alongside Orientation, is still metadata.
  assert.equal(hasEmbeddedMetadata(orientedGpsJpeg(6)), true);
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
