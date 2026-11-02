import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (
  await requireCutout(appCandidates(process.env.DEV_URL ?? "http://127.0.0.1:8080/"))
).replace(/\/$/, "");
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { webkit } from "playwright";
import { bypassCsp, launchChrome, webkitCrashed } from "./chrome.mjs";

const appUrl = verifiedAppUrl;
const transparentAvifMessage = "This browser cannot preserve transparency in AVIF. Choose PNG.";
const alphaControl = JSON.parse(
  await readFile(new URL("../src/lib/fixtures/avif-alpha-control.json", import.meta.url), "utf8"),
);

test("raster exports preserve odd dimensions and alpha or specifically refuse nonconforming AVIF", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(async () => {
      const { prepareExportCaps } = await import("/src/lib/composite.ts");
      const { exportFormats, formatMime } = await import("/src/lib/formats.ts");
      const { encodeExport } = await import("/src/lib/editor/export.ts");
      const { defaults } = await import("/src/lib/editor/model.ts");
      const { toProcessableFile } = await import("/src/lib/files.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 129;
      canvas.height = 65;
      const context = canvas.getContext("2d");
      context.fillStyle = "red";
      context.fillRect(0, 0, 64, 65);
      const result = await new Promise((resolve) => canvas.toBlob(resolve));
      const source = new File([result], "odd.png", { type: "image/png" });
      const results = [];
      for (const format of exportFormats(await prepareExportCaps())) {
        let encoded;
        try {
          encoded = await encodeExport({
            result,
            source,
            settings: { ...defaults, exportFormat: format },
          });
        } catch (error) {
          if (format !== "avif") throw error;
          results.push({ format, refused: error.message, code: error.code });
          continue;
        }
        const decoded = await toProcessableFile(
          new File([encoded.blob], `odd.${format}`, { type: formatMime(format) }),
        );
        const bitmap = await createImageBitmap(decoded);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        context.drawImage(bitmap, 0, 0);
        results.push({
          format,
          type: encoded.blob.type,
          width: bitmap.width,
          height: bitmap.height,
          reportedWidth: encoded.width,
          reportedHeight: encoded.height,
          left: [...context.getImageData(8, 8, 1, 1).data],
          right: [...context.getImageData(100, 8, 1, 1).data],
        });
        bitmap.close();
      }
      return results;
    });
    for (const result of results) {
      t.diagnostic(JSON.stringify(result));
      if (result.format === "avif") {
        assert.equal(result.refused, transparentAvifMessage);
        assert.equal(result.code, "export");
        continue;
      }
      assert.equal(result.width, 129, `${result.format} width`);
      assert.equal(result.height, 65, `${result.format} height`);
      assert.equal(result.reportedWidth, result.width);
      assert.equal(result.reportedHeight, result.height);
      assert.ok(
        result.left[0] > 240 && result.left[1] < 15 && result.left[3] > 250,
        `${result.format} red pixels`,
      );
      assert.equal(
        result.right[3],
        result.format === "jpeg" ? 255 : 0,
        `${result.format} background alpha`,
      );
    }
  } finally {
    await browser.close();
  }
});

const pairs = (...values) => values.join("\n") + "\n";
const line = (x1, y1, x2, y2) => pairs(0, "LINE", 10, x1, 20, y1, 11, x2, 21, y2);
const drawing = (blocks, entities) =>
  pairs(0, "SECTION", 2, "BLOCKS") +
  blocks +
  pairs(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES") +
  entities +
  pairs(0, "ENDSEC", 0, "EOF");

test("DXF nested rotated inserts preserve block origins and scale like flattened geometry", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const blocks =
      pairs(0, "BLOCK", 2, "A", 10, 2, 20, 3) +
      line(2, 3, 12, 8) +
      pairs(0, "ENDBLK") +
      pairs(0, "BLOCK", 2, "B", 10, 0, 20, 0, 0, "INSERT", 2, "A", 10, 10, 20, 0, 0, "ENDBLK");
    const anchor = line(0, 0, 100, 100);
    const nested = drawing(
      blocks,
      anchor + pairs(0, "INSERT", 2, "B", 10, 30, 20, 40, 41, 2, 42, 3, 50, 90),
    );
    const flat = drawing("", anchor + line(30, 60, 15, 80));
    const result = await page.evaluate(
      async ({ nested, flat }) => {
        const { toProcessableFile } = await import("/src/lib/files.ts");
        const images = [];
        for (const dxf of [nested, flat]) {
          const file = await toProcessableFile(new File([dxf], "drawing.dxf"));
          const bitmap = await createImageBitmap(file);
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context = canvas.getContext("2d");
          context.drawImage(bitmap, 0, 0);
          images.push(context.getImageData(0, 0, bitmap.width, bitmap.height).data);
          bitmap.close();
        }
        let differentPixels = 0;
        for (let i = 0; i < images[0].length; i += 4)
          if (images[0][i] !== images[1][i]) differentPixels += 1;
        return { differentPixels };
      },
      { nested, flat },
    );
    assert.equal(
      result.differentPixels,
      0,
      "nested drawing must match independently flattened coordinates",
    );
  } finally {
    await browser.close();
  }
});

test("drawing ingest extracts PDF RGB streams and embedded DWG/SKP previews", async (t) => {
  const compressed = deflateSync(Buffer.from([255, 0, 0, 0, 255, 0]));
  const pdf = Buffer.concat([
    Buffer.from(
      "%PDF-1.4\n1 0 obj\n<< /Subtype /Image /Width 2 /Height 1 /BitsPerComponent 8 /ColorSpace /DeviceRGB /Filter /FlateDecode >>\nstream\n",
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\n%%EOF"),
  ]);
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(
      async (pdf) => {
        const { toProcessableFile } = await import("/src/lib/files.ts");
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d");
        context.fillStyle = "red";
        context.fillRect(0, 0, 16, 16);
        const png = await new Promise((resolve) => canvas.toBlob(resolve));
        const dib = new Uint8Array(40 + 16 * 16 * 3);
        const view = new DataView(dib.buffer);
        view.setUint32(0, 40, true);
        view.setInt32(4, 16, true);
        view.setInt32(8, 16, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 24, true);
        for (let i = 42; i < dib.length; i += 3) dib[i] = 255;
        const files = [
          new File([new Uint8Array(pdf)], "rgb.pdf"),
          new File(["AC1032", dib], "preview.dwg"),
          new File(["SketchUp", png], "preview.skp"),
        ];
        const results = [];
        for (const file of files) {
          const processed = await toProcessableFile(file);
          const bitmap = await createImageBitmap(processed);
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          context.drawImage(bitmap, 0, 0);
          results.push({
            name: file.name,
            width: bitmap.width,
            height: bitmap.height,
            pixel: [...context.getImageData(0, 0, 1, 1).data],
          });
          bitmap.close();
        }
        return results;
      },
      [...pdf],
    );
    assert.deepEqual(results, [
      { name: "rgb.pdf", width: 2, height: 1, pixel: [255, 0, 0, 255] },
      { name: "preview.dwg", width: 16, height: 16, pixel: [255, 0, 0, 255] },
      { name: "preview.skp", width: 16, height: 16, pixel: [255, 0, 0, 255] },
    ]);
    results.forEach((result) => t.diagnostic(JSON.stringify(result)));
  } finally {
    await browser.close();
  }
});

test("Download menu writes raster files and SVG and safely refuses transparent AVIF", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
    });
    await page.goto(appUrl);
    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 129;
      canvas.height = 65;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 129, 65);
      context.fillStyle = "black";
      context.fillRect(32, 16, 64, 32);
      return canvas.toDataURL().split(",")[1];
    });
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (
      await choosing
    ).setFiles({ name: "odd.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
    await page.waitForFunction(
      () => window.__cutoutTest?.useWorkspace?.getState().items[0]?.status === "done",
    );
    await page.getByRole("button", { name: "Download format", exact: true }).click();
    const names = await page
      .getByRole("menuitem")
      .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
    t.diagnostic(JSON.stringify({ menu: names }));
    for (const name of names.filter((name) => /^(PNG|WebP|AVIF|HEIC|JPG|BMP|SVG)/.test(name))) {
      if (/^AVIF/.test(name)) {
        let downloads = 0;
        const count = () => downloads++;
        page.on("download", count);
        await page.evaluate(() => window.__cutoutTest.useWorkspace.setState({ saved: false }));
        await page.getByRole("menuitem", { name, exact: true }).click();
        await page.getByText(transparentAvifMessage, { exact: true }).first().waitFor();
        assert.equal(
          await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().saved),
          false,
        );
        assert.equal(downloads, 0);
        page.off("download", count);
        await page.getByRole("button", { name: "Download format", exact: true }).click();
        continue;
      }
      const downloading = page.waitForEvent("download");
      await page.getByRole("menuitem", { name, exact: true }).click();
      const downloaded = await downloading;
      const bytes = await readFile(await downloaded.path());
      const filename = downloaded.suggestedFilename();
      const decoded = await page.evaluate(
        async ({ bytes, filename }) => {
          const { toProcessableFile } = await import("/src/lib/files.ts");
          const file = new File([new Uint8Array(bytes)], filename);
          const bitmap = await createImageBitmap(await toProcessableFile(file));
          const size = { width: bitmap.width, height: bitmap.height };
          bitmap.close();
          return size;
        },
        { bytes: [...bytes], filename },
      );
      assert.deepEqual(decoded, { width: 129, height: 65 }, filename);
      if (filename.endsWith(".svg")) assert.match(bytes.toString(), /<path /);
      t.diagnostic(JSON.stringify({ name, filename, bytes: bytes.length, ...decoded }));
      await page.getByRole("button", { name: "Download format", exact: true }).click();
    }
  } finally {
    await browser.close();
  }
});

test("a white logo on #121212 at an unaligned size comes back on a clear background (C31)", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { cutoutGraphic } = await import("/src/lib/graphics.ts");
      const size = 101;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = "#121212";
      context.fillRect(0, 0, size, size);
      context.fillStyle = "#fff";
      context.beginPath();
      context.arc(50.5, 50.5, 15, 0, Math.PI * 2);
      context.fill();
      context.fillRect(20, 47, 61, 7);
      const source = context.getImageData(0, 0, size, size).data;
      const png = await new Promise((resolve) => canvas.toBlob(resolve));
      const cut = await cutoutGraphic(new File([png], "logo.png", { type: "image/png" }));
      const bitmap = await createImageBitmap(cut.blob);
      context.clearRect(0, 0, size, size);
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const out = context.getImageData(0, 0, size, size).data;
      let background = 0;
      let visible = 0;
      for (let i = 0; i < source.length; i += 4) {
        if (source[i] !== 18 || source[i + 1] !== 18 || source[i + 2] !== 18) continue;
        background += 1;
        if (out[i + 3]) visible += 1;
      }
      return { background, visible, centre: out[(50 * size + 50) * 4 + 3] };
    });
    t.diagnostic(JSON.stringify(result));
    assert.ok(result.background > 8000);
    assert.equal(result.visible, 0, "background pixels left visible");
    assert.equal(result.centre, 255);
  } finally {
    await browser.close();
  }
});

test("HEIC keeps straight semi-transparent colour; native nonconforming AVIF is refused (S3-C-PLATFORM-02)", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(async () => {
      const { codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
      const { toProcessableFile } = await import("/src/lib/files.ts");
      // White: the left half opaque, the right half a ramp from alpha 0 to 255 (128 at x = 300).
      const canvas = document.createElement("canvas");
      canvas.width = 400;
      canvas.height = 300;
      const image = canvas.getContext("2d").createImageData(400, 300);
      for (let i = 0; i < image.data.length; i += 4) {
        const x = (i / 4) % 400;
        image.data.fill(255, i, i + 3);
        image.data[i + 3] = x < 200 ? 255 : Math.round(((x - 200) / 199) * 255);
      }
      canvas.getContext("2d").putImageData(image, 0, 0);
      const results = [];
      for (const [mime, codec] of [
        ["image/avif", "av01.0.04M.08"],
        ["image/heic", "hvc1.1.6.L93.B0"],
      ]) {
        if (!(await codecSupported(codec))) continue;
        let blob;
        try {
          blob = await encodeStill(canvas, mime);
        } catch (error) {
          if (mime !== "image/avif") throw error;
          results.push({ mime, refused: error.message, code: error.code });
          continue;
        }
        // Chrome cannot decode HEIC; the app's own HEIC decoder can.
        const file =
          mime === "image/heic"
            ? await toProcessableFile(new File([blob], "ramp.heic", { type: mime }))
            : blob;
        const bitmap = await createImageBitmap(file);
        const decoded = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
        decoded.drawImage(bitmap, 0, 0);
        bitmap.close();
        results.push({
          mime,
          opaque: [...decoded.getImageData(100, 150, 1, 1).data],
          half: [...decoded.getImageData(300, 150, 1, 1).data],
        });
      }
      return results;
    });
    assert.ok(
      results.some((result) => result.mime === "image/avif"),
      "AVIF is encodable",
    );
    for (const result of results) {
      t.diagnostic(JSON.stringify(result));
      if (result.mime === "image/avif") {
        assert.equal(result.refused, transparentAvifMessage);
        assert.equal(result.code, "export");
        continue;
      }
      assert.deepEqual(result.opaque, [255, 255, 255, 255], `${result.mime} opaque white`);
      assert.ok(Math.abs(result.half[3] - 128) <= 8, `${result.mime} alpha near 128`);
      assert.ok(
        result.half.slice(0, 3).every((v) => v >= 250),
        `${result.mime} white stays white`,
      );
    }
  } finally {
    await browser.close();
  }
});

test("genuine monochrome full-range AVIF control survives mux, software decode and ImageIO (C44)", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async (control) => {
      const { muxHeif } = await import("/src/lib/heif-mux.ts");
      const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (byte) => parseInt(byte, 16));
      const color = {
        type: "av01",
        width: control.width,
        height: control.height,
        description: null,
        data: fromHex(control.color),
        channels: 3,
      };
      const file = muxHeif("avif", color, { ...color, data: fromHex(control.alpha), channels: 1 });
      const bytes = new Uint8Array(await file.arrayBuffer());
      // The muxer writes iloc version 0 with 4-byte offsets and lengths: colour item, then alpha.
      const view = new DataView(bytes.buffer);
      const at = String.fromCharCode(...bytes.subarray(0, 2048)).indexOf("iloc") + 10;
      const extent = (item) => {
        const entry = at + 2 + item * 14;
        const offset = view.getUint32(entry + 6);
        return bytes.slice(offset, offset + view.getUint32(entry + 10));
      };
      // Inspect actual luma endpoints. Chrome reports fullRange=false for this genuine
      // monochrome stream even though its parsed sequence range is 1 (checked separately).
      const plane = await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
          async output(frame) {
            const buffer = new Uint8Array(frame.allocationSize());
            const [luma] = await frame.copyTo(buffer);
            resolve({ fullRange: frame.colorSpace.fullRange, luma, buffer });
            frame.close();
          },
          error: reject,
        });
        decoder.configure({
          codec: "av01.0.04M.08",
          codedWidth: 400,
          codedHeight: 300,
          hardwareAcceleration: "prefer-software",
        });
        decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: 0, data: extent(1) }));
        decoder.flush().catch(reject);
      });
      const luma = (x, y) => plane.buffer[plane.luma.offset + y * plane.luma.stride + x];
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      return {
        fullRange: plane.fullRange,
        opaque: luma(100, 150),
        half: luma(300, 150),
        clear: luma(20, 20),
        avif: btoa(binary),
      };
    }, alphaControl);
    const { avif, ...alpha } = result;
    t.diagnostic(JSON.stringify({ alpha }));
    assert.ok(alpha.opaque >= 253, `opaque alpha luma: ${alpha.opaque}`);
    assert.ok(alpha.clear <= 2, `clear alpha luma: ${alpha.clear}`);
    assert.ok(Math.abs(alpha.half - 128) <= 2, `half alpha luma: ${alpha.half}`);
    if (process.platform !== "darwin") return;
    // Preview, Photos and Quick Look decode through ImageIO; sips uses the same decoder.
    const directory = await mkdtemp(join(tmpdir(), "cutout-avif-"));
    try {
      await writeFile(join(directory, "cutout.avif"), Buffer.from(avif, "base64"));
      execFileSync("sips", ["-s", "format", "png", "cutout.avif", "--out", "cutout.png"], {
        cwd: directory,
        stdio: "ignore",
      });
      const png = (await readFile(join(directory, "cutout.png"))).toString("base64");
      const imageio = await page.evaluate(async (png) => {
        const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        return {
          opaque: [...context.getImageData(100, 150, 1, 1).data],
          half: [...context.getImageData(300, 150, 1, 1).data],
          clear: context.getImageData(20, 20, 1, 1).data[3],
        };
      }, png);
      t.diagnostic(JSON.stringify({ imageio }));
      assert.ok(imageio.opaque[3] >= 253, `ImageIO opaque alpha: ${imageio.opaque[3]}`);
      assert.ok(
        imageio.opaque.slice(0, 3).every((channel) => channel >= 250),
        `ImageIO colour: ${imageio.opaque}`,
      );
      assert.equal(imageio.clear, 0, "ImageIO clear alpha");
      assert.ok(
        Math.abs(imageio.half[3] - 128) <= 2 && imageio.half.slice(0, 3).every((v) => v >= 250),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
});

/** Red opaque top-left, white at alpha 128 top-right, clear bottom half; samples at their centres. */
async function exportGrid(page, sizes, mimes) {
  return page.evaluate(
    async ({ sizes, mimes }) => {
      const { HEIC_PROBE, codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
      const codecs = { "image/heic": "hvc1.1.6.L93.B0", "image/avif": "av01.0.04M.08" };
      const probe = new Blob([Uint8Array.from(atob(HEIC_PROBE), (c) => c.charCodeAt(0))], {
        type: "image/heic",
      });
      const nativeHeic = await createImageBitmap(probe).then(
        (bitmap) => (bitmap.close(), true),
        () => false,
      );
      const results = [];
      for (const mime of mimes) {
        if (!(await codecSupported(codecs[mime]))) continue;
        for (const [width, height] of sizes) {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          context.fillStyle = "rgb(200,30,30)";
          context.fillRect(0, 0, Math.ceil(width / 2), Math.ceil(height / 2));
          context.fillStyle = "rgba(255,255,255,0.5)";
          context.fillRect(Math.ceil(width / 2), 0, width, Math.ceil(height / 2));
          const points = {
            opaque: [Math.floor(width / 4), Math.floor(height / 4)],
            half: [Math.floor((width * 3) / 4), Math.floor(height / 4)],
            clear: [Math.floor(width / 2), Math.floor((height * 3) / 4)],
          };
          try {
            const blob = await encodeStill(canvas, mime);
            const bitmap =
              mime === "image/heic" && !nativeHeic
                ? await (await import("/vendor/heic-to/csp.js")).heicTo({ blob, type: "bitmap" })
                : await createImageBitmap(blob);
            const decoded = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
            decoded.drawImage(bitmap, 0, 0);
            bitmap.close();
            const pixel = ([x, y]) => [...decoded.getImageData(x, y, 1, 1).data];
            results.push({
              mime,
              decoder: mime === "image/heic" && !nativeHeic ? "libheif" : "native",
              size: `${width}x${height}`,
              opaque: pixel(points.opaque),
              half: pixel(points.half),
              clear: pixel(points.clear),
            });
          } catch (error) {
            results.push({
              mime,
              decoder: mime === "image/heic" && !nativeHeic ? "libheif" : "native",
              size: `${width}x${height}`,
              error: String(error?.message),
              code: error.code,
            });
          }
        }
      }
      return results;
    },
    { sizes, mimes },
  );
}

test("WebKit HEIC keeps alpha at formerly blank sizes; transparent AVIF is safely refused (S3-C-PLATFORM-01)", async (t) => {
  const browser = bypassCsp(await webkit.launch());
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const sizes = [
      [1080, 1080],
      [800, 600],
      [400, 400],
      [130, 66],
      [401, 301],
      [256, 64],
    ];
    const results = await exportGrid(page, sizes, ["image/heic", "image/avif"]);
    if (!results.length) return t.skip("WebKit here cannot encode HEIC or AVIF");
    for (const result of results) t.diagnostic(JSON.stringify(result));
    for (const result of results) {
      const label = `${result.mime} ${result.size}`;
      if (result.mime === "image/avif") {
        assert.equal(result.error, transparentAvifMessage, label);
        assert.equal(result.code, "export");
        continue;
      }
      assert.equal(result.error, undefined, `${label} exported`);
      assert.ok(result.opaque[3] >= 250 && result.opaque[0] > 180, `${label} opaque red`);
      assert.ok(
        Math.abs(result.half[3] - 128) <= 8 && result.half[0] >= 240,
        `${label} half white`,
      );
      assert.equal(result.clear[3], 0, `${label} clear`);
    }
  } catch (error) {
    if (!webkitCrashed(error)) throw error;
    return t.skip("Linux WPE WebKit crashed (recorded environment limit)");
  } finally {
    await browser.close();
  }
});

test("an AVIF or HEIC export that decodes wrong is refused, not reported as saved (S3-C-PLATFORM-01)", async (t) => {
  const outcomes = [];
  for (const [name, launch, mime] of [
    ["Chrome", () => launchChrome(), "image/avif"],
    ["WebKit", async () => bypassCsp(await webkit.launch()), "image/heic"],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(appUrl);
      const result = await page.evaluate(async (mime) => {
        const { codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
        if (!(await codecSupported(mime === "image/heic" ? "hvc1.1.6.L93.B0" : "av01.0.04M.08")))
          return null;
        const canvas = document.createElement("canvas");
        canvas.width = 320;
        canvas.height = 240;
        const context = canvas.getContext("2d");
        context.fillStyle = "rgb(200,30,30)";
        context.fillRect(0, 0, 320, 240);
        const healthy = (await encodeStill(canvas, mime)).size > 0;
        // Stand in for Apple's decoder on a file it reads as fully transparent.
        const decode = window.createImageBitmap;
        window.createImageBitmap = (source, ...rest) =>
          source instanceof Blob && source.type === mime
            ? decode(new ImageData(320, 240))
            : decode(source, ...rest);
        try {
          await encodeStill(canvas, mime);
          return { healthy, refused: null };
        } catch (error) {
          return { healthy, refused: String(error?.message) };
        } finally {
          window.createImageBitmap = decode;
        }
      }, mime);
      t.diagnostic(`${name} ${mime}: ${JSON.stringify(result ?? "cannot encode here")}`);
      if (result) outcomes.push({ label: `${name} ${mime}`, ...result });
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
  assert.ok(outcomes.length, "some browser here encodes AVIF or HEIC");
  for (const outcome of outcomes) {
    assert.equal(outcome.healthy, true, `${outcome.label} exports normally`);
    assert.match(outcome.refused ?? "", /broken (AVIF|HEIC)/, `${outcome.label} refused`);
  }
});

test("a HEIC export that fails to decode is refused where HEIC decodes, and saved where it never does (S3-C-PLATFORM-01)", async (t) => {
  const outcomes = [];
  for (const [name, launch] of [
    ["WebKit", async () => bypassCsp(await webkit.launch())],
    ["Chrome", () => launchChrome()],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(appUrl);
      const result = await page.evaluate(async () => {
        const { codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
        if (!(await codecSupported("hvc1.1.6.L93.B0"))) return null;
        const canvas = document.createElement("canvas");
        canvas.width = 130;
        canvas.height = 66;
        canvas.getContext("2d").fillRect(10, 10, 100, 40);
        const attempt = async () => {
          try {
            return `saved ${(await encodeStill(canvas, "image/heic")).size} bytes`;
          } catch (error) {
            return String(error?.message);
          }
        };
        const healthy = await attempt();
        const decodes = await createImageBitmap(await encodeStill(canvas, "image/heic")).then(
          (bitmap) => (bitmap.close(), true),
          () => false,
        );
        // The decoder rejects the export, as it does a file it cannot parse.
        const decode = window.createImageBitmap;
        window.createImageBitmap = (source, ...rest) =>
          source instanceof Blob && source.type === "image/heic"
            ? Promise.reject(
                new DOMException("The source image could not be decoded.", "InvalidStateError"),
              )
            : decode(source, ...rest);
        let rejected;
        try {
          rejected = await attempt();
        } finally {
          window.createImageBitmap = decode;
        }
        // The muxed file becomes 32 bytes no decoder reads; the real decoder runs.
        const NativeBlob = window.Blob;
        window.Blob = class extends NativeBlob {
          constructor(parts, options) {
            super(options?.type === "image/heic" ? [new Uint8Array(32)] : parts, options);
          }
        };
        let corrupt;
        try {
          corrupt = await attempt();
        } finally {
          window.Blob = NativeBlob;
        }
        return { healthy, decodes, rejected, corrupt };
      });
      t.diagnostic(`${name}: ${JSON.stringify(result ?? "cannot encode HEIC here")}`);
      if (result) outcomes.push({ name, ...result });
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
  if (!outcomes.length) return t.skip("no browser here encodes HEIC");
  for (const { name, healthy, decodes, rejected, corrupt } of outcomes) {
    assert.match(healthy, /^saved/, `${name} exports HEIC normally`);
    if (decodes) {
      assert.match(rejected, /broken HEIC/, `${name} refuses an export its decoder rejects`);
    } else {
      // No HEIC decoder (Chrome, Firefox): a failed decode says nothing about the file.
      assert.match(rejected, /^saved/, `${name} saves HEIC it cannot check`);
    }
    assert.match(corrupt, /broken HEIC/, `${name} refuses corrupt bytes even without native HEIC`);
  }
  const webkitResult = outcomes.find((outcome) => outcome.name === "WebKit");
  if (process.platform === "darwin" && webkitResult)
    assert.equal(webkitResult.decodes, true, "WebKit on macOS decodes HEIC");
});

test("HEIC and opaque AVIF pass tiny/odd checks; nonconforming AVIF alpha is refused (S3-C-PLATFORM-01)", async (t) => {
  for (const [name, launch] of [
    ["Chrome", () => launchChrome()],
    ["WebKit", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(appUrl);
      const results = await page.evaluate(async () => {
        const { codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
        const results = [];
        for (const [mime, codec] of [
          ["image/heic", "hvc1.1.6.L93.B0"],
          ["image/avif", "av01.0.04M.08"],
        ]) {
          for (const [width, height] of [
            [7, 7],
            [8, 8],
            [9, 9],
            [15, 9],
            [129, 65],
            [401, 301],
          ])
            for (const fill of ["clear", "rgb(0,255,200)", "rgba(255,10,100,0.5)"]) {
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              const context = canvas.getContext("2d");
              if (fill !== "clear") {
                context.fillStyle = fill;
                context.fillRect(0, 0, width, height);
              }
              const label = `${mime} ${width}x${height} ${fill}`;
              const codedWidth = mime === "image/heic" ? width + (width % 2) : width;
              const codedHeight = mime === "image/heic" ? height + (height % 2) : height;
              const supported = await codecSupported(codec, codedWidth, codedHeight, 0.15);
              try {
                await encodeStill(canvas, mime, 0.15);
                results.push({ label, supported, ok: true });
              } catch (error) {
                results.push({
                  label,
                  supported,
                  error: String(error),
                  code: error.code,
                  cause: String(error?.cause),
                });
              }
            }
        }
        return results;
      });
      const failed = results.filter((result) => !result.ok);
      t.diagnostic(`${name}: ${results.length - failed.length}/${results.length} exports passed`);
      // Chrome cannot create a HEIC encoder for the tiniest of these sizes
      // (S3-C-PLATFORM-08); only a refusal by the check would be a false positive here.
      for (const result of failed) t.diagnostic(`${name} ${result.label}: ${result.error}`);
      assert.ok(
        results.some((result) => result.ok),
        `${name} exports something`,
      );
      for (const result of results) {
        if (!result.supported) {
          assert.equal(result.ok, undefined, `${name} refuses unsupported dimensions`);
          assert.equal(result.code, "export");
          assert.match(result.error, /(?:HEIC|AVIF).*dimensions.*PNG/);
          assert.match(result.cause, /does not support these output dimensions/);
        } else if (
          result.label.startsWith("image/avif") &&
          !result.label.endsWith("rgb(0,255,200)")
        )
          assert.equal(result.error, `CutoutError: ${transparentAvifMessage}`, result.label);
        else if (name === "Chrome" && /^image\/heic (7x7|8x8|9x9|15x9) /.test(result.label)) {
          assert.match(result.error, /HEIC.*dimensions.*PNG/);
          assert.match(result.cause, /Encoder creation|does not support these output dimensions/);
        } else assert.equal(result.ok, true, `${name} ${result.label}`);
      }
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
});

test("textured HEIC cutouts export at all search qualities; nonconforming AVIF is refused (S3-C-PLATFORM-01)", async (t) => {
  for (const [name, launch] of [
    ["Chrome", () => launchChrome()],
    ["WebKit", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(appUrl);
      const results = await page.evaluate(async () => {
        const { codecSupported, encodeStill } = await import("/src/lib/still-encode.ts");
        // A textured, feathered disc under a translucent tint: a photo cutout's opaque,
        // soft and clear areas, none of them flat in colour.
        const results = [];
        for (const [width, height] of [
          [640, 480],
          [129, 65],
          [1001, 750],
        ]) {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d");
          const image = context.createImageData(width, height);
          let seed = 11;
          const noise = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 64;
          const radius = Math.min(width, height) * 0.4;
          for (let y = 0; y < height; y += 1)
            for (let x = 0; x < width; x += 1) {
              const i = (y * width + x) * 4;
              const r = Math.hypot(x - width / 2, y - height / 2);
              const edge = Math.max(0, Math.min(1, (radius - r) / 12));
              image.data[i] = 150 + noise();
              image.data[i + 1] = 90 + noise();
              image.data[i + 2] = 40 + noise();
              image.data[i + 3] = y < height / 6 ? 96 : Math.round(edge * 255);
            }
          context.putImageData(image, 0, 0);
          for (const [mime, codec] of [
            ["image/avif", "av01.0.04M.08"],
            ["image/heic", "hvc1.1.6.L93.B0"],
          ]) {
            if (!(await codecSupported(codec))) continue;
            for (const quality of [0.15, 0.5, 0.92]) {
              const label = `${mime} ${width}x${height} q${quality}`;
              try {
                await encodeStill(canvas, mime, quality);
                results.push({ label, ok: true });
              } catch (error) {
                results.push({ label, error: String(error) });
              }
            }
          }
        }
        return results;
      });
      const failed = results.filter((result) => !result.ok);
      t.diagnostic(`${name}: ${results.length - failed.length}/${results.length} exports passed`);
      for (const result of results) {
        if (result.label.startsWith("image/avif"))
          assert.equal(result.error, `CutoutError: ${transparentAvifMessage}`, result.label);
        else assert.equal(result.ok, true, `${name} ${result.label}`);
      }
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
});
