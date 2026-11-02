import assert from "node:assert/strict";
import test from "node:test";
import { encodeBmp } from "./bmp.ts";

test("BMP keeps a transparent pixel as zero alpha", async () => {
  const data = new Uint8ClampedArray([10, 20, 30, 0, 40, 50, 60, 255]);
  const blob = encodeBmp(data, 2, 1);
  assert.equal(blob.type, "image/bmp");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(bytes[0], 0x42);
  assert.equal(bytes[1], 0x4d);
  const offset = new DataView(bytes.buffer).getUint32(10, true);
  assert.equal(bytes[offset + 3], 0);
  assert.equal(bytes[offset + 7], 255);
  assert.equal(bytes[offset], 30);
  assert.equal(bytes[offset + 2], 10);
});

test("BMP describes its BGRA pixels with valid BITMAPV5 channel masks", async () => {
  // Given an RGBA cutout containing partial transparency.
  const pixels = new Uint8ClampedArray([200, 100, 50, 128]);
  // When the file header is read by a BMP decoder.
  const header = new DataView(await encodeBmp(pixels, 1, 1).arrayBuffer());
  // Then the channel masks occupy their defined offsets without overlapping color space.
  assert.deepEqual(
    [54, 58, 62, 66, 70].map((offset) => header.getUint32(offset, true)),
    [0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000, 0x73524742],
  );
});
