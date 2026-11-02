import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
let browser, page;
beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage();
  await page.goto(verifiedAppUrl);
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  await page.evaluate(async (base) => {
    // Vite app imports can carry HMR versions; importing a plain URL creates a second cache.
    const loaded = performance
      .getEntriesByType("resource")
      .find((entry) => new URL(entry.name).pathname === "/src/lib/editor/canvas.ts");
    window.cache = await import(loaded?.name ?? `${base}/src/lib/editor/canvas.ts`);
    window.file = async (name, width = 32, height = 32) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "black";
      ctx.fillRect(width / 4, height / 4, width / 2, height / 2);
      return new File([await new Promise((resolve) => c.toBlob(resolve))], name, {
        type: "image/png",
      });
    };
  }, process.env.MODULE_URL ?? verifiedAppUrl);
});
afterEach(async () => {
  await browser?.close();
});

test("released preview closes when another image replaces it", async () => {
  // Given a real decoded preview whose caller has finished.
  const result = await page.evaluate(async () => {
    const first = await window.cache.sourceBitmap(await window.file("first.png"), 32, 32);
    first.release?.();
    // When another file becomes the cached preview.
    const second = await window.cache.sourceBitmap(await window.file("second.png"), 32, 32);
    const widths = [first.bitmap.width, second.bitmap.width];
    second.release?.();
    return widths;
  });
  // Then only the active cache entry remains drawable.
  assert.deepEqual(result, [0, 32]);
});

test("cache reset closes its last idle preview", async () => {
  const width = await page.evaluate(async () => {
    // Given an idle active preview.
    const lease = await window.cache.sourceBitmap(await window.file("last.png"), 32, 32);
    lease.release?.();
    // When the workspace releases its source window.cache.
    window.cache.clearSourceBitmapCache?.();
    // Then the native bitmap has been closed.
    return lease.bitmap.width;
  });
  assert.equal(width, 0);
});

test("two overlapping callers keep an evicted preview until both release", async () => {
  const widths = await page.evaluate(async () => {
    // Given two callers sharing one bitmap.
    const source = await window.file("shared.png");
    const [a, b] = await Promise.all([
      window.cache.sourceBitmap(source, 32, 32),
      window.cache.sourceBitmap(source, 32, 32),
    ]);
    const same = a.bitmap === b.bitmap;
    // When reset retires it and the callers finish in sequence.
    window.cache.clearSourceBitmapCache?.();
    const active = a.bitmap.width;
    a.release?.();
    a.release?.();
    const one = b.bitmap.width;
    b.release?.();
    return { same, active, one, final: b.bitmap.width };
  });
  // Then retirement is safe and repeated release cannot steal another caller's lease.
  assert.deepEqual(widths, { same: true, active: 32, one: 32, final: 0 });
});

test("superseded pending decode stays usable for its caller and closes after release", async () => {
  const report = await page.evaluate(async () => {
    // Given a decode suspended before the native bitmap is returned.
    const a = await window.file("pending.png"),
      b = await window.file("next.png");
    const native = window.createImageBitmap.bind(window);
    let unblock, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    window.createImageBitmap = async (...args) => {
      if (args[0] === a) {
        started();
        await gate;
      }
      return native(...args);
    };
    const pending = window.cache.sourceBitmap(a, 32, 32);
    await entered;
    // When another request replaces its slot before decode completion.
    const next = await window.cache.sourceBitmap(b, 32, 32);
    next.release?.();
    unblock();
    const old = await pending;
    const usable = old.bitmap.width;
    old.release?.();
    window.createImageBitmap = native;
    return { usable, closed: old.bitmap.width, current: next.bitmap.width };
  });
  // Then the stale decode has no leaked ownership and the new cache survives.
  assert.deepEqual(report, { usable: 32, closed: 0, current: 32 });
});

test("failed preview decode permits retrying the same file", async () => {
  const report = await page.evaluate(async () => {
    // Given a single decode error for an otherwise valid real PNG.
    const source = await window.file("retry.png"),
      native = window.createImageBitmap.bind(window);
    let attempts = 0;
    window.createImageBitmap = (...args) => {
      if (args[0] === source && ++attempts === 1)
        return Promise.reject(new DOMException("Decode failed", "InvalidStateError"));
      return native(...args);
    };
    let error;
    try {
      await window.cache.sourceBitmap(source, 32, 32);
    } catch (e) {
      error = e.name;
    }
    // When the user retries the same source.
    const lease = await window.cache.sourceBitmap(source, 32, 32);
    const width = lease.bitmap.width;
    lease.release?.();
    window.cache.clearSourceBitmapCache?.();
    window.createImageBitmap = native;
    return { error, attempts, width, closed: lease.bitmap.width };
  });
  assert.deepEqual(report, { error: "InvalidStateError", attempts: 2, width: 32, closed: 0 });
});

test("full resolution fallback releases its own bitmap independently of the preview", async () => {
  const report = await page.evaluate(async () => {
    // Given a wide source whose preview height cannot cover this request.
    const source = await window.file("wide.png", 2000, 100);
    const preview = await window.cache.sourceBitmap(source, 1600, 80);
    preview.release?.();
    // When a taller request requires the full image.
    const full = await window.cache.sourceBitmap(source, 100, 100);
    full.release?.();
    full.release?.();
    const result = { fullClosed: full.bitmap.width, previewWidth: preview.bitmap.width };
    window.cache.clearSourceBitmapCache?.();
    return { ...result, previewClosed: preview.bitmap.width };
  });
  assert.deepEqual(report, { fullClosed: 0, previewWidth: 1600, previewClosed: 0 });
});

test("render and brush consumers release every source lease on completion", async () => {
  const report = await page.evaluate(async () => {
    // Given real source pixels shared with a preview window.cache.
    const { renderCanvas } = await import("/src/lib/editor/render.ts");
    const { defaults } = await import("/src/lib/editor/model.ts");
    const source = await window.file("consumer.png");
    const result = source;
    const preview = await window.cache.sourceBitmap(source, 32, 32);
    preview.release();
    // When all original-source rendering paths finish.
    for (const mode of ["overlay", "composite"]) {
      const canvas = await renderCanvas(
        {
          result,
          source,
          settings: { ...defaults, background: { type: "blur" }, blurDepth: false },
        },
        { mode },
      );
      canvas.width = 0;
      canvas.height = 0;
    }
    const output = await window.cache.brushBlob(result, source, [
      { mode: "restore", size: 0.25, points: [{ x: 0.5, y: 0.5 }] },
    ]);
    const before = preview.bitmap.width;
    window.cache.clearSourceBitmapCache();
    const decoded = await createImageBitmap(output);
    const width = decoded.width;
    decoded.close();
    return { before, closed: preview.bitmap.width, width };
  });
  // Then no completed consumer pins the cached native bitmap.
  assert.deepEqual(report, { before: 32, closed: 0, width: 32 });
});

test("reset during a pending decode keeps the caller safe then releases the bitmap", async () => {
  const report = await page.evaluate(async () => {
    // Given a pending native decode whose caller is still waiting.
    const source = await window.file("reset-pending.png"),
      native = window.createImageBitmap.bind(window);
    let unblock, started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    window.createImageBitmap = async (...args) => {
      if (args[0] === source) {
        started();
        await gate;
      }
      return native(...args);
    };
    const pending = window.cache.sourceBitmap(source, 32, 32);
    await entered;
    // When reset retires the cache before decoding completes.
    window.cache.clearSourceBitmapCache();
    unblock();
    const lease = await pending;
    const drawable = lease.bitmap.width;
    lease.release();
    window.createImageBitmap = native;
    return { drawable, closed: lease.bitmap.width };
  });
  assert.deepEqual(report, { drawable: 32, closed: 0 });
});

for (const action of ["reset", "replacement", "selection", "deletion"]) {
  test(`workspace ${action} releases its idle source preview`, async () => {
    // Given two completed fixtures in the real workspace store.
    await page.evaluate(async () => {
      const { defaults } = await import("/src/lib/editor/model.ts");
      const sources = [await window.file("first.png"), await window.file("second.png")];
      const items = sources.map((source, index) => ({
        id: `cache-${index}`,
        name: source.name,
        source,
        sourceUrl: URL.createObjectURL(source),
        preview: null,
        resultBlob: source,
        resultUrl: URL.createObjectURL(source),
        width: 32,
        height: 32,
        status: "done",
      }));
      window.__cutoutTest?.useWorkspace.setState({
        items,
        activeId: items[0].id,
        phase: "result",
        settings: Object.fromEntries(items.map((item) => [item.id, defaults])),
      });
    });
    const width = await page.evaluate(async (action) => {
      const state = window.__cutoutTest?.useWorkspace.getState();
      const active = state.items.find((item) => item.id === state.activeId);
      const lease = await window.cache.sourceBitmap(active.source, 32, 32);
      lease.release();
      // When the actual workspace lifecycle action retires this source.
      if (action === "reset") state.reset();
      if (action === "replacement") {
        const file = await window.file("replacement.png");
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            unsubscribe();
            reject(new Error("Replacement timed out"));
          }, 5000);
          const unsubscribe = window.__cutoutTest.useWorkspace.subscribe((next) => {
            if (next.items.some((item) => item.source === file)) {
              clearTimeout(timer);
              unsubscribe();
              resolve();
            }
          });
          state.receiveFiles([file]);
        });
      }
      if (action === "selection")
        state.selectItem(state.items.find((item) => item.id !== active.id).id);
      if (action === "deletion") state.removeItem(active.id);
      // Then the former idle cache entry is closed once the lifecycle action completes.
      return lease.bitmap.width;
    }, action);
    assert.equal(width, 0);
  });
}

test("brush releases its source lease when a restore canvas cannot be allocated", async () => {
  const report = await page.evaluate(async () => {
    // Given a cached source and a browser unable to allocate the second 2D canvas.
    const source = await window.file("allocation.png");
    const lease = await window.cache.sourceBitmap(source, 32, 32);
    lease.release();
    const native = HTMLCanvasElement.prototype.getContext;
    let calls = 0,
      error;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (args[0] === "2d" && ++calls === 2) return null;
      return native.apply(this, args);
    };
    // When brush replay fails while preparing its restore plate.
    try {
      await window.cache.brushBlob(source, source, [
        { mode: "restore", size: 0.25, points: [{ x: 0.5, y: 0.5 }] },
      ]);
    } catch (e) {
      error = e.message;
    } finally {
      HTMLCanvasElement.prototype.getContext = native;
    }
    window.cache.clearSourceBitmapCache();
    // Then the error propagates and failed replay cannot pin its bitmap lease.
    return { failed: Boolean(error), closed: lease.bitmap.width };
  });
  assert.deepEqual(report, { failed: true, closed: 0 });
});
