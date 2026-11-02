// S7 unit test for the browser fake boundary (scripts/fake-transformers.mjs) and the static shape of
// the two retargeted browser scripts. Node only: no browser, no server, no model.
//   PATH=/usr/local/bin:$PATH node --test <this file>
// Lives in scripts/ so `npm run test:unit` catches drift between this fake and the real removal adapter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
// ESM import() needs a file:// URL for Windows absolute paths; ROOT stays a fs path.
const ROOT_URL = new URL("../", import.meta.url);
const fakeModule = () => import(new URL("./fake-transformers.mjs", import.meta.url).href);

let evaluations = 0;
/** Evaluates a fresh copy of the generated fake module in Node, as a page or as a worker. */
async function loadFake(config = {}, ctx = "page") {
  const fake = await fakeModule();
  const log = [];
  globalThis.__fakeTf = log;
  if (ctx === "worker") globalThis.WorkerGlobalScope = class {};
  else delete globalThis.WorkerGlobalScope;
  const body = `${fake.transformersFake(config)}\n//# nonce ${++evaluations}`;
  const tf = await import(`data:text/javascript;base64,${Buffer.from(body).toString("base64")}`);
  return { tf, log, fake };
}

/** Mirrors removal-model.ts defaultFactories, over the fake instead of Transformers.js. */
async function poolFor(tf) {
  const { createRemovalEnginePool, REMOVAL_MODELS } = await import(new URL("src/lib/removal-model.ts", ROOT_URL).href);
  const { removalProgressEvent } = await import(new URL("src/lib/removal-model-specs.ts", ROOT_URL).href);
  const pool = createRemovalEnginePool({
    loadProcessor: (model, progress) =>
      tf.AutoProcessor.from_pretrained(REMOVAL_MODELS[model].modelId, {
        revision: REMOVAL_MODELS[model].revision,
        progress_callback: (event) => progress(removalProgressEvent(event)),
      }),
    loadModel: (model, provider, progress) =>
      tf.AutoModel.from_pretrained(REMOVAL_MODELS[model].modelId, {
        revision: REMOVAL_MODELS[model].revision,
        device: provider,
        dtype: REMOVAL_MODELS[model].routes[provider].dtype,
        progress_callback: (event) => progress(removalProgressEvent(event)),
      }),
  });
  return pool;
}
const request = (model, provider) => ({ model, provider, context: "page" });
const types = (log, type) => log.filter((event) => event.type === type);
const rawImage = (tf, width = 120, height = 80) =>
  new tf.RawImage(new Uint8ClampedArray(width * height * 4), width, height, 4);

test("module exports the builders and helpers the browser scripts import", async () => {
  const fake = await fakeModule();
  for (const name of [
    "transformersFake",
    "workerPrelude",
    "eventLogInit",
    "pageEnvInit",
    "fixtureInit",
    "installFake",
    "readFakeLog",
    "runInterceptionSmoke",
    "sortLog",
    "select",
    "liveModels",
    "TRANSFORMERS_ROUTE",
    "WORKER_ROUTE",
  ])
    assert.ok(name in fake, `missing export ${name}`);
  assert.equal(fake.TRANSFORMERS_ROUTE, "**/node_modules/.vite/deps/@huggingface_transformers.js*");
  assert.equal(fake.WORKER_ROUTE, "**/src/lib/removal-worker.ts*");
  for (const build of [fake.eventLogInit, fake.fixtureInit, fake.workerPrelude, fake.pageEnvInit])
    assert.doesNotThrow(() => new vm.Script(build({ deviceMemory: 8 })), build.name);
});

test("the fake exposes only what Cutout uses and logs module-loaded", async () => {
  const { tf, log } = await loadFake();
  assert.deepEqual(Object.keys(tf).sort(), ["AutoModel", "AutoProcessor", "RawImage", "env"]);
  assert.equal(tf.env.useBrowserCache, false);
  assert.equal(typeof tf.env.remoteHost, "string");
  assert.deepEqual(tf.env.backends.onnx.wasm, {});
  const loaded = types(log, "module-loaded");
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].ctx, "page");
  const image = rawImage(tf, 12, 7);
  assert.deepEqual([image.width, image.height, image.channels], [12, 7, 4]);
});

test("BiRefNet on WASM passes the real adapter's tensor and name checks, with counted disposal", async () => {
  const { tf, log } = await loadFake();
  const pool = await poolFor(tf);
  const progress = [];
  await pool.use(request("birefnet", "wasm"), { onProgress: (event) => progress.push(event) }, async (engine) => {
    assert.equal(engine.provider, "wasm");
    const processed = await engine.processor(rawImage(tf));
    assert.deepEqual(processed.pixel_values.dims, [1, 3, 512, 512]);
    const output = await engine.model({ input_image: processed.pixel_values });
    assert.deepEqual(output.output_image.dims, [1, 1, 512, 512]);
    assert.equal(output.output_image.data.length, 512 * 512);
    assert.equal(output.output_image.data[0], 20, "default BiRefNet output is a raw logit");
    processed.pixel_values.dispose();
    output.output_image.dispose();
  });
  const pulls = types(log, "from_pretrained");
  assert.deepEqual(
    pulls.map((event) => [event.kind, event.model, event.device ?? null, event.dtype ?? null, event.file]),
    [
      ["processor", "birefnet", null, null, "preprocessor_config.json"],
      ["model", "birefnet", "wasm", "fp32", "onnx/model.onnx"],
    ],
  );
  assert.equal(pulls[1].revision, "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7");
  assert.equal(types(log, "model-ready").length, 1);
  assert.deepEqual(
    types(log, "run").map((event) => [event.phase, event.n]),
    [
      ["processor", 1],
      ["model", 1],
    ],
  );
  assert.equal(types(log, "run")[0].width, 120, "the processor run records the RawImage size");
  assert.ok(progress.some((event) => event.status === "progress" && event.file === "onnx/model.onnx"));
  const disposed = (target) => log.filter((event) => event.type === "dispose" && event.target === target).length;
  assert.deepEqual([disposed("pixel_values"), disposed("output_image"), disposed("sigmoid-result")], [1, 1, 0]);
  assert.equal(types(log, "sigmoid").length, 0);
  assert.equal(disposed("model"), 0, "the cached engine is still live");
  await pool.releaseIdle(request("birefnet", "wasm"));
  assert.equal(disposed("model"), 1);
  assert.equal(disposed("processor"), 1);
});

test("BiRefNet on WebGPU requests the fp16 file; ISNet uses input/output names and 1024 tensors", async () => {
  const { tf, log } = await loadFake();
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "webgpu"), {}, () => undefined);
  await pool.use(request("isnet", "wasm"), {}, async (engine) => {
    const processed = await engine.processor(rawImage(tf));
    assert.deepEqual(processed.pixel_values.dims, [1, 3, 1024, 1024]);
    const output = await engine.model({ input_image: processed.pixel_values });
    assert.deepEqual(output.output_image.dims, [1, 1, 1024, 1024]);
    assert.equal(output.output_image.data[0], 1, "default ISNet output is a probability");
  });
  const files = types(log, "from_pretrained")
    .filter((event) => event.kind === "model")
    .map((event) => [event.model, event.device, event.file]);
  assert.deepEqual(files, [
    ["birefnet", "webgpu", "onnx/model_fp16.onnx"],
    ["isnet", "wasm", "onnx/model_fp16.onnx"],
  ]);
  const run = types(log, "run").find((event) => event.phase === "model");
  assert.equal(run.inputName, "input");
});

test("masks are authored in model space from source coordinates and bands", async () => {
  const { tf } = await loadFake({
    page: {
      mask: (c, h) => (c.n === 1 ? h.rect(c, { x0: 40, y0: 30, x1: 52, y1: 50, inside: 20, outside: -20 }) : h.bandsX([-2, 0, 2])),
    },
  });
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
    const run = async () => {
      const processed = await engine.processor(rawImage(tf, 120, 80));
      return (await engine.model({ input_image: processed.pixel_values })).output_image.data;
    };
    const rect = await run();
    const at = (data, row, col) => data[row * 512 + col];
    // The 120x80 subject at x 40-52, y 30-50 is columns [171,222) x rows [192,320).
    assert.equal(at(rect, 192, 171), 20);
    assert.equal(at(rect, 319, 221), 20);
    assert.equal(at(rect, 191, 171), -20);
    assert.equal(at(rect, 192, 170), -20);
    assert.equal(at(rect, 320, 171), -20);
    assert.equal(at(rect, 192, 222), -20);
    const bands = await run();
    assert.deepEqual([at(bands, 100, 85), at(bands, 100, 256), at(bands, 100, 426)], [-2, 0, 2]);
  });
});

test("sigmoid is counted and returns a disposable tensor; double dispose is flagged", async () => {
  const { tf, log } = await loadFake({ page: { mask: () => 0 } });
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
    const processed = await engine.processor(rawImage(tf));
    const output = await engine.model({ input_image: processed.pixel_values });
    const normalized = output.output_image.sigmoid();
    assert.equal(normalized.data[0], 0.5);
    assert.deepEqual(normalized.dims, [1, 1, 512, 512]);
    normalized.dispose();
    normalized.dispose();
    output.output_image.dispose();
  });
  assert.equal(types(log, "sigmoid").length, 1);
  const results = log.filter((event) => event.type === "dispose" && event.target === "sigmoid-result");
  assert.deepEqual(
    results.map((event) => event.repeat),
    [false, true],
  );
});

test("a non-finite output is rejected by the adapter and the returned tensor is disposed", async () => {
  const { tf, log } = await loadFake({ page: { mask: (c, h) => h.nonFinite(c) } });
  const pool = await poolFor(tf);
  await assert.rejects(
    pool.use(request("birefnet", "wasm"), {}, async (engine) => {
      const processed = await engine.processor(rawImage(tf));
      await engine.model({ input_image: processed.pixel_values });
    }),
    (error) => error.name === "RemovalModelOutputError" && /nonfinite output_image/.test(error.message),
  );
  assert.equal(log.filter((event) => event.type === "dispose" && event.target === "output_image").length, 1);
});

test("a mask that throws fails that run only, and run counts continue", async () => {
  const { tf, log } = await loadFake({ page: { mask: (c, h) => (c.n > 1 ? h.fail("crop off") : 20) } });
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
    const processed = await engine.processor(rawImage(tf));
    await engine.model({ input_image: processed.pixel_values });
    await assert.rejects(engine.model({ input_image: processed.pixel_values }), /crop off/);
  });
  assert.deepEqual(
    types(log, "run").map((event) => event.n),
    [1, 1, 2],
  );
});

test("run hooks see per model+device call counts", async () => {
  const seen = [];
  globalThis.__seen = seen;
  const { tf } = await loadFake({ page: { run: async (c) => (c.phase === "model" ? void globalThis.__seen.push([c.device, c.n, c.deviceCall]) : undefined) } });
  const pool = await poolFor(tf);
  for (const provider of ["wasm", "webgpu", "wasm"]) {
    await pool.use(request("birefnet", provider), {}, async (engine) => {
      const processed = await engine.processor(rawImage(tf));
      await engine.model({ input_image: processed.pixel_values });
    });
  }
  delete globalThis.__seen;
  assert.deepEqual(seen, [["wasm", 1, 1], ["webgpu", 2, 1], ["wasm", 3, 2]]);
});

test("a model that returns nothing is reported as malformed by the adapter", async () => {
  const { tf } = await loadFake({ page: { mask: () => "missing" } });
  const pool = await poolFor(tf);
  await assert.rejects(
    pool.use(request("birefnet", "wasm"), {}, async (engine) => {
      const processed = await engine.processor(rawImage(tf));
      await engine.model({ input_image: processed.pixel_values });
    }),
    (error) => error.name === "RemovalModelOutputError" && /malformed output_image/.test(error.message),
  );
});

test("a load hook can fail a from_pretrained by kind and device, with attempt counts", async () => {
  const { tf, log } = await loadFake({
    page: {
      load: async (c) => {
        if (c.kind === "model" && c.device === "webgpu") throw new Error("WebGPU device lost");
        if (c.kind === "model" && c.device === "wasm" && c.attempt === 1) throw new Error("Failed to fetch");
      },
    },
  });
  const pool = await poolFor(tf);
  await assert.rejects(pool.use(request("birefnet", "webgpu"), {}, () => undefined), (error) => {
    return error.name === "RemovalModelLoadError" && /device lost/.test(error.message);
  });
  await assert.rejects(pool.use(request("birefnet", "wasm"), {}, () => undefined), /Failed to fetch/);
  await pool.use(request("birefnet", "wasm"), {}, () => undefined);
  const errors = types(log, "load-error").map((event) => [event.kind, event.device, event.message]);
  assert.deepEqual(errors, [
    ["model", "webgpu", "WebGPU device lost"],
    ["model", "wasm", "Failed to fetch"],
  ]);
  const wasm = types(log, "from_pretrained").filter((event) => event.kind === "model" && event.device === "wasm");
  assert.deepEqual(wasm.map((event) => event.attempt), [1, 2]);
  assert.equal(types(log, "model-ready").length, 1, "only the successful model is ready");
  // The failed webgpu load still produced a processor; the adapter disposed it.
  assert.ok(log.some((event) => event.type === "dispose" && event.target === "processor"));
});

test("the run hook holds a processor call open and fires its page hook once", async () => {
  const { tf, log } = await loadFake({
    page: {
      run: async (c, h) => {
        if (c.phase !== "processor") return undefined;
        globalThis.__imageSeen = [c.image.width, c.image.height, c.image.channels, c.width];
        return h.once("page-hook", () => globalThis.__pageHook(c.n));
      },
    },
  });
  let release;
  const calls = [];
  globalThis.__pageHook = (n) => {
    calls.push(n);
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
    let settled = false;
    const first = engine.processor(rawImage(tf)).then((value) => {
      settled = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(settled, false, "the processor call is held open by the hook");
    assert.deepEqual(calls, [1]);
    release();
    await first;
    await engine.processor(rawImage(tf));
    assert.deepEqual(calls, [1], "one-shot: the second processor call does not re-fire the hook");
  });
  delete globalThis.__pageHook;
  assert.deepEqual(globalThis.__imageSeen, [120, 80, 4, 120], "the processor call exposes the RawImage as call.image");
  delete globalThis.__imageSeen;
  assert.equal(types(log, "run").length, 2);
});

test("a run hook result replaces the processor or model result verbatim, and can re-emit load progress", async () => {
  const { tf } = await loadFake({
    page: {
      run: async (c) => {
        if (c.phase === "processor" && c.n === 2) return { pixel_values: { data: new Float32Array(4), dims: [1, 3, 2, 2], dispose() {} } };
        if (c.phase === "model" && c.n === 2) {
          c.progress({ status: "progress", file: "onnx/model.onnx", progress: 77 });
          return {};
        }
        return undefined;
      },
    },
  });
  const pool = await poolFor(tf);
  const progress = [];
  await pool.use(request("birefnet", "wasm"), { onProgress: (event) => progress.push(event) }, async (engine) => {
    const ok = await engine.processor(rawImage(tf));
    assert.deepEqual(ok.pixel_values.dims, [1, 3, 512, 512]);
    await assert.rejects(engine.processor(rawImage(tf)), (error) => error.name === "RemovalModelOutputError");
    await engine.model({ input_image: ok.pixel_values });
    await assert.rejects(engine.model({ input_image: ok.pixel_values }), (error) => /malformed output_image/.test(error.message));
  });
  assert.ok(progress.some((event) => event.progress === 77), "progress re-emitted through the load's callback");
});

test("in a worker the worker config applies and events are posted on the log channel", async () => {
  const posted = [];
  const listener = new BroadcastChannel("cutout-fake-tf");
  listener.onmessage = (message) => posted.push(message.data);
  try {
    const { tf, log } = await loadFake({ page: { mask: () => 1 }, worker: { mask: () => 7 } }, "worker");
    assert.equal(types(log, "module-loaded")[0].ctx, "worker");
    const pool = await poolFor(tf);
    await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
      const processed = await engine.processor(rawImage(tf));
      assert.equal((await engine.model({ input_image: processed.pixel_values })).output_image.data[0], 7);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(log.length > 0 && log.every((event) => event.ctx === "worker"));
    assert.equal(posted.length, log.length, "every worker event is posted for the page collector");
    assert.deepEqual(posted.map((event) => event.seq), log.map((event) => event.seq));
  } finally {
    listener.close();
    delete globalThis.WorkerGlobalScope;
  }
});

test("in a page nothing is posted on the channel (the page appends directly)", async () => {
  const posted = [];
  const listener = new BroadcastChannel("cutout-fake-tf");
  listener.onmessage = (message) => posted.push(message.data);
  try {
    const { tf } = await loadFake({ page: { mask: () => 3 }, worker: { mask: () => 9 } });
    const pool = await poolFor(tf);
    await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
      const processed = await engine.processor(rawImage(tf));
      assert.equal((await engine.model({ input_image: processed.pixel_values })).output_image.data[0], 3);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(posted, []);
  } finally {
    listener.close();
  }
});

test("event times are monotonic within a context", async () => {
  const { tf, log } = await loadFake();
  const pool = await poolFor(tf);
  await pool.use(request("birefnet", "wasm"), {}, async (engine) => {
    for (let i = 0; i < 3; i += 1) await engine.processor(rawImage(tf));
  });
  for (let i = 1; i < log.length; i += 1) assert.ok(log[i].t > log[i - 1].t, `t[${i}]`);
});

function sandboxContext(extra = {}) {
  const sandbox = { performance, ...extra };
  return { sandbox, context: vm.createContext(sandbox) };
}

test("workerPrelude defines own navigator properties, logs a prelude event and wraps createImageBitmap", async () => {
  const fake = await fakeModule();
  const posted = [];
  class Channel {
    postMessage(message) {
      posted.push(message);
    }
    unref() {}
  }
  const { sandbox, context } = sandboxContext({
    navigator: {},
    BroadcastChannel: Channel,
    WorkerGlobalScope: class {},
    createImageBitmap: async () => "original",
  });
  vm.runInContext(
    fake.workerPrelude({ deviceMemory: 6, adapter: false, createImageBitmap: "(original) => async () => 'wrapped:' + (await original())" }),
    context,
  );
  assert.equal(sandbox.navigator.deviceMemory, 6);
  assert.equal(await sandbox.navigator.gpu.requestAdapter(), null);
  assert.equal(await sandbox.createImageBitmap(), "wrapped:original");
  assert.equal(posted.length, 1);
  assert.deepEqual([posted[0].ctx, posted[0].type, posted[0].deviceMemory, posted[0].adapter], ["worker", "prelude", 6, false]);
  // An adapter and a missing deviceMemory (own property, value undefined) are both expressible.
  const second = sandboxContext({ navigator: {}, BroadcastChannel: Channel, WorkerGlobalScope: class {} });
  vm.runInContext(fake.workerPrelude({ deviceMemory: undefined, adapter: true }), second.context);
  assert.equal(Object.hasOwn(second.sandbox.navigator, "deviceMemory"), true);
  assert.equal(second.sandbox.navigator.deviceMemory, undefined);
  const adapter = await second.sandbox.navigator.gpu.requestAdapter();
  assert.equal(typeof adapter.requestDevice, "function");
  assert.equal(typeof (await adapter.requestDevice()), "object");
});

test("pageEnvInit stubs deviceMemory and requestAdapter, and leaves unrequested properties alone", async () => {
  const fake = await fakeModule();
  const { sandbox, context } = sandboxContext({ navigator: { deviceMemory: 99 } });
  vm.runInContext(fake.pageEnvInit({ adapter: true }), context);
  assert.equal(sandbox.navigator.deviceMemory, 99, "deviceMemory not requested, untouched");
  assert.ok(await sandbox.navigator.gpu.requestAdapter());
  const second = sandboxContext({ navigator: {} });
  vm.runInContext(fake.pageEnvInit({ deviceMemory: 3, adapter: false }), second.context);
  assert.equal(second.sandbox.navigator.deviceMemory, 3);
  assert.equal(await second.sandbox.navigator.gpu.requestAdapter(), null);
});

test("adapter modes: fake (with shader-f16), no-f16, null (string or falsy) and absent", async () => {
  const fake = await fakeModule();
  const modes = [];
  for (const adapter of [true, "fake", "no-f16", false, null, "null", "absent", undefined]) {
    const { sandbox, context } = sandboxContext({ navigator: {} });
    vm.runInContext(fake.pageEnvInit({ adapter }), context);
    const gpu = sandbox.navigator.gpu;
    const found = gpu && (await gpu.requestAdapter());
    modes.push(gpu === undefined ? "absent" : !found ? "null" : found.features.has("shader-f16") ? "fake" : "no-f16");
  }
  assert.deepEqual(modes, ["fake", "fake", "no-f16", "null", "null", "null", "absent", "null"]);
});

test("eventLogInit creates the collector, merges worker events and logs Worker create/terminate", async () => {
  const fake = await fakeModule();
  const channels = [];
  class Channel {
    constructor(name) {
      this.name = name;
      channels.push(this);
    }
    unref() {}
    postMessage() {}
  }
  class NativeWorker {
    constructor(url) {
      this.url = url;
    }
    terminate() {
      this.terminated = true;
    }
  }
  const { sandbox, context } = sandboxContext({ Worker: NativeWorker, BroadcastChannel: Channel });
  vm.runInContext(fake.eventLogInit(), context);
  assert.equal(sandbox.__fakeTf.length, 0, "the collector exists before any fake loads");
  assert.notEqual(sandbox.Worker, NativeWorker);
  const worker = new sandbox.Worker("/src/lib/removal-worker.ts?worker_file&type=module", { type: "module" });
  assert.ok(worker instanceof NativeWorker);
  worker.terminate();
  assert.equal(worker.terminated, true, "the native terminate still runs");
  assert.deepEqual(
    Array.from(sandbox.__fakeTf, (event) => [event.ctx, event.type]),
    [
      ["page", "worker-created"],
      ["page", "terminate"],
    ],
  );
  assert.match(sandbox.__fakeTf[0].url, /removal-worker\.ts/);
  assert.match(sandbox.__fakeTf[1].url, /removal-worker\.ts/);
  const collector = channels.find((channel) => channel.name === "cutout-fake-tf");
  collector.onmessage({ data: { ctx: "worker", t: 5, seq: 1, type: "model-ready" } });
  assert.equal(sandbox.__fakeTf.at(-1).ctx, "worker");
});

test("sortLog, select and liveModels read a cross-context log", async () => {
  const { sortLog, select, liveModels } = await fakeModule();
  const log = [
    { ctx: "worker", t: 5, type: "model-ready" },
    { ctx: "page", t: 1, type: "model-ready" },
    { ctx: "page", t: 3, type: "dispose", target: "model" },
    { ctx: "page", t: 4, type: "dispose", target: "model", repeat: true },
    { ctx: "page", t: 6, type: "model-ready" },
    { ctx: "page", t: 7, type: "terminate", url: "http://x/src/lib/removal-worker.ts?worker_file" },
    { ctx: "worker", t: 8, type: "model-ready" },
  ];
  const sorted = sortLog(log);
  assert.deepEqual(sorted.map((event) => event.t), [1, 3, 4, 5, 6, 7, 8]);
  assert.equal(select(sorted, { type: "model-ready", ctx: "worker" }).length, 2);
  assert.equal(select(sorted, { t: (t) => t > 4 }).length, 4);
  const live = liveModels(sorted);
  // page: 1, 0 (the repeated dispose is ignored), 1; worker: 1 at t=5, reset by terminate at t=7, 1 at t=8.
  assert.deepEqual([live.maxPage, live.maxWorker, live.final.page, live.final.worker], [1, 1, 1, 1]);
  assert.equal(live.maxTotal, 2, "page 1 + worker 1 overlap at t=6");
  const overlap = liveModels(sortLog([{ ctx: "page", t: 1, type: "model-ready" }, { ctx: "page", t: 2, type: "model-ready" }]));
  assert.equal(overlap.maxPage, 2);
});

test("installFake registers the transformers route, init scripts, and the worker entry route on demand", async () => {
  const { installFake, TRANSFORMERS_ROUTE, WORKER_ROUTE } = await fakeModule();
  const scripts = [];
  const routes = [];
  const target = {
    addInitScript: async (script) => scripts.push(script),
    route: async (pattern, handler) => routes.push([pattern, handler]),
  };
  await installFake(target, { deviceMemory: 8, adapter: false });
  assert.equal(scripts.length, 3, "event log, page environment, fixtures");
  assert.deepEqual(routes.map(([pattern]) => pattern), [TRANSFORMERS_ROUTE]);
  let fulfilled;
  await routes[0][1]({ fulfill: async (options) => (fulfilled = options) });
  assert.equal(fulfilled.contentType, "text/javascript");
  assert.match(fulfilled.body, /module-loaded/);

  const withWorker = { addInitScript: async () => {}, route: async (pattern, handler) => routes.push([pattern, handler]) };
  routes.length = 0;
  await installFake(withWorker, { deviceMemory: 4, adapter: true, workerEnv: { deviceMemory: 4, adapter: true } });
  assert.deepEqual(routes.map(([pattern]) => pattern), [TRANSFORMERS_ROUTE, WORKER_ROUTE]);
  const response = { text: async () => "WORKER_SOURCE();" };
  await routes[1][1]({ fetch: async () => response, fulfill: async (options) => (fulfilled = options) });
  assert.equal(fulfilled.response, response);
  assert.ok(fulfilled.body.endsWith("WORKER_SOURCE();"));
  assert.ok(fulfilled.body.startsWith("(()"), "the prelude is prepended");
  assert.match(fulfilled.body, /prelude/);
});

test("runInterceptionSmoke falls back from page.route to context.route and reports both attempts", async () => {
  const { runInterceptionSmoke } = await fakeModule();
  const worker = (intercepted) => [
    ...(intercepted ? [{ ctx: "worker", t: 2, type: "module-loaded" }, { ctx: "worker", t: 1, type: "prelude", deviceMemory: 6 }] : []),
  ];
  const makeBrowser = (interceptsWhen) => {
    const attempts = [];
    return {
      attempts,
      newContext: async () => {
        const state = { routedOn: undefined };
        const context = {
          addInitScript: async () => {},
          route: async () => (state.routedOn = "context"),
          close: async () => {},
          newPage: async () => ({
            addInitScript: async () => {},
            route: async () => (state.routedOn = "page"),
            goto: async () => {},
            evaluate: async (fn) => {
              if (!String(fn).includes("__fakeTf")) return undefined;
              attempts.push(state.routedOn);
              return worker(interceptsWhen === state.routedOn);
            },
          }),
        };
        return context;
      },
    };
  };
  const viaContext = makeBrowser("context");
  const result = await runInterceptionSmoke(viaContext, "http://app/", { deviceMemory: 6 });
  assert.equal(result.intercepted, "context");
  assert.deepEqual(viaContext.attempts, ["page", "context"]);
  assert.equal(result.attempts.length, 2);
  const viaPage = makeBrowser("page");
  assert.equal((await runInterceptionSmoke(viaPage, "http://app/", { deviceMemory: 6 })).intercepted, "page");
  assert.deepEqual(viaPage.attempts, ["page"]);
  const neither = await runInterceptionSmoke(makeBrowser("none"), "http://app/", { deviceMemory: 6 });
  assert.equal(neither.intercepted, null);
  assert.equal(neither.attempts.length, 2);
});

// ---- Static shape of the retargeted browser scripts (they are authored here, never run) ----

const refinement = readFileSync(`${ROOT}/scripts/browser-engine-refinement.mjs`, "utf8");
const adaptive = readFileSync(`${ROOT}/scripts/browser-adaptive-removal.mjs`, "utf8");

test("both browser scripts parse", () => {
  for (const file of ["browser-engine-refinement.mjs", "browser-adaptive-removal.mjs", "fake-transformers.mjs"])
    execFileSync(process.execPath, ["--check", `${ROOT}/scripts/${file}`]);
});

test("neither browser script routes or mentions bg0 any more", () => {
  for (const source of [refinement, adaptive]) {
    assert.doesNotMatch(source, /bg0/i);
    assert.doesNotMatch(source, /prepareEngine|removeBackground\(\)|export async function removeBackground/);
  }
});

test("browser-engine-refinement retargets through the fake boundary with the designed rows", () => {
  assert.match(refinement, /from "\.\/fake-transformers\.mjs"/);
  assert.match(refinement, /runInterceptionSmoke/);
  for (const title of [
    "interception smoke",
    "photo removal refines a small subject with a second bounded model pass",
    "BiRefNet raw logits are consumed as-is by default",
    "invalid BiRefNet logits still reach the engine non-finite mask error",
    "a successful compatibility result survives failed preferred-engine preparation",
    "lossless logo removal retains faint coverage on off-white paper",
    "C4 b1",
    "C4 b2",
    "C4 b3",
    "C4 b4",
    "crops: the global pass and every automatic and manual crop consume raw scores",
  ])
    assert.ok(refinement.includes(title), `missing row: ${title}`);
  // The three passthrough rows assert zero from_pretrained.
  const passthrough = refinement.slice(refinement.indexOf("small cutout"), refinement.indexOf("a successful compatibility result"));
  assert.match(passthrough, /sparse high-resolution cutout/);
  assert.match(passthrough, /translucent overlay/);
  assert.match(passthrough, /select\(log, \{ type: "from_pretrained" \}\)\.length[\s\S]*0/);
  // The one rendering never sigmoids, on the global pass or on crops.
  assert.match(refinement, /cutout-original-matte-v1/);
  assert.match(refinement, /refineWithUserCrops/);
});

test("browser-adaptive-removal routes the fake boundary before navigation, with zero-model graphics rows", () => {
  assert.match(adaptive, /from "\.\/fake-transformers\.mjs"/);
  assert.match(adaptive, /installFake/);
  assert.match(adaptive, /adapter: false/);
  const graphics = adaptive.slice(adaptive.indexOf("uniform noisy fields"), adaptive.indexOf("dark continuous grayscale shading"));
  assert.match(graphics, /from_pretrained/);
  const shading = adaptive.slice(adaptive.indexOf("dark continuous grayscale shading"));
  assert.match(shading, /method: "model"/);
  assert.match(shading, /calls: 1/);
});


test("C30 TESTS-6: the worker prelude can express an absent GPU API", async () => {
  const fake = await fakeModule();
  const { sandbox, context } = sandboxContext({ navigator: {} });
  vm.runInContext(fake.workerPrelude({ deviceMemory: 8, adapter: "absent" }), context);
  assert.equal(sandbox.navigator.gpu, undefined);
});
