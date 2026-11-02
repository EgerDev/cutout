// Cutout's own removal runtime: route choice, per-context job lock, model leases, the session
// route memo and the engine's boundary errors. It sits between engine.ts and the model pool.
// No canvas, UI or worker-message code lives here (design r9 section 3).
import { failureCode } from "./errors.ts";
import { hasFp16Adapter, navigatorGpu, requestCompatibleAdapter } from "./gpu-compat.ts";
import type { MaskSemantics, MatteRenderPolicy } from "./model-mask.ts";
import { createRemovalEnginePool, RemovalModelLoadError } from "./removal-model.ts";
import type { PreparedRemovalEngine } from "./removal-model.ts";
import {
  absorbsLoadFailure,
  requiresFreshRemovalContext,
  noteWebgpuLoadFailure,
  readGpuFailure,
  selectRemovalRoute,
  webgpuLoadMemo,
} from "./removal-provider.ts";
import type { RemovalModelKind, RemovalProvider, RemovalRoute } from "./removal-provider.ts";

export type RemovalTarget = RemovalRoute["primary"];
export type AutomaticRoute = {
  primary: RemovalRoute["primary"];
  lowMemory: boolean;
  shape: "primary" | "compat";
};

type CompatRecord = { readonly attempted: boolean; readonly transfer?: "fast" | "quality" };

/** C3: what a finished job rendered and on which engine. Not part of `RemovalResult`. */
export type RemovalProvenance = {
  readonly renderPolicy: MatteRenderPolicy;
  readonly rawOutputSemantics: MaskSemantics;
  readonly model: RemovalModelKind;
  readonly modelId: string;
  readonly revision: string;
  readonly provider: RemovalProvider;
  readonly dtype: "fp16" | "fp32";
  readonly onnxFile: "model.onnx" | "model_fp16.onnx";
  readonly mode: string;
  readonly shape: "primary" | "compat";
  readonly absorbAttempted: boolean;
  readonly globalTransfer: "fast" | "quality";
  readonly cropTransfer: "quality";
  readonly cropBudget: number;
  readonly cropInferences: number;
  readonly compat: CompatRecord;
};

/** C3 fault record: written before a job returns `provider: "fallback"` or throws. */
export type RemovalFaultProvenance = {
  readonly outcome: "fallback" | "error";
  readonly route: RemovalRoute["primary"];
  readonly shape: "primary" | "compat";
  readonly renderPolicy: MatteRenderPolicy;
  readonly absorbAttempted: boolean;
  readonly compat: CompatRecord;
  readonly ranOn?: RemovalProvider | undefined;
};

type RunOptions = {
  readonly signal?: AbortSignal;
  readonly onProgress?: (fraction: number) => void;
  /** Called once when an absorbed load failure starts the BiRefNet/WASM load. */
  readonly onAbsorb?: () => void;
};
type JobInfo = { absorbAttempted: boolean; absorbLoadFailed: boolean; webgpuLoadFailure?: unknown };
type PendingRelease = { readonly promise: Promise<void>; settled: boolean };

const BIREFNET_WASM = { model: "birefnet", provider: "wasm" } as const;
const noop = (): void => undefined;

export function createRemovalRuntime(deps: {
  pool?: ReturnType<typeof createRemovalEnginePool>;
  adapter?: () => Promise<unknown>;
  /** Whether that adapter can run the fp16 route; an injected `adapter` alone counts as able. */
  fp16?: () => Promise<boolean>;
} = {}) {
  const pool = deps.pool ?? createRemovalEnginePool();
  const context = "WorkerGlobalScope" in globalThis ? "worker" : "page";
  const probeAdapter = deps.adapter ?? (() => requestCompatibleAdapter(navigatorGpu()));
  const probeFp16 =
    deps.fp16 ?? (deps.adapter ? async () => true : () => hasFp16Adapter(navigatorGpu()));
  const cleanupFailures: unknown[] = [];

  let adapterProbe: Promise<{ compatible: boolean; fp16: boolean }> | undefined;
  let tail: Promise<void> = Promise.resolve();
  let locked = false;
  let pageJobs = 0;
  let pageIdleTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseOnDrain = false;
  let jobLoadFailure: unknown;
  let jobState = freshJobInfo();
  let current: RemovalTarget | undefined;
  let pendingRelease: PendingRelease | undefined;
  let lastProvenance: RemovalProvenance | RemovalFaultProvenance | undefined;

  function hasAdapter(): Promise<{ compatible: boolean; fp16: boolean }> {
    adapterProbe ??= Promise.resolve()
      .then(probeAdapter)
      .then(
        async (adapter) => ({
          compatible: adapter != null,
          fp16: adapter != null && (await probeFp16().catch(() => false)),
        }),
        () => ({ compatible: false, fp16: false }),
      );
    return adapterProbe;
  }

  function recordCleanupFailure(error: unknown): void {
    // Diagnostics only: the latest failures, not every one a long session produced.
    if (cleanupFailures.push(error) > 16) cleanupFailures.shift();
  }

  /** Never takes the lock and never rejects. Called only from `use` while the lock is held. */
  async function release(target?: RemovalTarget): Promise<void> {
    try {
      if (target) await pool.releaseIdle({ ...target, context });
      else await pool.releaseAllIdle();
    } catch (error) {
      recordCleanupFailure(error);
    }
  }

  /** An unsettled release is never replaced: a newer release is chained behind it (F2). */
  function startRelease(target?: RemovalTarget): void {
    const next = release(target);
    const previous = pendingRelease;
    const promise = previous && !previous.settled ? Promise.all([previous.promise, next]).then(noop) : next;
    const record: PendingRelease = { promise, settled: false };
    pendingRelease = record;
    void promise.then(() => {
      record.settled = true;
      if (pendingRelease === record) pendingRelease = undefined;
    });
  }

  function releasePageIdle() {
    clearTimeout(pageIdleTimer);
    if (pageJobs > 0) {
      releaseOnDrain = true;
      return;
    }
    releaseOnDrain = false;
    current = undefined;
    // A later lease waits for disposal, just as it waits when switching targets.
    startRelease();
  }

  if (context === "page" && typeof addEventListener === "function") {
    addEventListener("pagehide", releasePageIdle);
  }

  async function automaticRoute(): Promise<AutomaticRoute> {
    const { compatible: compatibleGpu, fp16 } = await hasAdapter();
    const deviceMemory = deviceMemoryHint();
    const memo = webgpuLoadMemo();
    const route = selectRemovalRoute({
      ...(deviceMemory === undefined ? {} : { deviceMemory }),
      compatibleGpu,
      fp16,
      gpuFailed: !compatibleGpu || readGpuFailure() || memo !== undefined,
    });
    // A remembered init-class WebGPU load failure keeps the session in the compatibility shape.
    return {
      primary: route.primary,
      lowMemory: route.primary.model === "isnet",
      shape: memo === "init" ? "compat" : "primary",
    };
  }

  function exclusive<R>(signal: AbortSignal | undefined, run: () => Promise<R>): Promise<R> {
    if (context === "page") {
      pageJobs++;
      clearTimeout(pageIdleTimer);
    }
    return new Promise<R>((resolve, reject) => {
      let started = false;
      const abandon = () => {
        if (!started && signal) reject(signal.reason);
      };
      signal?.addEventListener("abort", abandon, { once: true });
      const previous = tail;
      const turn = previous.then(async () => {
        started = true;
        signal?.removeEventListener("abort", abandon);
        jobLoadFailure = undefined;
        jobState = freshJobInfo();
        locked = true;
        try {
          signal?.throwIfAborted();
          return await run();
        } finally {
          // Cleared before the link settles, so a queued waiter always reads the updated route (F3).
          locked = false;
          jobLoadFailure = undefined;
          jobState = freshJobInfo();
          if (context === "page" && --pageJobs === 0) {
            if (releaseOnDrain) releasePageIdle();
            else {
              pageIdleTimer = setTimeout(releasePageIdle, 60_000);
              pageIdleTimer.unref?.();
            }
          }
        }
      });
      tail = turn.then(noop, noop);
      if (signal?.aborted) reject(signal.reason);
      turn.then(resolve, reject);
    });
  }

  async function lease<R>(
    target: RemovalTarget,
    opts: RunOptions,
    run: (engine: PreparedRemovalEngine) => R | Promise<R>,
  ): Promise<R> {
    if (!locked) throw new Error("removal runtime: use outside exclusive");
    const { signal } = opts;
    signal?.throwIfAborted();
    if (current !== undefined && !sameTarget(current, target)) {
      startRelease(current);
      current = undefined;
    }
    if (pendingRelease) await abortable(pendingRelease.promise, signal);
    current = target;
    let entered = false;
    try {
      return await pool.use(
        { ...target, context },
        {
          ...(signal ? { signal } : {}),
          onProgress: (event) => {
            if (event.status !== "progress" || !event.file?.endsWith(".onnx")) return;
            const percent = event.progress ?? 0;
            opts.onProgress?.(Math.min(1, Math.max(0, Number.isFinite(percent) ? percent / 100 : 0)));
          },
        },
        (engine) => {
          entered = true;
          // Engine-ready (Q4): a replacement BiRefNet/WASM engine after a WebGPU load failure
          // fixes the session route, synchronously and inside this job's lock link.
          if (
            jobLoadFailure !== undefined &&
            target.model === "birefnet" &&
            target.provider === "wasm" &&
            !jobState.absorbLoadFailed
          ) {
            noteWebgpuLoadFailure(jobLoadFailure);
          }
          return run(engine);
        },
      );
    } catch (error) {
      // Abort identity: one object at every entry point, never the pool's minted DOMException.
      if (signal?.aborted) throw signal.reason;
      // A load error is never "abort"-kind: its constructor files an abort cause under provider-init.
      if (!entered && error instanceof RemovalModelLoadError) {
        const code = failureCode(error);
        if (code !== "memory" && code !== "browser" && code !== "updated") {
          if (error.code !== "model-load-timeout") Object.assign(error, { code: "model-load-failed" });
        }
        if (target.provider === "webgpu") jobLoadFailure ??= error;
      }
      throw error;
    }
  }

  async function usePrimary<R>(
    route: AutomaticRoute,
    opts: RunOptions,
    run: (engine: PreparedRemovalEngine) => R | Promise<R>,
  ): Promise<R> {
    try {
      return await lease(route.primary, opts, run);
    } catch (error) {
      if (isAbort(error, opts.signal)) throw error;
      const { primary } = route;
      const mayAbsorb = primary.model === "birefnet" && primary.provider === "webgpu";
      if (!mayAbsorb || !absorbsLoadFailure(error)) throw error;
      jobState.absorbAttempted = true;
      opts.onAbsorb?.();
      let ready = false;
      try {
        return await lease(BIREFNET_WASM, opts, (engine) => {
          ready = true;
          return run(engine);
        });
      } catch (absorbError) {
        // One attempt, error unchanged; an abort never counts as a failed absorb.
        if (!ready && !isAbort(absorbError, opts.signal)) jobState.absorbLoadFailed = true;
        throw absorbError;
      }
    }
  }

  return {
    automaticRoute,
    exclusive,
    use: lease,
    usePrimary,
    jobInfo(): JobInfo {
      return { ...jobState, webgpuLoadFailure: jobLoadFailure };
    },
    recordCleanupFailure,
    cleanupErrors(): readonly unknown[] {
      return [...pool.cleanupErrors(), ...cleanupFailures];
    },
    recordProvenance(record: RemovalProvenance | RemovalFaultProvenance): void {
      lastProvenance = record;
    },
    provenance(): RemovalProvenance | RemovalFaultProvenance | undefined {
      return lastProvenance;
    },
  };
}

export const removalRuntime = createRemovalRuntime();

/** Name-based, as the engine has always checked it: an aborted signal, or an AbortError. */
export function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof DOMException && error.name === "AbortError") return true;
  return error instanceof Error && error.name === "AbortError";
}

/** `gpuSuspect`: the mask looks like a GPU that cannot run the model (NaN, or nothing), not like
 *  a photo without a subject; the WASM retry decides which. */
export function maskError(message: string, gpuSuspect = false, cause?: unknown): Error {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = "MaskError";
  return Object.assign(error, { gpuSuspect });
}

export function isGpuSuspectMask(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "MaskError" &&
    (error as { gpuSuspect?: boolean }).gpuSuspect === true
  );
}

/**
 * Maps a throw at the engine's processor/model boundary to the error the engine contract names.
 * Only the job's own aborted signal makes it a cancel, returned untouched: an error merely named
 * AbortError (WebGPU's readback after a device loss) with a live signal skipped the compatibility
 * pass and was requeued as a cancel with no end (C05). Messages stay verbatim; the original is the `cause`.
 */
export function engineErrorFor(
  error: unknown,
  boundary: "processor" | "model",
  provider: RemovalProvider,
  signal?: AbortSignal,
): unknown {
  if (signal?.aborted || requiresFreshRemovalContext(error)) return error;
  const outputError =
    error instanceof Error && error.name === "RemovalModelOutputError" ? error : undefined;
  if (boundary === "processor") {
    return new RemovalInputError(outputError ? "Image preprocessing failed" : messageOf(error), error);
  }
  if (outputError) {
    return outputError.message.startsWith("Model returned nonfinite")
      ? maskError("The model returned an invalid alpha mask", provider === "webgpu", error)
      : maskError("The model returned an invalid mask shape", (outputError as Error & { failureKind?: string }).failureKind === "gpu-mask", error);
  }
  // Memory, browser and updated keep their non-retryable precedence; everything else, including
  // a RuntimeError "Aborted()" crash, is a retryable inference failure rather than a cancellation.
  // ORT WASM can throw its numeric C++ exception pointer on allocation failure.
  if (typeof error === "number") return new RemovalInferenceError("The model ran out of memory", error, "out-of-memory");
  const kept = failureCode(error);
  return new RemovalInferenceError(
    messageOf(error),
    error,
    kept === "memory" || kept === "browser" || kept === "updated" ? undefined : "inference-failed",
  );
}

class RemovalInputError extends Error {
  readonly name = "RemovalInputError";
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

class RemovalInferenceError extends Error {
  readonly name = "RemovalInferenceError";
  declare code?: string;
  constructor(message: string, cause: unknown, code?: string) {
    super(message, { cause });
    if (code !== undefined) this.code = code;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function freshJobInfo(): { absorbAttempted: boolean; absorbLoadFailed: boolean } {
  return { absorbAttempted: false, absorbLoadFailed: false };
}

function sameTarget(a: RemovalTarget, b: RemovalTarget): boolean {
  return a.model === b.model && a.provider === b.provider && a.dtype === b.dtype;
}

function deviceMemoryHint(): number | undefined {
  if (typeof navigator === "undefined") return undefined;
  const memory: unknown = Reflect.get(navigator, "deviceMemory");
  return typeof memory === "number" ? memory : undefined;
}

/** Rejects with the signal's reason at once; `promise` keeps running. No timer. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
