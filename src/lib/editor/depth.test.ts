import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { blendByDepth, quantile } from "./depth.ts";

const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  if (specifier.endsWith("/transformers.ts") && parent.includes("depth.ts"))
    return { url: "cutout-test:depth-tf", shortCircuit: true };
  const resolved = await next(specifier, context);
  const tag = /[?&]case=([^&#]+)/.exec(parent)?.[1];
  const inSource =
    resolved.url.startsWith("file:") &&
    resolved.url.includes("/src/") &&
    !resolved.url.includes("node_modules");
  if (tag && inSource && !resolved.url.includes("?"))
    return { ...resolved, url: resolved.url + "?case=" + tag };
  return resolved;
}
export async function load(url, context, next) {
  if (url === "cutout-test:depth-tf")
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function transformers(){return globalThis.__depthTf;} export function prefetchRuntime(){}",
    };
  return next(url, context);
}
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
  const handle = nativeSetTimeout(fn, ms as number, ...args);
  if (
    typeof ms === "number" &&
    ms > 1000 &&
    handle &&
    typeof handle === "object" &&
    "unref" in handle
  )
    (handle as NodeJS.Timeout).unref();
  return handle;
}) as typeof setTimeout;

type DepthModule = typeof import("./depth.ts");
type DepthRun = ((image: unknown) => Promise<unknown>) & { dispose?: () => Promise<unknown> };

type DepthAttempt = { device: "webgpu" | "wasm"; dtype: "fp16" | "fp32" | "q8" };

type DepthGate = {
  loads: number;
  runs: number;
  disposed: number;
  loadStarted: boolean;
  runStarted: boolean;
  attempts: DepthAttempt[];
  failGpu?: Error;
  runError?: Error;
  finishLoad: () => void;
  finishRun: () => void;
  failLoad: (error: Error) => void;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond: () => boolean, label: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 1000) throw new Error(`timed out waiting for ${label}`);
    await delay(0);
  }
}

function depthResult() {
  return { depth: { width: 2, height: 2, data: new Uint8Array(4).fill(128) } };
}

function installDepthTf(hold?: "load" | "run"): DepthGate {
  const gate: DepthGate = {
    loads: 0,
    runs: 0,
    disposed: 0,
    loadStarted: false,
    runStarted: false,
    attempts: [],
    finishLoad: () => {},
    finishRun: () => {},
    failLoad: () => {},
  };
  const makeRun = (): DepthRun => {
    const run: DepthRun = async () => {
      gate.runs += 1;
      gate.runStarted = true;
      if (gate.runError) throw gate.runError;
      if (hold === "run")
        return new Promise((resolve) => {
          gate.finishRun = () => resolve(depthResult());
        });
      return depthResult();
    };
    run.dispose = async () => {
      gate.disposed += 1;
    };
    return run;
  };
  (globalThis as { __depthTf?: unknown }).__depthTf = {
    env: {},
    RawImage: { fromBlob: async () => ({ width: 8, height: 8 }) },
    pipeline: async (_task: string, _model: string, options: DepthAttempt) => {
      gate.attempts.push({ device: options.device, dtype: options.dtype });
      gate.loads += 1;
      gate.loadStarted = true;
      if (options.device === "webgpu" && gate.failGpu) throw gate.failGpu;
      if (hold === "load")
        return new Promise((resolve, reject) => {
          gate.finishLoad = () => resolve(makeRun());
          gate.failLoad = reject;
        });
      return makeRun();
    },
  };
  return gate;
}

function stubGpu(features: string[] | null) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      gpu: {
        requestAdapter: async () => {
          if (features === null) return null;
          return {
            requestDevice: async () => ({}),
            features: { has: (name: string) => features.includes(name) },
          };
        },
      },
    },
  });
  return () => {
    if (previous) Object.defineProperty(globalThis, "navigator", previous);
    else Reflect.deleteProperty(globalThis, "navigator");
  };
}

let depthCase = 0;
async function loadDepth(): Promise<DepthModule> {
  depthCase += 1;
  return (await import(`./depth.ts?case=${depthCase}`)) as DepthModule;
}

function photo() {
  return new File([new Uint8Array([1, 2, 3, 4])], "source.png", { type: "image/png" });
}

async function promptly<T>(pending: Promise<T>, ms = 40) {
  return Promise.race([pending, delay(ms).then(() => "pending")]);
}

test("quantile reads the sorted sample", () => {
  const spread = new Float32Array(64).map((_, i) => i / 63);
  assert.equal(quantile(spread, 0), 0);
  assert.equal(quantile(spread, 1), 1);
  assert.ok(quantile(spread, 0.5) > 0.4 && quantile(spread, 0.5) < 0.6);
});

test("blendByDepth takes the light blur where near, the full blur where far", () => {
  const w = 64,
    h = 1;
  const light = new Uint8ClampedArray(w * h * 4).fill(10);
  const medium = new Uint8ClampedArray(w * h * 4).fill(100);
  const full = new Uint8ClampedArray(w * h * 4).fill(200);
  const out = new Uint8ClampedArray(w * h * 4);
  // depth rises left to right: far on the left, near on the right
  const depth = new Float32Array(w).map((_, i) => i / (w - 1));
  blendByDepth(out, light, medium, full, w, h, { data: depth, width: w, height: 1 });
  assert.equal(out[0], 200); // far
  assert.equal(out[(w - 1) * 4], 10); // near
  assert.equal(out[3], 255);
  const middle = out[Math.floor(w / 2) * 4]!;
  assert.ok(middle > 10 && middle < 200, `${middle}`);
  // monotonic: sharper as depth increases
  for (let x = 1; x < w; x++) assert.ok(out[x * 4]! <= out[(x - 1) * 4]!, `x=${x}`);
});

test("an already-aborted depthOf starts no model work", async () => {
  const { depthOf } = await loadDepth();
  const gate = installDepthTf("load");
  const controller = new AbortController();
  const reason = new Error("preabort");
  controller.abort(reason);
  try {
    const result = await promptly(
      depthOf(photo(), undefined, controller.signal).then(
        () => "published",
        (error: unknown) => error,
      ),
    );
    assert.equal(result, reason);
    assert.equal(gate.loads, 0);
    assert.equal(gate.runs, 0);
  } finally {
    gate.finishLoad();
  }
});

test("abort during depth load rejects with the caller's reason and keeps shared work", async () => {
  const { depthOf } = await loadDepth();
  const gate = installDepthTf("load");
  const source = photo();
  const controller = new AbortController();
  const reason = new Error("switched-away");
  try {
    const cancelled = depthOf(source, undefined, controller.signal).then(
      () => "published",
      (error: unknown) => error,
    );
    await waitUntil(() => gate.loadStarted, "depth load");
    const live = depthOf(source);
    controller.abort(reason);
    assert.equal(await promptly(cancelled), reason);
    assert.equal(gate.loads, 1);
    assert.equal(gate.disposed, 0);
    gate.finishLoad();
    const map = await live;
    assert.equal(map.width, 2);
    assert.equal(map.height, 2);
    assert.equal(map.data.length, 4);
    const cached = await depthOf(source);
    assert.equal(cached, map);
    assert.equal(gate.loads, 1);
    assert.equal(gate.runs, 1);
    assert.equal(gate.disposed, 0);
  } finally {
    gate.finishLoad();
  }
});

test("abort during depth inference rejects promptly without discarding a live waiter", async () => {
  const { depthOf } = await loadDepth();
  const gate = installDepthTf("run");
  const source = photo();
  const controller = new AbortController();
  const reason = new DOMException("left", "AbortError");
  try {
    const cancelled = depthOf(source, undefined, controller.signal).then(
      () => "published",
      (error: unknown) => error,
    );
    await waitUntil(() => gate.runStarted, "depth inference");
    const live = depthOf(source);
    controller.abort(reason);
    assert.equal(await promptly(cancelled), reason);
    assert.equal(gate.disposed, 0);
    gate.finishRun();
    const map = await live;
    assert.equal(await depthOf(source), map);
    assert.equal(gate.loads, 1);
    assert.equal(gate.runs, 1);
    assert.equal(gate.disposed, 0);
  } finally {
    gate.finishRun();
  }
});

test("prepareDepth cancel during load rejects the waiter without disposing a shared session", async () => {
  const { prepareDepth, depthOf } = await loadDepth();
  const gate = installDepthTf("load");
  const controller = new AbortController();
  const reason = new DOMException("panel closed", "AbortError");
  const source = photo();
  try {
    const cancelled = prepareDepth(undefined, { signal: controller.signal });
    await waitUntil(() => gate.loadStarted, "prepareDepth load");
    const live = depthOf(source);
    controller.abort(reason);
    await assert.rejects(cancelled, (error: unknown) => error === reason);
    assert.equal(gate.disposed, 0);
    gate.finishLoad();
    assert.equal((await live).width, 2);
    assert.equal(gate.loads, 1);
  } finally {
    gate.finishLoad();
  }
});

test("prepareDepth cancel of a never-settling load then a healthy retry starts a new load", async () => {
  const { prepareDepth } = await loadDepth();
  const gate = installDepthTf("load");
  const controller = new AbortController();
  const cancelled = prepareDepth(undefined, { signal: controller.signal, timeoutMs: 1_000 });
  await waitUntil(() => gate.loadStarted, "first prepareDepth load");
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  const retry = prepareDepth(undefined, { timeoutMs: 1_000 });
  await waitUntil(() => gate.loads >= 2, "retry load after cancel");
  gate.finishLoad();
  await retry;
  assert.ok(gate.loads >= 2);
});

test("prepareDepth timeout then a healthy retry starts a new load", async () => {
  const { prepareDepth } = await loadDepth();
  const gate = installDepthTf("load");
  const pending = prepareDepth(undefined, { timeoutMs: 40 });
  await waitUntil(() => gate.loadStarted, "first prepareDepth load");
  await assert.rejects(pending, (error: unknown) => {
    assert.equal(error instanceof DOMException && error.name === "TimeoutError", true);
    return true;
  });
  const retry = prepareDepth();
  await waitUntil(() => gate.loads >= 2, "retry load");
  gate.finishLoad();
  await retry;
  assert.ok(gate.loads >= 2);
});

test("a GPU without shader-f16 skips fp16 and loads fp32", async () => {
  const restore = stubGpu([]);
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    await prepareDepth();
    assert.deepEqual(gate.attempts, [{ device: "webgpu", dtype: "fp32" }]);
  } finally {
    restore();
  }
});

test("shader-f16 adapters still try fp16 first", async () => {
  const restore = stubGpu(["shader-f16"]);
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    await prepareDepth();
    assert.equal(gate.attempts[0]?.device, "webgpu");
    assert.equal(gate.attempts[0]?.dtype, "fp16");
  } finally {
    restore();
  }
});

test("failed WebGPU initialization still reaches WASM", async () => {
  const restore = stubGpu(["shader-f16"]);
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error("Failed to create a GPUDevice");
    await prepareDepth();
    assert.ok(gate.attempts.some((attempt) => attempt.device === "webgpu"));
    assert.equal(gate.attempts.at(-1)?.device, "wasm");
    assert.equal(gate.attempts.at(-1)?.dtype, "q8");
  } finally {
    restore();
  }
});

test("device loss during depth inference reloads on the next prepare", async () => {
  const restore = stubGpu(["shader-f16"]);
  try {
    const { depthOf, prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.runError = new Error("The GPUDevice was lost.");
    await assert.rejects(depthOf(photo()), /device was lost/i);
    gate.runError = undefined;
    await prepareDepth();
    assert.ok(gate.loads >= 2, "lost session must not be reused");
  } finally {
    restore();
  }
});

test("no adapter loads WASM only", async () => {
  const restore = stubGpu(null);
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    await prepareDepth();
    assert.deepEqual(gate.attempts, [{ device: "wasm", dtype: "q8" }]);
  } finally {
    restore();
  }
});

class FakeDepthWorker extends EventTarget {
  static instances: FakeDepthWorker[] = [];
  static failNextLoad: string | null = null;
  static silent = false;
  static hangInfer = false;
  static throwOnInfer = false;
  terminated = false;
  sent: Array<{ type: string; attempt?: { device: string; dtype: string }; id?: number }> = [];
  constructor(_url?: URL | string, _opts?: { type?: string }) {
    super();
    FakeDepthWorker.instances.push(this);
  }
  postMessage(data: { type: string; attempt?: { device: string; dtype: string }; id?: number }) {
    this.sent.push(data);
    if (data.type === "infer" && FakeDepthWorker.throwOnInfer) throw new Error("DataCloneError");
    if (FakeDepthWorker.silent) return;
    if (data.type === "infer" && FakeDepthWorker.hangInfer) return;
    queueMicrotask(() => {
      if (this.terminated) return;
      if (data.type === "load") {
        const fail = FakeDepthWorker.failNextLoad;
        FakeDepthWorker.failNextLoad = null;
        if (fail) {
          this.dispatchEvent(
            new MessageEvent("message", { data: { type: "error", message: fail } }),
          );
          return;
        }
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "loaded", device: data.attempt?.device === "wasm" ? "wasm" : "webgpu" },
          }),
        );
        return;
      }
      if (data.type === "infer") {
        const bytes = new Uint8Array([128, 128, 128, 128]);
        this.dispatchEvent(
          new MessageEvent("message", {
            data: { type: "map", id: data.id, bytes: bytes.buffer, width: 2, height: 2 },
          }),
        );
      }
    });
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  terminate() {
    this.terminated = true;
  }
}

const INIT_POISON =
  "no available backend found. ERR: [webgpu] OperationError: injected requestDevice failure (ORT WebGPU INIT)";

function installDepthWorkerEnv() {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  FakeDepthWorker.instances = [];
  FakeDepthWorker.failNextLoad = null;
  FakeDepthWorker.silent = false;
  FakeDepthWorker.hangInfer = false;
  FakeDepthWorker.throwOnInfer = false;
  const scope = new EventTarget();
  install("document", Object.assign(new EventTarget(), { hidden: false }));
  install("addEventListener", scope.addEventListener.bind(scope));
  install("removeEventListener", scope.removeEventListener.bind(scope));
  install("Worker", FakeDepthWorker);
  return {
    restore() {
      FakeDepthWorker.failNextLoad = null;
      FakeDepthWorker.silent = false;
      FakeDepthWorker.hangInfer = false;
      FakeDepthWorker.throwOnInfer = false;
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function loadAttempt(worker: FakeDepthWorker | undefined) {
  return worker?.sent.find((message) => message.type === "load")?.attempt;
}

async function flush(n = 40) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function interceptWorkerBounds() {
  const previousTimeout = globalThis.setTimeout;
  const previousClear = globalThis.clearTimeout;
  const deferred = new Map<number, () => void>();
  let next = 1;
  globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    if (ms === 120_000) {
      const id = next++;
      deferred.set(id, () => {
        if (typeof fn === "function") (fn as (...rest: unknown[]) => void)(...args);
      });
      return id as unknown as ReturnType<typeof setTimeout>;
    }
    return previousTimeout(fn, ms as number, ...args);
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    if (typeof handle === "number" && deferred.has(handle)) {
      deferred.delete(handle);
      return;
    }
    previousClear(handle);
  }) as typeof clearTimeout;
  return {
    deferred,
    fireAll() {
      const callbacks = [...deferred.values()];
      deferred.clear();
      for (const callback of callbacks) callback();
    },
    restore() {
      globalThis.setTimeout = previousTimeout;
      globalThis.clearTimeout = previousClear;
    },
  };
}

test("looksLikeOrtInitPoison ignores network and content failures", async () => {
  const { looksLikeOrtInitPoison } = await loadDepth();
  assert.equal(looksLikeOrtInitPoison(new Error(INIT_POISON)), true);
  assert.equal(looksLikeOrtInitPoison(new Error("Failed to create a GPUDevice")), true);
  assert.equal(looksLikeOrtInitPoison(new Error("previous call to 'initWasm()' failed")), true);
  assert.equal(
    looksLikeOrtInitPoison(new Error("(503) occurred while trying to load file")),
    false,
  );
  assert.equal(looksLikeOrtInitPoison(new Error("Failed to fetch")), false);
  assert.equal(looksLikeOrtInitPoison(new Error("network error")), false);
  assert.equal(looksLikeOrtInitPoison(new Error("offline")), false);
  assert.equal(looksLikeOrtInitPoison(new Error("429 Too Many Requests")), false);
  assert.equal(looksLikeOrtInitPoison(new Error("Failed to parse JSON")), false);
});

test("poisoned WebGPU fp16 recovers through a fresh fp32 worker before WASM", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  try {
    const { depthOf } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    const map = await depthOf(photo());
    assert.equal(FakeDepthWorker.instances.length, 1);
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances[0]), {
      device: "webgpu",
      dtype: "fp32",
    });
    assert.deepEqual(gate.attempts, [{ device: "webgpu", dtype: "fp16" }]);
    assert.equal(map.device, "webgpu");
    assert.equal(map.width, 2);
    assert.equal(map.height, 2);
    assert.equal(map.data.length, 4);
    for (const value of map.data) assert.equal(value, Math.fround(128 / 255));
  } finally {
    env.restore();
    restoreGpu();
  }
});

test("a later prepare after page poison tries the page again, then a fresh fp32 worker", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    await prepareDepth();
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances[0]), {
      device: "webgpu",
      dtype: "fp32",
    });
    await prepareDepth();
    assert.equal(FakeDepthWorker.instances.length, 2);
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances[1]), {
      device: "webgpu",
      dtype: "fp32",
    });
    assert.deepEqual(
      gate.attempts.filter((attempt) => attempt.dtype === "fp16"),
      [
        { device: "webgpu", dtype: "fp16" },
        { device: "webgpu", dtype: "fp16" },
      ],
    );
  } finally {
    env.restore();
    restoreGpu();
  }
});

test("a worker fp32 init poison retires it and loads WASM in a fresh worker", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    FakeDepthWorker.failNextLoad = INIT_POISON;
    await prepareDepth();
    assert.equal(FakeDepthWorker.instances.length, 2);
    const gpuWorker = FakeDepthWorker.instances[0]!;
    const wasmWorker = FakeDepthWorker.instances[1]!;
    assert.deepEqual(loadAttempt(gpuWorker), { device: "webgpu", dtype: "fp32" });
    assert.equal(gpuWorker.terminated, true);
    assert.deepEqual(loadAttempt(wasmWorker), { device: "wasm", dtype: "q8" });
    assert.deepEqual(gate.attempts, [{ device: "webgpu", dtype: "fp16" }]);
  } finally {
    env.restore();
    restoreGpu();
  }
});

test("WASM worker depth maps match the page pipeline on the same fixture bytes", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  try {
    const page = await loadDepth();
    const pageGate = installDepthTf();
    const pageMap = await page.depthOf(photo());
    assert.equal(pageMap.device, "webgpu");
    const env = installDepthWorkerEnv();
    try {
      const isolated = await loadDepth();
      const gate = installDepthTf();
      gate.failGpu = new Error(INIT_POISON);
      FakeDepthWorker.failNextLoad = INIT_POISON;
      const workerMap = await isolated.depthOf(photo());
      assert.equal(workerMap.device, "wasm");
      assert.equal(workerMap.width, pageMap.width);
      assert.equal(workerMap.height, pageMap.height);
      assert.deepEqual([...workerMap.data], [...pageMap.data]);
      assert.equal(pageGate.attempts[0]?.device, "webgpu");
      assert.deepEqual(gate.attempts, [{ device: "webgpu", dtype: "fp16" }]);
      assert.deepEqual(loadAttempt(FakeDepthWorker.instances.at(-1)), {
        device: "wasm",
        dtype: "q8",
      });
    } finally {
      env.restore();
    }
  } finally {
    restoreGpu();
  }
});

test("a never-settling page init retries fp16 in a fresh worker", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  const gate = installDepthTf("load");
  try {
    const { prepareDepth } = await loadDepth();
    const timedOut = prepareDepth(undefined, { timeoutMs: 40 });
    await waitUntil(() => gate.loadStarted, "never-settling page load");
    await assert.rejects(timedOut, (error: unknown) => {
      assert.equal(error instanceof DOMException && error.name === "TimeoutError", true);
      return true;
    });
    assert.equal(FakeDepthWorker.instances.length, 0);
    assert.equal(gate.loads, 1);
    const retry = prepareDepth();
    await waitUntil(
      () => FakeDepthWorker.instances.length >= 1,
      "fp16 worker after abandoned page init",
    );
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances[0]), {
      device: "webgpu",
      dtype: "fp16",
    });
    await retry;
    assert.equal(gate.loads, 1, "retry must not join the page pipeline still in flight");
    await prepareDepth();
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances.at(-1)), {
      device: "webgpu",
      dtype: "fp16",
    });
    assert.ok(FakeDepthWorker.instances.length >= 2);
  } finally {
    gate.finishLoad();
    env.restore();
    restoreGpu();
  }
});

test("a network model error does not spawn a worker or stick as GPU failure", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error("(503) occurred while trying to load file");
    await prepareDepth();
    assert.equal(FakeDepthWorker.instances.length, 0);
    assert.equal(gate.attempts.at(-1)?.device, "wasm");
    await prepareDepth();
    assert.equal(FakeDepthWorker.instances.length, 0);
    assert.ok(gate.attempts.filter((attempt) => attempt.device === "wasm").length >= 2);
  } finally {
    env.restore();
    restoreGpu();
  }
});

test("endless worker progress still hits the absolute 120s load bound", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  const bounds = interceptWorkerBounds();
  try {
    const { prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    FakeDepthWorker.silent = true;
    const pending = prepareDepth();
    await flush();
    const worker = FakeDepthWorker.instances[0]!;
    assert.ok(worker, "poisoned page load must start a worker");
    assert.equal(bounds.deferred.size, 1, "one absolute load timer");
    worker.receive({ type: "progress", fraction: 0.5 });
    await flush();
    assert.equal(bounds.deferred.size, 1, "progress must not start a new load timer");
    assert.equal(worker.terminated, false);
    FakeDepthWorker.silent = false;
    bounds.fireAll();
    await pending;
    assert.equal(worker.terminated, true);
    assert.ok(FakeDepthWorker.instances.length >= 2);
    assert.deepEqual(loadAttempt(FakeDepthWorker.instances.at(-1)), {
      device: "wasm",
      dtype: "q8",
    });
  } finally {
    bounds.restore();
    env.restore();
    restoreGpu();
  }
});

test("loaded worker infer timeout rejects siblings, terminates, and prepare reloads", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  const bounds = interceptWorkerBounds();
  try {
    const { depthOf, prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    FakeDepthWorker.hangInfer = true;
    const first = photo();
    const second = photo();
    const a = depthOf(first);
    await flush();
    const worker = FakeDepthWorker.instances[0]!;
    assert.ok(worker, "poisoned page load must start a worker");
    const b = depthOf(second);
    await flush();
    assert.equal(worker.sent.filter((message) => message.type === "infer").length, 2);
    const rejectedA = assert.rejects(a, /stopped responding/);
    const rejectedB = assert.rejects(b, /stopped responding/);
    bounds.fireAll();
    await rejectedA;
    await rejectedB;
    assert.equal(worker.terminated, true);
    FakeDepthWorker.hangInfer = false;
    await prepareDepth();
    const retry = FakeDepthWorker.instances.at(-1)!;
    assert.notEqual(retry, worker);
    assert.deepEqual(loadAttempt(retry), { device: "webgpu", dtype: "fp32" });
  } finally {
    bounds.restore();
    env.restore();
    restoreGpu();
  }
});

test("synchronous infer postMessage throw deletes the waiter and prepare reloads", async () => {
  const restoreGpu = stubGpu(["shader-f16"]);
  const env = installDepthWorkerEnv();
  try {
    const { depthOf, prepareDepth } = await loadDepth();
    const gate = installDepthTf();
    gate.failGpu = new Error(INIT_POISON);
    FakeDepthWorker.throwOnInfer = true;
    const pending = depthOf(photo());
    const result = await promptly(
      pending.then(
        () => "published",
        (error: unknown) => error,
      ),
    );
    assert.ok(
      result instanceof Error && /Depth worker failed/.test(result.message),
      String(result),
    );
    const worker = FakeDepthWorker.instances[0]!;
    assert.equal(worker.terminated, true);
    FakeDepthWorker.throwOnInfer = false;
    await prepareDepth();
    const retry = FakeDepthWorker.instances.at(-1)!;
    assert.notEqual(retry, worker);
    assert.equal(retry.terminated, true);
  } finally {
    env.restore();
    restoreGpu();
  }
});
