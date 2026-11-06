/**
 * Background removal off the main thread. The engine and its helpers draw on
 * `document.createElement("canvas")` and `canvas.toBlob`, so the worker gives
 * them an OffscreenCanvas behind those names before loading the engine.
 */
import { adoptHostEnv, type ClientEnv } from "./device.ts";
import type { ConsumerProgress } from "./engine.ts";
import { navigatorGpu, requestCompatibleAdapter } from "./gpu-compat.ts";
import { rememberGpuFailure } from "./removal-provider.ts";
import type { RemovalMode, SubjectBox } from "./editor/model.ts";

type Request = (
  | { type: "warmup"; id: number }
  | { type: "run"; id: number; file: Blob; mode: RemovalMode }
  | {
      type: "refine";
      id: number;
      source: Blob;
      base: Blob;
      boxes: SubjectBox[];
    }
  | { type: "abort"; id: number }
) & { env?: ClientEnv; noWebgpu?: boolean };

const scope = self as unknown as { document?: unknown };
if (typeof scope.document === "undefined" && typeof OffscreenCanvas !== "undefined") {
  const proto = OffscreenCanvas.prototype as OffscreenCanvas & {
    toBlob?: (callback: (blob: Blob | null) => void, type?: string, quality?: number) => void;
  };
  // Always replace it: Firefox still ships a legacy OffscreenCanvas.toBlob(type, quality)
  // that returns a Promise and never calls a callback, so every worker cut hung there.
  proto.toBlob = function (this: OffscreenCanvas, callback, type, quality) {
    this.convertToBlob({ type, quality }).then(callback, () => callback(null));
  };
  // Only what the canvas code needs; the runtime probes for script tags and
  // must find nothing (it then resolves its files from import.meta.url).
  scope.document = {
    createElement: (tag: string): unknown => {
      if (tag !== "canvas") throw new Error(`worker cannot create <${tag}>`);
      return new OffscreenCanvas(1, 1);
    },
    currentScript: null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    head: null,
    body: null,
  };
}

const aborts = new Map<number, AbortController>();
const warmups = new Set<AbortController>();
/** One cut at a time: a superseded run finishing its edge cleanup next to the new one
 *  held two full-size buffer sets at once, twice the peak memory on a phone. */
let queue: Promise<void> = Promise.resolve();
/** Asked once per worker; adapters without f16 can run the fp32 route too. */
let gpuCheck: Promise<boolean> | undefined;
const hasGpu = () =>
  (gpuCheck ??= requestCompatibleAdapter(navigatorGpu()).then((adapter) => adapter !== null));

/** The message plus its cause chain: loader failures arrive wrapped in a generic error. */
function describe(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 4; depth++) {
    parts.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : null;
  }
  return parts.join(" ← ");
}

addEventListener("message", (event: MessageEvent<Request>) => {
  const data = event.data;
  if (data.env) adoptHostEnv(data.env);
  if (data.type === "abort") {
    aborts.get(data.id)?.abort();
    return;
  }
  // Registered now, so an abort that arrives while the job waits its turn is kept.
  const controller = new AbortController();
  aborts.set(data.id, controller);
  if (data.type === "warmup") warmups.add(controller);
  else for (const warmup of warmups) warmup.abort();
  queue = queue
    .then(() => handle(data, controller))
    // handle() rejects only when its own error reply could not be cloned. Send the text, so
    // the caller still settles; a rejected queue also never ran any later job.
    .catch((error: unknown) => {
      postMessage({
        type: "error",
        id: data.id,
        aborted: controller.signal.aborted,
        name: "Error",
        message: describe(error),
        detail: describe(error),
      });
    });
});

async function handle(data: Exclude<Request, { type: "abort" }>, controller: AbortController) {
  const { id } = data;
  // The runtime is already loaded by the engine; read before the job, a record is this job's
  // only if it is a different object afterwards (C3).
  let runtime: typeof import("./removal-runtime.ts").removalRuntime | undefined;
  let before: unknown;
  const recordOfThisJob = () => {
    const after = runtime?.provenance();
    return after === before ? undefined : after;
  };
  try {
    controller.signal.throwIfAborted();
    // WebGPU already failed on the page or in an earlier worker; this one would retry it on
    // every image. In a worker this sets only the in-process flag (there is no localStorage).
    if (data.noWebgpu) rememberGpuFailure("gpu-mask");
    const engine = await import("./engine.ts");
    runtime = (await import("./removal-runtime.ts")).removalRuntime;
    before = runtime.provenance();
    const onProgress = (progress: ConsumerProgress) =>
      postMessage({ type: "progress", id, progress });
    if (data.type === "warmup") {
      // The model download's fraction rides the progress message; the client hands it back as is.
      await engine.warmupBiRefNet(
        (fraction) => onProgress({ stage: "loading", progress: fraction, message: "" }),
        controller.signal,
      );
      postMessage({ type: "done", id, result: null });
      return;
    }
    if (data.type === "run") {
      const result = await engine.removeBackgroundLocal(data.file, {
        mode: data.mode,
        signal: controller.signal,
        onProgress,
      });
      // Ending on WASM with an adapter here means WebGPU failed for this image, not that
      // the worker lacks it: the page is no faster.
      const workerHadGpu = result.provider === "wasm" && (await hasGpu());
      postMessage({
        type: "done",
        id,
        result: { ...result, workerHadGpu, provenance: recordOfThisJob() },
      });
      return;
    }
    const blob = await engine.refineWithUserCrops(data.source, data.base, data.boxes, {
      signal: controller.signal,
      onProgress,
    });
    postMessage({ type: "done", id, result: { blob, provenance: recordOfThisJob() } });
  } catch (error) {
    postMessage({
      type: "error",
      id,
      aborted: controller.signal.aborted,
      name: error instanceof Error ? error.name : "Error",
      // The message users may see; the cause chain travels separately for diagnostics.
      message: error instanceof Error ? error.message : String(error),
      detail: describe(error),
      code: (error as { code?: string | number })?.code,
      failureKind: (error as { failureKind?: string })?.failureKind,
      retryable: (error as { retryable?: boolean })?.retryable,
      // C3: the fault record of a job that threw; the client strips it from the error.
      provenance: recordOfThisJob(),
    });
  } finally {
    aborts.delete(id);
    warmups.delete(controller);
  }
}
