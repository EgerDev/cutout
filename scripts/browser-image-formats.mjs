import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import UTIF from "utif2";
import { flatTiff } from "../src/lib/fixtures/flat-tiff.ts";
import { paddedGif } from "../src/lib/fixtures/flat-gif.ts";
import { launchChrome } from "./chrome.mjs";

const appUrl = verifiedAppUrl;

test("HEIC ingest converts a real phone-style still to PNG", async () => {
  // Generated locally with macOS sips from a 128x64 red/green BMP fixture.
  const fixture =
    "AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABwm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5WlwcnAAAADEaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAACAAAAAQAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABwaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAiQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcI+Ie5FlU3AgIGAIKIAAQAJRAHAYXLIQFMkAAAAGWlwbWEAAAAAAAAAAQABBoECAwWGhAAAACxpbG9jAAAAAEQAAAIAAQAAAAEAAAJCAAAAOQACAAAAAQAAAfYAAABMAAAAAW1kYXQAAAAAAAAAlQAAAAZFeGlmAABNTQAqAAAACAADARoABQAAAAEAAAAyARsABQAAAAEAAAA6ASgAAwAAAAEAAgAAAAAAAAAAAEgAAAABAAAASAAAAAEAAAA1KAGvo09GxX//FPv/79JyHsHtjPlKiepXv/3p3/8gMn86Jn//Q1tf6eSv0EqAPm4HCZjiqPw=";
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async (fixture) => {
      const { toProcessableFile } = await import("/src/lib/files.ts");
      const bytes = Uint8Array.from(atob(fixture), (char) => char.charCodeAt(0));
      const file = await toProcessableFile(new File([bytes], "phone.heic", { type: "image/heic" }));
      const bitmap = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const result = {
        type: file.type,
        width: bitmap.width,
        height: bitmap.height,
        left: Array.from(context.getImageData(4, 8, 1, 1).data),
        right: Array.from(context.getImageData(100, 8, 1, 1).data),
      };
      bitmap.close();
      return result;
    }, fixture);
    assert.equal(result.type, "image/png");
    assert.equal(result.width, 128);
    assert.equal(result.height, 64);
    assert.ok(result.left[0] > 230 && result.left[1] < 25 && result.left[3] === 255);
    assert.ok(result.right[1] > 230 && result.right[0] < 25 && result.right[3] === 255);
  } finally {
    await browser.close();
  }
});

test("TIFF conversion preserves all eight orientations", async () => {
  const colors = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
    [255, 255, 0, 255],
    [0, 255, 255, 255],
    [255, 0, 255, 255],
  ];
  const pixels = new Uint8Array(colors.flat());
  const fixtures = Array.from({ length: 8 }, (_, index) => ({
    orientation: index + 1,
    bytes: Array.from(new Uint8Array(UTIF.encodeImage(pixels, 2, 3, { t274: [index + 1] }))),
  }));
  const expectedOrders = [
    [0, 1, 2, 3, 4, 5],
    [1, 0, 3, 2, 5, 4],
    [5, 4, 3, 2, 1, 0],
    [4, 5, 2, 3, 0, 1],
    [0, 2, 4, 1, 3, 5],
    [4, 2, 0, 5, 3, 1],
    [5, 3, 1, 4, 2, 0],
    [1, 3, 5, 0, 2, 4],
  ];
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(async (fixtures) => {
      const { toProcessableFile, rasterizeSvgFile } = await import("/src/lib/files.ts");
      const results = [];
      for (const { bytes } of fixtures) {
        const file = await toProcessableFile(
          await rasterizeSvgFile(
            new File([new Uint8Array(bytes)], "scan.tif", { type: "image/tiff" }),
          ),
        );
        const bitmap = await createImageBitmap(file);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        results.push({
          width: bitmap.width,
          height: bitmap.height,
          pixels: Array.from(context.getImageData(0, 0, bitmap.width, bitmap.height).data),
        });
        bitmap.close();
      }
      return results;
    }, fixtures);
    for (const [index, result] of results.entries()) {
      assert.deepEqual(
        result,
        {
          width: index >= 4 ? 3 : 2,
          height: index >= 4 ? 2 : 3,
          pixels: expectedOrders[index].flatMap((color) => colors[color]),
        },
        `TIFF orientation ${index + 1}`,
      );
    }
  } finally {
    await browser.close();
  }
});

test("PNG, JPEG, WebP and GIF ingest preserve their raster dimensions", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(async () => {
      const { toProcessableFile } = await import("/src/lib/files.ts");
      const canvas = document.createElement("canvas");
      canvas.width = 4;
      canvas.height = 3;
      const context = canvas.getContext("2d");
      context.fillStyle = "red";
      context.fillRect(0, 0, 2, 3);
      const results = [];
      for (const [mime, name] of [
        ["image/png", "a.png"],
        ["image/jpeg", "a.jpg"],
        ["image/webp", "a.webp"],
      ]) {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime));
        const file = await toProcessableFile(new File([blob], name));
        const bitmap = await createImageBitmap(file);
        context.clearRect(0, 0, 4, 3);
        context.drawImage(bitmap, 0, 0);
        results.push({
          type: file.type,
          width: bitmap.width,
          height: bitmap.height,
          alpha: context.getImageData(3, 0, 1, 1).data[3],
        });
        bitmap.close();
        context.clearRect(0, 0, 4, 3);
        context.fillRect(0, 0, 2, 3);
      }
      const gif = Uint8Array.from(
        atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
        (c) => c.charCodeAt(0),
      );
      const file = await toProcessableFile(new File([gif], "a.gif", { type: "image/gif" }));
      const bitmap = await createImageBitmap(file);
      results.push({ type: file.type, width: bitmap.width, height: bitmap.height });
      bitmap.close();
      return results;
    });
    assert.deepEqual(results, [
      { type: "image/png", width: 4, height: 3, alpha: 0 },
      { type: "image/jpeg", width: 4, height: 3, alpha: 255 },
      { type: "image/webp", width: 4, height: 3, alpha: 0 },
      { type: "image/png", width: 1, height: 1 },
    ]);
  } finally {
    await browser.close();
  }
});

/** A flat grey PNG declaring width x height: a few hundred KB however large it claims to be. */
async function flatPng(width, height) {
  const row = Buffer.alloc(width + 1, 0xc8);
  row[0] = 0;
  const deflate = zlib.createDeflate({ level: 9 });
  const parts = [];
  deflate.on("data", (part) => parts.push(part));
  const done = new Promise((resolve) => deflate.on("end", resolve));
  for (let y = 0; y < height; y++) deflate.write(row);
  deflate.end();
  await done;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit greyscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", Buffer.concat(parts)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const format of ["PNG", "TIFF"])
  test(`a small ${format} declaring 16384 x 16384 is refused before any decoder runs; compatible control still loads`, async () => {
    const tiff = format === "TIFF";
    const type = tiff ? "image/tiff" : "image/png";
    const ext = tiff ? "tif" : "png";
    const bomb = await (tiff ? flatTiff(16384, 16384) : flatPng(16384, 16384));
    const over = await (tiff ? flatTiff(16, 8) : flatPng(10000, 10000));
    assert.ok(bomb.length < 400_000, `${bomb.length} bytes`);
    const browser = await launchChrome();
    try {
      const page = await browser.newPage();
      await page.goto(`${appUrl}/?e2e`);
      await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
      const result = await page.evaluate(
        async ({ bomb, over, type, ext }) => {
          // Observe every source boundary. Guards count regressions without allocating 268 MP.
          const refusedBoundaries = [];
          const decoded = [];
          const urls = new Set();
          const blocked = new WeakSet();
          const forbidden = (source) => source instanceof Blob && source.size === bomb.length;
          const mint = URL.createObjectURL;
          URL.createObjectURL = (blob) => {
            const url = mint.call(URL, blob);
            if (forbidden(blob)) {
              urls.add(url);
              refusedBoundaries.push("objectURL");
            }
            return url;
          };
          const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
          const setImage = function (value) {
            if (urls.has(value)) {
              blocked.add(this);
              refusedBoundaries.push("img.src");
              return;
            }
            src.set.call(this, value);
          };
          Object.defineProperty(HTMLImageElement.prototype, "src", { ...src, set: setImage });
          const attribute = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function (name, value) {
            if (
              this instanceof HTMLImageElement &&
              name.toLowerCase() === "src" &&
              urls.has(value)
            ) {
              blocked.add(this);
              refusedBoundaries.push("img.setAttribute");
              return;
            }
            return attribute.call(this, name, value);
          };
          const imageDecode = HTMLImageElement.prototype.decode;
          HTMLImageElement.prototype.decode = function () {
            if (blocked.has(this) || urls.has(this.src)) {
              refusedBoundaries.push("img.decode");
              return Promise.reject(new Error("counted decode"));
            }
            return imageDecode.call(this);
          };
          for (const prototype of [
            CanvasRenderingContext2D.prototype,
            OffscreenCanvasRenderingContext2D.prototype,
          ]) {
            const draw = prototype.drawImage;
            prototype.drawImage = function (source, ...args) {
              if (
                blocked.has(source) ||
                (source instanceof HTMLImageElement && urls.has(source.src))
              ) {
                refusedBoundaries.push("drawImage");
                return;
              }
              return draw.call(this, source, ...args);
            };
          }
          const post = Worker.prototype.postMessage;
          Worker.prototype.postMessage = function (message, ...args) {
            if (forbidden(message?.file) || message?.buffer?.byteLength === bomb.length) {
              refusedBoundaries.push("worker.postMessage");
              return;
            }
            return post.call(this, message, ...args);
          };
          const decode = window.createImageBitmap;
          window.createImageBitmap = (source, ...rest) => {
            if (source instanceof Blob) decoded.push(source.size);
            if (forbidden(source)) {
              refusedBoundaries.push("createImageBitmap");
              return Promise.reject(new Error("counted decode"));
            }
            return decode.call(window, source, ...rest);
          };
          const store = window.__cutoutTest.useWorkspace;
          const load = async (bytes, name, ready) => {
            store.getState().receiveFiles([new File([new Uint8Array(bytes)], name, { type })]);
            for (let i = 0; i < 600; i++) {
              const item = store.getState().items[0];
              if (store.getState().errorMessage || (item?.name === name && ready(item))) break;
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            const item = store.getState().items[0];
            return {
              items: store.getState().items.length,
              error: store.getState().errorMessage ?? item?.error ?? null,
              preview: Boolean(item?.preview),
            };
          };
          const refused = await load(bomb, `flat.${ext}`, (item) => item.status === "error");
          await new Promise((resolve) => setTimeout(resolve, 500));
          const bombDecodes = decoded.filter((size) => size === bomb.length).length;
          store.setState({ errorMessage: null });
          const kept = await load(over, `over.${ext}`, (item) => item.preview);
          const overDecodes = decoded.filter((size) => size === over.length).length;
          store.setState({ errorMessage: null });
          store
            .getState()
            .setBackgroundImage(new File([new Uint8Array(bomb)], `background.${ext}`, { type }));
          for (let i = 0; i < 100 && !store.getState().errorMessage; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
          const backgroundError = store.getState().errorMessage;
          const { resumeWorkspace } = await import("/src/lib/workspace-lifecycle.ts");
          const canvas = new OffscreenCanvas(2, 2);
          canvas.getContext("2d").fillRect(0, 0, 2, 2);
          const safe = await canvas.convertToBlob({ type: "image/png" });
          const settings = store.getState().settings[store.getState().activeId];
          const oversized = new File([new Uint8Array(bomb)], `oversized.${ext}`, { type });
          await resumeWorkspace(
            {
              version: 2,
              savedAt: Date.now(),
              activeIndex: 1,
              items: [
                {
                  name: "oversized.png",
                  source: oversized,
                  result: null,
                  width: 16384,
                  height: 16384,
                  settings,
                },
                {
                  name: "safe.png",
                  source: safe,
                  result: safe,
                  width: 2,
                  height: 2,
                  settings: {
                    ...settings,
                    backgroundBlob: oversized,
                    backgroundImageUrl: null,
                    background: { type: "image", url: "" },
                  },
                },
              ],
            },
            store,
          );
          const state = store.getState();
          const restored = {
            names: state.items.map((item) => item.name),
            background: state.settings[state.activeId].backgroundImageUrl,
          };
          window.createImageBitmap = decode;
          return {
            refused,
            refusedBoundaries,
            bombDecodes,
            kept,
            overDecodes,
            backgroundError,
            restored,
          };
        },
        { bomb: [...bomb], over: [...over], type, ext },
      );
      console.log(`C38 ${format} source boundaries`, JSON.stringify(result));
      assert.deepEqual(result.refusedBoundaries, [], "refused source reached a decode boundary");
      assert.deepEqual(result.refused, {
        items: 0,
        error: "This image is too large for this device. Try a smaller photo.",
        preview: false,
      });
      assert.equal(result.bombDecodes, 0, "neither the preview nor the remover decoded 268 MP");
      // 100 MP is over the 96 MP budget but under twice it: previewed, then scaled to fit.
      assert.equal(result.kept.preview, true);
      assert.notEqual(result.kept.error, result.refused.error);
      if (!tiff) assert.ok(result.overDecodes >= 1);
      assert.equal(result.backgroundError, result.refused.error);
      assert.deepEqual(result.restored, { names: ["safe.png"], background: null });
    } finally {
      await browser.close();
    }
  });

test("BMP export decodes with its colors and partial transparency", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { encodeBmp } = await import("/src/lib/bmp.ts");
      const file = encodeBmp(new Uint8ClampedArray([200, 100, 50, 128, 40, 50, 60, 255]), 2, 1);
      const bitmap = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      return Array.from(context.getImageData(0, 0, 2, 1).data);
    });
    // Canvas premultiplication can round partial-alpha colors by one level.
    for (const [index, expected] of [200, 100, 50, 128, 40, 50, 60, 255].entries()) {
      assert.ok(Math.abs(result[index] - expected) <= 1, `channel ${index}: ${result[index]}`);
    }
  } finally {
    await browser.close();
  }
});

test("SVG without a MIME type converts to PNG with dimensions and alpha intact", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { toProcessableFile } = await import("/src/lib/files.ts");
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="1"><rect width="1" height="1" fill="red"/></svg>';
      const file = await toProcessableFile(new File([svg], "drawing.SVG"));
      const bitmap = await createImageBitmap(file);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const result = {
        type: file.type,
        width: bitmap.width,
        height: bitmap.height,
        pixels: Array.from(context.getImageData(0, 0, 2, 1).data),
      };
      bitmap.close();
      return result;
    });
    assert.deepEqual(result, {
      type: "image/png",
      width: 2,
      height: 1,
      pixels: [255, 0, 0, 255, 0, 0, 0, 0],
    });
  } finally {
    await browser.close();
  }
});

test("padded GIF is valid and its hidden large frame is refused by helper and worker", async () => {
  const small = paddedGif(16, 8);
  const padded = paddedGif();
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(
      async ({ small, padded }) => {
        const { bitmapFromBlob, imageSizeOf } = await import("/src/lib/decode-bitmap.ts");
        // The same real LZW generator is validated by a native decode at a safe size.
        const control = await createImageBitmap(
          new Blob([new Uint8Array(small)], { type: "image/gif" }),
        );
        const controlSize = [control.width, control.height];
        control.close();
        const file = new File([new Uint8Array(padded)], "padded.gif", { type: "image/gif" });
        let decodes = 0;
        const native = window.createImageBitmap;
        window.createImageBitmap = () => {
          decodes++;
          return Promise.reject(new Error("counted decode"));
        };
        const size = await imageSizeOf(file);
        let helper;
        try {
          await bitmapFromBlob(file, { pixels: 24_000_000, side: 16384 });
        } catch (error) {
          helper = { code: error.code, message: error.message };
        }
        // A wrapper installs the guard before loading the actual decode worker, even on a regression.
        const wrapper = URL.createObjectURL(
          new Blob(
            [
              `
        self.createImageBitmap = async () => { self.postMessage({ countedDecode: true }); throw new Error("counted decode"); };
        await import(${JSON.stringify(new URL("/src/lib/decode-worker.ts", location.href).href)});
        self.postMessage({ ready: true });
      `,
            ],
            { type: "text/javascript" },
          ),
        );
        const worker = new Worker(wrapper, { type: "module" });
        let workerDecodes = 0;
        const reply = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("worker timeout")), 10000);
          worker.onerror = (error) => {
            clearTimeout(timer);
            reject(new Error(error.message));
          };
          worker.onmessage = ({ data }) => {
            if (data.countedDecode) workerDecodes++;
            else if (data.ready)
              worker.postMessage({
                id: 1,
                file,
                type: file.type,
                maxPixels: 24_000_000,
                maxSide: 16384,
              });
            else {
              clearTimeout(timer);
              resolve(data);
            }
          };
        }).finally(() => {
          worker.terminate();
          URL.revokeObjectURL(wrapper);
          window.createImageBitmap = native;
        });
        return { controlSize, size, helper, decodes, workerDecodes, reply };
      },
      { small: [...small], padded: [...padded] },
    );
    console.log("C38 padded GIF", JSON.stringify(result));
    assert.deepEqual(result.controlSize, [16, 8]);
    assert.deepEqual(result.size, { width: 10000, height: 10000 });
    assert.equal(result.helper.code, "memory");
    assert.match(result.helper.message, /too large/);
    assert.equal(result.reply.error, "memory");
    assert.match(result.reply.message, /too large/);
    assert.equal(result.decodes, 0);
    assert.equal(result.workerDecodes, 0);
  } finally {
    await browser.close();
  }
});
