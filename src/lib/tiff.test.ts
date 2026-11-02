import assert from "node:assert/strict";
import { test } from "node:test";
import { CutoutError } from "./errors.ts";
import { assertTiffWithinBudget, tiffDimensions } from "./tiff.ts";

/** Little-endian TIFF with one IFD and a strip pointing past EOF: 138 bytes. */
function tinyTiff(width: number, height: number) {
  const tags = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 8],
    [259, 3, 1],
    [262, 3, 2],
    [273, 4, 200],
    [277, 3, 4],
    [278, 4, height],
    [279, 4, 16],
  ] as const;
  const buffer = new ArrayBuffer(8 + 2 + tags.length * 12 + 4 + 16);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, 1, true);
    if (type === 3) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  return buffer;
}

test("a 138-byte TIFF declaring 16000×16000 is measured and refused without decoding", () => {
  const buffer = tinyTiff(16000, 16000);
  assert.equal(buffer.byteLength, 138);
  const heap = process.memoryUsage().heapUsed;
  // CPU time, not wall time: a busy machine must not fail this, a 1 GB decode would.
  const started = process.cpuUsage();
  const dims = tiffDimensions(buffer);
  assert.deepEqual(dims, { width: 16000, height: 16000 });
  assert.throws(
    () => assertTiffWithinBudget(dims, 96_000_000),
    (error) => error instanceof CutoutError && error.code === "memory",
  );
  const cpu = process.cpuUsage(started);
  assert.ok((cpu.user + cpu.system) / 1000 < 100);
  assert.ok(process.memoryUsage().heapUsed - heap < 20_000_000);
});

test("a TIFF inside the pixel budget passes", () => {
  const dims = tiffDimensions(tinyTiff(4000, 3000));
  assert.deepEqual(dims, { width: 4000, height: 3000 });
  assertTiffWithinBudget(dims, 96_000_000);
});

test("bytes that are not a TIFF have no dimensions", () => {
  assert.equal(tiffDimensions(new Uint8Array([1, 2, 3, 4]).buffer), null);
});
