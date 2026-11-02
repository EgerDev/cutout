import assert from "node:assert/strict";
import { test } from "node:test";
import { assertDecodableSize, bitmapFromBlob, imageSizeOf } from "./decode-bitmap.ts";
import { CutoutError } from "./errors.ts";
import { paddedGif } from "./fixtures/flat-gif.ts";

test("PNG signature refusal follows native rejection and leaves the valid ImageDecoder fallback unchanged", async (t) => {
  const native = globalThis.createImageBitmap;
  const decoder = Object.getOwnPropertyDescriptor(globalThis, "ImageDecoder");
  t.after(() => {
    globalThis.createImageBitmap = native;
    if (decoder) Object.defineProperty(globalThis, "ImageDecoder", decoder);
    else Reflect.deleteProperty(globalThis, "ImageDecoder");
  });
  const bitmap = {} as ImageBitmap;
  let nativeAccepts = true;
  let constructions = 0;
  let frameCloses = 0;
  let decoderCloses = 0;
  const frame = { close: () => frameCloses++ };
  globalThis.createImageBitmap = (async (input: unknown) => {
    if (input instanceof Blob) {
      if (!nativeAccepts) throw new Error("native decoder refused");
    } else assert.equal(input, frame);
    return bitmap;
  }) as typeof createImageBitmap;
  Object.defineProperty(globalThis, "ImageDecoder", {
    configurable: true,
    value: class {
      static async isTypeSupported(type: string) {
        assert.equal(type, "image/png");
        return true;
      }
      constructor(options: ImageDecoderInit) {
        constructions++;
        assert.equal(options.type, "image/png");
        assert.equal(options.preferAnimation, false);
        assert.ok(options.data instanceof ReadableStream);
      }
      async decode(options: ImageDecodeOptions) {
        assert.deepEqual(options, { frameIndex: 0 });
        return { image: frame };
      }
      close() {
        decoderCloses++;
      }
    },
  });
  const broken = new Blob(["broken"], { type: "image/png" });
  // The new check must never precede a successful native decode.
  assert.equal(await bitmapFromBlob(broken), bitmap);
  assert.equal(constructions, 0);
  nativeAccepts = false;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==",
    "base64",
  );
  assert.equal(await bitmapFromBlob(new Blob([png], { type: "image/png" })), bitmap);
  assert.equal(constructions, 1);
  assert.equal(frameCloses, 1);
  assert.equal(decoderCloses, 1);
  const corrupted = png.slice();
  corrupted[7] ^= 1;
  for (const bytes of [new Uint8Array(), Buffer.from("broken"), corrupted]) {
    await assert.rejects(
      bitmapFromBlob(new Blob([bytes], { type: "image/png" })),
      (error) => error instanceof Error && error.constructor === Error &&
        !("code" in error) && error.message === "This image could not be decoded.",
    );
  }
  assert.equal(constructions, 1, "a mismatched PNG signature must not construct ImageDecoder");
  // Ingest keeps image/png as given, so a HEIC saved as .png arrives here and must still
  // reach libheif. Under plain Node the Vite alias for heic-to is absent, so the attempted
  // import is the evidence that the PNG guard did not refuse it first.
  const heicNamedPng = Buffer.from("00000018667479706865696300000000686569636d696631", "hex");
  await assert.rejects(
    bitmapFromBlob(new Blob([heicNamedPng], { type: "image/png" })),
    (error) =>
      error instanceof Error &&
      error.message !== "This image could not be decoded." &&
      (error as { code?: string }).code === "ERR_MODULE_NOT_FOUND",
  );
  assert.equal(constructions, 1);
});

test("JPEG and HEIF scan limits refuse decode instead of treating an unchecked size as safe", async () => {
  const box = (type: string, payload: Uint8Array = new Uint8Array()) => {
    const bytes = Buffer.alloc(8 + payload.length);
    bytes.writeUInt32BE(bytes.length);
    bytes.write(type, 4);
    bytes.set(payload, 8);
    return bytes;
  };
  const app = Buffer.alloc(65537);
  app.set([0xff, 0xe2, 0xff, 0xff]);
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...Array.from({ length: 72 }, () => app),
    Buffer.from([0xff, 0xc0, 0, 11, 8, 0xff, 0xff, 0xff, 0xff, 1, 1, 0x11, 0]),
  ]);
  const ftyp = box("ftyp", Buffer.from("heic\0\0\0\0heic"));
  const ispe = Buffer.alloc(12);
  ispe.writeUInt32BE(60000, 4);
  ispe.writeUInt32BE(60000, 8);
  const properties = box("iprp", box("ipco", box("ispe", ispe)));
  const meta = box("meta", Buffer.concat([Buffer.alloc(4), properties]));
  const manyBoxes = Buffer.concat([ftyp, ...Array.from({ length: 65 }, () => box("free")), meta]);
  const longMeta = Buffer.concat([
    ftyp,
    box("meta", Buffer.concat([Buffer.alloc(4), box("free", Buffer.alloc(4_000_000)), properties])),
  ]);
  const original = globalThis.createImageBitmap;
  let decodes = 0;
  globalThis.createImageBitmap = (async () => {
    decodes++;
    throw new Error("must not decode");
  }) as typeof createImageBitmap;
  try {
    for (const bytes of [jpeg, manyBoxes, longMeta]) {
      await assert.rejects(
        bitmapFromBlob(new Blob([bytes]), { pixels: 24_000_000, side: 8192 }),
        (error) =>
          error instanceof CutoutError &&
          error.code === "memory" &&
          /checked safely/.test(error.message),
      );
    }
    assert.equal(decodes, 0);
  } finally {
    globalThis.createImageBitmap = original;
  }
});

test("oversized TIFF is refused before any whole-file read, including metadata cleanup", async () => {
  const { TIFF_BYTE_LIMIT } = await import("./tiff.ts");
  const { stripOriginalMetadata, inspectImageMetadata } = await import("./metadata.ts");
  for (const magic of ["II*\0", "II+\0", "MM\0*", "MM\0+"]) {
    const blob = new Blob([Buffer.from(magic, "latin1")]);
    Object.defineProperty(blob, "size", { value: TIFF_BYTE_LIMIT + 1 });
    let reads = 0;
    blob.arrayBuffer = async () => {
      reads++;
      throw new Error("whole-file read");
    };
    await assert.rejects(
      assertDecodableSize(blob, { pixels: 96_000_000, side: 16384 }),
      /under 50 MB/,
    );
    await assert.rejects(stripOriginalMetadata(blob), /under 50 MB/);
    await inspectImageMetadata(blob);
    assert.equal(reads, 0, magic);
  }
});

test("a complete GIF frame beyond 281 KB of comments is measured with bounded reads", async () => {
  const bytes = paddedGif();
  assert.equal(bytes.length, 349329);
  const blob = new Blob([bytes], { type: "image/gif" });
  const slice = blob.slice.bind(blob);
  let reads = 0;
  blob.slice = (start = 0, end = blob.size, type) => {
    reads++;
    assert.ok(end - start <= 64 * 1024, `unbounded read: ${end - start}`);
    return slice(start, end, type);
  };
  assert.deepEqual(await imageSizeOf(blob), { width: 10000, height: 10000 });
  assert.ok(reads < 100, `${reads} reads`);
});

test("an incomplete GIF extension or frame never proves the small logical screen", async () => {
  const bytes = paddedGif();
  for (const end of [13, 20, 255000, 262144, 281622, 281628]) {
    assert.equal(
      await imageSizeOf(new Blob([bytes.subarray(0, end)])),
      null,
      `truncated at ${end}`,
    );
  }
});

test("padded GIF helper and worker refuse the real large frame without decoding", async () => {
  const original = globalThis.createImageBitmap;
  let decodes = 0;
  // Counting guard: a regression must never actually allocate this 100 MP frame.
  globalThis.createImageBitmap = (async () => {
    decodes++;
    throw new Error("counted decode; allocation prevented");
  }) as typeof createImageBitmap;
  const scope = globalThis as { addEventListener?: unknown; postMessage?: unknown };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  let reply: (value: { error?: string; message?: string }) => void;
  scope.addEventListener = (_type: string, listener: typeof onMessage) => {
    onMessage = listener;
  };
  scope.postMessage = (value: { error?: string; message?: string }) => reply(value);
  const blob = new Blob([paddedGif()], { type: "image/gif" });
  try {
    await assert.rejects(
      bitmapFromBlob(blob, { pixels: 24_000_000, side: 16384 }),
      (error) =>
        error instanceof CutoutError && error.code === "memory" && /too large/.test(error.message),
    );
    assert.equal(decodes, 0);
    await import(new URL("./decode-worker.ts?padded-gif", import.meta.url).href);
    const result = await new Promise<{ error?: string; message?: string }>((resolve) => {
      reply = resolve;
      onMessage!({
        data: { id: 1, file: blob, type: blob.type, maxPixels: 24_000_000, maxSide: 16384 },
      });
    });
    assert.equal(result.error, "memory");
    assert.match(result.message ?? "", /too large/);
    assert.equal(decodes, 0);
  } finally {
    globalThis.createImageBitmap = original;
    delete scope.addEventListener;
    delete scope.postMessage;
  }
});

test("TIFF preflight retains the strict pixel budget and inclusive twice-side ceiling", async () => {
  const { tiffHeader } = await import("./fixtures/flat-tiff.ts");
  const tooLarge = (error: unknown) => error instanceof CutoutError && error.code === "memory";
  for (const limits of [
    { pixels: 96_000_000, side: 16384 },
    { pixels: 32_000_000, side: 16384 },
    { pixels: 16_000_000, side: 4096 },
    { pixels: 24_000_000, side: 8192 },
    { pixels: 24_000_000, side: 16384 },
  ]) {
    for (const little of [true, false]) {
      // Metadata only: none of these threshold probes may reach a pixel decoder.
      for (const delta of [-1, 0, 1]) {
        const width = limits.pixels / 4000 + delta;
        const blob = new Blob([tiffHeader(width, 4000, 0, little)]);
        if (delta > 0) await assert.rejects(assertDecodableSize(blob, limits), tooLarge);
        else await assertDecodableSize(blob, limits);
        for (const [w, h] of [
          [2 * limits.side + delta, 1],
          [1, 2 * limits.side + delta],
        ]) {
          const wide = new Blob([tiffHeader(w!, h!, 0, little)]);
          if (delta > 0) await assert.rejects(assertDecodableSize(wide, limits), tooLarge);
          else await assertDecodableSize(wide, limits);
        }
      }
    }
  }
});

test("TIFF common gate uses effective devices and bytes, including empty MIME/extensionless files", async () => {
  const { tiffHeader } = await import("./fixtures/flat-tiff.ts");
  const { rasterizeSvgFile, processingLimits } = await import("./files.ts");
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const scope = globalThis as { window?: unknown };
  const originalWindow = scope.window;
  scope.window = {};
  const tooLarge = (error: unknown) => error instanceof CutoutError && error.code === "memory";
  try {
    for (const [userAgent, deviceMemory, pixels] of [
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130", undefined, 96_000_000],
      ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130", 4, 32_000_000],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile Safari/604.1",
        undefined,
        16_000_000,
      ],
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1",
        undefined,
        24_000_000,
      ],
      [
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36",
        8,
        24_000_000,
      ],
    ] as const) {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: { userAgent, deviceMemory, maxTouchPoints: 5 },
      });
      const limits = processingLimits();
      assert.equal(limits.pixels, pixels);
      for (const [w, h] of [
        [2 * limits.side, 1],
        [1, 2 * limits.side],
      ]) {
        await rasterizeSvgFile(new File([tiffHeader(w!, h!)], "wide", { type: "" }));
        await assert.rejects(
          rasterizeSvgFile(
            new File([tiffHeader(w! + (h === 1 ? 1 : 0), h! + (w === 1 ? 1 : 0))], "wide", {
              type: "",
            }),
          ),
          tooLarge,
        );
      }
      for (const [name, type] of [
        ["scan.tif", "image/tiff"],
        ["scan.tiff", ""],
        ["scan", ""],
      ]) {
        const good = new File([tiffHeader(pixels / 4000, 4000)], name!, { type });
        const accepted = await rasterizeSvgFile(good);
        assert.equal(accepted.type, "image/tiff");
        if (type) assert.equal(accepted, good);
        assert.deepEqual(await accepted.arrayBuffer(), await good.arrayBuffer());
        await assert.rejects(
          rasterizeSvgFile(new File([tiffHeader(pixels / 4000 + 1, 4000)], name!, { type })),
          tooLarge,
        );
      }
    }
  } finally {
    if (originalWindow === undefined) delete scope.window;
    else scope.window = originalWindow;
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
});

test("TIFF truncated metadata and failed reads do not escape preflight as parser exceptions", async () => {
  const { tiffHeader } = await import("./fixtures/flat-tiff.ts");
  const bytes = tiffHeader(16, 8);
  for (const end of [0, 4, 7, 8, 10, 15])
    await assertDecodableSize(new Blob([bytes.slice(0, end)]), { pixels: 96_000_000, side: 16384 });
  const broken = new Blob([bytes]);
  broken.arrayBuffer = async () => {
    throw new Error("read failed");
  };
  await assertDecodableSize(broken, { pixels: 96_000_000, side: 16384 });
});

// E01-O-01: browsers decode a JPEG with its EXIF orientation applied, so the size the engine budgets
// with must be the decoded one. Measured in the stored frame, an over-budget portrait (orientation 6/8)
// was resized into a landscape frame: rotated and squashed.
function orientedJpeg(width: number, height: number, orientation: number | null, order: "II" | "MM" = "II") {
  const le = order === "II";
  const u16 = (value: number) => Buffer.from(le ? [value & 0xff, value >> 8] : [value >> 8, value & 0xff]);
  const u32 = (value: number) => { const b = Buffer.alloc(4); if (le) b.writeUInt32LE(value); else b.writeUInt32BE(value); return b; };
  const entry = (tag: number, type: number, value: number) => Buffer.concat([u16(tag), u16(type), u32(1), u16(value), u16(0)]);
  // IFD0 holds an unrelated tag first (ImageWidth), as cameras write it.
  const entries = [entry(0x0100, 3, width & 0xffff), ...(orientation === null ? [] : [entry(0x0112, 3, orientation)])];
  const tiff = Buffer.concat([Buffer.from(order), u16(42), u32(8), u16(entries.length), ...entries, u32(0)]);
  const app1 = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const be16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
  return new Blob([Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe1]), be16(app1.length + 2), app1,
    Buffer.from([0xff, 0xe0]), be16(16), Buffer.from("JFIF\0", "latin1"), Buffer.alloc(9),
    Buffer.from([0xff, 0xc0]), be16(17), Buffer.from([8]), be16(height), be16(width), Buffer.from([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.from([0xff, 0xd9]),
  ])], { type: "image/jpeg" });
}

test("E01-O-01: a JPEG's declared size follows its EXIF orientation (1, 6, 8; both byte orders)", async () => {
  for (const order of ["II", "MM"] as const) {
    assert.deepEqual(await imageSizeOf(orientedJpeg(6000, 4500, null, order)), { width: 6000, height: 4500 });
    for (const orientation of [1, 2, 3, 4]) assert.deepEqual(await imageSizeOf(orientedJpeg(6000, 4500, orientation, order)), { width: 6000, height: 4500 }, `${order} ${orientation}`);
    for (const orientation of [5, 6, 7, 8]) assert.deepEqual(await imageSizeOf(orientedJpeg(6000, 4500, orientation, order)), { width: 4500, height: 6000 }, `${order} ${orientation}`);
    // Out-of-range values are not a rotation.
    assert.deepEqual(await imageSizeOf(orientedJpeg(6000, 4500, 9, order)), { width: 6000, height: 4500 });
  }
});

test("E01-O-01: an over-budget rotated JPEG is resized to a portrait frame; within budget it is not resized", async () => {
  const { exceedsProcessingBudget, processingScale } = await import("./files.ts");
  const pixel8 = { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36", maxTouchPoints: 5, pointerCoarse: true, compactViewport: false, framed: false };
  const mac = { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", maxTouchPoints: 0, pointerCoarse: false, compactViewport: false, framed: false };
  // engine.ts prepareForInference: the target frame it resizes the decoded (oriented) pixels into.
  const target = async (blob: Blob, memory: number, env: typeof mac) => {
    const dims = (await imageSizeOf(blob))!;
    if (!exceedsProcessingBudget(dims.width, dims.height, memory, env)) return null;
    const scale = processingScale(dims.width, dims.height, memory, env);
    return [Math.max(1, Math.round(dims.width * scale)), Math.max(1, Math.round(dims.height * scale))];
  };
  // A 27 MP phone portrait (stored 6000 x 4500) over the 24 MP phone budget.
  assert.deepEqual(await target(orientedJpeg(6000, 4500, 1), 8, pixel8), [5657, 4243]);
  assert.deepEqual(await target(orientedJpeg(6000, 4500, 6), 8, pixel8), [4243, 5657]);
  assert.deepEqual(await target(orientedJpeg(6000, 4500, 8), 8, pixel8), [4243, 5657]);
  // Over the side limit (stored 16400 x 300).
  assert.deepEqual(await target(orientedJpeg(16400, 300, 6), 8, mac), [300, 16384]);
  assert.deepEqual(await target(orientedJpeg(16400, 300, 1), 8, mac), [16384, 300]);
  // Within budget nothing is resized, whatever the orientation: the decoder rotates the original.
  for (const orientation of [1, 6, 8]) assert.equal(await target(orientedJpeg(4000, 3000, orientation), 8, pixel8), null, String(orientation));
  assert.equal(await target(orientedJpeg(16000, 300, 6), 8, mac), null);
});
