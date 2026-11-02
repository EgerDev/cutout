import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { HEIC_PROBE, pickSamples, sampleMismatch } from "./still-encode.ts";

/** Rows of `stride` px; the first `width` px of each row hold `paint(x, y)`, the rest junk. */
function image(
  stride: number,
  width: number,
  height: number,
  paint: (x: number, y: number) => number[],
) {
  const data = new Uint8ClampedArray(stride * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < stride; x += 1)
      data.set(x < width ? paint(x, y) : [255, 0, 255, 255], (y * stride + x) * 4);
  return data;
}

test("pickSamples finds a clear, a mid-alpha and an opaque pixel inside flat patches (S3-C-PLATFORM-01)", () => {
  // Red opaque, then white at alpha 128, then clear; one junk column of padding per row.
  const data = image(91, 90, 30, (x) =>
    x < 30 ? [200, 30, 30, 255] : x < 60 ? [255, 255, 255, 128] : [0, 0, 0, 0],
  );
  const samples = pickSamples(data, 91, 90, 30);
  assert.deepEqual(
    samples.map((sample) => [sample.rgba[3], sample.colour]),
    [
      [0, false],
      [128, true],
      [255, true],
    ],
  );
  for (const sample of samples) {
    const band = sample.rgba[3] === 255 ? [0, 30] : sample.rgba[3] === 128 ? [30, 60] : [60, 90];
    assert.ok(
      sample.x - 3 >= band[0]! && sample.x + 3 < band[1]!,
      `patch at ${sample.x} stays in its band`,
    );
    assert.ok(sample.y >= 3 && sample.y + 3 < 30);
  }
});

test("pickSamples keeps an alpha-only sample on textured art and never reads padding (S3-C-PLATFORM-01)", () => {
  let seed = 7;
  const noise = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
  const textured = pickSamples(
    image(41, 40, 40, () => [noise(), noise(), noise(), 255]),
    41,
    40,
    40,
  );
  assert.deepEqual(
    textured.map((sample) => [sample.rgba[3], sample.colour]),
    [[255, false]],
  );
  // Rows are 8 px apart but only 7 are image: the one 7x7 patch is x 0-6, and the junk
  // eighth column is never read. Six columns hold no patch at all.
  const grey = () => [9, 9, 9, 255];
  assert.deepEqual(pickSamples(image(8, 7, 7, grey), 8, 7, 7), [
    { x: 3, y: 3, rgba: [9, 9, 9, 255], colour: true },
  ]);
  assert.deepEqual(pickSamples(image(8, 6, 20, grey), 8, 6, 20), []);
});

test("sampleMismatch flags lost alpha and premultiplied colour, and allows coding noise (S3-C-PLATFORM-01)", () => {
  const opaque = { x: 10, y: 12, rgba: [200, 30, 30, 255], colour: true };
  const half = { x: 40, y: 12, rgba: [255, 255, 255, 128], colour: true };
  const clear = { x: 70, y: 12, rgba: [0, 0, 0, 0], colour: false };
  const textured = { ...opaque, colour: false };
  assert.equal(sampleMismatch(opaque, [196, 34, 27, 252]), null);
  assert.equal(sampleMismatch(half, [250, 252, 247, 131]), null);
  assert.equal(sampleMismatch(clear, [0, 0, 0, 3]), null);
  assert.equal(sampleMismatch(textured, [90, 140, 20, 255]), null);
  assert.match(sampleMismatch(opaque, [0, 0, 0, 0]) ?? "", /alpha 0 at 10,12 .* 255/);
  assert.match(sampleMismatch(clear, [0, 0, 0, 255]) ?? "", /alpha 255/);
  assert.match(sampleMismatch(half, [128, 128, 128, 128]) ?? "", /colour 128,128,128 at 40,12/);
  assert.match(sampleMismatch(opaque, [30, 30, 200, 255]) ?? "", /colour/);
});

test("the HEIC decoder probe is the committed libheif fixture, byte for byte (S3-C-PLATFORM-01)", async () => {
  const fixture = await readFile(new URL("./fixtures/tiny.heic", import.meta.url));
  assert.deepEqual(Buffer.from(HEIC_PROBE, "base64"), fixture);
});

test("HEIC checks real coded dimensions before allocating and preserves capability failures (S3-C-PLATFORM-08)", async (t) => {
  const { encodeStill } = await import("./still-encode.ts");
  const before = ["VideoEncoder", "document"].map((key) =>
    Object.getOwnPropertyDescriptor(globalThis, key),
  );
  t.after(() =>
    ["VideoEncoder", "document"].forEach((key, i) => {
      if (before[i]) Object.defineProperty(globalThis, key, before[i]!);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  const configs: VideoEncoderConfig[] = [];
  let cause: unknown;
  Object.defineProperty(globalThis, "VideoEncoder", {
    configurable: true,
    value: class {
      static async isConfigSupported(config: VideoEncoderConfig) {
        configs.push(config);
        if (cause) throw cause;
        return { supported: false };
      }
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        throw new Error("no image allocation expected");
      },
    },
  });
  const source = { width: 40001, height: 7 } as HTMLCanvasElement;
  for (cause of [
    undefined,
    new DOMException("controlled large-size capability rejection", "NotSupportedError"),
  ]) {
    await assert.rejects(encodeStill(source, "image/heic"), (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "export");
      assert.match(error.message, /HEIC.*40001.*7/);
      assert.match(error.message, /dimensions|size/i);
      assert.match(error.message, /PNG/);
      if (cause) assert.equal(error.cause, cause);
      else assert.match(String(error.cause), /support/i);
      return true;
    });
  }
  assert.deepEqual(
    configs.map((c) => [c.width, c.height]),
    [
      [40002, 8],
      [40002, 8],
    ],
  );
});

test("HEIC runtime creation/task failures retain their exact cause even after support says yes (S3-C-PLATFORM-08)", async (t) => {
  const { encodeStill } = await import("./still-encode.ts");
  const keys = ["VideoEncoder", "VideoFrame", "document"];
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() =>
    keys.forEach((key, i) => {
      if (before[i]) Object.defineProperty(globalThis, key, before[i]!);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  let failAt = "configure",
    closes = 0,
    framesClosed = 0;
  const failure = new DOMException("controlled encoder failure", "OperationError");
  Object.defineProperty(globalThis, "VideoEncoder", {
    configurable: true,
    value: class {
      static async isConfigSupported() {
        return { supported: true };
      }
      configure() {
        if (failAt === "configure") throw failure;
      }
      encode() {}
      flush() {
        return Promise.reject(failure);
      }
      close() {
        closes++;
      }
    },
  });
  Object.defineProperty(globalThis, "VideoFrame", {
    configurable: true,
    value: class {
      close() {
        framesClosed++;
      }
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({
        width: 8,
        height: 8,
        getContext: () => ({
          drawImage() {},
          putImageData() {},
          getImageData: () => ({ data: new Uint8ClampedArray(8 * 8 * 4) }),
        }),
      }),
    },
  });
  for (failAt of ["configure", "flush"]) {
    await assert.rejects(
      encodeStill({ width: 8, height: 8 } as HTMLCanvasElement, "image/heic"),
      (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error && error.code === "export");
        assert.match(error.message, /HEIC.*8.*8/);
        assert.equal(error.cause, failure);
        return true;
      },
    );
  }
  assert.equal(closes, 2);
  assert.equal(framesClosed, 1);
});

test("AVIF refuses unsupported actual odd size instead of trying an unsafe padded crop", async (t) => {
  const { encodeStill } = await import("./still-encode.ts");
  const keys = ["VideoEncoder", "document"];
  const before = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() =>
    keys.forEach((key, i) => {
      if (before[i]) Object.defineProperty(globalThis, key, before[i]!);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  const sizes: number[][] = [];
  Object.defineProperty(globalThis, "VideoEncoder", {
    configurable: true,
    value: class {
      static async isConfigSupported(config: VideoEncoderConfig) {
        sizes.push([config.width!, config.height!]);
        return { supported: config.width === 130 && config.height === 66 };
      }
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement() {
        throw new Error("unsupported dimensions must refuse before allocation");
      },
    },
  });
  await assert.rejects(
    encodeStill({ width: 129, height: 65 } as HTMLCanvasElement, "image/avif"),
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === "export");
      assert.match(error.message, /AVIF.*129.*65.*dimensions.*PNG/);
      assert.match(String(error.cause), /does not support/);
      return true;
    },
  );
  assert.deepEqual(sizes, [[129, 65]]);
});
