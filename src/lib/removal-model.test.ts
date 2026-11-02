import assert from "node:assert/strict";
import test from "node:test";
import {
  REMOVAL_MODELS,
  RemovalModelOutputError,
  createRemovalEnginePool,
  type RemovalLoadFactories,
  type RemovalTensor,
} from "./removal-model.ts";

const REQUEST = { model: "birefnet", provider: "webgpu", context: "page" } as const;

class Deferred<T> {
  readonly promise: Promise<T>;
  private settle: ((value: T) => void) | undefined;
  constructor() {
    this.promise = new Promise((resolve) => {
      this.settle = resolve;
    });
  }
  resolve(value: T): void {
    const settle = this.settle;
    if (!settle) throw new Error("Deferred has already settled");
    this.settle = undefined;
    settle(value);
  }
}

function tensor(values: readonly number[], dims: readonly number[] = [1, 1, 512, 512]): RemovalTensor {
  const data = new Float32Array(dims.reduce((size, dimension) => size * dimension, 1));
  data.set(values);
  return {
    data,
    dims,
    dispose() {},
    sigmoid() {
      return tensor(values.map((value) => 1 / (1 + Math.exp(-value))), dims);
    },
  };
}

function workingFactories(state: { modelLoads: number; disposals: number }): RemovalLoadFactories {
  return {
    async loadProcessor() {
      return async () => ({ pixel_values: tensor([1], [1, 3, 512, 512]) });
    },
    async loadModel() {
      state.modelLoads += 1;
      return Object.assign(async () => ({ output_image: tensor([-2, 0, 2]) }), {
        async dispose() {
          state.disposals += 1;
        },
      });
    },
  };
}

test("exports the measured model revisions, shapes, semantics, dtypes, and ONNX files", () => {
  // Given/When: W3 reads the Cutout-owned model specifications.
  const birefnet = REMOVAL_MODELS.birefnet;
  const isnet = REMOVAL_MODELS.isnet;

  // Then: every loader-bearing literal matches the frozen W0 contract.
  assert.deepEqual(
    [birefnet.modelId, birefnet.revision, birefnet.inputDims, birefnet.outputDims, birefnet.semantics],
    ["studioludens/birefnet-lite-512", "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7", [1, 3, 512, 512], [1, 1, 512, 512], "logits"],
  );
  assert.deepEqual(birefnet.routes, {
    webgpu: { dtype: "fp16", onnxFile: "model_fp16.onnx" },
    webgpuFp32: { dtype: "fp32", onnxFile: "model.onnx" },
    wasm: { dtype: "fp32", onnxFile: "model.onnx" },
  });
  assert.deepEqual(
    [isnet.modelId, isnet.revision, isnet.inputName, isnet.outputName, isnet.inputDims, isnet.semantics],
    ["imgly/isnet-general-onnx", "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f", "input", "output", [1, 3, 1024, 1024], "probabilities"],
  );
  assert.deepEqual(isnet.routes.wasm, { dtype: "fp16", onnxFile: "model_fp16.onnx" });
});

test("bridges ISNet input and output names while preserving probabilities", async () => {
  // Given: the retained ISNet public boundary with its native input/output names.
  let seenInputs: Record<string, unknown> | undefined;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return async () => ({ pixel_values: tensor([0.5], [1, 3, 1024, 1024]) });
    },
    async loadModel() {
      return Object.assign(async (inputs: Record<string, unknown>) => {
        seenInputs = inputs;
        return { output: tensor([0.25], [1, 1, 1024, 1024]) };
      }, { async dispose() {} });
    },
  });
  const request = { model: "isnet", provider: "wasm", context: "worker" } as const;

  // When: W3-shaped input_image data passes through the prepared engine.
  const result = await pool.use(request, {}, async (engine) => {
    const prepared = await engine.processor("image");
    const output = await engine.model({ input_image: prepared.pixel_values });
    prepared.pixel_values.dispose();
    return { value: output.output_image.data[0], semantics: engine.outputImageSemantics, output: output.output_image };
  });

  // Then: the native model saw `input`, and its probability is returned unchanged.
  assert.deepEqual(Object.keys(seenInputs ?? {}), ["input"]);
  assert.equal(result.value, 0.25);
  assert.equal(result.semantics, "probabilities");
  result.output.dispose();
  await pool.releaseIdle(request);
});

test("two concurrent consumers share initialization and receive raw numerical logits", async () => {
  // Given: a model load held until both consumers have subscribed.
  const gate = new Deferred<unknown>();
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadModel(spec, provider, progress) {
      state.modelLoads += 1;
      progress({ status: "progress", file: "model_fp16.onnx", progress: 25 });
      await gate.promise;
      return Object.assign(async () => ({ output_image: tensor([-2, 0, 2]) }), {
        async dispose() {
          state.disposals += 1;
        },
      });
    },
  });
  const seen: number[] = [];

  // When: an early and late consumer join the same pending initialization.
  const first = pool.use(REQUEST, { onProgress: (event) => seen.push(event.progress ?? 0) }, async (engine) => {
    const prepared = await engine.processor("pixels");
    return engine.model({ input_image: prepared.pixel_values });
  });
  await Promise.resolve();
  const second = pool.use(REQUEST, { onProgress: (event) => seen.push(event.progress ?? 0) }, async (engine) => {
    const output = await engine.model({ input_image: tensor([1], [1, 3, 512, 512]) });
    return Array.from(output.output_image.data).slice(0, 3);
  });
  gate.resolve(undefined);

  // Then: both succeed through one model and the adapter does not normalize logits.
  const [firstOutput, secondOutput] = await Promise.all([first, second]);
  assert.deepEqual(Array.from(firstOutput.output_image.data).slice(0, 3), [-2, 0, 2]);
  assert.deepEqual(secondOutput, [-2, 0, 2]);
  assert.equal(state.modelLoads, 1);
  assert.deepEqual(seen, [25, 25]);
});

test("partial initialization disposes the returned model and the next call retries", async () => {
  // Given: the first processor load fails after its sibling model was returned.
  let attempts = 0;
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadProcessor() {
      attempts += 1;
      if (attempts === 1) throw new TypeError("offline processor config");
      return base.loadProcessor(REQUEST.model, () => undefined);
    },
  });

  // When: initialization fails, then an explicit later use retries.
  await assert.rejects(pool.use(REQUEST, {}, async () => "unused"), /offline processor config/);
  const result = await pool.use(REQUEST, {}, async (engine) => engine.identity.modelId);

  // Then: the live partial model was released and a fresh entry succeeded.
  assert.equal(result, "studioludens/birefnet-lite-512");
  assert.equal(state.modelLoads, 2);
  assert.equal(state.disposals, 1);
});

test("one subscriber aborts without cancelling the shared load or the other subscriber", async () => {
  // Given: two consumers waiting on one controlled initialization.
  const gate = new Deferred<unknown>();
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadModel() {
      state.modelLoads += 1;
      await gate.promise;
      return Object.assign(async () => ({ output_image: tensor([-2, 0, 2]) }), {
        async dispose() {
          state.disposals += 1;
        },
      });
    },
  });
  const controller = new AbortController();
  const cancelled = pool.use(REQUEST, { signal: controller.signal }, async () => "cancelled");
  const survivor = pool.use(REQUEST, {}, async () => "survived");

  // When: only the first subscriber cancels before initialization completes.
  controller.abort();
  await assert.rejects(cancelled, (error) => error instanceof DOMException && error.name === "AbortError");
  gate.resolve(undefined);

  // Then: the other subscriber completes and the pending entry was not poisoned.
  assert.equal(await survivor, "survived");
  assert.equal(state.modelLoads, 1);
});

test("a throwing progress subscriber is isolated from the load and other consumers", async () => {
  // Given: one hostile progress callback and one ordinary consumer.
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadModel(model, provider, progress) {
      progress({ status: "progress", progress: 70 });
      return base.loadModel(model, provider, progress);
    },
  });
  const hostile = pool.use(REQUEST, { onProgress: () => { throw new Error("listener failed"); } }, async () => 1);
  const observed: number[] = [];

  // When: a second consumer joins after the shared progress event.
  const healthy = pool.use(REQUEST, { onProgress: (event) => observed.push(event.progress ?? 0) }, async () => 2);

  // Then: listener failure changes neither completion nor late progress replay.
  assert.deepEqual(await Promise.all([hostile, healthy]), [1, 2]);
  assert.deepEqual(observed, [70]);
});

test("explicit release waits for active use and then disposes exactly once", async () => {
  // Given: a consumer holding an active lease.
  const state = { modelLoads: 0, disposals: 0 };
  const pool = createRemovalEnginePool(workingFactories(state));
  const runGate = new Deferred<unknown>();
  const running = pool.use(REQUEST, {}, async () => {
    await runGate.promise;
    return "done";
  });
  await Promise.resolve();

  // When: explicit idle release is requested during use.
  await pool.releaseIdle(REQUEST);
  assert.equal(state.disposals, 0);
  runGate.resolve(undefined);

  // Then: active work completes before its model is disposed.
  assert.equal(await running, "done");
  await Promise.resolve();
  assert.equal(state.disposals, 1);
});

test("nonfinite GPU masks remain actionable and release the invalid tensor", async () => {
  // Given: a WebGPU model returning a nonfinite raw logit.
  let tensorDisposals = 0;
  const invalid = { ...tensor([Number.NaN]), dispose() { tensorDisposals += 1; } };
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadModel() {
      return Object.assign(async () => ({ output_image: invalid }), { async dispose() {} });
    },
  });

  // When/Then: inference rejects with a GPU-mask signal instead of hiding it with sigmoid.
  await assert.rejects(
    pool.use(REQUEST, {}, async (engine) => engine.model({ input_image: tensor([1], [1, 3, 512, 512]) })),
    (error) => error instanceof RemovalModelOutputError && error.failureKind === "gpu-mask",
  );
  assert.equal(tensorDisposals, 1);
});

test("malformed GPU masks remain actionable and release the returned resource", async () => {
  // Given: a WebGPU result whose dimensions violate the pinned output contract.
  let tensorDisposals = 0;
  const malformed = { ...tensor([0], [1, 1, 1, 1]), dispose() { tensorDisposals += 1; } };
  const state = { modelLoads: 0, disposals: 0 };
  const base = workingFactories(state);
  const pool = createRemovalEnginePool({
    ...base,
    async loadModel() {
      return Object.assign(async () => ({ output_image: malformed }), { async dispose() {} });
    },
  });

  // When/Then: shape corruption is a typed GPU-mask fault and its tensor is released.
  await assert.rejects(
    pool.use(REQUEST, {}, async (engine) => engine.model({ input_image: tensor([1], [1, 3, 512, 512]) })),
    (error) => error instanceof RemovalModelOutputError && error.failureKind === "gpu-mask",
  );
  assert.equal(tensorDisposals, 1);
});


test("S3-A-ENGINE-01: device loss settles a hung boundary and all later leases reject without disposal", async () => {
  for (const dtype of ["fp16", "fp32"] as const) for (const boundary of ["processor", "model"] as const) {
    let lose!: (value: unknown) => void;
    const lost = new Promise<unknown>((resolve) => { lose = resolve; });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let loads = 0;
    let disposals = 0;
    const hang = () => { entered(); return new Promise<never>(() => {}); };
    const pool = createRemovalEnginePool({
      async loadProcessor() { return boundary === "processor" ? hang : async () => ({}); },
      async loadModel() { loads++; return Object.assign(boundary === "model" ? hang : async () => ({}), { dispose() { disposals++; } }); },
      async gpuDevice() { return { lost }; },
    });
    const job = pool.use({ ...REQUEST, dtype }, {}, async (engine) => { if (boundary === "processor") await engine.processor({}); else await engine.model({ input_image: {} }); });
    await started;
    lose({ reason: "unknown" });
    const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("device loss left the run pending")), 100).unref());
    await assert.rejects(Promise.race([job, deadline]), { code: "removal-context-lost", failureKind: "gpu-device" });
    await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unreachable"), { code: "removal-context-lost" });
    await pool.releaseAllIdle();
    assert.equal(loads, 1);
    assert.equal(disposals, 0, "a hung ORT session must not be awaited for disposal");
  }
});

test("S3-A-ENGINE-01: shipped transformers exposes ORT's actual WebGPU device", async () => {
  const { readFile } = await import("node:fs/promises");
  const specs = await import("./removal-model-specs.ts");
  const bundle = await readFile(new URL("../../node_modules/@huggingface/transformers/dist/transformers.web.js", import.meta.url), "utf8");
  assert.match(bundle, /env\.backends\.onnx = ONNX_ENV/);
  // transformers resolves its nested ORT first; a hoisting install puts the same pin at the top
  // level (scripts/patch-dependencies.mjs patches either).
  const { existsSync } = await import("node:fs");
  const ortFile = ["../../node_modules/@huggingface/transformers/node_modules/", "../../node_modules/"]
    .map((dir) => new URL(`${dir}onnxruntime-web/dist/ort.webgpu.bundle.min.mjs`, import.meta.url))
    .find((url) => existsSync(url));
  assert.ok(ortFile, "onnxruntime-web is installed, nested under transformers or hoisted");
  const ort = await readFile(ortFile, "utf8");
  assert.ok(/defineProperty\([^,]+,["']device["']/.test(ort), "ORT publishes webgpu.device");
  const device = { lost: new Promise(() => {}) };
  assert.equal(specs.removalGpuDevice({ backends: { onnx: { webgpu: { device } } } }), device);
  assert.equal(specs.removalGpuDevice({}), undefined);
});


test("C06: pending loads time out on progress silence, not total time, and are evicted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let progress!: (event: { status: string; progress: number }) => void;
  let loads = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return async () => ({}); },
    async loadModel(_model, _provider, notify) { loads++; progress = notify; return new Promise(() => {}); },
  });
  let expired = false;
  const waiting = pool.use(REQUEST, {}, () => "unused");
  void waiting.catch(() => { expired = true; });
  const first = assert.rejects(waiting, { code: "model-load-timeout", failureKind: "network" });
  t.mock.timers.tick(59_000);
  progress({ status: "progress", progress: 1 });
  t.mock.timers.tick(59_000);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(expired, false, "progress keeps a download alive beyond the total-time limit");
  assert.equal(loads, 1);
  progress({ status: "progress", progress: 2 });
  t.mock.timers.tick(60_000);
  await first;
  const second = assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "model-load-timeout" });
  assert.equal(loads, 2);
  t.mock.timers.tick(60_000);
  await second;
});

test("C06: the last cancelled load subscriber evicts immediately; retirement never waits for it", async () => {
  let loads = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return async () => ({}); },
    async loadModel() { loads++; return new Promise(() => {}); },
  });
  const a = new AbortController();
  const b = new AbortController();
  const first = assert.rejects(pool.use(REQUEST, { signal: a.signal }, () => "unused"));
  const shared = assert.rejects(pool.use(REQUEST, { signal: b.signal }, () => "unused"));
  a.abort(); await first;
  assert.equal(loads, 1, "one remaining subscriber keeps the load");
  b.abort(); await shared;
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("retirement awaited an evicted load")), 100).unref());
  await Promise.race([pool.releaseAllIdle(), deadline]);
  const c = new AbortController();
  const next = assert.rejects(pool.use(REQUEST, { signal: c.signal }, () => "unused"));
  assert.equal(loads, 2, "new job cannot inherit the stalled entry");
  c.abort(); await next;
});

test("S3-B-EVIDENCE-01: an ORT parse failure evicts the weight and rejects later leases in that context", async () => {
  let loads = 0;
  const evicted: string[] = [];
  const pool = createRemovalEnginePool({
    async loadProcessor() { return async () => ({}); },
    async loadModel() { loads++; throw new Error("Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed."); },
    async evictModelFile(model, provider) { evicted.push(`${model}:${provider}`); return true; },
  });
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "removal-model-damaged" });
  assert.deepEqual(evicted, ["birefnet:webgpu"]);
  await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unused"), { code: "removal-model-damaged" });
  assert.equal(loads, 1, "no new session in a poisoned module");
  const fresh = createRemovalEnginePool(workingFactories({ modelLoads: 0, disposals: 0 }));
  assert.equal(await fresh.use(REQUEST, {}, () => "ready"), "ready");
  await fresh.releaseAllIdle();
});

test("S3-B-EVIDENCE-01: cache eviction removes only this revision's weight, including a configured mirror", async () => {
  const specs = await import("./removal-model-specs.ts");
  const target = `https://mirror.test/${REMOVAL_MODELS.birefnet.modelId}/resolve/${REMOVAL_MODELS.birefnet.revision}/onnx/model_fp16.onnx`;
  const untouched = target.replace("model_fp16.onnx", "model.onnx");
  const keys = new Set([target, untouched, target.replace(REMOVAL_MODELS.birefnet.revision, "other-revision")]);
  const cache = { async delete(key: string) { return keys.delete(key); } };
  const store = { async open(name: string) { assert.equal(name, "transformers-cache"); return cache; } };
  assert.equal(await specs.evictRemovalModelFile(REQUEST, { remoteHost: "https://mirror.test/", remotePathTemplate: "{model}/resolve/{revision}/" }, store), true);
  assert.equal(keys.has(target), false);
  assert.equal(keys.has(untouched), true);
  assert.equal(keys.size, 2);
});


test("S3-B-EVIDENCE-01: a parse failure is handled even while the processor download is stalled", async () => {
  let evicted = false;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return new Promise(() => {}); },
    async loadModel() { throw new Error("Can't create a session. ERROR_CODE: 7, protobuf parsing failed"); },
    async evictModelFile() { evicted = true; return true; },
  });
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("parse recovery waited for stalled processor")), 100).unref());
  await assert.rejects(Promise.race([pool.use(REQUEST, {}, () => "unused"), deadline]), { code: "removal-model-damaged" });
  assert.equal(evicted, true);
});


for (const message of [
  "Can't create a session. failed to allocate a buffer of size 268435456.",
  "Can't create a session. ERROR_CODE: 1, ERROR_MESSAGE: Failed to initialize WebGPU execution provider.",
  "Can't create a session. ERROR_CODE: 9, ERROR_MESSAGE: Could not find an implementation for Conv(11).",
]) test(`RR1 cache: ordinary ORT session failure preserves weights: ${message}`, async () => {
  let evictions = 0;
  const state = { modelLoads: 0, disposals: 0 };
  const good = workingFactories(state);
  const pool = createRemovalEnginePool({ ...good,
    async loadModel(...args) { if (args[1] === "webgpu") throw new Error(message); return good.loadModel(...args); },
    async evictModelFile() { evictions++; return true; },
  });
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), { name: "RemovalModelLoadError" });
  assert.equal(evictions, 0);
  // Normal load recovery is still permitted in this realm.
  assert.equal(await pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "ready"), "ready");
  await pool.releaseAllIdle();
});

test("RR1 cache: nested protobuf evidence is required; unavailable/disabled/failed storage is truthful", async () => {
  const { isRemovalSessionFailure, evictRemovalModelFile } = await import("./removal-model-specs.ts");
  const { RemovalModelCacheError } = await import("./removal-provider.ts");
  assert.equal(isRemovalSessionFailure(new Error("Can't create a session.")), false);
  assert.equal(isRemovalSessionFailure(new Error("wrapper", { cause: new Error("invalid protobuf") })), true);
  for (const removed of [
    await evictRemovalModelFile(REQUEST, {}, undefined),
    await evictRemovalModelFile(REQUEST, { useBrowserCache: false }, { async open() { throw new Error("disabled storage must not be opened"); } }),
    await evictRemovalModelFile(REQUEST, {}, { async open() { throw new Error("denied"); } }),
    await evictRemovalModelFile(REQUEST, {}, { async open() { return { async delete() { throw new Error("delete failed"); } }; } }),
  ]) {
    assert.equal(removed, false);
    assert.doesNotMatch(new RemovalModelCacheError(removed, new Error("invalid protobuf")).message, /has been removed/);
  }
  assert.equal(await evictRemovalModelFile(REQUEST, {}, { async open() { return { async delete() { return false; } }; } }), true, "verified absence is safe");
});

for (const pending of ["model", "processor", "both"] as const) test(`RR1 GPU: loss while ${pending} load is pending poisons the realm`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lost = new Deferred<unknown>();
  const state = { modelLoads: 0, disposals: 0 };
  const good = workingFactories(state);
  let probes = 0;
  const pool = createRemovalEnginePool({ ...good,
    async loadProcessor(...args) { return pending !== "model" ? new Promise(() => {}) : good.loadProcessor(...args); },
    async loadModel(...args) { return pending !== "processor" ? new Promise(() => {}) : good.loadModel(...args); },
    async gpuDevice() { probes++; return { lost: lost.promise }; },
  });
  const rejected = assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "removal-context-lost", failureKind: "gpu-device" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  lost.resolve({ reason: "destroyed" });
  t.mock.timers.tick(60_000);
  await rejected;
  assert.ok(probes > 0);
  await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unused"), /Reload the page/);
  assert.equal(state.disposals, 0);
});

test("RR1 GPU: device published after load starts is checked before timeout fallback", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lost = new Deferred<unknown>();
  let device: { lost: Promise<unknown> } | undefined = undefined;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return new Promise(() => {}); },
    async loadModel() { return new Promise(() => {}); },
    async gpuDevice() { return device; },
  });
  const rejected = assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "removal-context-lost" });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  device = { lost: lost.promise };
  lost.resolve({});
  t.mock.timers.tick(60_000);
  await rejected;
  await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unused"), { code: "removal-context-lost" });
});

test("RR1 GPU: idle loss survives model retirement; missing or unusable accessors stay bounded", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lost = new Deferred<unknown>();
  const state = { modelLoads: 0, disposals: 0 };
  const pool = createRemovalEnginePool({ ...workingFactories(state), async gpuDevice() { return { lost: lost.promise }; } });
  await pool.use(REQUEST, {}, () => "ready");
  await pool.releaseAllIdle();
  lost.resolve({});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unused"), { code: "removal-context-lost" });
  for (const gpuDevice of [undefined, async () => undefined, async () => { throw new Error("no accessor"); }, async () => new Promise<undefined>(() => {})]) {
    const fallback = createRemovalEnginePool({ ...workingFactories(state), gpuDevice,
      async loadModel() { return new Promise(() => {}); },
    });
    const rejected = assert.rejects(fallback.use(REQUEST, {}, () => "unused"), { code: "model-load-timeout" });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(60_000);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    t.mock.timers.tick(1_000);
    await rejected;
  }
});


test("RR1 cache: unavailable CacheStorage must not claim successful removal", async () => {
  const { evictRemovalModelFile } = await import("./removal-model-specs.ts");
  assert.equal(await evictRemovalModelFile(REQUEST, {}, undefined), false);
});

test("RR1 cache: disabled CacheStorage must not delete or claim removal", async () => {
  const { evictRemovalModelFile } = await import("./removal-model-specs.ts");
  let opens = 0;
  assert.equal(await evictRemovalModelFile(REQUEST, { useBrowserCache: false }, { async open() { opens++; return { async delete() { return true; } }; } }), false);
  assert.equal(opens, 0);
});

test("RR1 cache: an inaccessible CacheStorage getter yields truthful damaged-model copy", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "caches");
  Object.defineProperty(globalThis, "caches", { configurable: true, get() { throw new Error("SecurityError"); } });
  try {
    const { evictRemovalModelFile } = await import("./removal-model-specs.ts");
    assert.equal(await evictRemovalModelFile(REQUEST, {}), false);
  } finally {
    if (prior) Object.defineProperty(globalThis, "caches", prior); else Reflect.deleteProperty(globalThis, "caches");
  }
});


test("RR1 cache: protobuf mentions without parse evidence are not corruption; nested textual causes are", async () => {
  const { isRemovalSessionFailure } = await import("./removal-model-specs.ts");
  assert.equal(isRemovalSessionFailure(new Error("Failed to load model: protobuf execution provider unavailable")), false);
  assert.equal(isRemovalSessionFailure(new Error("wrapper", { cause: "INVALID_PROTOBUF" })), true);
});


const flushRR2 = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

for (const cancel of [false, true]) test(`RR2 cache: pending deletion quarantines concurrent WASM leases, cancellation=${cancel}`, async () => {
  const deletion = new Deferred<boolean>();
  const started = new Deferred<void>();
  const calls: string[] = [];
  const controller = new AbortController();
  const pool = createRemovalEnginePool({
    async loadProcessor() { calls.push("processor"); return async () => ({}); },
    async loadModel(_model, provider) {
      calls.push(provider);
      if (provider === "webgpu") throw new Error("protobuf parsing failed");
      return Object.assign(async () => ({}), { async dispose() {} });
    },
    async evictModelFile() { calls.push("delete"); started.resolve(); return deletion.promise; },
  });
  const first = pool.use(REQUEST, { signal: controller.signal }, () => "unused");
  const firstResult = first.catch((error: unknown) => error);
  await started.promise;
  if (cancel) { controller.abort(); await assert.rejects(first, { name: "AbortError" }); }
  let settled = false;
  const next = pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "ADMITTED");
  const nextResult = next.catch((error: unknown) => error).finally(() => { settled = true; });
  const waitingController = new AbortController();
  const waiting = pool.use(REQUEST, { signal: waitingController.signal }, () => "unused");
  waitingController.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  await flushRR2();
  const before = calls.slice();
  const early = settled;
  deletion.resolve(true);
  await firstResult;
  const failure = await nextResult;
  assert.deepEqual(before, ["processor", "webgpu", "delete"], "no factory may start in quarantine");
  assert.equal(early, false, "fresh-context error waits for deletion");
  assert.equal(Reflect.get(failure as object, "code"), "removal-model-damaged");
  assert.match((failure as Error).message, /has been removed/);
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "removal-model-damaged" });
  assert.deepEqual(calls, before);
});

for (const corruptionAt of [0, 59_999]) for (const processorStalled of [false, true]) test(`RR2 cache: stalled eviction is bounded and never becomes load silence, processor stalled=${processorStalled}, corruption at=${corruptionAt}`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const deletion = new Deferred<boolean>();
  const started = new Deferred<void>();
  const corrupt = new Deferred<void>();
  let loads = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return processorStalled ? new Promise(() => {}) : async () => ({}); },
    async loadModel() { loads++; await corrupt.promise; throw new Error("INVALID_PROTOBUF"); },
    async evictModelFile() { started.resolve(); return deletion.promise; },
  });
  let failure: unknown;
  const first = pool.use(REQUEST, {}, () => "unused").catch((error: unknown) => { failure = error; return error; });
  await flushRR2();
  t.mock.timers.tick(corruptionAt);
  corrupt.resolve();
  await started.promise;
  t.mock.timers.tick(4_999); await flushRR2();
  assert.equal(failure, undefined);
  t.mock.timers.tick(1); await flushRR2();
  const atBound = failure;
  t.mock.timers.tick(60_100); await flushRR2();
  const afterSilence = failure;
  // Settle the old operation even on the red revision; it must not revise the timeout copy.
  deletion.resolve(true); const finalFailure = await first; await flushRR2();
  assert.equal(Reflect.get((atBound ?? {}) as object, "code"), "removal-model-damaged");
  assert.equal(afterSilence, atBound);
  assert.match((finalFailure as Error).message, /Delete.*reload/);
  await assert.rejects(pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "unused"), { code: "removal-model-damaged" });
  assert.equal(loads, 1);
});

for (const result of ["success", "failed", "denied", "unavailable"] as const) test(`RR2 cache: ${result} deletion preserves fatal classification and truthful copy`, async () => {
  const { evictRemovalModelFile } = await import("./removal-model-specs.ts");
  const cause = new Error("protobuf parsing failed");
  const pool = createRemovalEnginePool({
    async loadProcessor() { return new Promise(() => {}); },
    async loadModel() { throw cause; },
    ...(result === "unavailable" ? {} : { async evictModelFile() {
      if (result === "failed") throw new Error("delete failed");
      return evictRemovalModelFile(REQUEST, {}, { async open() {
        if (result === "denied") throw new DOMException("denied", "SecurityError");
        return { async delete() { return true; } };
      } });
    } }),
  });
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), (error: unknown) => {
    assert.equal(Reflect.get(error as object, "code"), "removal-model-damaged");
    assert.equal((error as Error).cause, cause);
    assert.match((error as Error).message, result === "success" ? /has been removed/ : /Delete.*reload/);
    return true;
  });
});


test("RR2 cache: an ordinary allocation error with a stalled processor keeps normal timeout/provider recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let processors = 0;
  let evictions = 0;
  let models = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() { return ++processors === 1 ? new Promise(() => {}) : async () => ({}); },
    async loadModel(_model, provider) {
      models++;
      if (provider === "webgpu") throw new Error("Can't create a session. failed to allocate a buffer of size 268435456.");
      return Object.assign(async () => ({}), { async dispose() {} });
    },
    async evictModelFile() { evictions++; return true; },
  });
  const first = assert.rejects(pool.use(REQUEST, {}, () => "unused"), { code: "model-load-timeout", failureKind: "network" });
  await flushRR2(); t.mock.timers.tick(60_000); await first;
  assert.equal(await pool.use({ ...REQUEST, provider: "wasm" }, {}, () => "ready"), "ready");
  assert.equal(evictions, 0);
  assert.equal(models, 2);
  await pool.releaseAllIdle();
});

// E05-01: transformers stores a hub file before it parses it, so a captive portal's HTML 200 or a
// cut-short config.json was read back on every later load.
const portalJson = () => new SyntaxError(`Unexpected token '<', "<html><bod"... is not valid JSON`);

for (const failing of ["processor", "model", "both"] as const) test(`E05-01: a hub JSON that does not parse (${failing}) clears the model's cache and loads once more`, async () => {
  const state = { modelLoads: 0, disposals: 0 };
  const good = workingFactories(state);
  const calls = { processor: 0, model: 0, evictions: [] as string[] };
  const pool = createRemovalEnginePool({
    async loadProcessor(...args) {
      if (++calls.processor === 1 && failing !== "model") throw portalJson();
      return good.loadProcessor(...args);
    },
    async loadModel(...args) {
      if (++calls.model === 1 && failing !== "processor") throw new Error("wrapper", { cause: portalJson() });
      return good.loadModel(...args);
    },
    async evictModelCache(model) { calls.evictions.push(model); return true; },
    async evictModelFile() { throw new Error("the protobuf heal is not this one"); },
  });
  assert.equal(await pool.use(REQUEST, {}, () => "ready"), "ready");
  assert.deepEqual(calls.evictions, ["birefnet"]);
  // Only what failed is loaded again: a session that started is kept, not created twice.
  assert.equal(calls.processor, failing === "model" ? 1 : 2);
  assert.equal(calls.model, failing === "processor" ? 1 : 2);
  assert.equal(state.disposals, 0);
  await pool.releaseAllIdle();
});

test("E05-01: a hub JSON that still does not parse is removed again and reported as the damaged copy; the context stays usable", async () => {
  const state = { modelLoads: 0, disposals: 0 };
  const good = workingFactories(state);
  let portal = true;
  const evictions: string[] = [];
  const pool = createRemovalEnginePool({
    ...good,
    async loadProcessor(...args) {
      if (portal) throw portalJson();
      return good.loadProcessor(...args);
    },
    async evictModelCache(model) { evictions.push(model); return true; },
  });
  const failure = await pool.use(REQUEST, {}, () => "unused").catch((error: unknown) => error);
  assert.equal(Reflect.get(failure as object, "code"), "removal-model-damaged");
  assert.match((failure as Error).message, /damaged and has been removed\. Try again\./);
  assert.equal(evictions.length, 2, "removed before the retry, and again after it");
  assert.equal(state.modelLoads, 1, "the model session that started is not loaded twice");
  assert.equal(state.disposals, 1, "and it is released with the failure");
  portal = false;
  assert.equal(await pool.use(REQUEST, {}, () => "ready"), "ready", "no quarantine: the next try loads fresh");
  await pool.releaseAllIdle();
});

test("E05-01: without a cache the JSON came from the network: one retry, then the ordinary load error", async () => {
  let processorLoads = 0;
  const good = workingFactories({ modelLoads: 0, disposals: 0 });
  const pool = createRemovalEnginePool({
    ...good,
    async loadProcessor() { processorLoads++; throw portalJson(); },
    async evictModelCache() { return false; },
  });
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), { name: "RemovalModelLoadError" });
  assert.equal(processorLoads, 2);
});

test("E05-01: other load failures and protobuf damage keep their own handling", async () => {
  let evictions = 0;
  const good = workingFactories({ modelLoads: 0, disposals: 0 });
  const pool = createRemovalEnginePool({
    ...good,
    async loadModel() { throw new Error("Failed to fetch"); },
    async evictModelCache() { evictions++; return true; },
  });
  await assert.rejects(pool.use(REQUEST, {}, () => "unused"), { name: "RemovalModelLoadError" });
  assert.equal(evictions, 0);
  const { isHubJsonFailure } = await import("./removal-model-specs.ts");
  for (const message of [
    `Unexpected token '<', "<html><bod"... is not valid JSON`,
    "Expected double-quoted property name in JSON at position 27",
    "Unexpected end of JSON input",
    "JSON.parse: unexpected character at line 1 column 1 of the JSON data",
    "JSON Parse error: Unrecognized token '<'",
  ]) assert.equal(isHubJsonFailure(new Error("wrapper", { cause: new SyntaxError(message) })), true, message);
  assert.equal(isHubJsonFailure(new SyntaxError("Unexpected identifier 'x'")), false);
  assert.equal(isHubJsonFailure(new Error("JSON body was fine but the session failed")), false, "only a parse failure");
  assert.equal(isHubJsonFailure(new Error("protobuf parsing failed")), false);
});

test("E05-01: the cache clean removes every file and revision of that model id only, and is truthful", async () => {
  const { evictRemovalModelCache } = await import("./removal-model-specs.ts");
  const hf = `https://huggingface.co/${REMOVAL_MODELS.birefnet.modelId}/resolve/${REMOVAL_MODELS.birefnet.revision}`;
  const keys = new Set([
    `${hf}/config.json`,
    `${hf}/preprocessor_config.json`,
    `${hf}/onnx/model_fp16.onnx`,
    `https://mirror.test/${REMOVAL_MODELS.birefnet.modelId}/resolve/other/config.json`,
    `https://huggingface.co/${REMOVAL_MODELS.isnet.modelId}/resolve/${REMOVAL_MODELS.isnet.revision}/config.json`,
    "https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/resolve/x/config.json",
  ]);
  const cache = { async keys() { return [...keys].map((url) => ({ url })); }, async delete(key: string) { return keys.delete(key); } };
  const store = { async open(name: string) { assert.equal(name, "transformers-cache"); return cache; } };
  assert.equal(await evictRemovalModelCache("birefnet", {}, store), true);
  assert.deepEqual([...keys].map((url) => url.split("/")[4]), ["isnet-general-onnx", "swin2SR-lightweight-x2-64"]);
  assert.equal(await evictRemovalModelCache("birefnet", {}, undefined), false, "no CacheStorage");
  assert.equal(await evictRemovalModelCache("birefnet", { useBrowserCache: false }, store), false, "disabled");
  assert.equal(await evictRemovalModelCache("birefnet", {}, { async open() { throw new Error("denied"); } }), false);
});


for (const context of ["page", "worker"] as const) {
  for (const file of ["onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"]) {
    for (const persistent of [false, true]) {
      test(`integrity ${context}/${file}: evict then retry once; persistent=${persistent}`, async () => {
        const { RemovalModelIntegrityError } = await import("./removal-model-integrity.ts");
        const state = { modelLoads: 0, disposals: 0 };
        const factories = workingFactories(state);
        const original = file === "preprocessor_config.json" ? factories.loadProcessor : factories.loadModel;
        let loads = 0;
        let evictions = 0;
        const load = async () => {
          loads++;
          if (persistent || loads === 1) throw new RemovalModelIntegrityError(file);
          // Both factory signatures differ only by a progress argument unused by the fixture.
          return Reflect.apply(original, factories, ["birefnet", "webgpu", () => {}]);
        };
        const pool = createRemovalEnginePool({
          ...factories,
          ...(file === "preprocessor_config.json" ? { loadProcessor: load } : { loadModel: load }),
          async evictModelCache() { evictions++; return false; }, // Private mode still gets one retry.
        });
        let uses = 0;
        const pending = pool.use({ ...REQUEST, context }, {}, () => { uses++; });
        if (persistent) await assert.rejects(pending, (error: unknown) => error instanceof RemovalModelIntegrityError && error.code === "removal-model-integrity");
        else await pending;
        assert.equal(loads, 2);
        assert.equal(evictions, persistent ? 2 : 1);
        assert.equal(uses, persistent ? 0 : 1, "no unverified engine is used");
        await pool.releaseAllIdle();
      });
    }
  }
}

test("WebGPU fp32 has its own pool identity and loader dtype, and evicts its own weights", async () => {
  const state = { modelLoads: 0, disposals: 0 };
  const factories = workingFactories(state);
  const dtypes: unknown[] = [];
  const pool = createRemovalEnginePool({ ...factories, async loadModel(model, provider, progress, dtype) {
    dtypes.push(dtype);
    return factories.loadModel(model, provider, progress, dtype);
  } });
  const fp32 = { ...REQUEST, dtype: "fp32" } as const;
  const half = await pool.use(REQUEST, {}, (engine) => engine.identity);
  const full = await pool.use(fp32, {}, (engine) => engine.identity);
  assert.equal(half.dtype, "fp16");
  assert.equal(full.dtype, "fp32");
  assert.equal(full.onnxFile, "model.onnx");
  await pool.use(fp32, {}, () => undefined);
  assert.deepEqual(dtypes, ["fp16", "fp32"]);
  assert.equal(state.modelLoads, 2);
  await pool.releaseAllIdle();
  assert.equal(state.disposals, 2);
  const { evictRemovalModelFile } = await import("./removal-model-specs.ts");
  const deleted: string[] = [];
  await evictRemovalModelFile(fp32, {}, { async open() {
    return { async delete(url: string) { deleted.push(url); return true; } };
  } });
  assert.equal(deleted.length, 1);
  assert.ok(deleted[0]?.endsWith("/onnx/model.onnx"));
});
