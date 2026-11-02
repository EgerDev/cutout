import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { webkit } from "playwright";
import { launchChrome, bypassCsp, webkitCrashed } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";

const appUrl = await requireCutout(appCandidates(process.env.DEV_URL ?? "http://127.0.0.1:8080/"));
const moduleRoot = process.env.PIXELS_MODULE_ROOT ?? "/src/lib";

async function decoded(page, bytes, width, height) {
  return page.evaluate(
    async ({ bytes, width, height }) => {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data];
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
        .map((v) => v.toString(16).padStart(2, "0"))
        .join("");
      bitmap.close();
      return {
        width: canvas.width,
        height: canvas.height,
        last: at(width - 1, Math.floor(height / 2)),
        bottom: at(Math.floor(width / 2), height - 1),
        hash,
      };
    },
    { bytes, width, height },
  );
}

for (const selected of [0, 1])
  test(`${selected === 0 ? "Chrome" : "WebKit"} opaque AVIF without auxiliary items preserves edges across native decoders (S3-C-PLATFORM-07)`, async (t) => {
    const chrome = await launchChrome();
    const apple = bypassCsp(await webkit.launch());
    const dir = await mkdtemp(join(tmpdir(), "cutout-pixels-"));
    const rows = [];
    try {
      const pages = await Promise.all([chrome.newPage(), apple.newPage()]);
      await Promise.all(pages.map((page) => page.goto(appUrl)));
      for (const [encoder, page] of pages.entries()) {
        if (encoder !== selected) continue;
        for (const [width, height] of [
          [1001, 750],
          [129, 65],
          [128, 64],
          [65, 64],
          [64, 65],
          [1, 17],
          [17, 1],
          [1, 1],
        ]) {
          const encoded = await page.evaluate(
            async ({ root, width, height }) => {
              const { codecSupported, encodeStill } = await import(`${root}/still-encode.ts`);
              const canvas = document.createElement("canvas");
              canvas.width = width;
              canvas.height = height;
              const ctx = canvas.getContext("2d");
              ctx.fillStyle = "rgb(80,180,220)";
              ctx.fillRect(0, 0, width, height);
              const supported = await codecSupported("av01.0.04M.08", width, height);
              let file;
              try {
                file = await encodeStill(canvas, "image/avif");
              } catch (error) {
                return {
                  supported,
                  error: error.message,
                  code: error.code,
                  cause: String(error.cause),
                };
              }
              const bytes = new Uint8Array(await file.arrayBuffer());
              const text = new TextDecoder().decode(bytes);
              if (text.includes("auxC") || text.includes("auxl"))
                throw new Error("opaque AVIF unexpectedly has an auxiliary item");
              return { supported, bytes: [...bytes] };
            },
            { root: moduleRoot, width, height },
          );
          if (encoded.error) {
            t.diagnostic(JSON.stringify({ encoder, width, height, ...encoded }));
            assert.equal(encoded.supported, false, "supported dimensions must encode");
            assert.equal(encoded.code, "export");
            assert.equal(
              encoded.error,
              `This browser couldn’t encode AVIF at ${width} × ${height}. Try different export dimensions or choose PNG.`,
            );
            assert.match(encoded.cause, /does not support these output dimensions/);
            continue;
          }
          assert.equal(encoded.supported, true);
          const bytes = encoded.bytes;
          for (const [decoder, target] of pages.entries()) {
            rows.push({
              encoder,
              decoder,
              expected: [width, height],
              width,
              height,
              ...(await decoded(target, bytes, width, height)),
            });
          }
          if (process.platform === "darwin") {
            const path = join(dir, `${encoder}-${width}x${height}.avif`);
            await writeFile(path, new Uint8Array(bytes));
            execFileSync("sips", ["-s", "format", "png", path, "--out", `${path}.png`], {
              stdio: "pipe",
            });
            rows.push({
              encoder,
              decoder: "ImageIO",
              expected: [width, height],
              width,
              height,
              ...(await decoded(pages[0], [...(await readFile(`${path}.png`))], width, height)),
            });
          }
        }
      }
      for (const row of rows) t.diagnostic(JSON.stringify(row));
      for (const row of rows) {
        assert.deepEqual([row.width, row.height], row.expected);
        assert.equal(row.last[3] >= 250, true, `last column ${JSON.stringify(row)}`);
        assert.equal(row.bottom[3] >= 250, true, `last row ${JSON.stringify(row)}`);
        for (const pixel of [row.last, row.bottom])
          for (const [i, expected] of [80, 180, 220].entries()) {
            assert.ok(Math.abs(pixel[i] - expected) <= 12, `edge colour ${JSON.stringify(row)}`);
          }
      }
    } catch (error) {
      if (selected !== 1 || !webkitCrashed(error)) throw error;
      return t.skip("Linux WPE WebKit crashed (recorded environment limit)");
    } finally {
      await chrome.close();
      await apple.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("native HEIC small/extreme sizes either encode or report dimensions and retain the failure (S3-C-PLATFORM-08)", async (t) => {
  for (const [name, launch] of [
    ["Chrome", launchChrome],
    ["WebKit", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      await page.goto(appUrl);
      const rows = await page.evaluate(async (root) => {
        const { codecSupported, encodeStill } = await import(`${root}/still-encode.ts`);
        const rows = [];
        for (const [width, height] of [
          [1, 1],
          [8, 8],
          [12, 12],
          [16, 16],
          [32, 8],
          [64, 1],
          [1, 64],
          [64, 64],
          [129, 65],
        ]) {
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "rgb(80,180,220)";
          ctx.fillRect(0, 0, width, height);
          const supported = await codecSupported(
            "hvc1.1.6.L93.B0",
            width + (width % 2),
            height + (height % 2),
          );
          try {
            const blob = await encodeStill(canvas, "image/heic");
            rows.push({ width, height, supported, bytes: blob.size });
          } catch (error) {
            rows.push({
              width,
              height,
              supported,
              message: error.message,
              code: error.code,
              cause: String(error.cause),
            });
          }
        }
        return rows;
      }, moduleRoot);
      for (const row of rows) {
        t.diagnostic(JSON.stringify({ browser: name, ...row }));
        if (row.message) {
          assert.equal(row.code, "export");
          assert.match(row.message, /HEIC.*dimensions.*PNG/);
          assert.ok(row.message.includes(`${row.width} × ${row.height}`));
          assert.ok(row.cause && row.cause !== "undefined");
        } else assert.ok(row.bytes > 0);
      }
      const control = rows.find((row) => row.width === 64 && row.height === 64);
      if (control.supported) assert.ok(control.bytes, "healthy supported 64x64 control");
      else {
        assert.equal(control.code, "export");
        assert.match(control.cause, /does not support these output dimensions/);
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

test("workspace refuses blank/corrupt exports with specific UI copy and no download or saved mark", async (t) => {
  for (const [name, format, launch] of [
    ["Chrome", "avif", launchChrome],
    ["WebKit", "heic", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      let downloads = 0;
      page.on("download", () => {
        downloads++;
      });
      await page.goto(new URL("?e2e", appUrl).href);
      await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
      await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 194;
        canvas.height = 98;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "rgb(200,30,60)";
        ctx.fillRect(0, 0, 194, 98);
        const png = await new Promise((resolve) => canvas.toBlob(resolve));
        const source = new File([png], "pixels.png", { type: "image/png" });
        const url = URL.createObjectURL(png);
        window.__cutoutTest.useWorkspace.setState({
          phase: "result",
          activeId: "pixels",
          saved: false,
          errorMessage: null,
          items: [
            {
              id: "pixels",
              name: source.name,
              source,
              sourceUrl: url,
              resultBlob: png,
              resultUrl: url,
              preview: null,
              width: 194,
              height: 98,
              status: "done",
            },
          ],
        });
        window.showSaveFilePicker = undefined;
      });
      // Prime HEIC's independent capability probe, and prove a real download first.
      const healthy = page.waitForEvent("download");
      await page.evaluate(
        (format) => window.__cutoutTest.useWorkspace.getState().downloadActive(format),
        format,
      );
      await healthy;
      assert.equal(downloads, 1);
      for (const fault of ["blank", "corrupt"]) {
        const result = await page.evaluate(
          async ({ format, fault }) => {
            const store = window.__cutoutTest.useWorkspace;
            store.setState({ saved: false, errorMessage: null });
            const realBitmap = window.createImageBitmap,
              RealBlob = window.Blob;
            if (fault === "blank")
              window.createImageBitmap = async (blob, ...rest) => {
                if (blob instanceof Blob && blob.type === `image/${format}`) {
                  const blank = new OffscreenCanvas(194, 98);
                  return realBitmap(blank);
                }
                return realBitmap(blob, ...rest);
              };
            else
              window.Blob = class extends RealBlob {
                constructor(parts, options) {
                  super(
                    options?.type === `image/${format}` ? [new Uint8Array(32)] : parts,
                    options,
                  );
                }
              };
            try {
              await store.getState().downloadActive(format);
              const { saved, errorMessage, exporting } = store.getState();
              return { saved, errorMessage, exporting };
            } finally {
              window.createImageBitmap = realBitmap;
              window.Blob = RealBlob;
            }
          },
          { format, fault },
        );
        t.diagnostic(JSON.stringify({ browser: name, fault, ...result }));
        assert.equal(
          result.errorMessage,
          `This browser wrote a broken ${format.toUpperCase()} file. Choose PNG.`,
        );
        assert.equal(result.saved, false);
        assert.equal(result.exporting, false);
        await page.getByText(result.errorMessage, { exact: true }).first().waitFor();
        assert.equal(downloads, 1, "refused exports produce no additional download");
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

test("a real failed capability import is safe for shared callers without claiming browser cache recovery (FINISH-03)", async (t) => {
  for (const [name, launch] of [
    ["Chrome", launchChrome],
    ["WebKit", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const errors = [];
      let requests = 0;
      page.on("pageerror", (error) => errors.push(String(error)));
      await page.route("**/caps-probe", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Capability probe</title>",
        }),
      );
      await page.route(/\/still-encode\.ts(?:\?.*)?$/, (route) => {
        requests++;
        return route.abort("failed");
      });
      await page.goto(new URL("caps-probe", appUrl).href);
      const result = await page.evaluate(async (root) => {
        const { prepareExportCaps, exportCaps } = await import(`${root}/composite.ts`);
        const first = prepareExportCaps(),
          second = prepareExportCaps();
        const values = await Promise.all([first, second.then((caps) => caps)]);
        const retry = prepareExportCaps();
        await retry;
        return {
          shared: first === second,
          retryIsNew: retry !== first,
          values,
          caps: exportCaps(),
        };
      }, moduleRoot);
      await page.unroute(/\/still-encode\.ts(?:\?.*)?$/);
      const afterNetworkRestored = await page.evaluate(
        async (root) => (await import(`${root}/composite.ts`)).prepareExportCaps(),
        moduleRoot,
      );
      await page.waitForTimeout(50);
      t.diagnostic(
        JSON.stringify({ browser: name, requests, result, afterNetworkRestored, errors }),
      );
      assert.equal(result.shared, true);
      assert.equal(result.retryIsNew, true);
      assert.equal(result.values[0].avif, false);
      assert.equal(result.values[0].heic, false);
      assert.deepEqual(errors, []);
      // The same module URL can remain failed in the browser's module map. Recovery of
      // the app-owned promise is tested above; this is deliberately no network-retry assertion.
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
});

test("workspace contains native AVIF transparency before Blob/download/share and keeps PNG copy", async (t) => {
  for (const [name, launch] of [
    ["Chrome", launchChrome],
    ["WebKit", async () => bypassCsp(await webkit.launch())],
  ]) {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      let downloads = 0;
      page.on("download", () => downloads++);
      await page.goto(new URL("?e2e", appUrl).href);
      await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
      const rows = await page.evaluate(async () => {
        const store = window.__cutoutTest.useWorkspace;
        const { codecSupported } = await import("/src/lib/still-encode.ts");
        const rows = [];
        let shares = 0;
        Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
        Object.defineProperty(navigator, "share", {
          configurable: true,
          value: async () => {
            shares++;
          },
        });
        window.showSaveFilePicker = undefined;
        const ua = navigator.userAgent;
        for (const [width, height] of [
          [1001, 750],
          [129, 65],
          [128, 64],
          [65, 64],
          [64, 65],
          [1, 17],
          [17, 1],
          [1, 1],
        ]) {
          const supported = await codecSupported("av01.0.04M.08", width, height);
          for (const pattern of ["clear", "half", "last-pixel-254", "last-pixel-clear"]) {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = pattern === "half" ? "rgba(255,255,255,0.5)" : "rgb(80,180,220)";
            if (pattern !== "clear") ctx.fillRect(0, 0, width, height);
            if (pattern.startsWith("last-pixel")) {
              const pixel = ctx.createImageData(1, 1);
              pixel.data.set([80, 180, 220, pattern.endsWith("254") ? 254 : 0]);
              ctx.putImageData(pixel, width - 1, height - 1);
            }
            const blob = await new Promise((resolve) => canvas.toBlob(resolve));
            const source = new File([blob], "alpha.png", { type: "image/png" });
            const url = URL.createObjectURL(blob);
            const item = {
              id: "alpha",
              name: source.name,
              source,
              sourceUrl: url,
              resultBlob: blob,
              resultUrl: url,
              preview: null,
              width,
              height,
              status: "done",
            };
            for (const viaShare of [false, true]) {
              // Exercise the existing share route; encoder acceptance never consults a UA.
              Object.defineProperty(navigator, "userAgent", {
                configurable: true,
                value: viaShare ? "iPhone" : ua,
              });
              store.setState({
                phase: "result",
                activeId: item.id,
                items: [item],
                settings: {},
                saved: false,
                copied: false,
                errorMessage: null,
                exporting: false,
              });
              store.getState().changeEdit({ exportFormat: "avif", stripMetadata: false });
              let avifBlobs = 0;
              const RealBlob = window.Blob;
              window.Blob = class extends RealBlob {
                constructor(parts, options) {
                  super(parts, options);
                  if (options?.type === "image/avif") avifBlobs++;
                }
              };
              try {
                await store.getState().downloadActive("avif");
                const { saved, errorMessage, exporting } = store.getState();
                rows.push({
                  width,
                  height,
                  supported,
                  pattern,
                  viaShare,
                  saved,
                  errorMessage,
                  exporting,
                  avifBlobs,
                  shares,
                });
              } finally {
                window.Blob = RealBlob;
              }
            }
            URL.revokeObjectURL(url);
          }
        }
        // Copy intentionally renders PNG even when AVIF is selected. Observe that real
        // encode promise without writing to the host clipboard or opening a share sheet.
        Object.defineProperty(navigator, "userAgent", { configurable: true, value: ua });
        window.ClipboardItem = class {
          constructor(data) {
            this.data = data;
          }
          getType(type) {
            return this.data[type];
          }
        };
        let copiedPng;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            write: async (items) => {
              const png = await items[0].getType("image/png");
              const bitmap = await createImageBitmap(png);
              const c = new OffscreenCanvas(bitmap.width, bitmap.height),
                ctx = c.getContext("2d");
              ctx.drawImage(bitmap, 0, 0);
              bitmap.close();
              copiedPng = {
                type: png.type,
                size: [c.width, c.height],
                alpha: ctx.getImageData(0, 0, 1, 1).data[3],
              };
            },
          },
        });
        store.setState({ saved: false, errorMessage: null });
        await store.getState().copyActive();
        const { saved, copied, copying, errorMessage } = store.getState();
        return { rows, copy: { saved, copied, copying, errorMessage, png: copiedPng }, shares };
      });
      for (const row of rows.rows) {
        t.diagnostic(JSON.stringify({ browser: name, ...row }));
        assert.equal(
          row.errorMessage,
          row.supported
            ? "This browser cannot preserve transparency in AVIF. Choose PNG."
            : `This browser couldn’t encode AVIF at ${row.width} × ${row.height}. Try different export dimensions or choose PNG.`,
        );
        assert.equal(row.saved, false);
        assert.equal(row.exporting, false);
        assert.equal(row.avifBlobs, 0);
        assert.equal(row.shares, 0);
      }
      assert.equal(rows.rows.length, 64);
      assert.equal(downloads, 0);
      assert.equal(rows.shares, 0);
      assert.deepEqual(rows.copy, {
        saved: false,
        copied: true,
        copying: false,
        errorMessage: null,
        png: { type: "image/png", size: [1, 1], alpha: 0 },
      });
    } catch (error) {
      if (name !== "WebKit" || !webkitCrashed(error)) throw error;
      t.diagnostic("WebKit leg skipped: Linux WPE WebKit crashed (recorded environment limit)");
      continue;
    } finally {
      await browser.close();
    }
  }
});
