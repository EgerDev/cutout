import assert from "node:assert/strict";
import test from "node:test";
import { muxHeif } from "./heif-mux.ts";

test("HEIC and AVIF files start with the right brand", async () => {
  const color = {
    type: "hvc1" as const,
    width: 8,
    height: 8,
    description: Uint8Array.of(1, 1, 96, 0),
    data: Uint8Array.of(0, 0, 0, 1, 2),
    channels: 3 as const,
  };
  const alpha = {
    ...color,
    channels: 1 as const,
    data: Uint8Array.of(0, 0, 0, 1, 9),
  };
  const heic = new Uint8Array(await muxHeif("heic", color, alpha).arrayBuffer());
  const brand = String.fromCharCode(...heic.slice(8, 12));
  assert.equal(brand, "heic");
  assert.equal(muxHeif("heic", color, alpha).type, "image/heic");
  const avif = new Uint8Array(
    await muxHeif(
      "avif",
      { ...color, type: "av01", description: null, data: sequence(0) },
      { ...alpha, type: "av01", description: null, data: sequence(0, { mono: 1 }) },
    ).arrayBuffer(),
  );
  assert.equal(String.fromCharCode(...avif.slice(8, 12)), "avif");
});

function boxes(bytes: Uint8Array, start = 0, end = bytes.length) {
  const result: { type: string; start: number; end: number }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = start; offset < end;) {
    const size = view.getUint32(offset);
    assert.ok(size >= 8 && offset + size <= end);
    result.push({
      type: String.fromCharCode(...bytes.slice(offset + 4, offset + 8)),
      start: offset + 8,
      end: offset + size,
    });
    offset += size;
  }
  return result;
}

test("odd dimensions crop both HEIF layers with signed offsets and distinct property associations", async () => {
  const color = {
    type: "av01",
    width: 130,
    height: 66,
    displayWidth: 129,
    displayHeight: 65,
    description: null,
    data: sequence(0),
    channels: 3,
  } satisfies Parameters<typeof muxHeif>[1];
  const bytes = new Uint8Array(
    await muxHeif("avif", color, {
      ...color,
      channels: 1,
      data: sequence(0, { mono: 1 }),
    }).arrayBuffer(),
  );
  const meta = boxes(bytes).find((box) => box.type === "meta");
  assert.ok(meta);
  const iprp = boxes(bytes, meta.start + 4, meta.end).find((box) => box.type === "iprp");
  assert.ok(iprp);
  const children = boxes(bytes, iprp.start, iprp.end);
  const ipco = children.find((box) => box.type === "ipco");
  const ipma = children.find((box) => box.type === "ipma");
  assert.ok(ipco && ipma);
  const properties = boxes(bytes, ipco.start, ipco.end);
  assert.deepEqual(
    properties.map((box) => box.type),
    ["av1C", "ispe", "pixi", "colr", "clap", "av1C", "ispe", "pixi", "auxC", "clap"],
  );
  for (const crop of properties.filter((box) => box.type === "clap")) {
    const view = new DataView(bytes.buffer, crop.start, crop.end - crop.start);
    assert.deepEqual(
      Array.from({ length: 8 }, (_, index) => view.getInt32(index * 4)),
      [129, 1, 65, 1, -1, 2, -1, 2],
    );
  }
  assert.deepEqual(
    [...bytes.slice(ipma.start + 8, ipma.end)],
    [0, 1, 5, 0x81, 0x82, 0x83, 0x84, 0x85, 0, 2, 5, 0x86, 0x87, 0x88, 0x89, 0x8a],
  );
});

function hvcCs(bytes: Uint8Array) {
  const meta = boxes(bytes).find((box) => box.type === "meta");
  assert.ok(meta);
  const iprp = boxes(bytes, meta.start + 4, meta.end).find((box) => box.type === "iprp");
  assert.ok(iprp);
  const ipco = boxes(bytes, iprp.start, iprp.end).find((box) => box.type === "ipco");
  assert.ok(ipco);
  return boxes(bytes, ipco.start, ipco.end)
    .filter((box) => box.type === "hvcC")
    .map((box) => [...bytes.slice(box.start, box.end)]);
}

test("the alpha hvcC never repeats the colour one byte for byte (S3-C-PLATFORM-01)", async () => {
  // HEVCDecoderConfigurationRecord: version 1, Main, level 3.1, avgFrameRate 0 (bytes 19-20),
  // lengthSizeMinusOne 3, then one VPS array. Apple's decoder shows a file whose two
  // records match as fully transparent.
  const record = Uint8Array.from(
    Buffer.from("0101600000009000000000005df000fcfdf8f800000f01a0000100024001", "hex"),
  );
  const color = {
    type: "hvc1" as const,
    width: 1080,
    height: 1080,
    description: record,
    data: Uint8Array.of(0, 0, 0, 1, 2),
    channels: 3 as const,
  };
  const alpha = { ...color, description: Uint8Array.from(record), channels: 1 as const };
  const [colorConfig, alphaConfig] = hvcCs(
    new Uint8Array(await muxHeif("heic", color, alpha).arrayBuffer()),
  );
  assert.ok(colorConfig && alphaConfig);
  assert.deepEqual(colorConfig, [...record], "the colour record is written as encoded");
  const differ = alphaConfig.flatMap((value, index) =>
    value === colorConfig[index] ? [] : [index],
  );
  assert.deepEqual(differ, [20], "only avgFrameRate, which no still decoder reads, differs");
  assert.equal(alphaConfig.length, record.length);
  assert.deepEqual([...alpha.description], [...record], "the encoder's buffer is not mutated");

  // Records that already differ are written as encoded.
  const other = Uint8Array.from(record);
  other[12] = 90;
  const [, kept] = hvcCs(
    new Uint8Array(await muxHeif("heic", color, { ...alpha, description: other }).arrayBuffer()),
  );
  assert.deepEqual(kept, [...other]);
});

/** A small synthetic sequence header (no frame allocation), following AV1 §5.5. */
function sequence(
  level: number,
  { reduced = false, tier = 0, mono = 0, high = 0, range = 1 } = {},
) {
  let bits = "";
  const put = (value: number, count: number) => {
    bits += value.toString(2).padStart(count, "0");
  };
  put(0, 3);
  put(reduced ? 1 : 0, 1);
  put(reduced ? 1 : 0, 1);
  if (reduced) put(level, 5);
  else {
    put(0, 1);
    put(0, 1);
    put(0, 5); // timing, initial delay, operating points minus one
    put(0, 12);
    put(level, 5);
    if (level > 7) put(tier, 1);
  }
  put(15, 4);
  put(15, 4);
  put(7999, 16);
  put(5999, 16);
  if (!reduced) put(0, 1); // frame IDs
  put(0, 3);
  if (!reduced) {
    put(0, 5);
    put(0, 1);
    put(0, 1);
  }
  put(0, 3);
  put(high, 1);
  put(mono, 1);
  put(0, 1); // depth, mono, color description
  put(range, 1); // actual sequence range
  if (!mono) {
    put(0, 2);
    put(0, 1);
  } // chroma position, separate_uv_delta_q
  put(0, 1);
  put(1, 1); // film grain, trailing bit
  while (bits.length % 8) bits += "0";
  const payload = Uint8Array.from(bits.match(/.{8}/g)!, (byte) => parseInt(byte, 2));
  return Uint8Array.of(0x12, 0, 0x0e, 0, payload.length, ...payload); // delimiter + extended sequence OBU
}

function av1Properties(bytes: Uint8Array) {
  const meta = boxes(bytes).find((box) => box.type === "meta")!;
  const iprp = boxes(bytes, meta.start + 4, meta.end).find((box) => box.type === "iprp")!;
  const ipco = boxes(bytes, iprp.start, iprp.end).find((box) => box.type === "ipco")!;
  return boxes(bytes, ipco.start, ipco.end)
    .filter((box) => box.type === "av1C")
    .map((box) => [...bytes.slice(box.start, box.end)]);
}

test("av1C follows sequence levels, tier, monochrome and bit depth; ftyp makes no unproved profile claim (S3-C-PLATFORM-13)", async () => {
  for (const [level, options, flags] of [
    [0, {}, 0x0c],
    [16, { tier: 1 }, 0x8c],
    [31, {}, 0x0c],
    [0, { reduced: true, mono: 1 }, 0x1c],
    [13, { high: 1 }, 0x4c],
  ] as const) {
    const color = {
      type: "av01" as const,
      width: 8000,
      height: 6000,
      channels: 3 as const,
      description: null,
      data: sequence(level, options),
    };
    const alpha = { ...color, channels: 1 as const, data: sequence(0, { mono: 1 }) };
    const bytes = new Uint8Array(await muxHeif("avif", color, alpha).arrayBuffer());
    assert.deepEqual(av1Properties(bytes), [
      [0x81, level, flags, 0],
      [0x81, 0, 0x1c, 0],
    ]);
    const ftyp = boxes(bytes).find((box) => box.type === "ftyp")!;
    assert.ok(!Buffer.from(bytes.slice(ftyp.start, ftyp.end)).includes(Buffer.from("MA1B")));
  }
  // Real Chrome 64x64 sequence header: no decoderConfig.description is returned by WebCodecs AV1.
  const data = Uint8Array.from(Buffer.from("12000a0c00000002afff803440434041", "hex"));
  const item = {
    type: "av01" as const,
    width: 64,
    height: 64,
    channels: 3 as const,
    description: null,
    data,
  };
  assert.deepEqual(av1Properties(new Uint8Array(await muxHeif("avif", item, null).arrayBuffer())), [
    [0x81, 0, 0x0c, 0],
  ]);
});

test("AVIF mux refuses a missing or truncated sequence instead of inventing a config (S3-C-PLATFORM-13)", () => {
  const item = {
    type: "av01" as const,
    width: 8,
    height: 8,
    channels: 3 as const,
    description: null,
    data: Uint8Array.of(0x0a, 1, 0),
  };
  assert.throws(() => muxHeif("avif", item, null), /AV1.*sequence|sequence.*AV1/i);
  assert.throws(
    () => muxHeif("avif", { ...item, data: new Uint8Array() }, null),
    /AV1.*sequence|sequence.*AV1/i,
  );
});

// These headers describe the payload; changing av1C alone cannot make I420 monochrome.
test("AVIF rejects actual non-monochrome or limited-range auxiliary sequences before Blob creation", async (t) => {
  const color = {
    type: "av01" as const,
    width: 64,
    height: 64,
    channels: 3 as const,
    description: null,
    data: sequence(0),
  };
  const RealBlob = globalThis.Blob;
  let blobs = 0;
  t.mock.method(
    globalThis,
    "Blob",
    class extends RealBlob {
      constructor(parts: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        blobs++;
      }
    },
  );
  for (const options of [
    { mono: 0, range: 1 },
    { mono: 1, range: 0 },
    { mono: 0, range: 0 },
  ]) {
    const data = sequence(0, options),
      before = data.slice();
    assert.throws(
      () => muxHeif("avif", color, { ...color, channels: 1, data }),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === "export");
        assert.equal(
          error.message,
          "This browser cannot preserve transparency in AVIF. Choose PNG.",
        );
        assert.match(String(error.cause), /monochrome.*full.range/i);
        return true;
      },
    );
    assert.deepEqual(data, before, "the encoded payload is never relabelled or rewritten");
  }
  assert.equal(blobs, 0, "invalid streams do not reach Blob construction");
  const file = muxHeif("avif", color, { ...color, channels: 1, data: sequence(0, { mono: 1 }) });
  assert.equal(file.type, "image/avif", "a monochrome full-range synthetic control is accepted");
  assert.equal(blobs, 1);
  assert.deepEqual(av1Properties(new Uint8Array(await file.arrayBuffer()))[1], [0x81, 0, 0x1c, 0]);
});

test("genuinely encoded monochrome AVIF alpha retains its sequence-derived config and payload", async () => {
  const { readFile } = await import("node:fs/promises");
  const control = JSON.parse(
    await readFile(new URL("./fixtures/avif-alpha-control.json", import.meta.url), "utf8"),
  );
  const color = {
    type: "av01" as const,
    width: control.width,
    height: control.height,
    channels: 3 as const,
    description: null,
    data: new Uint8Array(Buffer.from(control.color, "hex")),
  };
  const alpha = {
    ...color,
    channels: 1 as const,
    data: new Uint8Array(Buffer.from(control.alpha, "hex")),
  };
  const bytes = new Uint8Array(await muxHeif("avif", color, alpha).arrayBuffer());
  assert.deepEqual(av1Properties(bytes), [
    [0x81, 0, 0x0c, 0],
    [0x81, 0, 0x1c, 0],
  ]);
  const mdat = boxes(bytes).find((box) => box.type === "mdat")!;
  assert.deepEqual(
    bytes.slice(mdat.start, mdat.end),
    new Uint8Array(Buffer.concat([color.data, alpha.data])),
  );
  const opaque = new Uint8Array(await muxHeif("avif", color, null).arrayBuffer());
  assert.equal(Buffer.from(opaque).includes(Buffer.from("auxC")), false);
  assert.equal(Buffer.from(opaque).includes(Buffer.from("auxl")), false);
});
