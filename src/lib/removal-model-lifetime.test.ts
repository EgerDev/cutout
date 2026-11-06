import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import {
  RemovalModelLoadError,
  RemovalModelOutputError,
  createRemovalEnginePool,
  type RemovalLoadFactories,
} from "./removal-model.ts";

const REQUEST = { model: "birefnet", provider: "webgpu", context: "worker" } as const;

function callableModel(dispose: () => void | Promise<void>): unknown {
  return Object.assign(async () => ({}), { dispose });
}

async function flushCleanup(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function hold<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

async function expectTensorCleanupFailure(options: {
  readonly stage: "processor" | "model";
  readonly provider: "webgpu" | "wasm";
  readonly dims: readonly number[];
  readonly value: number;
  readonly message: string;
  readonly failureKind: "gpu-mask" | "model-output";
}): Promise<void> {
  let disposals = 0;
  const data = new Float32Array(options.dims.reduce((size, dimension) => size * dimension, 1));
  data[0] = options.value;
  const returned = {
    data,
    dims: options.dims,
    sigmoid() {
      return this;
    },
    dispose() {
      disposals += 1;
      throw new Error("returned tensor dispose failed");
    },
  };
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return options.stage === "processor"
        ? async () => ({ pixel_values: returned })
        : async () => ({});
    },
    async loadModel() {
      return options.stage === "model"
        ? Object.assign(async () => ({ output_image: returned }), { async dispose() {} })
        : callableModel(() => undefined);
    },
  });
  const request = { model: "birefnet", provider: options.provider, context: "worker" } as const;

  await assert.rejects(
    pool.use(request, {}, async (engine) =>
      options.stage === "processor" ? engine.processor({}) : engine.model({ input_image: {} }),
    ),
    (error) => {
      if (!(error instanceof RemovalModelOutputError) || error.failureKind !== options.failureKind)
        return false;
      if (error.message !== options.message || !(error.cause instanceof AggregateError))
        return false;
      const source = error.cause.cause;
      const cleanup = error.cause.errors[1];
      return (
        source instanceof RemovalModelOutputError &&
        error.cause.errors[0] === source &&
        source.message === options.message &&
        cleanup instanceof Error &&
        cleanup.message === "returned tensor dispose failed"
      );
    },
  );
  assert.equal(disposals, 1);
}

test("a pre-aborted subscriber starts no initialization", async () => {
  // Given: factories whose only observable is initialization.
  let loads = 0;
  const factories: RemovalLoadFactories = {
    async loadProcessor() {
      loads += 1;
      return async () => ({});
    },
    async loadModel() {
      loads += 1;
      return callableModel(() => undefined);
    },
  };
  const pool = createRemovalEnginePool(factories);
  const controller = new AbortController();
  controller.abort();

  // When/Then: cancellation wins before a cache entry, fetch, or session can start.
  await assert.rejects(
    pool.use(REQUEST, { signal: controller.signal }, async () => "unreachable"),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(loads, 0);
});

test("an aborted subscriber detaches from a never-settling shared load", async () => {
  // Given: a model initialization that remains pending without timers or handles.
  const never = new Promise<unknown>(() => undefined);
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return async () => ({});
    },
    async loadModel() {
      return never;
    },
  });
  const controller = new AbortController();
  const waiting = pool.use(REQUEST, { signal: controller.signal }, async () => "unreachable");
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);

  // When: this subscriber aborts while the shared initialization remains pending.
  controller.abort();

  // Then: it rejects locally and retains no abort listener.
  await assert.rejects(
    waiting,
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("deferred disposal failures are captured without an unhandled rejection", async () => {
  // Given: active work whose eventual model disposal fails.
  let finish: (() => void) | undefined;
  const runGate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return async () => ({});
    },
    async loadModel() {
      return callableModel(async () => {
        throw new Error("dispose failed");
      });
    },
  });
  const running = pool.use(REQUEST, {}, async () => {
    await runGate;
    return "done";
  });
  await Promise.resolve();
  await pool.releaseIdle(REQUEST);

  // When: active work ends and fire-and-forget retirement runs.
  finish?.();
  assert.equal(await running, "done");
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Then: the pool retains the cleanup cause for W3 diagnostics.
  const [failure] = pool.cleanupErrors();
  assert.equal(failure instanceof Error ? failure.message : "", "dispose failed");
});

test("partial cleanup failure retains both the source cause and cleanup error", async () => {
  // Given: processor delivery fails after the sibling model returns, then disposal also fails.
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      throw new TypeError("offline processor config");
    },
    async loadModel() {
      return callableModel(async () => {
        throw new Error("partial dispose failed");
      });
    },
  });

  // When/Then: classification follows the source while the aggregate retains cleanup detail.
  await assert.rejects(
    pool.use(REQUEST, {}, async () => null),
    (error) => {
      if (!(error instanceof RemovalModelLoadError) || error.failureKind !== "network")
        return false;
      if (!(error.cause instanceof AggregateError)) return false;
      return error.cause.cause instanceof TypeError && error.cause.errors.length === 2;
    },
  );
});

test("a returned processor is disposed when its sibling model load rejects", async () => {
  // Given: a callable processor resource returned before its sibling load fails.
  let processorDisposals = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        async dispose() {
          processorDisposals += 1;
        },
      });
    },
    async loadModel() {
      throw new Error("model load failed");
    },
  });

  // When/Then: the partial processor resource is released exactly once.
  await assert.rejects(
    pool.use(REQUEST, {}, async () => null),
    /model load failed/,
  );
  assert.equal(processorDisposals, 1);
});

test("bridge validation failure disposes every returned disposable resource", async () => {
  // Given: a non-callable processor and model object that both own cleanup hooks.
  let processorDisposals = 0;
  let modelDisposals = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return {
        async dispose() {
          processorDisposals += 1;
        },
      };
    },
    async loadModel() {
      return {
        async dispose() {
          modelDisposals += 1;
        },
      };
    },
  });

  // When/Then: rejected bridge construction releases both resources once.
  await assert.rejects(
    pool.use(REQUEST, {}, async () => null),
    /non-callable removal model or processor/,
  );
  assert.equal(processorDisposals, 1);
  assert.equal(modelDisposals, 1);
});

test("successful engine retirement disposes processor and model exactly once", async () => {
  // Given: a fully prepared engine whose processor and model both own resources.
  let processorDisposals = 0;
  let modelDisposals = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        async dispose() {
          processorDisposals += 1;
        },
      });
    },
    async loadModel() {
      return callableModel(async () => {
        modelDisposals += 1;
      });
    },
  });
  await pool.use(REQUEST, {}, async () => "ready");

  // When: repeated explicit retirement is requested.
  await pool.releaseIdle(REQUEST);
  await pool.releaseIdle(REQUEST);

  // Then: both owned resources are disposed exactly once.
  assert.equal(processorDisposals, 1);
  assert.equal(modelDisposals, 1);
});

test("processor cleanup failure preserves the sibling model-load cause", async () => {
  // Given: model loading fails and releasing its returned processor sibling also fails.
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        async dispose() {
          throw new Error("processor dispose failed");
        },
      });
    },
    async loadModel() {
      throw new TypeError("offline model load");
    },
  });

  // When/Then: classification follows the source and the aggregate retains both errors.
  await assert.rejects(
    pool.use(REQUEST, {}, async () => null),
    (error) => {
      if (!(error instanceof RemovalModelLoadError) || error.failureKind !== "network")
        return false;
      if (!(error.cause instanceof AggregateError)) return false;
      return error.cause.cause instanceof TypeError && error.cause.errors.length === 2;
    },
  );
});

test("malformed processor output remains non-persistent when tensor cleanup throws", async () => {
  await expectTensorCleanupFailure({
    stage: "processor",
    provider: "webgpu",
    dims: [1, 3, 1, 1],
    value: 0,
    message: "Processor returned an invalid input tensor",
    failureKind: "model-output",
  });
});

test("malformed model output retains a typed GPU fault when tensor cleanup throws", async () => {
  await expectTensorCleanupFailure({
    stage: "model",
    provider: "webgpu",
    dims: [1, 1, 1, 1],
    value: 0,
    message: "Model returned malformed output_image",
    failureKind: "gpu-mask",
  });
});

test("nonfinite GPU output retains a typed fault when tensor cleanup throws", async () => {
  await expectTensorCleanupFailure({
    stage: "model",
    provider: "webgpu",
    dims: [1, 1, 512, 512],
    value: Number.NaN,
    message: "Model returned nonfinite output_image",
    failureKind: "gpu-mask",
  });
});

test("nonfinite WASM output retains a typed model fault when tensor cleanup throws", async () => {
  await expectTensorCleanupFailure({
    stage: "model",
    provider: "wasm",
    dims: [1, 1, 512, 512],
    value: Number.NaN,
    message: "Model returned nonfinite output_image",
    failureKind: "model-output",
  });
});

test("C13: asymmetric dual load failures retain both causes and the model fetch classification", async () => {
  const processor = new SyntaxError("preprocessor_config.json: unexpected token");
  const model = new TypeError("Failed to fetch");
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      throw processor;
    },
    async loadModel() {
      throw model;
    },
  });
  await assert.rejects(
    pool.use(REQUEST, {}, () => null),
    (error) => {
      assert.ok(error instanceof RemovalModelLoadError);
      assert.equal(error.failureKind, "network");
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(error.cause.errors, [processor, model]);
      assert.equal(error.cause.cause, model);
      return true;
    },
  );
});

for (const variant of ["getter", "uint16"] as const)
  test(`C15: ${variant} output is a typed mask fault and is disposed`, async () => {
    let disposed = 0;
    const candidate = {
      dims: [1, 1, 512, 512],
      get data() {
        if (variant === "getter") throw new Error("Tensor data is not on CPU");
        return new Uint16Array(512 * 512);
      },
      dispose() {
        disposed++;
      },
      sigmoid() {
        return this;
      },
    };
    // Use the same real preparation function as the pool, to inject a model tensor accessor.
    const { prepareRemovalEngine } = await import("./removal-prepared-engine.ts");
    const { REMOVAL_MODELS } = await import("./removal-model.ts");
    const engine = prepareRemovalEngine({
      request: REQUEST,
      spec: REMOVAL_MODELS.birefnet,
      route: REMOVAL_MODELS.birefnet.routes.webgpu,
      processorValue: async () => ({}),
      modelValue: Object.assign(async () => ({ output_image: candidate }), { dispose() {} }),
    });
    await assert.rejects(
      engine.model({ input_image: {} }),
      (error) => error instanceof RemovalModelOutputError && error.failureKind === "gpu-mask",
    );
    assert.equal(disposed, 1);
  });

test("C17: pool retirement retries a transient teardown failure without redisposing a successful sibling", async () => {
  let proc = 0,
    model = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        dispose() {
          proc++;
        },
      });
    },
    async loadModel() {
      return callableModel(() => {
        if (++model === 1) throw new Error("transient teardown");
      });
    },
  });
  await pool.use(REQUEST, {}, () => null);
  await pool.releaseIdle(REQUEST);
  await pool.releaseIdle(REQUEST);
  assert.deepEqual([proc, model], [1, 2]);
  assert.equal((pool.cleanupErrors()[0] as Error).message, "transient teardown");
});

test("C17: a cancelled pending load that resolves late retries failed teardown once", async () => {
  const gate = hold<unknown>();
  let proc = 0,
    model = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        dispose() {
          proc++;
        },
      });
    },
    async loadModel() {
      return gate.promise;
    },
  });
  const controller = new AbortController();
  const pending = assert.rejects(
    pool.use(REQUEST, { signal: controller.signal }, () => assert.fail("abandoned job entered")),
    (error) => error instanceof DOMException && error.name === "AbortError",
  );
  controller.abort();
  await pending;
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("retirement awaited an abandoned load")), 50).unref(),
  );
  await Promise.race([pool.releaseAllIdle(), deadline]);
  gate.resolve(
    callableModel(() => {
      if (++model === 1) throw new Error("late transient");
    }),
  );
  await flushCleanup();
  await pool.releaseAllIdle();
  await flushCleanup();
  assert.deepEqual([proc, model], [1, 2]);
  assert.equal(pool.cleanupErrors().length, 1);
  assert.equal((pool.cleanupErrors()[0] as Error).message, "late transient");
});

test("C17: late persistent teardown stays bounded and records both failures", async () => {
  const gate = hold<unknown>();
  let proc = 0,
    model = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        dispose() {
          proc++;
        },
      });
    },
    async loadModel() {
      return gate.promise;
    },
  });
  const controller = new AbortController();
  const pending = assert.rejects(
    pool.use(REQUEST, { signal: controller.signal }, () => assert.fail("abandoned job entered")),
  );
  controller.abort();
  await pending;
  gate.resolve(
    callableModel(() => {
      model++;
      throw new Error("late persistent");
    }),
  );
  await flushCleanup();
  await pool.releaseAllIdle();
  await flushCleanup();
  assert.deepEqual([proc, model], [1, 2]);
  assert.equal(pool.cleanupErrors().length, 2);
  for (const error of pool.cleanupErrors())
    assert.equal((error as Error).message, "late persistent");
});

test("C17: timeout completion retries failed teardown once without redisposing a sibling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const gate = hold<unknown>();
  let proc = 0,
    model = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        dispose() {
          proc++;
        },
      });
    },
    async loadModel() {
      return gate.promise;
    },
  });
  const waiting = assert.rejects(
    pool.use(REQUEST, {}, () => "unused"),
    { code: "model-load-timeout", failureKind: "network" },
  );
  t.mock.timers.tick(60_000);
  await waiting;
  gate.resolve(
    callableModel(() => {
      if (++model === 1) throw new Error("timeout transient");
    }),
  );
  await flushCleanup();
  await pool.releaseAllIdle();
  await flushCleanup();
  assert.deepEqual([proc, model], [1, 2]);
  assert.equal(pool.cleanupErrors().length, 1);
  assert.equal((pool.cleanupErrors()[0] as Error).message, "timeout transient");
});

test("C17: late completion after a fatal realm skips teardown", async () => {
  let lose!: (value: unknown) => void;
  const lost = new Promise<unknown>((resolve) => {
    lose = resolve;
  });
  const gate = hold<unknown>();
  let proc = 0,
    model = 0;
  const pool = createRemovalEnginePool({
    async loadProcessor() {
      return Object.assign(async () => ({}), {
        dispose() {
          proc++;
        },
      });
    },
    async loadModel() {
      return gate.promise;
    },
    async gpuDevice() {
      return { lost };
    },
  });
  const controller = new AbortController();
  const pending = assert.rejects(
    pool.use(REQUEST, { signal: controller.signal }, () => assert.fail("abandoned job entered")),
  );
  await flushCleanup();
  controller.abort();
  await pending;
  lose({ reason: "unknown" });
  await flushCleanup();
  gate.resolve(
    callableModel(() => {
      model++;
    }),
  );
  await flushCleanup();
  await pool.releaseAllIdle();
  assert.deepEqual([proc, model], [0, 0]);
  assert.equal(pool.cleanupErrors().length, 0);
});
