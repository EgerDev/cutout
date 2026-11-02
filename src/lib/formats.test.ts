import assert from "node:assert/strict";
import test from "node:test";
import { applyEdgeDetailed } from "./defringe.ts";
import {
  exportFormats,
  formatExtension,
  formatLabel,
  formatMime,
  formatTrait,
  previewBackground,
  sniffImage,
} from "./formats.ts";

test("sniffImage reads PNG, JPEG, WebP and both TIFF byte orders from magic bytes", () => {
  const bytes = (...values: Array<number | string>) =>
    new Uint8Array(values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])));
  assert.equal(sniffImage(bytes(0x89, "PNG\r\n")), "png");
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), "jpeg");
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0x00)), null);
  assert.equal(sniffImage(bytes("RIFF", 0, 0, 0, 0, "WEBP")), "webp");
  assert.equal(sniffImage(bytes("RIFF", 0, 0, 0, 0, "WAVE")), null);
  assert.equal(sniffImage(bytes("II", 0x2a, 0)), "tiff");
  assert.equal(sniffImage(bytes("MM", 0, 0x2b)), "tiff");
  assert.equal(sniffImage(bytes("MM", 0x2a, 0)), null);
  assert.equal(sniffImage(new Uint8Array(2)), null);
});

test("previewBackground fills white when JPEG cannot keep transparency", () => {
  const filled = previewBackground({ type: "transparent" }, "jpeg");
  assert.deepEqual(filled, { type: "color", color: "#ffffff" });
  assert.deepEqual(previewBackground({ type: "transparent" }, "png"), { type: "transparent" });
});

test("exportFormats always includes PNG, JPEG and BMP", () => {
  assert.deepEqual(exportFormats({ webp: true, avif: true, heic: true }), [
    "png",
    "webp",
    "avif",
    "heic",
    "jpeg",
    "bmp",
  ]);
  assert.deepEqual(exportFormats({ webp: false, avif: false, heic: false }), [
    "png",
    "jpeg",
    "bmp",
  ]);
});

test("format helpers cover the download menu", () => {
  assert.equal(formatLabel("heic"), "HEIC");
  assert.equal(formatExtension("jpeg"), "jpg");
  assert.equal(formatMime("avif"), "image/avif");
  assert.equal(formatTrait("jpeg"), "Solid background");
  assert.equal(formatTrait("avif"), "Solid background");
  assert.equal(formatTrait("heic"), "Transparency");
});

test("applyEdgeDetailed is a no-op when feather and choke are 0", async () => {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  assert.equal((await applyEdgeDetailed(blob, 0, 0)).blob, blob);
});
