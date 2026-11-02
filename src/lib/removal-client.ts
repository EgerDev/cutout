/**
 * Runs background removal in a Web Worker when the browser can (OffscreenCanvas
 * and, for speed, WebGPU inside workers), so a 12 MP photo does not freeze the
 * page for seconds while its edges are cleaned. Falls back to the main-thread
 * engine everywhere else, and after a worker failure.
 */
import type { ConsumerProgress, removeBackgroundLocal } from "./engine.ts";
import type { RemovalMode, SubjectBox } from "./editor/model.ts";
import { readEnv } from "./device.ts";
import { CutoutError, failureCode } from "./errors.ts";
import { navigatorGpu, requestCompatibleAdapter } from "./gpu-compat.ts";
import { isPrepareTimeout, withPrepareDeadline } from "./idle-model.ts";
import { ENGINE_ERROR_NAMES, requiresFreshRemovalContext, requiresWasmContext, readGpuFailure, rememberGpuFailure } from "./removal-provider.ts";
import type { RemovalFaultProvenance, RemovalProvenance } from "./removal-runtime.ts";

export type RemovalResult = Awaited<ReturnType<typeof removeBackgroundLocal>>;

type Pending = {
  cleanup: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ConsumerProgress) => void;
};

let worker: Worker | null | undefined;
let next = 1;
const pending = new Map<number, Pending>();
/** Jobs the worker is still running, including ones whose caller already cancelled: a
 *  cancel cannot stop a model download, and releasing the worker then threw it away. */
const inFlight = new Set<number>();
let activityTimer: ReturnType<typeof setTimeout> | undefined;
const INACTIVITY_MS = 120_000;
function touch() {
  clearTimeout(activityTimer);
  if (!inFlight.size) return;
  activityTimer = setTimeout(() => {
    const error = Object.assign(new Error("The remover stopped responding. Try again."), {
      code: "removal-worker-stalled", failureKind: "network",
    });
    dropWorker(error, true);
  }, INACTIVITY_MS);
}
function canRespawn(error: unknown) {
  return (
    requiresFreshRemovalContext(error) ||
    (error as { code?: unknown })?.code === "removal-worker-stalled" ||
    (error as { workerCrashed?: unknown })?.workerCrashed === true
  );
}
/** E03-01: an uncaught error in the worker (not a reply) replaces it once per page, and the jobs it
 *  had are redriven there; a second one moves the session to the page, as every one did before. */
const CRASH_RESPAWNS = 1;
let crashRespawns = 0;
/** Set once the worker had to fall back to WASM although the page has WebGPU. */
let workerSlow = false;
/** The worker was found slow while it still had jobs: it takes no new model of its own
 *  accord, but retires (and `workerSlow` is set) the moment it drains, so the page model
 *  and the worker model never coexist (Q5). */
let retireWhenIdle = false;
/** Set once WebGPU failed inside a worker; later workers skip it from the start. */
let workerGpuFailed = false;
/** A loaded model pins ~2 GB of WASM heap (on WebGPU too: its shape ops run on the
 *  CPU) plus its GPU buffers until the worker ends. Free it after a minute idle, or
 *  a few seconds once the tab is hidden. The cached model reloads. */
const IDLE_MS = 60_000;
const HIDDEN_IDLE_MS = 5_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let watchingVisibility = false;

function scheduleRelease() {
  clearTimeout(idleTimer);
  if (pending.size || inFlight.size || !worker) return;
  if (retireWhenIdle) {
    retireWhenIdle = false;
    worker.terminate(); // synchronous: the page may load its own model on the next tick
    worker = undefined;
    workerSlow = true;
    return;
  }
  idleTimer = setTimeout(
    () => {
      if (pending.size || inFlight.size || !worker) return;
      worker.terminate();
      worker = undefined; // not null: the next cut spawns a fresh worker
    },
    document.hidden ? HIDDEN_IDLE_MS : IDLE_MS,
  );
}

function settle(id: number) {
  pending.get(id)?.cleanup();
  pending.delete(id);
  scheduleRelease();
}

/** C3: what the last finished removal job rendered, or the fault it recorded. The worker's
 *  record rides its reply; a page job reads the page runtime. Not part of `RemovalResult`. */
let lastProvenance: RemovalProvenance | RemovalFaultProvenance | undefined;
export function lastRemovalProvenance() {
  return lastProvenance;
}

export function workerRemovalSupported() {
  return (
    typeof Worker !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof createImageBitmap === "function" &&
    !workerSlow
  );
}

function getWorker(): Worker | null {
  if (worker === null || workerSlow) return null;
  if (worker) return worker;
  if (!workerRemovalSupported()) return (worker = null);
  try {
    worker = new Worker(new URL("./removal-worker.ts", import.meta.url), { type: "module" });
  } catch {
    return (worker = null);
  }
  if (!watchingVisibility) {
    watchingVisibility = true;
    document.addEventListener("visibilitychange", scheduleRelease);
    // A page kept in the back/forward cache has its timers frozen, so the hidden-tab
    // release never ran and the ~2 GB worker stayed with it. pagehide does not stop the
    // page being cached; a later cut starts a fresh worker from the cached model.
    addEventListener("pagehide", () => {
      if (pending.size || inFlight.size || !worker) return;
      clearTimeout(idleTimer);
      worker.terminate();
      worker = undefined;
    });
  }
  const attached = worker;
  worker.addEventListener("error", () => {
    if (worker !== attached) return;
    // No code: a crash is the worker's, not the engine's, so the page can still take the job.
    if (crashRespawns < CRASH_RESPAWNS) {
      crashRespawns += 1;
      dropWorker(Object.assign(new Error("The removal worker failed."), { workerCrashed: true }), true);
    } else dropWorker(new Error("The removal worker failed."));
  });
  worker.addEventListener(
    "message",
    (
      event: MessageEvent<
        | { type: "progress"; id: number; progress: ConsumerProgress }
        | { type: "done"; id: number; result: unknown }
        | {
            type: "error";
            id: number;
            aborted: boolean;
            name: string;
            message: string;
            detail: string;
            code?: string;
            failureKind?: string;
            retryable?: boolean;
            provenance?: RemovalFaultProvenance;
          }
      >,
    ) => {
      if (worker !== attached) return;
      const data = event.data;
      if (inFlight.has(data.id)) {
        if (data.type !== "progress") inFlight.delete(data.id);
        // The queue shares one execution lane. Its active job keeps every waiter
        // alive, including cancelled callers whose abort has not drained yet.
        touch();
        if (data.type !== "progress") scheduleRelease();
      }
      const entry = pending.get(data.id);
      if (!entry) {
        // Cancellation already settled the caller, but a dead realm must still be retired.
        if (data.type === "error" && requiresFreshRemovalContext(data)) {
          if (requiresWasmContext(data)) workerGpuFailed = true;
          dropWorker(Object.assign(new Error(data.message), { code: data.code, failureKind: data.failureKind }), true);
        }
        return;
      }
      if (data.type === "progress") entry.onProgress?.(data.progress);
      else if (data.type === "done") {
        settle(data.id);
        entry.resolve(data.result);
      } else {
        lastProvenance = data.provenance;
        settle(data.id);
        // Rebuild what the worker threw: a CutoutError stays one; an engine error keeps
        // its name and code so classifyError maps it to copy (and marks it retryable)
        // exactly as on the page, instead of showing the engine's text and cause chain.
        const cause = new Error(data.detail);
        const error = data.aborted
          ? new DOMException(data.message || "Aborted", "AbortError")
          : data.name === "CutoutError"
            ? new CutoutError(data.code as never, data.message, Boolean(data.retryable), { cause })
            : Object.assign(new Error(data.message, { cause }), {
                name: data.name,
                code: data.code,
                failureKind: data.failureKind,
              });
        if (requiresFreshRemovalContext(error)) {
          if (requiresWasmContext(error)) workerGpuFailed = true;
          dropWorker(error, true);
        }
        entry.reject(error);
      }
    },
  );
  return worker;
}

function dropWorker(error: Error, respawn = false) {
  clearTimeout(idleTimer);
  clearTimeout(activityTimer);
  for (const entry of pending.values()) { entry.cleanup(); entry.reject(error); }
  pending.clear();
  inFlight.clear();
  worker?.terminate();
  worker = respawn ? undefined : null;
  // A worker found slow that dies before it drains is still slow; the decision stands.
  if (retireWhenIdle) {
    retireWhenIdle = false;
    workerSlow = true;
  }
}

function call<T>(
  message: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (progress: ConsumerProgress) => void,
): Promise<T> | null {
  const first = callOnce<T>(message, signal, onProgress);
  if (!first) return null;
  return first.catch(async (error: unknown) => {
    if (!canRespawn(error) || signal?.aborted) throw error;
    if (requiresWasmContext(error)) workerGpuFailed = true;
    const retry = callOnce<T>(message, signal, onProgress);
    if (!retry) throw error;
    return retry;
  });
}

function callOnce<T>(
  message: Record<string, unknown>,
  signal?: AbortSignal,
  onProgress?: (progress: ConsumerProgress) => void,
): Promise<T> | null {
  const w = getWorker();
  if (!w) return null;
  const id = next++;
  clearTimeout(idleTimer);
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (value: unknown) => void, reject, onProgress, cleanup: () => signal?.removeEventListener("abort", abort) });
    // Settle now: a job waiting behind an inference that cannot be interrupted would
    // otherwise keep the cancel pending until that inference ends.
    const abort = () => {
      w.postMessage({ type: "abort", id });
      if (!pending.has(id)) return;
      settle(id);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    inFlight.add(id);
    if (inFlight.size === 1) touch();
    try {
      w.postMessage({ ...message, id, env: readEnv(), noWebgpu: workerGpuFailed || readGpuFailure() });
    } catch (error) {
      // Never sent (a value that cannot be cloned): no reply will come to clear the job, and
      // a job left in either map keeps the worker's model from ever being released.
      signal?.removeEventListener("abort", abort);
      inFlight.delete(id);
      if (!inFlight.size) clearTimeout(activityTimer);
      settle(id);
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // Already cancelled (a re-cut replaced this one before it started): the listener never
    // fires for that, and the job would run in full ahead of its replacement.
    if (signal?.aborted) abort();
  });
}

/**
 * Rethrows what the page would fail on too; retires the worker only when the worker
 * itself broke (no OffscreenCanvas 2D, module failure, a decode only the page can do).
 * Re-running an image that ran out of memory on the main thread only froze the page
 * before failing again, and left every later cut there.
 */
async function fallBackToPage(error: unknown, signal: AbortSignal | undefined, inputs: readonly Blob[]) {
  if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))
    throw error;
  // An error the engine reported (with a string code) is not a broken worker: keep it. A
  // DOMException's legacy numeric code (InvalidStateError = 11) is not an engine code (Q12).
  if (error instanceof CutoutError || typeof (error as { code?: unknown }).code === "string")
    throw error;
  if (failureCode(error) === "memory") throw error;
  // An engine-origin failure already had its one compatibility attempt inside the worker;
  // a page rerun can only repeat it (Q12). The worker is healthy: keep it.
  if (ENGINE_ERROR_NAMES.has((error as { name?: string })?.name ?? "")) throw error;
  // A file the page cannot decode either is the file's fault: one corrupt photo retired the
  // worker for the session, and every later cut froze the page (C07). Only a decode the page
  // can do, which the worker could not, is a broken worker.
  if (failureCode(error) === "decode") {
    const decodes = await pageDecodes(inputs);
    signal?.throwIfAborted();
    if (!decodes) throw error;
  }
  console.warn("[cutout] removal worker failed; running on the page instead", error);
  dropWorker(error instanceof Error ? error : new Error(String(error)));
}

async function pageDecodes(inputs: readonly Blob[]) {
  try {
    for (const input of inputs) (await createImageBitmap(input)).close();
    return true;
  } catch {
    return false;
  }
}

/** Removal in the worker when possible; the main-thread engine otherwise. */
export async function removeBackgroundAuto(
  file: Blob,
  options: {
    mode?: RemovalMode;
    signal?: AbortSignal;
    onProgress?: (progress: ConsumerProgress) => void;
  } = {},
): Promise<RemovalResult> {
  const viaWorker = call<
    RemovalResult & { workerHadGpu?: boolean; provenance?: RemovalProvenance }
  >(
    { type: "run", file, mode: options.mode ?? "auto" },
    options.signal,
    options.onProgress,
  );
  if (viaWorker) {
    try {
      const { workerHadGpu, provenance, ...result } = await viaWorker;
      lastProvenance = provenance;
      // A worker without WebGPU is slower than the page's GPU; keep the page
      // responsive for this run, then let later runs take the faster path.
      // `navigator.gpu` alone is not WebGPU: without an adapter the page would also run WASM on the
      // main thread, freezing it on every later cut.
      // A worker whose WebGPU failed stays: the page shares that GPU. Only a GPU the
      // engine found broken (not a one-off failure) is skipped by later workers.
      if (result.webgpuBroken) {
        workerGpuFailed = true;
        // The page skips this GPU too for the rest of the session; a mask judged from one
        // image is not kept for later visits (E10-S-01).
        rememberGpuFailure("gpu-mask");
      }
      if (
        !workerHadGpu &&
        result.provider === "wasm" &&
        (await requestCompatibleAdapter(navigatorGpu())) !== null
      ) {
        // Free the worker's model copy; the page engine takes every later run. A worker
        // still running a job (even a cancelled one: it cannot be interrupted) drains first,
        // so the page's model never loads next to the worker's (Q5).
        if (pending.size === 0 && inFlight.size === 0) {
          workerSlow = true;
          dropWorker(new Error("The removal worker was retired."));
        } else retireWhenIdle = true;
      }
      return result;
    } catch (error) {
      await fallBackToPage(error, options.signal, [file]);
    }
  }
  const { removeBackgroundLocal } = await import("./engine.ts");
  return onPage((onProvenance) => removeBackgroundLocal(file, { ...options, onProvenance }));
}

/** Capture the engine's per-invocation handoff; another overlapping job cannot supply it. */
async function onPage<T>(job: (record: (value: RemovalProvenance | RemovalFaultProvenance) => void) => Promise<T>): Promise<T> {
  let record: RemovalProvenance | RemovalFaultProvenance | undefined;
  try {
    return await job((value) => { record = value; });
  } finally {
    lastProvenance = record;
  }
}

export async function refineCropsAuto(
  source: Blob,
  base: Blob,
  boxes: readonly SubjectBox[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ConsumerProgress) => void;
  } = {},
): Promise<Blob> {
  const viaWorker = call<{ blob: Blob; provenance?: RemovalProvenance }>(
    { type: "refine", source, base, boxes: [...boxes] },
    options.signal,
    options.onProgress,
  );
  if (viaWorker) {
    try {
      const { blob, provenance } = await viaWorker;
      lastProvenance = provenance;
      return blob;
    } catch (error) {
      await fallBackToPage(error, options.signal, [source, base]);
    }
  }
  const { refineWithUserCrops } = await import("./engine.ts");
  return onPage((onProvenance) => refineWithUserCrops(source, base, boxes, { ...options, onProvenance }));
}

/** Loads the model where removal will run, reporting its download (0..1); rejects when it fails.
 *  Only a broken worker falls back to the page, as for a cut: a page warmup after a real load
 *  failure only repeated it (C09). Cancel/timeout stop this wait; a deadline remaps the worker's
 *  generic AbortError back to TimeoutError. */
export async function warmupRemoval(
  onProgress?: (fraction: number) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const bound = withPrepareDeadline(options);
  try {
    const viaWorker = call<null>(
      { type: "warmup" },
      bound.signal,
      onProgress && ((progress) => onProgress(progress.progress)),
    );
    if (viaWorker) {
      try {
        await viaWorker;
        return;
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (isPrepareTimeout(bound.signal?.reason)) throw bound.signal!.reason;
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        await fallBackToPage(error, bound.signal, []);
      }
    }
    const { warmupBiRefNet } = await import("./engine.ts");
    await warmupBiRefNet(onProgress, bound.signal);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (isPrepareTimeout(bound.signal?.reason)) throw bound.signal!.reason;
    throw error;
  } finally {
    bound.stop();
  }
}
