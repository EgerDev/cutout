// Requires Vite dev, like browser-stage-lifecycle.mjs. Synthetic graphics only;
// model/runtime requests are blocked, including requests from workers.
import assert from "node:assert/strict";
import test from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
async function open(t) {
  const browser = await launchChrome();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on("dialog", (d) => void d.accept());
  await page.context().route(/huggingface\.co|\.onnx|ort-wasm|transformers/i, (r) => r.abort());
  await page.addInitScript(() => {
    const made = new Set(),
      closed = new Map(),
      invalid = [];
    window.previewAccounting = { made, closed, invalid };
    const create = window.createImageBitmap,
      close = ImageBitmap.prototype.close;
    window.createImageBitmap = async (...args) => {
      const b = await create(...args);
      made.add(b);
      return b;
    };
    ImageBitmap.prototype.close = function () {
      closed.set(this, (closed.get(this) ?? 0) + 1);
      return close.call(this);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image, ...args) {
      if (image instanceof ImageBitmap && !image.width)
        invalid.push(new Error("closed draw").stack);
      return draw.call(this, image, ...args);
    };
  });
  await page.goto(e2eUrl(appUrl));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  return page;
}
async function upload(page, name, count = 1) {
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 96;
    const x = c.getContext("2d");
    x.fillStyle = "white";
    x.fillRect(0, 0, 96, 96);
    x.fillStyle = "black";
    x.fillRect(24, 24, 48, 48);
    return c.toDataURL().split(",")[1];
  });
  await page
    .getByLabel("Choose files", { exact: true })
    .setInputFiles(
      Array.from({ length: count }, (_, i) => ({
        name: `${name}-${i}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      })),
    );
  await page.waitForFunction((n) => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return (
      s.items.length > 0 &&
      s.items.every((i) => i.name.startsWith(n) && i.status === "done") &&
      s.items[0].preview &&
      !s.previewBusy &&
      s.previewBitmap
    );
  }, name);
}
async function accounting(page) {
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().reset());
  await page.waitForFunction(() => {
    const a = window.previewAccounting;
    return [...a.made].every((b) => b.width === 0);
  });
  return page.evaluate(() => {
    const a = window.previewAccounting;
    return {
      created: a.made.size,
      closed: [...a.closed.values()].reduce((n, v) => n + v, 0),
      double: [...a.closed.values()].filter((v) => v !== 1).length,
      invalid: a.invalid,
    };
  });
}

for (const slot of ["item", "editor"])
  test(`rapid replacement survives Suspense replay of the retired ${slot} preview`, async (t) => {
    const page = await open(t);
    await upload(page, "first");
    await page.evaluate(async (slot) => {
      const { default: React } = await import("/node_modules/.vite/deps/react.js");
      const { createRoot } = (await import("/node_modules/.vite/deps/react-dom_client.js")).default;
      const { flushSync } = (await import("/node_modules/.vite/deps/react-dom.js")).default;
      const { Stage } = await import("/src/features/workspace/stage.tsx");
      const s = window.__cutoutTest.useWorkspace.getState();
      const bitmap = slot === "item" ? s.items[0].preview : s.previewBitmap;
      // Keep the DOM painter visible. Only this fixture's GPU canvas is unavailable.
      const get = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
        if (this.closest("#stale-preview") && this.hasAttribute("aria-hidden")) return null;
        return get.call(this, kind, ...args);
      };
      const host = document.createElement("div");
      host.id = "stale-preview";
      document.body.append(host);
      const failures = [];
      class Boundary extends React.Component {
        state = { failed: false };
        static getDerivedStateFromError() {
          return { failed: true };
        }
        componentDidCatch(e) {
          failures.push(e.stack);
        }
        render() {
          return this.state.failed ? "stale painter failed" : this.props.children;
        }
      }
      let blocked = false,
        release;
      const pending = new Promise((r) => {
        release = r;
      });
      const Gate = () => {
        if (blocked) throw pending;
        return null;
      };
      const stage = React.createElement(Stage, {
        preview: slot === "item" ? bitmap : null,
        resultBitmap: slot === "editor" ? bitmap : null,
        width: 96,
        height: 96,
        comparing: false,
        peeking: false,
      });
      const root = createRoot(host);
      const tree = () =>
        React.createElement(
          Boundary,
          null,
          React.createElement(
            React.Suspense,
            { fallback: React.createElement("span", { id: "held-preview" }, "held") },
            stage,
            React.createElement(Gate),
          ),
        );
      flushSync(() => root.render(tree()));
      flushSync(() => {
        blocked = true;
        root.render(tree());
      });
      window.stalePreview = {
        bitmap,
        failures,
        reveal() {
          flushSync(() => {
            blocked = false;
            release();
            root.render(tree());
          });
        },
        dispose() {
          root.unmount();
          host.remove();
          HTMLCanvasElement.prototype.getContext = get;
        },
      };
    }, slot);
    await page.locator("#held-preview").waitFor();
    await upload(page, "next");
    assert.equal(
      await page.evaluate(() => window.stalePreview.bitmap.width),
      0,
      "hidden bitmap retired before replay",
    );
    await page.evaluate(() => window.stalePreview.reveal());
    await page.locator("#held-preview").waitFor({ state: "hidden" });
    const failures = await page.evaluate(() => window.stalePreview.failures);
    t.diagnostic(JSON.stringify({ slot, failures }));
    assert.deepEqual(failures, [], "a hidden subtree may replay stale props after any delay");
    assert.equal(await page.getByText("Something went wrong", { exact: true }).count(), 0);
    await page.evaluate(() => window.stalePreview.dispose());
    const counts = await accounting(page);
    t.diagnostic(JSON.stringify(counts));
    assert.equal(counts.created, counts.closed);
    assert.equal(counts.double, 0);
    assert.deepEqual(counts.invalid, []);
  });

test("switch, retry, mask, remove, clear and rapid uploads release all preview bitmaps", async (t) => {
  const page = await open(t);
  for (let i = 0; i < 4; i++) {
    await upload(page, `batch-${i}`, 2);
    await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      s.selectItem(s.items[1].id);
    });
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().previewBitmap);
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setInspectMode("mask"));
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().previewUrl);
    await page.evaluate(() =>
      window.__cutoutTest.useWorkspace.getState().setInspectMode("composite"),
    );
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().previewBitmap);
    await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      s.reprocessItem(s.activeId);
    });
    await page.waitForFunction(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      return s.items.every((i) => i.status === "done") && s.previewBitmap;
    });
    await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      s.removeItem(s.activeId);
    });
  }
  const counts = await accounting(page);
  t.diagnostic(JSON.stringify(counts));
  assert.ok(counts.created >= 20);
  assert.equal(counts.created, counts.closed);
  assert.equal(counts.double, 0);
  assert.deepEqual(counts.invalid, []);
  assert.equal(await page.getByText("Something went wrong", { exact: true }).count(), 0);
});

test("all stage backends paint closed inputs exactly as absent and recover without demotion", async (t) => {
  const page = await open(t);
  const results = await page.evaluate(async () => {
    const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
    const make = async (color) => {
      const c = document.createElement("canvas");
      c.width = 32;
      c.height = 24;
      const x = c.getContext("2d");
      x.fillStyle = color;
      x.fillRect(0, 0, 32, 24);
      return createImageBitmap(c);
    };
    const results = [];
    for (const backend of ["webgpu", "webgl2", "2d"]) {
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:32px;height:24px";
      document.body.append(canvas);
      const stage = await attachStageGpu(canvas, undefined, backend);
      if (!stage) {
        results.push({ backend, unavailable: true });
        canvas.remove();
        continue;
      }
      const source = await make("red"),
        result = await make("blue"),
        retired = await make("green");
      const frame = { source, result, comparing: false, peeking: false, masking: false, wipe: 0.5 };
      const snapshot = async () => {
        const copy = document.createElement("canvas");
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext("2d");
        ctx.drawImage(canvas, 0, 0);
        return Array.from(ctx.getImageData(0, 0, copy.width, copy.height).data);
      };
      const cases = [],
        healthyHashes = [];
      for (const mode of ["normal", "compare", "peek", "mask"]) {
        stage.paint({
          ...frame,
          comparing: mode === "compare",
          peeking: mode === "peek",
          masking: mode === "mask",
        });
        const pixels = new Uint8Array(await snapshot());
        const hash = await crypto.subtle.digest("SHA-256", pixels);
        healthyHashes.push({
          mode,
          sha256: Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(""),
        });
      }
      for (const slot of ["source", "result"])
        for (const mode of ["normal", "compare", "peek", "mask"]) {
          const f = {
            ...frame,
            comparing: mode === "compare",
            peeking: mode === "peek",
            masking: mode === "mask",
          };
          // Exercise both a newly closed upload and a closed cached identity.
          const b = retired.width ? retired : await make("green");
          stage.paint({ ...f, [slot]: b });
          b.close();
          const ok = stage.paint({ ...f, [slot]: b });
          const closed = await snapshot();
          const absentOk = stage.paint({ ...f, [slot]: null });
          const absent = await snapshot();
          const recovered = stage.paint(f);
          cases.push({
            slot,
            mode,
            ok,
            absentOk,
            recovered,
            equal: JSON.stringify(closed) === JSON.stringify(absent),
          });
        }
      stage.destroy();
      source.close();
      result.close();
      canvas.remove();
      results.push({ backend, healthyHashes, cases });
    }
    return results;
  });
  t.diagnostic(JSON.stringify(results));
  assert.ok(results.some((r) => !r.unavailable), "at least one stage backend is available");
  for (const r of results)
    for (const c of r.cases ?? [])
      assert.deepEqual(
        [c.ok, c.absentOk, c.recovered, c.equal],
        [true, true, true, true],
        `${r.backend} ${c.slot} ${c.mode}`,
      );
});
