// Regression for overlapping asynchronous renderer attachments. Requires Vite dev.
// Exercises WebGPU where the browser has it and the WebGL2 fallback elsewhere (most Linux).
import assert from "node:assert/strict";
import nodeTest from "node:test";
import { appCandidates } from "./app-url.mjs";
import { launchChrome, tolerantTest } from "./chrome.mjs";

// A "WebKit …" test skips if Linux WPE WebKit crashes.
const test = tolerantTest(nodeTest, (name) => name.startsWith("WebKit "));
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

test("disposing a superseded renderer preserves the replacement canvas context", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:96px;height:96px";
      document.body.append(canvas);
      const bitmap = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(96 * 96 * 4).fill(255), 96, 96),
      );
      const [oldRenderer, currentRenderer] = await Promise.all([
        attachStageGpu(canvas),
        attachStageGpu(canvas),
      ]);
      const frame = {
        source: bitmap,
        result: bitmap,
        comparing: false,
        peeking: false,
        masking: false,
        wipe: 0.5,
      };
      oldRenderer?.destroy();
      const painted = currentRenderer?.paint(frame);
      const kind = currentRenderer?.kind;
      await new Promise(requestAnimationFrame);
      const data = canvas.toDataURL();
      currentRenderer?.destroy();
      bitmap.close();
      canvas.remove();
      return { kind, painted, encodedLength: data.length };
    });
    if (result.kind !== "webgpu")
      t.diagnostic(`no WebGPU here; checked the ${result.kind} renderer`);
    assert.ok(result.kind, "no stage renderer attached");
    assert.equal(result.painted, true);
    assert.ok(result.encodedLength > 100);
  } finally {
    await browser.close();
  }
});

test("a failed WebGPU resize upload recovers on the next healthy paint", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) return { kind: null };
      const errors = [];
      const request = GPUAdapter.prototype.requestDevice;
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await request.apply(this, args);
        device.addEventListener("uncapturederror", (event) => {
          errors.push(String(event.error?.message ?? event.error));
        });
        return device;
      };
      const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
      const mk = async (w, h) => {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        c.getContext("2d").fillRect(0, 0, w, h);
        return createImageBitmap(c);
      };
      const cases = [];
      for (const slot of ["source", "result"]) {
        for (const mode of ["create", "copy", "closed"]) {
          const canvas = document.createElement("canvas");
          canvas.style.cssText = "width:320px;height:240px";
          document.body.append(canvas);
          let invalidated = 0;
          const stage = await attachStageGpu(canvas, () => {
            invalidated += 1;
          });
          if (stage?.kind !== "webgpu") {
            stage?.destroy();
            canvas.remove();
            return { kind: stage?.kind ?? null };
          }
          const A = await mk(120, 90);
          const B = await mk(300, 200);
          const D = await mk(64, 48);
          const stable = await mk(12, 8);
          const frame = (bmp) => ({
            source: slot === "source" ? bmp : stable,
            result: slot === "result" ? bmp : null,
            comparing: false,
            peeking: false,
            masking: false,
            wipe: 0.5,
          });
          const origCreate = GPUDevice.prototype.createTexture;
          const origCopy = GPUQueue.prototype.copyExternalImageToTexture;
          const errorsBefore = errors.length;
          const first = stage.paint(frame(A));
          let failed;
          try {
            if (mode === "create") {
              let throws = 1;
              GPUDevice.prototype.createTexture = function (desc) {
                if (throws-- > 0)
                  throw new DOMException("injected upload failure", "OperationError");
                return origCreate.call(this, desc);
              };
            } else if (mode === "copy") {
              let throws = 1;
              GPUQueue.prototype.copyExternalImageToTexture = function (...args) {
                if (throws-- > 0)
                  throw new DOMException("The ImageBitmap is closed", "InvalidStateError");
                return origCopy.apply(this, args);
              };
            } else {
              B.close();
            }
            failed = stage.paint(frame(B));
          } finally {
            GPUDevice.prototype.createTexture = origCreate;
            GPUQueue.prototype.copyExternalImageToTexture = origCopy;
          }
          const recovered = stage.paint(frame(A));
          await new Promise((r) => setTimeout(r, 100));
          const afterRecoveryInvalidated = invalidated;
          const afterRecoveryErrors = errors.slice(errorsBefore);
          const later = stage.paint(frame(D));
          await new Promise((r) => setTimeout(r, 30));
          cases.push({
            slot,
            mode,
            first,
            failed,
            recovered,
            later,
            invalidated,
            afterRecoveryInvalidated,
            errors: afterRecoveryErrors.slice(0, 4),
          });
          stage.destroy();
          A.close();
          if (mode !== "closed") B.close();
          D.close();
          stable.close();
          canvas.remove();
        }
      }
      GPUAdapter.prototype.requestDevice = request;
      return { kind: "webgpu", cases };
    });
    if (result.kind !== "webgpu") {
      t.skip("WebGPU is not available in this browser");
      return;
    }
    assert.equal(result.cases.length, 6);
    for (const entry of result.cases) {
      const label = `${entry.slot} ${entry.mode}`;
      assert.equal(entry.first, true, `${label}: initial paint`);
      assert.equal(
        entry.failed,
        entry.mode === "closed",
        `${label}: closed inputs are absent; upload faults decline`,
      );
      assert.equal(entry.recovered, true, `${label}: exact previous identity must recover`);
      assert.equal(
        entry.afterRecoveryInvalidated,
        0,
        `${label}: identity retry must not invalidate`,
      );
      assert.equal(entry.later, true, `${label}: later healthy paint`);
      assert.equal(entry.invalidated, 0, `${label}: onInvalidate`);
      assert.deepEqual(entry.errors, [], `${label}: uncaptured GPU errors`);
    }
  } finally {
    await browser.close();
  }
});

test("manual compare declines mismatched tiles and recovers with the packed compositor", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const results = await page.evaluate(async () => {
      const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
      const make = (w, h, color) => {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, w, h);
        return canvas;
      };
      const A = make(32, 24, "red"),
        B = make(16, 12, "blue"),
        source = make(32, 24, "green");
      const results = [];
      const originalGet = HTMLCanvasElement.prototype.getContext;
      for (const backend of ["webgpu", "webgl2"]) {
        const canvas = make(32, 24, "black").cloneNode();
        canvas.style.cssText = "width:32px;height:24px";
        document.body.append(canvas);
        if (backend === "webgl2") {
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            return kind === "webgpu" ? null : originalGet.call(this, kind, ...args);
          };
        }
        const stage = await attachStageGpu(canvas, undefined, backend);
        if (stage?.kind !== backend) {
          stage?.destroy();
          canvas.remove();
          continue;
        }
        const frame = (result) => ({
          result,
          source,
          comparing: true,
          peeking: false,
          masking: false,
          wipe: 0.5,
        });
        const first = stage.paint(frame(A));
        HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
          if (kind === "2d") return null; // Valid drawable inputs; only packing is unavailable.
          return originalGet.call(this, kind, ...args);
        };
        const declined = stage.paint(frame(B));
        const previous = stage.paint(frame(A));
        HTMLCanvasElement.prototype.getContext = originalGet;
        const recovered = stage.paint(frame(B));
        results.push({ backend, first, declined, previous, recovered });
        stage.destroy();
        canvas.remove();
      }
      HTMLCanvasElement.prototype.getContext = originalGet;
      return results;
    });
    if (!results.some((r) => r.backend === "webgpu"))
      t.diagnostic("WebGPU unavailable; no WebGPU claim");
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.equal(r.first, true, r.backend);
      assert.equal(
        r.declined,
        false,
        `${r.backend}: use the existing DOM fallback instead of a misaligned atlas`,
      );
      assert.equal(r.previous, true, r.backend);
      assert.equal(r.recovered, true, r.backend);
    }
  } finally {
    await browser.close();
  }
});

test("manual WebGPU atlas faults release candidates and preserve exact identity retries", async (t) => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      if (!navigator.gpu) return { skip: true };
      const errors = [],
        created = [],
        live = new Set(),
        destroyed = new WeakSet(),
        badViews = [];
      const orig = {
        create: GPUDevice.prototype.createTexture,
        destroy: GPUTexture.prototype.destroy,
        view: GPUTexture.prototype.createView,
        get: HTMLCanvasElement.prototype.getContext,
        request: GPUAdapter.prototype.requestDevice,
      };
      GPUAdapter.prototype.requestDevice = async function (...args) {
        const device = await orig.request.apply(this, args);
        device.addEventListener("uncapturederror", (e) => errors.push(e.error.message));
        return device;
      };
      GPUDevice.prototype.createTexture = function (...args) {
        const tex = orig.create.apply(this, args);
        created.push(tex);
        live.add(tex);
        return tex;
      };
      GPUTexture.prototype.destroy = function () {
        live.delete(this);
        destroyed.add(this);
        return orig.destroy.call(this);
      };
      GPUTexture.prototype.createView = function (...args) {
        if (destroyed.has(this)) badViews.push("destroyed view");
        return orig.view.apply(this, args);
      };
      const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
      const make = async (size, color) => {
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, size, size);
        return createImageBitmap(c);
      };
      const cases = [];
      const faults = [
        [GPUDevice.prototype, "createTexture", 1],
        [GPUDevice.prototype, "createTexture", 2],
        [GPUDevice.prototype, "createTexture", 3],
        [GPUQueue.prototype, "copyExternalImageToTexture", 1],
        [GPUQueue.prototype, "copyExternalImageToTexture", 2],
        [GPUDevice.prototype, "createCommandEncoder", 1],
        [GPUCommandEncoder.prototype, "copyTextureToTexture", 1],
        [GPUCommandEncoder.prototype, "copyTextureToTexture", 2],
        [GPUCommandEncoder.prototype, "finish", 1],
        [GPUQueue.prototype, "submit", 1],
        [null, "closed-bitmap", 1],
      ];
      try {
        for (const [prototype, method, nth] of faults) {
          const canvas = document.createElement("canvas");
          canvas.style.cssText = "width:64px;height:64px";
          document.body.append(canvas);
          const stage = await attachStageGpu(canvas);
          if (stage?.kind !== "webgpu") {
            stage?.destroy();
            canvas.remove();
            return { skip: true, kind: stage?.kind };
          }
          const size = prototype ? 32 : 1;
          const A = await make(size, "red"),
            B = await make(size, "blue"),
            source = await make(size, "green"),
            D = await make(size, "orange");
          const frame = (result) => ({
            result,
            source,
            comparing: true,
            peeking: false,
            masking: false,
            wipe: 0.5,
          });
          const first = stage.paint(frame(A));
          const ownedBefore = [...live];
          if (!prototype) B.close();
          const original = prototype?.[method];
          let failed = true,
            noCandidates = true,
            previousLive = true;
          for (let repeat = 0; repeat < 2; repeat++) {
            const before = created.length;
            let remaining = nth;
            HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
              return kind === "2d" ? null : orig.get.call(this, kind, ...args);
            };
            if (prototype)
              prototype[method] = function (...args) {
                if (--remaining === 0)
                  throw new DOMException(`controlled ${method}`, "OperationError");
                return original.apply(this, args);
              };
            try {
              failed &&= stage.paint(frame(B)) === !prototype;
            } finally {
              if (prototype) prototype[method] = original;
              HTMLCanvasElement.prototype.getContext = orig.get;
            }
            noCandidates &&= created.slice(before).every((tex) => !live.has(tex));
            previousLive &&= !prototype || ownedBefore.every((tex) => live.has(tex));
          }
          const recovered = stage.paint(frame(A));
          await new Promise((resolve) => setTimeout(resolve, 40));
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            return kind === "2d" ? null : orig.get.call(this, kind, ...args);
          };
          const later = stage.paint(frame(D)); // Healthy native-copy fallback, including required texture usages.
          HTMLCanvasElement.prototype.getContext = orig.get;
          stage.destroy();
          cases.push({
            method,
            nth,
            first,
            failed,
            noCandidates,
            previousLive,
            recovered,
            later,
            liveAfterDestroy: live.size,
          });
          for (const bitmap of [A, source, D, ...(prototype ? [B] : [])]) bitmap.close();
          canvas.remove();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { cases, errors, badViews };
      } finally {
        GPUDevice.prototype.createTexture = orig.create;
        GPUTexture.prototype.destroy = orig.destroy;
        GPUTexture.prototype.createView = orig.view;
        GPUAdapter.prototype.requestDevice = orig.request;
        HTMLCanvasElement.prototype.getContext = orig.get;
      }
    });
    if (result.skip) {
      t.skip("WebGPU unavailable");
      return;
    }
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.cases.length, 11);
    for (const entry of result.cases) {
      const label = `${entry.method} ${entry.nth}`;
      for (const key of ["first", "failed", "noCandidates", "previousLive", "recovered", "later"])
        assert.equal(entry[key], true, `${label}: ${key}`);
      assert.equal(entry.liveAfterDestroy, 1, `${label}: only shared placeholder remains`);
    }
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.badViews, []);
  } finally {
    await browser.close();
  }
});

test("WebKit 2d restoration only reaches live attachments and listeners are released", async (t) => {
  const { webkit } = await import("playwright");
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({ bypassCSP: true });
    await page.goto(appUrl);
    const result = await page.evaluate(async () => {
      const { attachStageGpu } = await import("/src/lib/stage-gpu.ts");
      const canvas = document.createElement("canvas");
      canvas.style.cssText = "width:32px;height:24px";
      document.body.append(canvas);
      const get = canvas.getContext.bind(canvas);
      canvas.getContext = (kind, ...args) => (kind === "2d" ? get(kind, ...args) : null);
      const listeners = new Map();
      const add = canvas.addEventListener.bind(canvas),
        remove = canvas.removeEventListener.bind(canvas);
      canvas.addEventListener = (kind, fn, ...args) => {
        const set = listeners.get(kind) ?? new Set();
        set.add(fn);
        listeners.set(kind, set);
        add(kind, fn, ...args);
      };
      canvas.removeEventListener = (kind, fn, ...args) => {
        listeners.get(kind)?.delete(fn);
        remove(kind, fn, ...args);
      };
      const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
      const red = document.createElement("canvas");
      red.width = red.height = 1;
      red.getContext("2d").fillStyle = "#ff0000";
      red.getContext("2d").fillRect(0, 0, 1, 1);
      const frame = {
        result: red,
        comparing: false,
        peeking: false,
        masking: false,
        wipe: 0.5,
      };
      const old = await attachStageGpu(canvas, undefined, "2d");
      const initial = old?.paint(frame);
      old?.destroy();
      const afterOldDestroy = count();
      const active = await attachStageGpu(canvas, undefined, "2d");
      canvas.dispatchEvent(new Event("contextlost", { cancelable: true }));
      const lost = active?.paint(frame);
      canvas.dispatchEvent(new Event("contextrestored"));
      const restored = active?.paint(frame),
        stale = old?.paint(frame);
      old?.destroy();
      const afterStaleDestroy = count();
      const pixel = Array.from(get("2d").getImageData(16, 12, 1, 1).data);
      active?.destroy();
      const final = count();
      canvas.remove();
      return {
        kind: active?.kind,
        initial,
        afterOldDestroy,
        lost,
        restored,
        stale,
        afterStaleDestroy,
        final,
        pixel,
      };
    });
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.kind, "2d");
    assert.equal(result.initial, true);
    assert.equal(result.afterOldDestroy, 0);
    assert.equal(result.lost, false);
    assert.equal(result.restored, true);
    assert.equal(result.stale, false);
    assert.equal(result.afterStaleDestroy, 2);
    assert.equal(result.final, 0);
    assert.deepEqual(result.pixel, [255, 0, 0, 255]);
  } finally {
    await browser.close();
  }
});
