import { isRemovalModelIntegrityError } from "./removal-model-integrity.ts";
import { RemovalContextLostError, RemovalModelCacheError, classifyRemovalFailure } from "./removal-provider.ts";
import type { RemovalFailureKind } from "./removal-provider.ts";
import { prepareRemovalEngine } from "./removal-prepared-engine.ts";
import {
  REMOVAL_MODELS,
  removalModelRoute,
  disposeRemovalResources,
  removalCleanupFailure,
  removalProgressEvent,
  removalGpuDevice,
  evictRemovalModelCache,
  evictRemovalModelFile,
  isHubJsonFailure,
  isRemovalSessionFailure,
} from "./removal-model-specs.ts";
import type {
  PreparedRemovalEngine,
  RemovalLoadFactories,
  RemovalLoadProgress,
  RemovalLoadRequest,
  RemovalGpuDevice,
} from "./removal-model-specs.ts";
export { REMOVAL_MODELS } from "./removal-model-specs.ts";
export { RemovalModelOutputError } from "./removal-prepared-engine.ts";
export type { PreparedRemovalEngine, RemovalLoadFactories, RemovalLoadProgress, RemovalLoadRequest, RemovalModelIdentity, RemovalTensor } from "./removal-model-specs.ts";

export class RemovalModelLoadError extends Error {
  readonly name = "RemovalModelLoadError"; declare code?: string; readonly failureKind: RemovalFailureKind;
  readonly dtype: RemovalLoadRequest["dtype"];
  constructor(request: RemovalLoadRequest, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`Could not load ${request.model} on ${request.provider}${detail}`, { cause });
    this.dtype = request.dtype;
    const classified = classifyRemovalFailure(cause);
    if (classified === "abort") this.code = "model-load-failed";
    this.failureKind = classified === "unknown" || classified === "abort" ? "provider-init" : classified;
  }
}

type ProgressState = { readonly listeners: Set<(event: RemovalLoadProgress) => void>; last?: RemovalLoadProgress };
type CacheEntry = {
  readonly promise: Promise<PreparedRemovalEngine>;
  readonly progress: ProgressState;
  users: number; releaseAfterUse: boolean; pending: boolean; abandon(error?: unknown): void;
};
export function createRemovalEnginePool(factories: RemovalLoadFactories = defaultFactories) {
  const cache = new Map<string, CacheEntry>();
  const cleanupFailures: unknown[] = [];
  let contextFailure: Error | undefined;
  let contextQuarantined = false;
  let rejectContext!: (error: Error) => void;
  const contextLost = new Promise<never>((_, reject) => { rejectContext = reject; });
  void contextLost.catch(() => {});
  let observedDevice = false;
  let deviceProbe: Promise<void> | undefined;
  const failContext = (error: Error = new RemovalContextLostError()) => {
    contextFailure ??= error;
    rejectContext(contextFailure);
    for (const [key, entry] of cache) {
      if (entry.pending) { cache.delete(key); entry.abandon(contextFailure); }
    }
    return contextFailure;
  };
  const quarantineContext = (request: RemovalLoadRequest, cause: unknown): Promise<never> => {
    if (!contextQuarantined && !contextFailure) {
      // Poisoning is known now. Block admission before touching asynchronous storage,
      // but publish the fatal reply only after cleanup so a fresh worker cannot race it.
      contextQuarantined = true;
      void boundedEviction(() => factories.evictModelFile?.(request.model, request.provider, request.dtype))
        .then((removed) => { failContext(new RemovalModelCacheError(removed, cause)); });
    }
    return contextLost;
  };
  // ORT publishes its own device before session creation finishes. Sample at load
  // boundaries and before silence recovery, without polling or requesting a device.
  function observeDevice(): Promise<void> {
    if (observedDevice || !factories.gpuDevice) return Promise.resolve();
    if (deviceProbe) return deviceProbe;
    deviceProbe = new Promise<RemovalGpuDevice | undefined>((resolve) => {
      const deadline = setTimeout(() => resolve(undefined), 100);
      deadline.unref?.();
      void Promise.resolve().then(() => factories.gpuDevice?.()).then(
        (device) => { clearTimeout(deadline); resolve(device); },
        () => { clearTimeout(deadline); resolve(undefined); },
      );
    }).then((device) => {
      if (!device) return;
      observedDevice = true;
      void device.lost.then(() => { if (!contextQuarantined) failContext(); }, () => {});
    }).finally(() => { deviceProbe = undefined; });
    return deviceProbe;
  }
  const keyOf = (request: RemovalLoadRequest) => `${request.context}:${request.model}:${request.provider}:${removalModelRoute(request)?.dtype}`;
  // Diagnostics only: the latest failures, not every one a long session produced.
  const captureCleanupFailure = (error: unknown) => {
    if (cleanupFailures.push(error) > 16) cleanupFailures.shift();
  };
  const disposeEngine = async (engine: PreparedRemovalEngine): Promise<void> => {
    try { await engine.dispose(); }
    catch (error) {
      // Retry teardown once, retaining its first failure for diagnostics. Successful
      // siblings are already released; prepared engines retry only failed resources.
      captureCleanupFailure(error);
      await engine.dispose();
    }
  };

  const retire = async (key: string, entry: CacheEntry): Promise<void> => {
    if (cache.get(key) !== entry) return;
    cache.delete(key);
    if (entry.pending) {
      entry.abandon();
      return; // A fetch cannot be stopped here, and may never settle.
    }
    try {
      const engine = await entry.promise;
      await disposeEngine(engine);
    } catch (error) {
      if (error instanceof RemovalModelLoadError) return;
      throw error;
    }
  };

  const entryFor = (request: RemovalLoadRequest): CacheEntry => {
    const key = keyOf(request);
    const existing = cache.get(key);
    if (existing) return existing;
    const progress: ProgressState = { listeners: new Set() };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let loadVersion = 0;
    const checkDevice = () => request.provider === "webgpu" ? observeDevice() : Promise.resolve();
    let resolveLoad!: (engine: PreparedRemovalEngine) => void;
    let rejectLoad!: (error: unknown) => void;
    const entry: CacheEntry = {
      promise: new Promise<PreparedRemovalEngine>((resolve, reject) => {
        resolveLoad = resolve;
        rejectLoad = reject;
      }),
      progress,
      users: 0,
      releaseAfterUse: false,
      pending: true,
      abandon(error: unknown = new DOMException("Removal load abandoned", "AbortError")) {
        entry.pending = false;
        clearTimeout(timer);
        rejectLoad(error);
      },
    };
    function arm() {
      clearTimeout(timer);
      const version = ++loadVersion;
      timer = setTimeout(async () => {
        if (contextQuarantined) return;
        await checkDevice();
        if (contextQuarantined || !entry.pending || version !== loadVersion) return;
        entry.pending = false;
        if (cache.get(key) === entry) cache.delete(key);
        rejectLoad(Object.assign(new RemovalModelLoadError(request, new Error("Model download stopped making progress")), {
          code: "model-load-timeout", failureKind: "network",
        }));
      }, 60_000);
      timer.unref?.();
    }
    cache.set(key, entry);
    arm();
    void initialize(request, factories, (event) => {
      if (contextQuarantined || cache.get(key) !== entry) return;
      if (entry.pending) { arm(); void checkDevice(); }
      publish(progress, event);
    }, quarantineContext, () => contextFailure, checkDevice, contextLost).then((engine) => {
      if (!entry.pending) {
        void disposeEngine(engine).catch(captureCleanupFailure);
        return;
      }
      entry.pending = false;
      clearTimeout(timer);
      resolveLoad(engine);
    }, (error: unknown) => {
      entry.pending = false;
      clearTimeout(timer);
      rejectLoad(error);
    });
    void checkDevice();
    void entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    return entry;
  };

  return {
    async use<Result>(
      request: RemovalLoadRequest,
      options: { readonly signal?: AbortSignal; readonly onProgress?: (event: RemovalLoadProgress) => void },
      run: (engine: PreparedRemovalEngine) => Result | Promise<Result>,
    ): Promise<Result> {
      if (contextFailure) throw contextFailure;
      if (options.signal?.aborted) throw new DOMException("Removal cancelled", "AbortError");
      if (contextQuarantined) return subscriberWait(contextLost, options.signal);
      const key = keyOf(request);
      const entry = entryFor(request);
      entry.users += 1;
      const unsubscribe = subscribe(entry.progress, options.onProgress);
      try {
        const engine = await subscriberWait(entry.promise, options.signal);
        options.signal?.throwIfAborted();
        if (contextQuarantined) return await subscriberWait(contextLost, options.signal);
        if (contextFailure) throw contextFailure;
        return await run(engine);
      } finally {
        unsubscribe();
        entry.users -= 1;
        if (entry.users === 0 && (entry.pending || entry.releaseAfterUse)) void retire(key, entry).catch(captureCleanupFailure);
      }
    },
    async releaseIdle(request: RemovalLoadRequest): Promise<void> {
      const key = keyOf(request);
      const entry = cache.get(key);
      if (!entry) return;
      if (entry.users > 0) {
        entry.releaseAfterUse = true;
        return;
      }
      await retire(key, entry);
    },
    async releaseAllIdle(): Promise<void> {
      await Promise.all(Array.from(cache, async ([key, entry]) => {
        if (entry.users > 0) entry.releaseAfterUse = true;
        else await retire(key, entry);
      }));
    },
    cleanupErrors(): readonly unknown[] {
      return cleanupFailures.slice();
    },
  };
}

async function initialize(
  request: RemovalLoadRequest,
  factories: RemovalLoadFactories,
  progress: (event: RemovalLoadProgress) => void,
  quarantineContext: (request: RemovalLoadRequest, cause: unknown) => Promise<never>,
  contextFailure: () => Error | undefined,
  checkDevice: () => Promise<void>,
  contextLost: Promise<never>,
): Promise<PreparedRemovalEngine> {
  const spec = REMOVAL_MODELS[request.model];
  const route = removalModelRoute(request);
  if (!route) throw new RemovalModelLoadError(request, new Error(`${request.model} has no ${request.provider} adapter`));
  const loadProcessor = () => factories.loadProcessor(request.model, progress).finally(checkDevice);
  const loadModel = () => factories.loadModel(request.model, request.provider, progress, route.dtype).catch(async (cause: unknown) => {
    if (!isRemovalSessionFailure(cause)) throw cause;
    return quarantineContext(request, cause);
  }).finally(checkDevice);
  let [processorResult, modelResult] = await Promise.allSettled([loadProcessor(), loadModel()]);
  await checkDevice();
  if (contextFailure()) throw contextFailure();
  // A malformed JSON or failed SHA-256 must not survive the next load. Delete this model's
  // cached files and retry only the failed half once, even when storage is unavailable.
  const integrityFailure = (result: PromiseSettledResult<unknown>) => result.status === "rejected" && isRemovalModelIntegrityError(result.reason);
  const jsonFailure = (result: PromiseSettledResult<unknown>) => result.status === "rejected" && (isHubJsonFailure(result.reason) || isRemovalModelIntegrityError(result.reason));
  if (jsonFailure(processorResult) || jsonFailure(modelResult)) {
    await boundedEviction(() => factories.evictModelCache?.(request.model));
    [processorResult, modelResult] = await Promise.allSettled([
      processorResult.status === "rejected" ? loadProcessor() : processorResult.value,
      modelResult.status === "rejected" ? loadModel() : modelResult.value,
    ]);
    await checkDevice();
    if (contextFailure()) throw contextFailure();
    const stillBad = [processorResult, modelResult].find(jsonFailure);
    if (stillBad?.status === "rejected") {
      // The fresh copy did not parse either (a captive portal still answering): remove it again, so
      // the next try fetches, and say so. Without a cache the bytes came from the network: a load error.
      const removed = await boundedEviction(() => factories.evictModelCache?.(request.model));
      if (integrityFailure(stillBad)) {
        const cleanup = await disposeRemovalResources([processorResult, modelResult].flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
        if (cleanup.length) Object.assign(stillBad.reason, { cause: new AggregateError(cleanup, "Removal cleanup also failed") });
        throw stillBad.reason;
      }
      if (removed) {
        const cleanup = await disposeRemovalResources([processorResult, modelResult].flatMap((result) => result.status === "fulfilled" ? [result.value] : []));
        throw new RemovalModelCacheError(true, cleanup.length > 0 ? removalCleanupFailure(stillBad.reason, cleanup) : stillBad.reason);
      }
    }
  }
  if (processorResult.status === "rejected" || modelResult.status === "rejected") {
    // The model fetch controls provider recovery; retain its sibling's failure for diagnostics.
    const cause = processorResult.status === "rejected" && modelResult.status === "rejected"
      ? new AggregateError([processorResult.reason, modelResult.reason], modelResult.reason instanceof Error ? modelResult.reason.message : "Removal model load failed", { cause: modelResult.reason })
      : processorResult.status === "rejected" ? processorResult.reason : modelResult.status === "rejected" ? modelResult.reason : undefined;
    const returned = [...(processorResult.status === "fulfilled" ? [processorResult.value] : []), ...(modelResult.status === "fulfilled" ? [modelResult.value] : [])];
    const cleanup = await disposeRemovalResources(returned);
    if (cleanup.length > 0) throw new RemovalModelLoadError(request, removalCleanupFailure(cause, cleanup));
    throw new RemovalModelLoadError(request, cause);
  }
  try {
    return prepareRemovalEngine({
      contextLost: request.provider === "webgpu" ? contextLost : undefined,
      contextFailure,
      request,
      spec,
      route,
      processorValue: processorResult.value,
      modelValue: modelResult.value,
    });
  } catch (error) {
    const cleanup = await disposeRemovalResources([processorResult.value, modelResult.value]);
    if (cleanup.length > 0) throw new RemovalModelLoadError(request, removalCleanupFailure(error, cleanup));
    throw new RemovalModelLoadError(request, error);
  }
}

/** Cache Storage has no cancellation API. Five seconds bounds local cleanup well below load and
 *  worker silence; a late delete cannot change the recovery copy. */
function boundedEviction(evict: () => Promise<boolean> | boolean | undefined): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const deadline = setTimeout(() => resolve(false), 5_000);
    deadline.unref?.();
    void Promise.resolve().then(() => evict() ?? false).then(
      (removed) => { clearTimeout(deadline); resolve(removed); },
      () => { clearTimeout(deadline); resolve(false); },
    );
  });
}

/** Transformers with the ORT runtime prefetched and its browser cache on, for a model load. */
async function readyTransformers() {
  const module = await import("./transformers.ts");
  module.prefetchRuntime();
  const tf = module.transformers();
  if (typeof caches !== "undefined") tf.env.useBrowserCache = true;
  return tf;
}

const defaultFactories: RemovalLoadFactories = {
  async evictModelFile(model, provider, dtype) {
    const { transformers } = await import("./transformers.ts");
    return evictRemovalModelFile({ model, provider, context: "page", ...(dtype ? { dtype } : {}) }, transformers().env);
  },
  async evictModelCache(model) {
    const { transformers } = await import("./transformers.ts");
    return evictRemovalModelCache(model, transformers().env);
  },
  async gpuDevice() {
    const { transformers } = await import("./transformers.ts");
    return removalGpuDevice(transformers().env);
  },
  async loadProcessor(model, progress) {
    const tf = await readyTransformers();
    const spec = REMOVAL_MODELS[model];
    return tf.AutoProcessor.from_pretrained(spec.modelId, {
      revision: spec.revision,
      progress_callback: (event: unknown) => progress(removalProgressEvent(event)),
    });
  },
  async loadModel(model, provider, progress, dtype) {
    const tf = await readyTransformers();
    const spec = REMOVAL_MODELS[model];
    const route = removalModelRoute({ model, provider, ...(dtype ? { dtype } : {}) });
    if (!route) throw new Error(`${model} has no ${provider} adapter`);
    return tf.AutoModel.from_pretrained(spec.modelId, {
      revision: spec.revision,
      device: provider,
      dtype: route.dtype,
      ...(provider === "webgpu"
        ? { session_options: { graphOptimizationLevel: "basic" as const } }
        : {}),
      progress_callback: (event: unknown) => progress(removalProgressEvent(event)),
    });
  },
};

function publish(state: ProgressState, event: RemovalLoadProgress): void {
  state.last = event;
  for (const listener of state.listeners) notify(listener, event);
}

function subscribe(state: ProgressState, listener?: (event: RemovalLoadProgress) => void): () => void {
  if (!listener) return () => undefined;
  state.listeners.add(listener);
  if (state.last) notify(listener, state.last);
  return () => state.listeners.delete(listener);
}

function notify(listener: (event: RemovalLoadProgress) => void, event: RemovalLoadProgress): void {
  try {
    listener(event);
  } catch {
    // A failing subscriber must not fail the shared load or the other subscribers.
  }
}

function subscriberWait<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new DOMException("Removal cancelled", "AbortError"));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Removal cancelled", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
