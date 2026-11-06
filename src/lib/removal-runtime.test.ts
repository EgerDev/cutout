import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { failureCode, isRetryableEngineError } from "./errors.ts";
import {
  RemovalModelLoadError,
  RemovalModelOutputError,
  createRemovalEnginePool,
  type RemovalLoadFactories,
  type RemovalLoadProgress,
} from "./removal-model.ts";
import {
  ENGINE_ERROR_NAMES,
  clearRemovalFailureRecords,
  readGpuFailure,
  rememberGpuFailure,
  webgpuLoadMemo,
  type RemovalModelKind,
  type RemovalProvider,
} from "./removal-provider.ts";
import {
  createRemovalRuntime,
  engineErrorFor,
  isAbort,
  isGpuSuspectMask,
  maskError,
  removalRuntime,
} from "./removal-runtime.ts";

const WEBGPU = { model: "birefnet", provider: "webgpu" } as const;
const WASM = { model: "birefnet", provider: "wasm" } as const;
const ISNET = { model: "isnet", provider: "wasm" } as const;

type Deferred = { promise: Promise<void>; resolve(): void; reject(error: unknown): void };
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks and I/O-free callbacks run. */
async function flush(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(condition: () => boolean): Promise<void> {
  for (let round = 0; round < 200 && !condition(); round += 1) await flush(1);
  assert.ok(condition(), "condition never became true");
}

function bounded<T>(promise: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timed out (deadlock?)")), ms).unref(),
    ),
  ]);
}

const DIMS = {
  birefnet: { input: [1, 3, 512, 512], output: [1, 1, 512, 512], outputName: "output_image" },
  isnet: { input: [1, 3, 1024, 1024], output: [1, 1, 1024, 1024], outputName: "output" },
} as const;

function tensor(dims: readonly number[], fill = 0.5) {
  const size = dims.reduce((total, dimension) => total * dimension, 1);
  const data = new Float32Array(size).fill(fill);
  return {
    data,
    dims,
    disposed: 0,
    sigmoids: 0,
    dispose() {
      this.disposed += 1;
    },
    sigmoid() {
      this.sigmoids += 1;
      return this;
    },
  };
}

type Step = "ok" | Error | Deferred;

/** A fake pool boundary with an event log, a live-model counter and scripted loads. */
function harness(options: { gpu?: boolean } = {}) {
  const log: string[] = [];
  const counts = new Map<string, number>();
  const script = new Map<string, Step[]>();
  const progressByKey = new Map<string, RemovalLoadProgress[]>();
  const disposeFailures = new Set<string>();
  const modelOutput = new Map<string, () => unknown>();
  const processorOutput = new Map<string, () => unknown>();
  let live = 0;
  let maxLive = 0;
  const factories: RemovalLoadFactories = {
    async loadProcessor(model) {
      log.push(`processor:${model}`);
      return async () =>
        processorOutput.get(model)?.() ?? { pixel_values: tensor(DIMS[model].input) };
    },
    async loadModel(model: RemovalModelKind, provider: RemovalProvider, progress) {
      const key = `${model}:${provider}`;
      log.push(`load:${key}`);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      await null; // the pool subscribes right after it starts the load
      for (const event of progressByKey.get(key) ?? []) progress(event);
      const step = script.get(key)?.shift();
      if (step instanceof Error) throw step;
      if (step && step !== "ok") await step.promise;
      log.push(`ready:${key}`);
      live += 1;
      maxLive = Math.max(maxLive, live);
      return Object.assign(
        async () =>
          modelOutput.get(key)?.() ?? { [DIMS[model].outputName]: tensor(DIMS[model].output) },
        {
          async dispose() {
            log.push(`dispose:${key}`);
            live -= 1;
            if (disposeFailures.has(key)) throw new Error(`dispose failed ${key}`);
          },
        },
      );
    },
  };
  const pool = createRemovalEnginePool(factories);
  // The runtime wraps the pool's own rejection; this wrapper records what the pool threw.
  const poolErrors: unknown[] = [];
  const recordingPool: typeof pool = {
    ...pool,
    async use(request, opts, run) {
      try {
        return await pool.use(request, opts, run);
      } catch (error) {
        poolErrors.push(error);
        throw error;
      }
    },
  };
  const runtime = createRemovalRuntime({
    pool: recordingPool,
    adapter: async () => (options.gpu === false ? null : {}),
  });
  return {
    runtime,
    factories,
    log,
    script,
    progressByKey,
    disposeFailures,
    modelOutput,
    processorOutput,
    poolErrors,
    count: (key: string) => counts.get(key) ?? 0,
    live: () => live,
    maxLive: () => maxLive,
    index: (entry: string, from = 0) => log.indexOf(entry, from),
  };
}
type Harness = ReturnType<typeof harness>;

const failFetch = () => new Error("Failed to fetch");
const failInit = () => new Error("WebGPU session creation failed");

let originalNavigator: PropertyDescriptor | undefined;
function stubNavigator(value: unknown): void {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

beforeEach(() => {
  originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  stubNavigator({ userAgent: "removal-runtime-test" });
  clearRemovalFailureRecords(null);
});
afterEach(() => {
  clearRemovalFailureRecords(null);
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
});

// ---------------------------------------------------------------------------------------
// Surface
// ---------------------------------------------------------------------------------------

test("the module exports a process singleton and the whole documented surface", () => {
  for (const name of [
    "automaticRoute",
    "exclusive",
    "use",
    "usePrimary",
    "jobInfo",
    "recordCleanupFailure",
    "cleanupErrors",
    "recordProvenance",
    "provenance",
  ] as const)
    assert.equal(typeof removalRuntime[name], "function", name);
  assert.equal(typeof isAbort, "function");
  assert.equal(typeof maskError, "function");
  assert.equal(typeof isGpuSuspectMask, "function");
  assert.equal(typeof engineErrorFor, "function");
});

test("isAbort is name-based, honours an aborted signal, and ignores other errors", () => {
  const controller = new AbortController();
  assert.equal(isAbort(new Error("boom")), false);
  assert.equal(isAbort(new Error("boom"), controller.signal), false);
  assert.equal(isAbort(new DOMException("x", "AbortError")), true);
  assert.equal(isAbort(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isAbort("not an error"), false);
  controller.abort();
  assert.equal(isAbort(new Error("boom"), controller.signal), true);
});

test("maskError keeps the original MaskError shape and now preserves a cause", () => {
  const plain = maskError("flat");
  assert.equal(plain.name, "MaskError");
  assert.equal(plain.message, "flat");
  assert.equal((plain as { gpuSuspect?: boolean }).gpuSuspect, false);
  assert.equal(isGpuSuspectMask(plain), false);
  const cause = new Error("inner");
  const suspect = maskError("nan", true, cause);
  assert.equal(suspect.cause, cause);
  assert.equal(isGpuSuspectMask(suspect), true);
  assert.equal(isGpuSuspectMask(Object.assign(new Error("x"), { gpuSuspect: true })), false);
  assert.equal(isGpuSuspectMask("MaskError"), false);
});

// ---------------------------------------------------------------------------------------
// Q1 / Q2: boundary mapping
// ---------------------------------------------------------------------------------------

async function rawBoundaryError(
  h: Harness,
  provider: RemovalProvider,
  stage: "processor" | "model",
): Promise<unknown> {
  const pool = createRemovalEnginePool(h.factories);
  try {
    await pool.use({ model: "birefnet", provider, context: "page" }, {}, async (engine) => {
      if (stage === "processor") await engine.processor({});
      else await engine.model({ input_image: {} });
    });
  } catch (error) {
    return error;
  }
  throw new Error("expected the boundary to throw");
}

test("Q1: adapter output errors map to the original engine errors", async () => {
  // D1: missing output stays non-persistent; C16 retains GPU evidence for a returned malformed tensor.
  for (const provider of ["webgpu", "wasm"] as const) {
    const nonfinite = tensor(DIMS.birefnet.output);
    nonfinite.data[0] = Number.NaN;
    const cases: Array<[string, () => unknown, string, boolean]> = [
      [
        "nonfinite",
        () => ({ output_image: nonfinite }),
        "The model returned an invalid alpha mask",
        provider === "webgpu",
      ],
      [
        "malformed",
        () => ({ output_image: tensor([1, 1, 4, 4]) }),
        "The model returned an invalid mask shape",
        provider === "webgpu",
      ],
      ["missing (Q2/D1)", () => ({}), "The model returned an invalid mask shape", false],
    ];
    for (const [label, output, message, suspect] of cases) {
      const h = harness();
      h.modelOutput.set(`birefnet:${provider}`, output);
      const raw = await rawBoundaryError(h, provider, "model");
      assert.ok(
        raw instanceof RemovalModelOutputError,
        `${provider} ${label}: pool raises its output error`,
      );
      const mapped = engineErrorFor(raw, "model", provider) as Error & { gpuSuspect?: boolean };
      assert.equal(mapped.name, "MaskError", `${provider} ${label}`);
      assert.equal(mapped.message, message, `${provider} ${label}`);
      assert.equal(mapped.gpuSuspect, suspect, `${provider} ${label}`);
      assert.ok(
        mapped.cause instanceof RemovalModelOutputError,
        `${provider} ${label}: cause kept`,
      );
      assert.equal(mapped.cause, raw);
      assert.equal(isRetryableEngineError(mapped) || mapped.name === "MaskError", true);
    }
    const h = harness();
    h.processorOutput.set("birefnet", () => ({ pixel_values: tensor([1, 3, 2, 2]) }));
    const raw = await rawBoundaryError(h, provider, "processor");
    assert.ok(raw instanceof RemovalModelOutputError);
    const mapped = engineErrorFor(raw, "processor", provider) as Error;
    assert.equal(mapped.name, "RemovalInputError");
    assert.equal(mapped.message, "Image preprocessing failed");
    assert.equal(mapped.cause, raw);
  }
});

test("Q1: a processor throw keeps its message verbatim in a RemovalInputError", () => {
  const raw = new Error("processor exploded");
  const mapped = engineErrorFor(raw, "processor", "wasm") as Error;
  assert.equal(mapped.name, "RemovalInputError");
  assert.equal(mapped.message, "processor exploded");
  assert.equal(mapped.cause, raw);
  assert.equal(Reflect.get(mapped, "code"), undefined);
  assert.ok(ENGINE_ERROR_NAMES.has(mapped.name));
});

test("Q1: raw model boundary throws are named, verbatim, and only the job's aborted signal passes one through", () => {
  const lost = new Error("WebGPU device lost");
  const mapped = engineErrorFor(lost, "model", "webgpu") as Error & { code?: string };
  assert.equal(mapped.name, "RemovalInferenceError");
  assert.equal(mapped.message, "WebGPU device lost");
  assert.equal(mapped.cause, lost);
  assert.equal(mapped.code, "inference-failed");
  assert.equal(isRetryableEngineError(mapped), true);
  assert.ok(ENGINE_ERROR_NAMES.has(mapped.name));

  const memory = engineErrorFor(new Error("out of memory"), "model", "wasm") as Error & {
    code?: string;
  };
  assert.equal(memory.name, "RemovalInferenceError");
  assert.equal(memory.code, undefined, "memory keeps its non-retryable precedence");
  assert.equal(failureCode(memory), "memory");

  // Abort identity is the job's signal (C05): an error only named AbortError (a lost device's readback,
  // the worker's rebuilt reply), with no signal or a live one, is a failure, never passed through as a cancel.
  const readback = new DOMException("Device is lost", "AbortError");
  const named = Object.assign(new Error("x"), { name: "AbortError" });
  for (const signal of [undefined, new AbortController().signal]) {
    const asModel = engineErrorFor(readback, "model", "webgpu", signal) as Error & {
      code?: string;
    };
    assert.deepEqual(
      [asModel.name, asModel.code, asModel.cause],
      ["RemovalInferenceError", "inference-failed", readback],
    );
    assert.equal(isRetryableEngineError(asModel), true);
    assert.equal(
      (engineErrorFor(named, "processor", "wasm", signal) as Error).name,
      "RemovalInputError",
    );
  }
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    engineErrorFor(readback, "model", "webgpu", controller.signal),
    readback,
    "a real cancel passes through",
  );
  const plain = new Error("whatever");
  assert.equal(
    engineErrorFor(plain, "model", "wasm", controller.signal),
    plain,
    "an aborted signal wins",
  );
});

test("Q1 (N1): an opaque inference throw is retryable and coded", () => {
  // documents D4: minting inference-failed is a deviation from 5522, not a restoration.
  const mapped = engineErrorFor(new Error("ORT session run failed"), "model", "webgpu") as Error & {
    code?: string;
  };
  assert.equal(isRetryableEngineError(mapped), true);
  assert.equal(failureCode(mapped), "model");
  assert.equal(mapped.code, "inference-failed");
  // Pin: the raw error classifies unknown, so without the mint there is no compatibility pass.
  assert.equal(isRetryableEngineError(new Error("ORT session run failed")), false);
});

test("Q1 (F2): Aborted() crashes are coded inference failures, never cancellations", () => {
  // documents D4: the mint classifies model/retryable instead of a silent cancelled requeue.
  for (const message of ["Aborted()", "Aborted(OOM)"]) {
    const crash = Object.assign(new Error(message), { name: "RuntimeError" });
    const mapped = engineErrorFor(crash, "model", "wasm") as Error & { code?: string };
    assert.equal(mapped.name, "RemovalInferenceError", message);
    assert.equal(mapped.code, "inference-failed", message);
    assert.equal(failureCode(mapped), "model", message);
    assert.notEqual(failureCode(mapped), "cancelled", message);
    assert.equal(isRetryableEngineError(mapped), true, message);
  }
});

test("Q1: browser and updated causes keep their precedence instead of the inference code", () => {
  for (const [message, code] of [
    ["OffscreenCanvas not supported", "browser"],
    ["error loading dynamically imported module", "updated"],
  ] as const) {
    const mapped = engineErrorFor(new Error(message), "model", "wasm") as Error & { code?: string };
    assert.equal(mapped.code, undefined, message);
    assert.equal(failureCode(mapped), code, message);
  }
});

test("Q12: every minted engine error name is in the worker rethrow allowlist", () => {
  const minted = [
    maskError("x"),
    engineErrorFor(new Error("x"), "model", "wasm"),
    engineErrorFor(new Error("x"), "processor", "wasm"),
  ] as Error[];
  for (const error of minted) assert.ok(ENGINE_ERROR_NAMES.has(error.name), error.name);
});

// ---------------------------------------------------------------------------------------
// Q4: lock, release, one live model
// ---------------------------------------------------------------------------------------

test("Q4 (a): job B waits while A holds the lock and starts no load", async () => {
  const h = harness();
  const hold = deferred();
  const order: string[] = [];
  const jobA = h.runtime.exclusive(undefined, async () => {
    order.push("A-start");
    await hold.promise;
    order.push("A-end");
  });
  const jobB = h.runtime.exclusive(undefined, async () => {
    order.push("B-start");
    return h.runtime.use(WASM, {}, () => "b");
  });
  await flush();
  assert.deepEqual(order, ["A-start"]);
  assert.equal(h.count("birefnet:wasm"), 0);
  hold.resolve();
  await jobA;
  assert.equal(await jobB, "b");
  assert.deepEqual(order, ["A-start", "A-end", "B-start"]);
});

test("Q4 (b): B aborted while waiting rejects with its exact reason and never loads; A completes", async () => {
  const h = harness();
  const hold = deferred();
  const jobA = h.runtime.exclusive(undefined, async () => {
    await hold.promise;
    return "a";
  });
  const controller = new AbortController();
  let bRan = false;
  const jobB = h.runtime.exclusive(controller.signal, async () => {
    bRan = true;
    return h.runtime.use(WASM, { signal: controller.signal }, () => "b");
  });
  await flush();
  const reason = new Error("stop B");
  controller.abort(reason);
  await assert.rejects(jobB, (error) => error === reason);
  hold.resolve();
  assert.equal(await jobA, "a");
  await flush();
  assert.equal(bRan, false, "an aborted waiter's turn does not run its body");
  assert.equal(h.count("birefnet:wasm"), 0);
});

test("Q4 (b): an already aborted signal rejects at once with the reason", async () => {
  const h = harness();
  const controller = new AbortController();
  const reason = Symbol("pre-aborted");
  controller.abort(reason);
  await assert.rejects(
    h.runtime.exclusive(controller.signal, async () => "never"),
    (error) => error === reason,
  );
  assert.equal(
    await h.runtime.exclusive(undefined, async () => "next"),
    "next",
    "the chain is not poisoned",
  );
});

test("Q4 (i): a rejected job never poisons the lock chain", async () => {
  const h = harness();
  await assert.rejects(
    h.runtime.exclusive(undefined, async () => {
      throw new Error("A fails");
    }),
    /A fails/,
  );
  assert.equal(await h.runtime.exclusive(undefined, async () => "B ok"), "B ok");
});

test("Q4 (j): use outside exclusive is refused", async () => {
  const h = harness();
  await assert.rejects(
    h.runtime.use(WASM, {}, () => 1),
    /removal runtime: use outside exclusive/,
  );
  await h.runtime.exclusive(undefined, async () => undefined);
  await assert.rejects(
    h.runtime.use(WASM, {}, () => 1),
    /use outside exclusive/,
    "also after a job ended",
  );
  assert.equal(h.count("birefnet:wasm"), 0);
});

test("Q4: job state is reset at link start and cleared before the link settles", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  let during: ReturnType<typeof h.runtime.jobInfo> | undefined;
  await h.runtime.exclusive(undefined, async () => {
    await h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined);
    during = h.runtime.jobInfo();
  });
  assert.equal(during?.absorbAttempted, true);
  assert.ok(during?.webgpuLoadFailure instanceof RemovalModelLoadError);
  const after = h.runtime.jobInfo();
  assert.deepEqual(after, {
    absorbAttempted: false,
    absorbLoadFailed: false,
    webgpuLoadFailure: undefined,
  });
  await h.runtime.exclusive(undefined, async () => {
    assert.deepEqual(h.runtime.jobInfo(), {
      absorbAttempted: false,
      absorbLoadFailed: false,
      webgpuLoadFailure: undefined,
    });
  });
});

test("Q4 (c): primary failure then compatibility disposes the primary first and keeps live <= 1", async () => {
  const h = harness();
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WEBGPU);
    await assert.rejects(
      h.runtime.usePrimary(route, {}, async () => {
        throw new Error("run failed");
      }),
      /run failed/,
    );
    assert.equal(await h.runtime.use(WASM, {}, (engine) => engine.provider), "wasm");
  });
  assert.ok(h.index("dispose:birefnet:webgpu") > -1);
  assert.ok(h.index("dispose:birefnet:webgpu") < h.index("load:birefnet:wasm"));
  assert.equal(h.maxLive(), 1);
});

test("Q4 (d): a warmup and a removal job on the same target share one load", async () => {
  const h = harness({ gpu: false });
  await h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
  );
  await h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
  );
  assert.equal(h.count("birefnet:wasm"), 1);
  assert.equal(h.log.filter((entry) => entry.startsWith("dispose:")).length, 0);
});

test("Q4 (e): same-target compatibility neither releases nor double-loads", async () => {
  const h = harness({ gpu: false });
  await h.runtime.exclusive(undefined, async () => {
    await assert.rejects(
      h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, async () => {
        throw new Error("run failed");
      }),
      /run failed/,
    );
    await h.runtime.use(WASM, {}, () => undefined);
  });
  assert.equal(h.count("birefnet:wasm"), 1);
  assert.equal(h.log.filter((entry) => entry.startsWith("dispose:")).length, 0);
});

test("Q4 (f): two jobs, job 1 device loss then compat, job 2 routes webgpu again with live <= 1", async () => {
  const h = harness();
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    await assert.rejects(
      h.runtime.usePrimary(route, {}, async () => {
        throw new Error("WebGPU device lost");
      }),
      /device lost/,
    );
    await h.runtime.use(WASM, {}, () => undefined);
  });
  const mark = h.log.length;
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WEBGPU, "a run failure is not a load memo");
    await h.runtime.usePrimary(route, {}, () => undefined);
  });
  const second = h.log.slice(mark);
  assert.ok(second.indexOf("dispose:birefnet:wasm") > -1);
  assert.ok(second.indexOf("dispose:birefnet:wasm") < second.indexOf("load:birefnet:webgpu"));
  assert.equal(h.maxLive(), 1);
});

test("Q4 (g): a route flip releases the warmed webgpu model before loading wasm", async () => {
  const h = harness();
  await h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
  );
  assert.equal(h.count("birefnet:webgpu"), 1);
  rememberGpuFailure("gpu-mask", null);
  assert.equal(readGpuFailure(null), true);
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WASM);
    await h.runtime.usePrimary(route, {}, () => undefined);
  });
  assert.ok(h.index("dispose:birefnet:webgpu") < h.index("load:birefnet:wasm"));
  assert.equal(h.maxLive(), 1);
});

test("Q4 (h): a release dispose failure is recorded and never skips the compatibility result", async () => {
  const h = harness();
  h.disposeFailures.add("birefnet:webgpu");
  const result = await bounded(
    h.runtime.exclusive(undefined, async () => {
      await assert.rejects(
        h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, async () => {
          throw new Error("device lost");
        }),
        /device lost/,
      );
      return h.runtime.use(WASM, {}, (engine) => engine.provider);
    }),
  );
  assert.equal(result, "wasm");
  assert.equal(
    h.runtime.cleanupErrors().length,
    2,
    "both failed teardown attempts remain observable",
  );
  assert.equal(
    h.log.filter((event) => event === "dispose:birefnet:webgpu").length,
    2,
    "one bounded retry",
  );
  for (const error of h.runtime.cleanupErrors())
    assert.match((error as Error).message, /dispose failed birefnet:webgpu/);
});

test("Q4: recordCleanupFailure appends to cleanupErrors and provenance is last-write-wins", () => {
  const h = harness();
  assert.deepEqual(h.runtime.cleanupErrors(), []);
  const failure = new Error("canvas release failed");
  h.runtime.recordCleanupFailure(failure);
  assert.deepEqual(h.runtime.cleanupErrors(), [failure]);
  const later = Array.from({ length: 20 }, (_, index) => new Error(`release ${index}`));
  for (const error of later) h.runtime.recordCleanupFailure(error);
  assert.deepEqual(h.runtime.cleanupErrors(), later.slice(-16), "only the latest 16 are kept");
  assert.equal(h.runtime.provenance(), undefined);
  const record = {
    outcome: "error",
    route: WASM,
    shape: "primary",
    renderPolicy: "cutout-original-matte-v1",
    absorbAttempted: false,
    compat: { attempted: true, transfer: "fast" },
    ranOn: undefined,
  } as const;
  h.runtime.recordProvenance(record);
  assert.equal(h.runtime.provenance(), record);
  const next = { ...record, outcome: "fallback" } as const;
  h.runtime.recordProvenance(next);
  assert.equal(h.runtime.provenance(), next);
});

test("Q4 (k) pin: a queued waiter receives no progress until its turn, then monotonic progress", async () => {
  const h = harness({ gpu: false });
  const hold = deferred();
  h.script.set("birefnet:wasm", [hold]);
  h.progressByKey.set("birefnet:wasm", [
    { status: "progress", file: "config.json", progress: 90 },
    { status: "download", file: "onnx/model.onnx" },
    { status: "progress", file: "onnx/model.onnx", progress: 50 },
    { status: "progress", file: "onnx/model.onnx", progress: 100 },
  ]);
  const a: number[] = [];
  const b: number[] = [];
  const jobA = h.runtime.exclusive(undefined, () =>
    h.runtime.use(WASM, { onProgress: (f) => a.push(f) }, () => "a"),
  );
  await until(() => h.count("birefnet:wasm") === 1);
  const jobB = h.runtime.exclusive(undefined, () =>
    h.runtime.use(WASM, { onProgress: (f) => b.push(f) }, () => "b"),
  );
  await flush();
  assert.deepEqual(a, [0.5, 1], "only .onnx progress events count, as fractions");
  assert.deepEqual(b, [], "B sees nothing while A holds the lock");
  hold.resolve();
  await jobA;
  assert.equal(await jobB, "b");
  assert.ok(b.length > 0 && b.every((value, index) => index === 0 || value >= (b[index - 1] ?? 0)));
  assert.equal(b.at(-1), 1);
  assert.equal(h.count("birefnet:wasm"), 1);
});

test("C06 cross-target: cancellation evicts the pending load; switching targets never awaits it", async () => {
  const h = harness();
  const hold = deferred();
  h.script.set("birefnet:webgpu", [hold]);
  const controller = new AbortController();
  const reason = new Error("stop");
  const job = h.runtime.exclusive(controller.signal, async () =>
    h.runtime.usePrimary(
      await h.runtime.automaticRoute(),
      { signal: controller.signal },
      () => "a",
    ),
  );
  await until(() => h.count("birefnet:webgpu") === 1);
  controller.abort(reason);
  await assert.rejects(job, (error) => error === reason);
  rememberGpuFailure("gpu-mask", null);
  const next = h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, (engine) => engine.provider),
  );
  assert.equal(await bounded(next), "wasm", "a stalled abandoned load cannot hold the lane");
  assert.equal(h.index("ready:birefnet:webgpu"), -1);
  hold.resolve();
  await until(() => h.index("dispose:birefnet:webgpu") > -1);
  assert.deepEqual(h.runtime.cleanupErrors(), []);
});

// ---------------------------------------------------------------------------------------
// Q3: use() decoration and usePrimary absorb
// ---------------------------------------------------------------------------------------

async function loadFailureFor(cause: Error, target: typeof WASM | typeof WEBGPU = WASM) {
  const h = harness({ gpu: target.provider === "webgpu" });
  h.script.set(`birefnet:${target.provider}`, [cause]);
  let caught: unknown;
  await h.runtime.exclusive(undefined, async () => {
    try {
      await h.runtime.use(target, {}, () => undefined);
    } catch (error) {
      caught = error;
    }
  });
  return { h, caught };
}

test("Q3: load failures are coded and retryable, and the decorated object is the pool's own rejection", async () => {
  const causes: Array<[string, Error]> = [
    ["Failed to fetch", new Error("Failed to fetch")],
    ["HTTP 503", new Error("HTTP 503")],
    ["opaque failure", new Error("opaque failure")],
    ["Aborted() crash", Object.assign(new Error("Aborted()"), { name: "RuntimeError" })],
  ];
  for (const [label, cause] of causes) {
    const { h, caught } = await loadFailureFor(cause);
    assert.ok(caught instanceof RemovalModelLoadError, label);
    assert.equal(Reflect.get(caught, "code"), "model-load-failed", label);
    assert.equal(caught, h.poolErrors[0], `${label}: the pool's own rejection (===)`);
    assert.equal(isRetryableEngineError(caught), true, label);
    assert.equal(failureCode(caught), "model", label);
  }
});

test("Q3 pins: memory, browser and updated causes keep their non-retryable precedence (D2 carve-out)", async () => {
  // D2: an out-of-memory load is not compatibility-eligible (rejection path: drop `memory`).
  const causes: Array<[string, string]> = [
    ["out of memory", "memory"],
    ["OOM", "memory"], // C26: the standalone error token retains memory precedence
    ["OffscreenCanvas not supported", "browser"],
    ["error loading dynamically imported module", "updated"],
  ];
  for (const [message, expected] of causes) {
    const { caught } = await loadFailureFor(new Error(message));
    assert.ok(caught instanceof RemovalModelLoadError, message);
    assert.equal(Reflect.get(caught, "code"), undefined, message);
    assert.equal(failureCode(caught), expected, message);
    assert.equal(isRetryableEngineError(caught), false, message);
  }
});

test("C05 load: an AbortError-named cause is a coded init failure, never a cancel", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [Object.assign(new Error("gone"), { name: "AbortError" })]);
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  await h.runtime.exclusive(undefined, async () => {
    try {
      await h.runtime.use(WEBGPU, {}, () => undefined);
    } catch (error) {
      assert.ok(error instanceof RemovalModelLoadError);
      assert.equal(error.failureKind, "provider-init");
      assert.equal(Reflect.get(error, "code"), "model-load-failed");
      info = h.runtime.jobInfo();
    }
  });
  assert.ok(info?.webgpuLoadFailure instanceof RemovalModelLoadError);
});

test("Q3: decorating the same error twice leaves one code", async () => {
  const request = { ...WASM, context: "page" } as const;
  const shared = new RemovalModelLoadError(request, new Error("Failed to fetch"));
  const runtime = createRemovalRuntime({
    pool: {
      async use() {
        throw shared;
      },
      async releaseIdle() {},
      async releaseAllIdle() {},
      cleanupErrors: () => [],
    } as unknown as ReturnType<typeof createRemovalEnginePool>,
    adapter: async () => ({}),
  });
  for (let round = 0; round < 2; round += 1) {
    await runtime.exclusive(undefined, async () => {
      await assert.rejects(
        runtime.use(WASM, {}, () => undefined),
        (error) => error === shared,
      );
    });
  }
  assert.equal(Reflect.get(shared, "code"), "model-load-failed");
  assert.equal(Object.getOwnPropertyNames(shared).filter((name) => name === "code").length, 1);
});

test("Q3 (r): webgpu rejects Failed to fetch -> exactly one wasm load, run once on wasm, absorbAttempted", async () => {
  // pins D5 (fetch-layer memo), default unchanged
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const runs: string[] = [];
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    await h.runtime.usePrimary(route, {}, (engine) => {
      runs.push(engine.provider);
    });
    info = h.runtime.jobInfo();
  });
  assert.deepEqual(runs, ["wasm"]);
  assert.equal(h.count("birefnet:webgpu"), 1);
  assert.equal(h.count("birefnet:wasm"), 1);
  assert.equal(info?.absorbAttempted, true);
  assert.equal(info?.absorbLoadFailed, false);
  assert.equal(webgpuLoadMemo(), "network");
});

test("C10: usePrimary calls onAbsorb once, just before the absorbing wasm load, and only then", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const order: string[] = [];
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    await h.runtime.usePrimary(
      route,
      {
        onAbsorb: () =>
          order.push(`absorb after ${h.count("birefnet:webgpu")}/${h.count("birefnet:wasm")}`),
      },
      () => {
        order.push("run");
      },
    );
  });
  assert.deepEqual(order, ["absorb after 1/0", "run"]);

  const plain = harness();
  const none: string[] = [];
  await plain.runtime.exclusive(undefined, async () => {
    await plain.runtime.usePrimary(
      await plain.runtime.automaticRoute(),
      { onAbsorb: () => none.push("absorb") },
      () => undefined,
    );
  });
  const init = harness();
  init.script.set("birefnet:webgpu", [failInit()]);
  await init.runtime.exclusive(undefined, async () => {
    await init.runtime
      .usePrimary(
        await init.runtime.automaticRoute(),
        { onAbsorb: () => none.push("absorb") },
        () => undefined,
      )
      .catch(() => undefined);
  });
  assert.deepEqual(none, [], "no call on success or on a failure that is not absorbed");
});

test("Q3 (r): webgpu and wasm both reject -> rejects with the wasm error after exactly two loads", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  h.script.set("birefnet:wasm", [new Error("Failed to fetch wasm")]);
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  let caught: unknown;
  await h.runtime.exclusive(undefined, async () => {
    try {
      await h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined);
    } catch (error) {
      caught = error;
      info = h.runtime.jobInfo();
    }
  });
  assert.ok(caught instanceof RemovalModelLoadError);
  assert.match(caught.message, /^Could not load birefnet on wasm: Failed to fetch wasm/);
  assert.equal(h.count("birefnet:webgpu") + h.count("birefnet:wasm"), 2);
  assert.equal(info?.absorbLoadFailed, true);
  assert.equal(webgpuLoadMemo(), undefined);
});

test("Q3 (r): a provider-init webgpu failure is not absorbed and is rethrown unchanged", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failInit()]);
  let caught: unknown;
  await h.runtime.exclusive(undefined, async () => {
    try {
      await h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined);
    } catch (error) {
      caught = error;
    }
  });
  assert.ok(caught instanceof RemovalModelLoadError);
  assert.equal(caught.failureKind, "provider-init");
  assert.equal(caught, h.poolErrors[0]);
  assert.equal(h.count("birefnet:wasm"), 0);
  assert.equal(h.runtime.jobInfo().absorbAttempted, false);
});

test("Q3 (r6): a wasm primary load failure makes no second load and is rethrown by identity", async () => {
  const h = harness({ gpu: false });
  h.script.set("birefnet:wasm", [failFetch()]);
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  let caught: unknown;
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WASM);
    try {
      await h.runtime.usePrimary(route, {}, () => undefined);
    } catch (error) {
      caught = error;
      info = h.runtime.jobInfo();
    }
  });
  assert.equal(caught, h.poolErrors[0]);
  assert.equal(h.count("birefnet:wasm"), 1);
  assert.equal(info?.absorbAttempted, false);
  assert.equal(webgpuLoadMemo(), undefined);
});

test("Q3 (r): ISNet never absorbs", async () => {
  stubNavigator({ deviceMemory: 4 });
  const h = harness({ gpu: false });
  h.script.set("isnet:wasm", [failFetch()]);
  let route: Awaited<ReturnType<typeof h.runtime.automaticRoute>> | undefined;
  let caught: unknown;
  await h.runtime.exclusive(undefined, async () => {
    route = await h.runtime.automaticRoute();
    try {
      await h.runtime.usePrimary(route, {}, () => undefined);
    } catch (error) {
      caught = error;
    }
  });
  assert.deepEqual(route?.primary, ISNET);
  assert.ok(caught instanceof RemovalModelLoadError);
  assert.equal(h.count("isnet:wasm"), 1);
  assert.equal(h.count("birefnet:wasm"), 0);
});

test("Q3 (r6, concurrency-r5 F1): an abort during the absorb's wasm load does not count as a failed absorb", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const hold = deferred();
  h.script.set("birefnet:wasm", [hold]);
  const controller = new AbortController();
  const reason = new Error("cancel mid absorb");
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  const job = h.runtime.exclusive(controller.signal, async () => {
    try {
      await h.runtime.usePrimary(
        await h.runtime.automaticRoute(),
        { signal: controller.signal },
        () => undefined,
      );
    } catch (error) {
      info = h.runtime.jobInfo();
      throw error;
    }
  });
  await until(() => h.count("birefnet:wasm") === 1);
  controller.abort(reason);
  await assert.rejects(job, (error) => error === reason);
  assert.equal(info?.absorbLoadFailed, false);
  assert.equal(info?.absorbAttempted, true);
  hold.resolve();
});

test("Q3: an abort during the webgpu load rejects with the reason and loads no wasm", async () => {
  const h = harness();
  const hold = deferred();
  h.script.set("birefnet:webgpu", [hold]);
  const controller = new AbortController();
  const reason = new Error("cancel webgpu");
  const job = h.runtime.exclusive(controller.signal, async () =>
    h.runtime.usePrimary(
      await h.runtime.automaticRoute(),
      { signal: controller.signal },
      () => undefined,
    ),
  );
  await until(() => h.count("birefnet:webgpu") === 1);
  controller.abort(reason);
  await assert.rejects(job, (error) => error === reason);
  hold.resolve();
  await flush();
  assert.equal(h.count("birefnet:wasm"), 0);
});

test("Q3 (r-abort): abort identity is the signal reason, undecorated, and not kept as a load failure", async () => {
  const h = harness();
  const hold = deferred();
  h.script.set("birefnet:webgpu", [hold]);
  const controller = new AbortController();
  const reason = { tag: "custom reason, not an AbortError" };
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  const job = h.runtime.exclusive(controller.signal, async () => {
    try {
      await h.runtime.usePrimary(
        await h.runtime.automaticRoute(),
        { signal: controller.signal },
        () => undefined,
      );
    } catch (error) {
      info = h.runtime.jobInfo();
      throw error;
    }
  });
  await until(() => h.count("birefnet:webgpu") === 1);
  controller.abort(reason);
  await assert.rejects(job, (error) => error === reason, "not the pool's minted DOMException");
  assert.equal(Reflect.get(reason, "code"), undefined);
  assert.equal(info?.webgpuLoadFailure, undefined);
  hold.resolve();
});

// ---------------------------------------------------------------------------------------
// Q4 (q): memo at engine-ready
// ---------------------------------------------------------------------------------------

test("Q4 (q1): the absorb's wasm engine ready, then an abort in run -> memo network", async () => {
  // pins D5 (fetch-layer memo), default unchanged
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const controller = new AbortController();
  const reason = new Error("abort in run");
  await assert.rejects(
    h.runtime.exclusive(controller.signal, async () =>
      h.runtime.usePrimary(
        await h.runtime.automaticRoute(),
        { signal: controller.signal },
        async () => {
          controller.abort(reason);
          throw reason;
        },
      ),
    ),
    (error) => error === reason,
  );
  assert.equal(webgpuLoadMemo(), "network");
});

test("Q4 (q2): absorb wasm load rejects, then the compatibility pass succeeds -> no memo (double failure)", async () => {
  // pins D5 (fetch-layer memo), default unchanged
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  h.script.set("birefnet:wasm", [failFetch()]);
  await h.runtime.exclusive(undefined, async () => {
    await assert.rejects(
      h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
      RemovalModelLoadError,
    );
    assert.equal(await h.runtime.use(WASM, {}, (engine) => engine.provider), "wasm");
  });
  assert.equal(h.count("birefnet:wasm"), 2, "the pool evicted the rejected entry");
  assert.equal(webgpuLoadMemo(), undefined);
  // Job 2 re-attempts webgpu once, disposing the compatibility session first.
  h.script.set("birefnet:webgpu", [failFetch()]);
  const mark = h.log.length;
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WEBGPU);
    await h.runtime.usePrimary(route, {}, () => undefined);
  });
  const second = h.log.slice(mark);
  assert.ok(second.indexOf("dispose:birefnet:wasm") < second.indexOf("load:birefnet:webgpu"));
  assert.equal(webgpuLoadMemo(), "network");
});

test("Q4 (q3): webgpu provider-init, compatibility engine ready, abort in run -> memo init", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failInit()]);
  const controller = new AbortController();
  const reason = new Error("abort in compat run");
  await assert.rejects(
    h.runtime.exclusive(controller.signal, async () => {
      try {
        await h.runtime.usePrimary(
          await h.runtime.automaticRoute(),
          { signal: controller.signal },
          () => undefined,
        );
      } catch {
        // the engine's one compatibility attempt
      }
      return h.runtime.use(WASM, { signal: controller.signal }, async () => {
        controller.abort(reason);
        throw reason;
      });
    }),
    (error) => error === reason,
  );
  assert.equal(webgpuLoadMemo(), "init");
});

test("Q4 (q4): webgpu provider-init and a rejected compatibility load -> no memo", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failInit()]);
  h.script.set("birefnet:wasm", [failFetch()]);
  await h.runtime.exclusive(undefined, async () => {
    await assert.rejects(
      h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
      RemovalModelLoadError,
    );
    await assert.rejects(
      h.runtime.use(WASM, {}, () => undefined),
      RemovalModelLoadError,
    );
  });
  assert.equal(webgpuLoadMemo(), undefined);
});

test("C05 load: an AbortError-named cause follows the init memo policy when WASM becomes ready", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [Object.assign(new Error("aborted"), { name: "AbortError" })]);
  await h.runtime.exclusive(undefined, async () => {
    await assert.rejects(
      h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
      RemovalModelLoadError,
    );
    await h.runtime.use(WASM, {}, () => undefined);
  });
  assert.equal(webgpuLoadMemo(), "init");
});

test("Q4 (q6): inside the absorb's run callback the memo is already set", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  let seen: string | undefined;
  await h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => {
      seen = webgpuLoadMemo();
    }),
  );
  assert.equal(seen, "network");
});

test("Q4 (q7): a pre-ready cancel sets no memo; job 2 disposes the finished load and re-absorbs", async () => {
  // pins D5 (fetch-layer memo), default unchanged
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch(), failFetch()]);
  const hold = deferred();
  h.script.set("birefnet:wasm", [hold]);
  const controller = new AbortController();
  const reason = new Error("cancel before ready");
  let info: ReturnType<typeof h.runtime.jobInfo> | undefined;
  const job1 = h.runtime.exclusive(controller.signal, async () => {
    try {
      await h.runtime.usePrimary(
        await h.runtime.automaticRoute(),
        { signal: controller.signal },
        () => undefined,
      );
    } catch (error) {
      info = h.runtime.jobInfo();
      throw error;
    }
  });
  await until(() => h.count("birefnet:wasm") === 1);
  controller.abort(reason);
  await assert.rejects(job1, (error) => error === reason);
  assert.equal(webgpuLoadMemo(), undefined);
  assert.equal(info?.absorbLoadFailed, false);
  hold.resolve();
  await until(() => h.index("ready:birefnet:wasm") > -1);

  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WEBGPU, "no memo, so job 2 routes webgpu");
    await h.runtime.usePrimary(route, {}, () => undefined);
  });
  const ready = h.index("ready:birefnet:wasm");
  const dispose = h.index("dispose:birefnet:wasm");
  const webgpu = h.index("load:birefnet:webgpu", dispose);
  assert.ok(ready > -1 && dispose > ready && webgpu > dispose, h.log.join(","));
  assert.equal(h.count("birefnet:wasm"), 2, "job 2 absorbs with a second wasm model");
  assert.equal(webgpuLoadMemo(), "network");
  assert.equal(h.maxLive(), 1);
});

test("Q4 (q7) init variant: a cancel during the compatibility wasm load sets no memo", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failInit(), failInit()]);
  const hold = deferred();
  h.script.set("birefnet:wasm", [hold]);
  const controller = new AbortController();
  const reason = new Error("cancel compat load");
  const job1 = h.runtime.exclusive(controller.signal, async () => {
    try {
      await h.runtime.usePrimary(
        await h.runtime.automaticRoute(),
        { signal: controller.signal },
        () => undefined,
      );
    } catch {
      // not absorbable: the engine goes on to the compatibility pass
    }
    return h.runtime.use(WASM, { signal: controller.signal }, () => undefined);
  });
  await until(() => h.count("birefnet:wasm") === 1);
  controller.abort(reason);
  await assert.rejects(job1, (error) => error === reason);
  assert.equal(webgpuLoadMemo(), undefined);
  hold.resolve();
  await until(() => h.index("ready:birefnet:wasm") > -1);
  await h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WEBGPU);
    await h.runtime.usePrimary(route, {}, () => undefined).catch(() => undefined);
  });
  assert.ok(
    h.index("dispose:birefnet:wasm") <
      h.index("load:birefnet:webgpu", h.index("ready:birefnet:wasm")),
  );
});

test("Q4 (s): a queued waiter reads the memo set by the job before it and loads nothing", async () => {
  // pins D5 (fetch-layer memo), default unchanged
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const hold = deferred();
  const jobA = h.runtime.exclusive(undefined, async () =>
    h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, async () => {
      await hold.promise;
    }),
  );
  await until(() => h.count("birefnet:wasm") === 1 && h.index("ready:birefnet:wasm") > -1);
  let bProvider: string | undefined;
  const jobB = h.runtime.exclusive(undefined, async () => {
    const route = await h.runtime.automaticRoute();
    assert.deepEqual(route.primary, WASM);
    assert.equal(route.shape, "primary");
    await h.runtime.usePrimary(route, {}, (engine) => {
      bProvider = engine.provider;
    });
  });
  await flush();
  hold.resolve();
  await jobA;
  await jobB;
  assert.equal(bProvider, "wasm");
  assert.equal(h.count("birefnet:webgpu"), 1);
  assert.equal(h.count("birefnet:wasm"), 1);
  assert.equal(h.log.filter((entry) => entry.startsWith("dispose:")).length, 0);
});

// ---------------------------------------------------------------------------------------
// Q10: route table
// ---------------------------------------------------------------------------------------

async function inducedMemo(kind: "none" | "network" | "init"): Promise<void> {
  if (kind === "none") return;
  const h = harness();
  h.script.set("birefnet:webgpu", [kind === "network" ? failFetch() : failInit()]);
  await h.runtime.exclusive(undefined, async () => {
    try {
      await h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined);
    } catch {
      // init class: not absorbed
    }
    await h.runtime.use(WASM, {}, () => undefined);
  });
  assert.equal(webgpuLoadMemo(), kind);
}

test("Q10: the route table (adapter x memory x record x memo) gives the exact model, provider, lowMemory and shape", async () => {
  const memories: Array<number | undefined> = [2, 4, 8, undefined];
  for (const adapter of [true, false]) {
    for (const memory of memories) {
      for (const record of [false, true]) {
        for (const memo of adapter ? (["none", "network", "init"] as const) : (["none"] as const)) {
          clearRemovalFailureRecords(null);
          stubNavigator(memory === undefined ? {} : { deviceMemory: memory });
          await inducedMemo(memo);
          if (record) rememberGpuFailure("gpu-mask", null);
          const h = harness({ gpu: adapter });
          const route = await h.runtime.automaticRoute();
          const label = `adapter=${adapter} memory=${memory} record=${record} memo=${memo}`;
          const lowMemory = !adapter && typeof memory === "number" && memory <= 4;
          const expectedPrimary = lowMemory
            ? ISNET
            : adapter && !record && memo === "none"
              ? WEBGPU
              : WASM;
          assert.deepEqual(route.primary, expectedPrimary, label);
          assert.equal(route.lowMemory, lowMemory, label);
          assert.equal(route.shape, memo === "init" ? "compat" : "primary", label);
        }
      }
    }
  }
});

test("Q10: the adapter is probed once per context", async () => {
  let probes = 0;
  const runtime = createRemovalRuntime({
    pool: createRemovalEnginePool(harness().factories),
    adapter: async () => {
      probes += 1;
      return {};
    },
  });
  await runtime.automaticRoute();
  await runtime.automaticRoute();
  assert.equal(probes, 1);
});

test("Q10: a rejecting adapter probe counts as no adapter", async () => {
  const runtime = createRemovalRuntime({
    pool: createRemovalEnginePool(harness().factories),
    adapter: async () => {
      throw new Error("probe failed");
    },
  });
  const route = await runtime.automaticRoute();
  assert.deepEqual(route.primary, WASM);
  assert.equal(route.lowMemory, false);
});

test("S3-A-ENGINE-02: an adapter without shader-f16 routes BiRefNet/WebGPU fp32 primary", async () => {
  for (const [memory, fp16] of [
    [8, async () => false],
    [4, async () => false],
    [
      8,
      async () => {
        throw new Error("probe failed");
      },
    ],
  ] as const) {
    stubNavigator({ deviceMemory: memory });
    const runtime = createRemovalRuntime({
      pool: createRemovalEnginePool(harness().factories),
      adapter: async () => ({}),
      fp16,
    });
    const route = await runtime.automaticRoute();
    assert.deepEqual(
      route,
      { primary: { ...WEBGPU, dtype: "fp32" }, lowMemory: false, shape: "primary" },
      `memory ${memory}`,
    );
  }
  stubNavigator({ deviceMemory: 8 });
  const able = createRemovalRuntime({
    pool: createRemovalEnginePool(harness().factories),
    adapter: async () => ({}),
    fp16: async () => true,
  });
  assert.deepEqual((await able.automaticRoute()).primary, WEBGPU);
});

test("Q10: the memo and a stored record never leave the process (no storage key written by loads)", async () => {
  const h = harness();
  h.script.set("birefnet:webgpu", [failFetch()]);
  const writes: string[] = [];
  const store = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem: (key: string) => {
      writes.push(key);
    },
    removeItem: () => undefined,
  };
  Object.defineProperty(globalThis, "localStorage", { value: store, configurable: true });
  try {
    await h.runtime.exclusive(undefined, async () =>
      h.runtime.usePrimary(await h.runtime.automaticRoute(), {}, () => undefined),
    );
    assert.equal(webgpuLoadMemo(), "network");
    assert.equal(readGpuFailure(store), false, "Q6: a network failure never blacklists the GPU");
    assert.deepEqual(writes, []);
  } finally {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("C08: page engines release after 60 seconds idle, reload on demand, and release on pagehide", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  let hide: (() => void) | undefined;
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: (type: string, fn: () => void) => {
      if (type === "pagehide") hide = fn;
    },
  });
  try {
    const h = harness({ gpu: false });
    const run = () => h.runtime.exclusive(undefined, () => h.runtime.use(WASM, {}, () => "cut"));
    await run();
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(h.index("dispose:birefnet:wasm"), -1);
    await run();
    t.mock.timers.tick(59_999);
    await flush();
    assert.equal(h.index("dispose:birefnet:wasm"), -1, "the second job resets idle time");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(h.live(), 0, "the page no longer pins the model heap");
    await run();
    assert.equal(h.count("birefnet:wasm"), 2, "cold lease after release");
    assert.equal(typeof hide, "function");
    hide!();
    await flush();
    assert.equal(h.live(), 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "addEventListener", previous);
    else Reflect.deleteProperty(globalThis, "addEventListener");
  }
});

test("C08: pagehide defers disposal until the active job ends", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  let hide: (() => void) | undefined;
  Object.defineProperty(globalThis, "addEventListener", {
    configurable: true,
    value: (type: string, fn: () => void) => {
      if (type === "pagehide") hide = fn;
    },
  });
  try {
    const h = harness({ gpu: false });
    const gate = deferred();
    const run = h.runtime.exclusive(undefined, () => h.runtime.use(WASM, {}, () => gate.promise));
    await until(() => h.live() === 1);
    assert.equal(typeof hide, "function");
    hide!();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(h.index("dispose:birefnet:wasm"), -1, "no active-job disposal");
    gate.resolve();
    await run;
    await flush();
    assert.equal(h.live(), 0, "the hidden page releases as soon as it drains");
  } finally {
    if (previous) Object.defineProperty(globalThis, "addEventListener", previous);
    else Reflect.deleteProperty(globalThis, "addEventListener");
  }
});

test("C16: malformed WebGPU output keeps its gpu-mask evidence; WASM shape errors do not", () => {
  for (const provider of ["webgpu", "wasm"] as const) {
    const source = new RemovalModelOutputError(
      { model: "birefnet", provider, context: "page" },
      "Model returned malformed output_image",
    );
    const error = engineErrorFor(source, "model", provider);
    assert.equal(isGpuSuspectMask(error), provider === "webgpu");
    assert.equal((error as Error).cause, source);
  }
});

test("S3-A-ENGINE-03: numeric ORT throws at the model boundary are nonretryable memory failures", () => {
  const error = engineErrorFor(10023264, "model", "wasm") as Error & { code?: string };
  assert.equal(error.code, "out-of-memory");
  assert.equal(error.cause, 10023264);
  assert.equal(failureCode(error), "memory");
  assert.equal(isRetryableEngineError(error), false);
});

test("no-f16 WebGPU respects the GPU-failure and load-failure memos", async () => {
  for (const failure of ["gpu", "network", "init"] as const) {
    clearRemovalFailureRecords(null);
    stubNavigator({ deviceMemory: 8 });
    if (failure === "gpu") rememberGpuFailure("gpu-mask", null);
    else await inducedMemo(failure);
    const runtime = createRemovalRuntime({ adapter: async () => ({}), fp16: async () => false });
    assert.deepEqual(await runtime.automaticRoute(), {
      primary: WASM,
      lowMemory: false,
      shape: failure === "init" ? "compat" : "primary",
    });
  }
});
