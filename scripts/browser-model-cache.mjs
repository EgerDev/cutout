import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
import assert from "node:assert/strict";
import test from "node:test";
import { launchChrome } from "./chrome.mjs";
import { installFake } from "./fake-transformers.mjs";

const models = [
  ["birefnet", "BiRefNet lite", "studioludens/birefnet-lite-512"],
  ["swin2sr-x2", "Swin2SR ×2", "Xenova/swin2SR-lightweight-x2-64"],
  ["swin2sr-x4", "Swin2SR ×4", "Xenova/swin2SR-compressed-sr-x4-48"],
  ["depth", "Depth Anything V2 small", "onnx-community/depth-anything-v2-small"],
];
for (const [id, label] of models) {
  test(`clears only ${label} through the model settings dialog`, async () => {
    const browser = await launchChrome();
    try {
      const page = await browser.newPage();
      await page.goto(verifiedAppUrl);
      await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
      // Given native Cache API entries for every model, with independently known byte sizes.
      await page.evaluate(async (models) => {
        const cache = await caches.open("transformers-cache");
        for (const [, , slug] of models) {
          await cache.put(
            `https://huggingface.co/${slug}/resolve/main/config.json`,
            new Response(new Uint8Array(31)),
          );
          await cache.put(
            `https://huggingface.co/${slug}/resolve/main/model.onnx`,
            new Response(new Uint8Array(73), { headers: { "Content-Length": "73" } }),
          );
        }
      }, models);
      await page
        .getByRole("button", { name: "On-device models · download ahead", exact: true })
        .click();
      const clear = page.getByRole("button", { name: `Clear ${label}`, exact: true });
      await clear.waitFor();
      // When this model is cleared through the visible setting.
      await clear.click();
      await page.getByRole("button", { name: `Download ${label}`, exact: true }).waitFor();
      const entries = await page.evaluate(async () => {
        const { listModelCache } = await import("/src/lib/models.ts");
        return listModelCache();
      });
      // Then its native cache files are gone, while every other model is preserved.
      for (const entry of entries)
        assert.deepEqual(
          { files: entry.files, bytes: entry.cachedBytes },
          entry.id === id ? { files: 0, bytes: 0 } : { files: 2, bytes: 104 },
        );
    } finally {
      await browser.close();
    }
  });
}

test("Ask browser to keep them reports the actual storage-persistence decision", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(verifiedAppUrl);
    await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
    // Given the actual browser persistence API and model dialog.
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    const keep = page.getByRole("button", { name: "Ask browser to keep them", exact: true });
    await keep.waitFor();
    // When persistent storage is requested.
    await keep.click();
    const status = page.getByRole("status");
    await status.waitFor();
    const text = await status.textContent();
    const persisted = await page.evaluate(() => navigator.storage.persisted());
    // Then the reported branch agrees with the browser decision.
    assert.equal(text.includes("did not grant"), !persisted);
    assert.equal(await keep.count(), persisted ? 0 : 1);
  } finally {
    await browser.close();
  }
});

// C09: the remover's "Download" over the faked Transformers.js boundary (worker and page). It showed
// 0 % throughout and could not fail: "ready" with nothing downloaded.
async function downloadRemover(load) {
  const browser = await launchChrome();
  try {
    const context = await browser.newContext();
    const config = { load };
    await installFake(context, {
      deviceMemory: 8,
      adapter: false,
      page: config,
      worker: config,
      workerEnv: { deviceMemory: 8, adapter: false },
    });
    const page = await context.newPage();
    await page.goto(verifiedAppUrl);
    await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    return page;
  } catch (error) {
    await browser.close();
    throw error;
  }
}

test("C09: the remover's Download shows the model download's progress", async () => {
  // Half the weights arrive, then the download pauses for a moment.
  const page = await downloadRemover(`async (call) => {
    if (call.kind !== "model") return;
    call.progress({ status: "progress", file: call.file, progress: 50, loaded: 50, total: 100 });
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }`);
  try {
    const size = page.locator("li", { hasText: "BiRefNet lite" }).locator(".models-size");
    await page.waitForFunction(
      (element) => element.textContent === "50%",
      await size.elementHandle(),
      { timeout: 5000 },
    );
    await page
      .getByRole("button", { name: "Download BiRefNet lite", exact: true })
      .and(page.locator(":enabled"))
      .waitFor();
    assert.equal(await page.getByRole("status").count(), 0, "no failure note");
  } finally {
    await page.context().browser().close();
  }
});

test("C09: a failed remover Download says so instead of passing as ready", async () => {
  const page = await downloadRemover(`async (call) => {
    if (call.kind === "model") throw new Error("Failed to fetch");
  }`);
  try {
    const status = page.getByRole("status");
    await status.waitFor({ timeout: 5000 });
    const text = await status.textContent();
    assert.equal(
      text,
      "The local remover couldn’t start on this device. Check your connection and try again.",
    );
    assert.doesNotMatch(text, /Could not load birefnet|Failed to fetch/);
    assert.doesNotMatch(text, /ready/);
  } finally {
    await page.context().browser().close();
  }
});

test("C18: clear reports a snapshot truthfully when a concurrent cache write lands", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(verifiedAppUrl);
    await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
    await page.evaluate(async () => {
      const cache = await caches.open("transformers-cache");
      await cache.put(
        "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/config.json",
        new Response("config"),
      );
    });
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    await page.getByRole("button", { name: "Clear BiRefNet lite", exact: true }).waitFor();
    await page.evaluate(() => {
      const keys = Cache.prototype.keys;
      let armed = true;
      Cache.prototype.keys = async function (...args) {
        const snapshot = await keys.apply(this, args);
        if (armed) {
          armed = false;
          await this.put(
            "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/onnx/model.onnx",
            new Response("late weights"),
          );
        }
        return snapshot;
      };
    });
    await page.getByRole("button", { name: "Clear BiRefNet lite", exact: true }).click();
    await page.getByRole("status").waitFor();
    const message = await page.getByRole("status").textContent();
    const remaining = await page.evaluate(async () => {
      const { listModelCache } = await import("/src/lib/models.ts");
      return (await listModelCache()).find((m) => m.id === "birefnet");
    });
    assert.equal(
      remaining.files,
      1,
      "native Cache write after enumeration survives the snapshot clear",
    );
    assert.match(message, /currently cached/);
    assert.match(message, /Active downloads can save files again/);
  } finally {
    await browser.close();
  }
});

test("E03-02: an aborted model download uses cancelled copy", async () => {
  const page = await downloadRemover(`async (call) => {
    if (call.kind === "model") await new Promise(resolve => setTimeout(resolve, 3000));
  }`);
  try {
    await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(120, 80);
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, 120, 80);
      gradient.addColorStop(0, "#1357d5");
      gradient.addColorStop(0.5, "#f28b12");
      gradient.addColorStop(1, "#45b96b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 120, 80);
      const blob = await canvas.convertToBlob();
      await window.__cutoutTest.useWorkspace
        .getState()
        .receiveFiles([new File([blob], "preempt.png", { type: "image/png" })]);
    });
    await page.getByRole("status").waitFor();
    assert.equal(await page.getByRole("status").textContent(), "Stopped.");
    assert.doesNotMatch(await page.getByRole("dialog").innerText(), /Check your connection/);
  } finally {
    await page.context().browser().close();
  }
});

test("E02-G-07 / E06-06: the uncached remover shows the range for GPU, CPU and low-memory routes", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(verifiedAppUrl);
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    const row = page.locator("li", { hasText: "BiRefNet lite" });
    await row.getByRole("button", { name: "Download BiRefNet lite", exact: true }).waitFor();
    assert.equal(await row.locator(".models-size").textContent(), "about 90–192 MB");
  } finally {
    await browser.close();
  }
});

test("E03-02: Download all does not replace cancelled copy with connection advice", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.route("**/src/lib/models.ts*", (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.has("actual")) return route.continue();
      url.searchParams.set("actual", "1");
      return route.fulfill({
        contentType: "application/javascript",
        body: `
        export * from ${JSON.stringify(url.href)};
        export async function prepareModel() { throw new DOMException("The operation was aborted.", "AbortError"); }
      `,
      });
    });
    await page.goto(verifiedAppUrl);
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    await page.getByRole("button", { name: "Download all now", exact: true }).click();
    await page
      .getByRole("status")
      .getByText("Some models couldn’t be prepared. Try again.", { exact: true })
      .waitFor();
    assert.doesNotMatch(
      await page.getByRole("dialog").innerText(),
      /Check your connection|operation was aborted/,
    );
  } finally {
    await browser.close();
  }
});

// Real-model integrity rows are opt-in. The caller must hold the shared real-model lock and
// supply a persistent profile under its scratch directory. These load models, never corpus images.
const realIntegrity = process.env.RUN_REAL_MODELS === "1";
for (const realm of ["page", "worker"]) {
  for (const file of ["onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"]) {
    test(
      `P1 real integrity: ${realm} heals tampered ${file}`,
      { skip: !realIntegrity, timeout: 180_000 },
      async () => {
        const { launchChromeContext } = await import("./chrome.mjs");
        assert.ok(
          process.env.MODEL_CACHE_PROFILE,
          "MODEL_CACHE_PROFILE is required for real model rows",
        );
        const context = await launchChromeContext(process.env.MODEL_CACHE_PROFILE, {
          bypassCSP: true,
          args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
        });
        try {
          const page = await context.newPage();
          await page.goto(verifiedAppUrl);
          async function load() {
            return page.evaluate(async (realm) => {
              const source = `
              import { createRemovalEnginePool } from ${JSON.stringify(new URL("/src/lib/removal-model.ts", location.href).href)};
              import { classifyError } from ${JSON.stringify(new URL("/src/lib/errors.ts", location.href).href)};
              const pool = createRemovalEnginePool();
              async function load() {
                try {
                  await pool.use({ model: "birefnet", provider: "webgpu", context: ${JSON.stringify(realm)} }, {}, () => {});
                  return { ok: true };
                } catch (error) { return { ok: false, code: error.code, failure: classifyError(error) }; }
                finally { await pool.releaseAllIdle(); }
              }
            `;
              if (realm === "page") {
                const module = await import(
                  URL.createObjectURL(
                    new Blob([source + "export { load };"], { type: "text/javascript" }),
                  )
                );
                return module.load();
              }
              const { readEnv } = await import("/src/lib/device.ts");
              const { classifyError } = await import("/src/lib/errors.ts");
              return new Promise((resolve, reject) => {
                // Exercise the actual worker entry, including its canvas/runtime setup.
                const worker = new Worker(
                  new URL("/src/lib/removal-worker.ts?worker_file&type=module", location.href),
                  { type: "module" },
                );
                worker.onmessage = ({ data }) => {
                  if (data.type !== "done" && data.type !== "error") return;
                  worker.terminate();
                  if (data.type === "done") resolve({ ok: true });
                  else {
                    const error = Object.assign(new Error(data.message), {
                      name: data.name,
                      code: data.code,
                    });
                    resolve({
                      ok: false,
                      code: data.code,
                      detail: data.detail,
                      failure: classifyError(error),
                    });
                  }
                };
                worker.onerror = (error) => {
                  worker.terminate();
                  reject(new Error(error.message));
                };
                worker.postMessage({ type: "warmup", id: 1, env: readEnv() });
              });
            }, realm);
          }
          assert.deepEqual(await load(), { ok: true });
          const key = await page.evaluate(async (file) => {
            const cache = await caches.open("transformers-cache");
            const request = (await cache.keys()).find(
              (key) =>
                key.url.includes("/studioludens/birefnet-lite-512/") &&
                key.url.endsWith(`/${file}`),
            );
            if (!request) throw new Error(`No cached ${file}`);
            const response = await cache.match(request);
            const bytes = new Uint8Array(await response.arrayBuffer());
            // In-band mutation preserves the model's protobuf structure and the JSON's syntax.
            bytes[Math.floor(bytes.length * 0.7)] ^= 1;
            await cache.put(request, new Response(bytes, { headers: response.headers }));
            return request.url;
          }, file);
          let downloads = 0;
          context.on("request", (request) => {
            if (request.url() === key) downloads++;
          });
          assert.deepEqual(await load(), { ok: true });
          assert.equal(downloads, 1, "one fresh download after eviction");
          const intact = await page.evaluate(async (key) => {
            const response = await (await caches.open("transformers-cache")).match(key);
            const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
            return Array.from(new Uint8Array(digest), (byte) =>
              byte.toString(16).padStart(2, "0"),
            ).join("");
          }, key);
          const { REMOVAL_MODEL_SHA256 } = await import("../src/lib/removal-model-specs.ts");
          assert.equal(intact, REMOVAL_MODEL_SHA256.birefnet[file]);
        } finally {
          await context.close();
        }
      },
    );
  }
}

test(
  "P1 real integrity: a fresh tampered JSON fails once with actionable non-retryable copy",
  { skip: !realIntegrity, timeout: 180_000 },
  async () => {
    const { launchChromeContext } = await import("./chrome.mjs");
    const context = await launchChromeContext(process.env.MODEL_CACHE_PROFILE, { bypassCSP: true });
    try {
      const page = await context.newPage();
      await page.goto(verifiedAppUrl);
      const spec = {
        modelId: "studioludens/birefnet-lite-512",
        revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
      };
      const key = `https://huggingface.co/${spec.modelId}/resolve/${spec.revision}/preprocessor_config.json`;
      await page.evaluate(async (key) => {
        await (await caches.open("transformers-cache")).delete(key);
      }, key);
      let downloads = 0;
      await context.route(key, async (route) => {
        downloads++;
        await route.fulfill({
          contentType: "application/json",
          body: '{"image_processor_type":"ImageFeatureExtractor"}',
        });
      });
      const result = await page.evaluate(async () => {
        const { createRemovalEnginePool } = await import("/src/lib/removal-model.ts");
        const { classifyError } = await import("/src/lib/errors.ts");
        const pool = createRemovalEnginePool();
        try {
          await pool.use({ model: "birefnet", provider: "webgpu", context: "page" }, {}, () => {});
          return { unexpectedSuccess: true };
        } catch (error) {
          return { code: error.code, ...classifyError(error) };
        } finally {
          await pool.releaseAllIdle();
        }
      });
      assert.equal(result.code, "model");
      assert.equal(result.retryable, false);
      assert.match(result.message, /safety check.*reload/);
      assert.equal(downloads, 2, "first fetch and exactly one heal retry");
      assert.equal(
        await page.evaluate(
          async (key) => Boolean(await (await caches.open("transformers-cache")).match(key)),
          key,
        ),
        false,
      );
    } finally {
      await context.close();
    }
  },
);

for (const storage of ["disabled", "absent", "denied"]) {
  test(
    `P1 real integrity: ${storage} Cache Storage cannot bypass the download check`,
    { skip: !realIntegrity, timeout: 60_000 },
    async () => {
      const { launchChromeContext } = await import("./chrome.mjs");
      const context = await launchChromeContext(process.env.MODEL_CACHE_PROFILE, {
        bypassCSP: true,
      });
      try {
        await context.route(
          "**/studioludens/birefnet-lite-512/resolve/*/preprocessor_config.json",
          (route) =>
            route.fulfill({
              contentType: "application/json",
              body: '{"image_processor_type":"ImageFeatureExtractor"}',
            }),
        );
        const page = await context.newPage();
        await page.goto(verifiedAppUrl);
        const result = await page.evaluate(async (storage) => {
          const { transformers } = await import("/src/lib/transformers.ts");
          const { REMOVAL_MODELS } = await import("/src/lib/removal-model-specs.ts");
          const tf = transformers();
          tf.env.useBrowserCache = storage !== "disabled";
          if (storage === "absent")
            Object.defineProperty(globalThis, "caches", { value: undefined });
          if (storage === "denied")
            Object.defineProperty(globalThis, "caches", {
              get() {
                throw new DOMException("Denied", "SecurityError");
              },
            });
          try {
            const spec = REMOVAL_MODELS.birefnet;
            await tf.AutoProcessor.from_pretrained(spec.modelId, { revision: spec.revision });
            return "unexpected success";
          } catch (error) {
            return error.code;
          }
        }, storage);
        assert.equal(result, "removal-model-integrity");
      } finally {
        await context.close();
      }
    },
  );
}

test("P1 integrity: persistent failure shows its own copy after two loads in one worker", async () => {
  const page = await downloadRemover(`async (call) => {
    if (call.kind === "model") {
      const { RemovalModelIntegrityError } = await import(${JSON.stringify(new URL("/src/lib/removal-model-integrity.ts", `${verifiedAppUrl}/`).href)});
      throw new RemovalModelIntegrityError(call.file);
    }
  }`);
  try {
    await page.getByRole("status").waitFor({ timeout: 5000 });
    assert.match(await page.getByRole("status").textContent(), /safety check.*reload/);
    const { readFakeLog } = await import("./fake-transformers.mjs");
    const log = await readFakeLog(page);
    const loads = log.filter((event) => event.type === "from_pretrained" && event.kind === "model");
    assert.equal(loads.length, 2);
    assert.ok(loads.every((event) => event.ctx === "worker"));
    assert.equal(log.filter((event) => event.type === "worker-created").length, 1);
  } finally {
    await page.context().browser().close();
  }
});

test("S20: a cache read failure is explained and reopening the panel recovers", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(verifiedAppUrl);
    await page.evaluate(() => {
      const keys = Cache.prototype.keys;
      window.restoreCacheKeys = () => {
        Cache.prototype.keys = keys;
      };
      Cache.prototype.keys = async function () {
        throw new DOMException("Storage was evicted", "UnknownError");
      };
    });
    const open = page.getByRole("button", {
      name: "On-device models · download ahead",
      exact: true,
    });
    await open.click();
    await page
      .getByText("Model storage is unavailable. Try reopening this panel.", { exact: false })
      .waitFor();
    assert.equal(await page.getByText("Reading the cache…", { exact: true }).count(), 0);
    await page.evaluate(() => window.restoreCacheKeys());
    await page.keyboard.press("Escape");
    await open.click();
    await page.getByText("0 MB of models on this device", { exact: false }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("S20: unavailable storage estimates do not hide readable model files", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(verifiedAppUrl);
    await page.evaluate(async () => {
      const cache = await caches.open("transformers-cache");
      await cache.put(
        "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/config.json",
        new Response("{}"),
      );
      navigator.storage.estimate = async () => {
        throw new Error("Storage estimate unavailable");
      };
    });
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    await page.getByRole("button", { name: "Clear BiRefNet lite", exact: true }).waitFor();
    assert.equal(await page.getByText("Reading the cache…", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test("S20: a failed cache clear keeps the files and offers a working retry", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(verifiedAppUrl);
    await page.evaluate(async () => {
      const cache = await caches.open("transformers-cache");
      await cache.put(
        "https://huggingface.co/studioludens/birefnet-lite-512/resolve/main/config.json",
        new Response("{}"),
      );
      const remove = Cache.prototype.delete;
      Cache.prototype.delete = async function () {
        Cache.prototype.delete = remove;
        throw new DOMException("Storage backend unavailable", "UnknownError");
      };
    });
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    const clear = page.getByRole("button", { name: "Clear BiRefNet lite", exact: true });
    await clear.click();
    await page
      .getByRole("status")
      .getByText("Couldn’t clear the model files. Try again.", { exact: true })
      .waitFor();
    await clear.click();
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
