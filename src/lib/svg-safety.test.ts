import assert from "node:assert/strict";
import test from "node:test";
import { CutoutError } from "./errors.ts";
import { needsRasterize, rasterizeSvgFile } from "./files.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>document.title="X"</script></svg>';
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("needsRasterize catches SVG by type, by name and by content", () => {
  assert.equal(needsRasterize(new File([SVG], "a", { type: "image/svg+xml" }), bytes(SVG)), true);
  assert.equal(needsRasterize(new File([SVG], "logo.svg", { type: "" }), bytes(SVG)), true);
  // Type spoofing: the claimed type says PNG, the bytes are markup.
  assert.equal(needsRasterize(new File([SVG], "a.png", { type: "image/png" }), bytes(SVG)), true);
  const bom = String.fromCharCode(0xfeff);
  const xml = `${bom}  \n<?xml version="1.0"?>${SVG}`;
  assert.equal(needsRasterize(new File([xml], "a", { type: "" }), bytes(xml)), true);
  // A leading comment would make a type-less blob sniff as HTML, where inline SVG runs too.
  const comment = `<!-- logo -->${SVG}`;
  assert.equal(needsRasterize(new File([comment], "a", { type: "" }), bytes(comment)), true);
});

test("needsRasterize leaves raster images alone", () => {
  assert.equal(
    needsRasterize(new File([PNG_HEAD], "a.png", { type: "image/png" }), PNG_HEAD),
    false,
  );
  // An ISO-BMFF box whose size byte happens to be '<' (60) is still a photo.
  const heif = new Uint8Array([0, 0, 0, 0x3c, ...bytes("ftypheic")]);
  assert.equal(needsRasterize(new File([heif], "a.heic", { type: "image/heic" }), heif), false);
});

test("rasterizeSvgFile returns non-SVG files untouched", async () => {
  const png = new File([PNG_HEAD], "photo.png", { type: "image/png" });
  assert.equal(await rasterizeSvgFile(png), png);
});

const MARKUP = "<html><script>document.title='PWNED'</script></html>";
const rejectsAsUndrawable = (file: File, label: string) =>
  assert.rejects(
    rasterizeSvgFile(file),
    (error: unknown) => error instanceof CutoutError && error.code === "decode",
    label,
  );

test("needsRasterize finds markup behind any control bytes, marks or padding", () => {
  // A type-less blob is sniffed as HTML after form feeds too; NULs and other controls are no image.
  const pads: Array<[string, string]> = [
    ["form feed", "\f"],
    ["vertical tab", "\v"],
    ["NUL", "\0"],
    ["mixed controls", "\0\x01\x1f\f\v \t"],
    ["UTF-8 mark, then controls", "﻿\f\0"],
  ];
  // The old check looked at 64 bytes: 64 or more spaces hid the "<".
  for (const count of [63, 64, 65, 80]) pads.push([`${count} spaces`, " ".repeat(count)]);
  for (const [label, pad] of pads) {
    const text = pad + MARKUP;
    assert.equal(needsRasterize(new File([text], "a", { type: "" }), bytes(text)), true, label);
  }
  // UTF-16 markup, with and without a mark, padded or not.
  for (const head of [
    [0xff, 0xfe, 0x3c, 0x00],
    [0xfe, 0xff, 0x00, 0x3c],
    [0x00, 0x3c, 0x00, 0x68],
    [0xff, 0xfe, 0x20, 0x00, 0x0c, 0x00, 0x3c, 0x00],
  ]) {
    const data = new Uint8Array(head);
    assert.equal(needsRasterize(new File([data], "a", { type: "" }), data), true, String(head));
  }
});

test("rasterizeSvgFile never passes markup on, whatever comes before it", async () => {
  for (const count of [63, 64, 65, 80, 70_000]) {
    const spaces = " ".repeat(count) + MARKUP;
    await rejectsAsUndrawable(new File([spaces], "payload", { type: "" }), `${count} spaces`);
    const nuls = "\0".repeat(count) + MARKUP;
    await rejectsAsUndrawable(new File([nuls], "x.tiff", { type: "" }), `${count} NULs`);
  }
  for (const pad of ["\f", "\v", "\0", "﻿﻿\f"]) {
    const label = JSON.stringify(pad);
    await rejectsAsUndrawable(new File([pad + MARKUP], "payload", { type: "" }), label);
    await rejectsAsUndrawable(new File([pad + MARKUP], "a.jpg", { type: "image/jpeg" }), label);
  }
  // No known signature: refused, whatever the claimed type.
  for (const type of ["", "image/png", "text/html", "image/jxl"])
    await rejectsAsUndrawable(new File(["hello <script>x</script>"], "photo", { type }), type);
});

/** A file of `head` followed by zero bytes, so it is long enough to sniff. */
const image = (head: number[] | string, name: string, type: string) => {
  const start = typeof head === "string" ? bytes(head) : new Uint8Array(head);
  const data = new Uint8Array(start.length + 64);
  data.set(start);
  return new File([data], name, { type });
};
const RASTERS: Array<[string, number[] | string, string]> = [
  ["png", [...PNG_HEAD], "image/png"],
  ["jpeg", [0xff, 0xd8, 0xff, 0xe0], "image/jpeg"],
  ["gif", "GIF89a", "image/gif"],
  ["webp", "RIFF\x10\0\0\0WEBPVP8 ", "image/webp"],
  ["bmp", "BM", "image/bmp"],
  ["tiff", "II*\0", "image/tiff"],
  ["big-endian tiff", "MM\0*", "image/tiff"],
  // An ftyp box 60 bytes long starts 00 00 00 3C: padding, then "<", to a markup check.
  ["heic", [0, 0, 0, 0x3c, ...bytes("ftypheic")], "image/heic"],
  ["avif", [0, 0, 0, 0x3c, ...bytes("ftypavif")], "image/avif"],
  // Some AVIF writers lead with the generic HEIF brand and list "avif" after it.
  ["mif1 avif", [0, 0, 0, 0x1c, ...bytes("ftypmif1\0\0\0\0mif1avifmiaf")], "image/avif"],
  ["icon", [0, 0, 1, 0, 1, 0, 0x3c, 0x3c], "image/x-icon"],
  ["jpeg xl", [0xff, 0x0a], "image/jxl"],
  ["jpeg xl container", [0, 0, 0, 0x0c, ...bytes("JXL \r\n"), 0x87, 0x0a], "image/jxl"],
];

test("rasterizeSvgFile passes real images through, typed by their bytes", async () => {
  for (const [label, head, type] of RASTERS) {
    const typed = image(head, `photo.${label}`, type);
    const all = new Uint8Array(await typed.arrayBuffer());
    assert.equal(needsRasterize(typed, all), false, label);
    assert.equal(await rasterizeSvgFile(typed), typed, `${label} with its own type is untouched`);
    // An empty or foreign type is replaced, so the object URL can never be served as a page.
    for (const claimed of ["", "text/html", "image/png, text/html", "application/xhtml+xml"]) {
      const file = image(head, "upload", claimed);
      const passed = await rasterizeSvgFile(file);
      assert.equal(passed.type, type, `${label} claimed ${JSON.stringify(claimed)}`);
      assert.equal(passed.name, "upload");
      assert.equal(passed.lastModified, file.lastModified);
      assert.deepEqual(new Uint8Array(await passed.arrayBuffer()), all);
    }
  }
});

test("drawings keep their bytes and get a type every engine shows itself, never a page", async () => {
  // WebKit parses any type it cannot display (application/dxf, image/vnd.dwg, even
  // application/octet-stream) as an HTML page, markup inside or not; it shows PDF and plain
  // text itself. The converter routes DXF, DWG and SKP by extension.
  const DRAWINGS: Array<[string, string, string, string]> = [
    ["sheet.pdf", "%PDF-1.7\n", "application/pdf", "application/pdf"],
    ["plan.dxf", "  0\nSECTION\n  2\nHEADER\n", "image/vnd.dxf", "text/plain"],
    ["plan.dwg", "AC1032\0\0\0\0", "image/vnd.dwg", "text/plain"],
    ["model.skp", "\xff\xfe\xff\x0eSketchUp Model", "application/vnd.sketchup.skp", "text/plain"],
  ];
  for (const [name, content, own, type] of DRAWINGS) {
    for (const claimed of [own, type, "", "text/html", "application/octet-stream"]) {
      // A drawing is converted when it is processed; until then its object URL must be inert.
      for (const body of [content, "\f" + MARKUP]) {
        const file = new File([body], name, { type: claimed });
        const passed = await rasterizeSvgFile(file);
        assert.equal(passed.type, type, `${name} claimed ${JSON.stringify(claimed)}`);
        assert.equal(passed.name, name);
        assert.deepEqual(
          new Uint8Array(await passed.arrayBuffer()),
          new Uint8Array(await file.arrayBuffer()),
        );
        if (claimed === type) assert.equal(passed, file, `${name} with that type is untouched`);
      }
    }
  }
  // With no extension, the drawing's own type picks the converter: PDF keeps that type, the
  // others gain their extension.
  for (const [own, name, type] of [
    ["application/pdf", "plan", "application/pdf"],
    ["image/vnd.dxf", "plan.dxf", "text/plain"],
    ["image/vnd.dwg", "plan.dwg", "text/plain"],
    ["application/vnd.sketchup.skp", "plan.skp", "text/plain"],
  ]) {
    const passed = await rasterizeSvgFile(new File(["AC1032"], "plan", { type: own }));
    assert.deepEqual([passed.name, passed.type], [name, type], own);
  }
});

test("rasterizeSvgFile never hands back SVG bytes when it cannot rasterise", async () => {
  // Node has no image decoder, so rasterising fails: the SVG must be rejected, not passed on.
  for (const file of [
    new File([SVG], "logo.svg", { type: "image/svg+xml" }),
    new File([SVG], "photo.png", { type: "image/png" }),
  ]) {
    await assert.rejects(
      rasterizeSvgFile(file),
      (error: unknown) => error instanceof CutoutError && error.code === "decode",
    );
  }
});
