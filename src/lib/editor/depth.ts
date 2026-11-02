import { hasFp16Adapter, navigatorGpu, requestCompatibleAdapter } from "../gpu-compat.ts";
import { idleModel } from "../idle-model.ts";

export const DEPTH_MODEL = "onnx-community/depth-anything-v2-small";
/** Pinned: an upstream change must not alter or break every visitor's depth blur. */
export const DEPTH_REVISION = "4472b7362082ad9968fee890ca0f1e5aca36b93d";

const WORKER_LOAD_MS = 120_000;
const WORKER_INFER_MS = 120_000;

export type DepthMap = Readonly<{
  /** 0 = far, 1 = near, row-major at `width` x `height`. */
  data: Float32Array;
  width: number;
  height: number;
  device: "webgpu" | "wasm";
}>;

export type DepthAttempt = { device: "webgpu" | "wasm"; dtype: "fp16" | "fp32" | "q8" };

type DepthPipeline = ((image: unknown) => Promise<{
  depth: { data: Uint8ClampedArray | Uint8Array; width: number; height: number };
}>) & { dispose?: () => Promise<unknown> };

type DepthSession = {
  device: "webgpu" | "wasm";
  infer: (
    image: Blob,
  ) => Promise<{ depth: { data: Uint8ClampedArray | Uint8Array; width: number; height: number } }>;
  dispose: () => void;
  broken: boolean;
};

type WorkerRequest =
  { type: "load"; attempt: DepthAttempt } | { type: "infer"; id: number; blob: Blob };

type WorkerReply =
  | { type: "progress"; fraction: number }
  | { type: "loaded"; device: "webgpu" | "wasm" }
  | { type: "error"; message: string }
  | { type: "map"; id: number; bytes: ArrayBuffer; width: number; height: number };

function depthWorkerSupported() {
  return typeof Worker === "function" && typeof document !== "undefined";
}

/** A rejected WebGPU InferenceSession.create poisons this realm's wasmInitPromise. Network/content errors do not. */
export function looksLikeOrtInitPoison(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  const lower = text.toLowerCase();
  if (
    /fetch|network|offline|download|load file|locate file|access to file|json|429|too many requests/.test(
      lower,
    )
  )
    return false;
  return /no available backend|previous call to (?:'initwasm\(\)'|initializewebassembly\(\)) failed|failed to create a gpudevice|requested device could not be created|execution provider|\bwebgpu\b/i.test(
    text,
  );
}

function sessionFromPipeline(pipeline: {
  run: DepthPipeline;
  device: "webgpu" | "wasm";
}): DepthSession {
  return {
    device: pipeline.device,
    infer: (image) => estimateDepth(pipeline.run, image),
    dispose: () => {
      void pipeline.run.dispose?.();
    },
    broken: false,
  };
}

let pagePipelineInFlight: Promise<unknown> | null = null;

export async function loadDepthPipeline(
  onProgress: ((fraction: number) => void) | undefined,
  attempt: DepthAttempt,
): Promise<{ run: DepthPipeline; device: "webgpu" | "wasm" }> {
  const pending = (async () => {
    const tf = (await import("../transformers.ts")).transformers();
    if (typeof caches !== "undefined") tf.env.useBrowserCache = true;
    const progress_callback = (event: { status?: string; progress?: number }) => {
      if (event.status === "progress" && typeof event.progress === "number")
        onProgress?.(event.progress / 100);
    };
    const run = (await tf.pipeline("depth-estimation", DEPTH_MODEL, {
      ...attempt,
      revision: DEPTH_REVISION,
      progress_callback,
    })) as unknown as DepthPipeline;
    return { run, device: attempt.device };
  })();
  // A never-settling InferenceSession.create leaves wasmInitPromise pending in this
  // realm. Track it so a later idle generation uses a fresh worker instead of joining.
  pagePipelineInFlight = pending;
  try {
    return await pending;
  } finally {
    if (pagePipelineInFlight === pending) pagePipelineInFlight = null;
  }
}

/** Decode, cap at 518 px, and run an already-loaded depth pipeline. */
export async function estimateDepth(run: DepthPipeline, source: Blob) {
  const tf = (await import("../transformers.ts")).transformers();
  const file = source instanceof File ? source : new File([source], "image", { type: source.type });
  const image = await tf.RawImage.fromBlob(file);
  const scale = Math.min(1, 518 / Math.max(image.width, image.height));
  const small =
    scale < 1
      ? await image.resize(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        )
      : image;
  return run(small);
}

async function depthAttempts(): Promise<DepthAttempt[]> {
  const gpu =
    typeof navigator !== "undefined" && Boolean(await requestCompatibleAdapter(navigatorGpu()));
  const fp16 = gpu ? await hasFp16Adapter(navigatorGpu()) : false;
  return gpu
    ? [
        ...(fp16 ? [{ device: "webgpu" as const, dtype: "fp16" as const }] : []),
        { device: "webgpu", dtype: "fp32" },
        { device: "wasm", dtype: "q8" },
      ]
    : [{ device: "wasm", dtype: "q8" }];
}

function loadDepthWorker(
  onProgress: ((fraction: number) => void) | undefined,
  attempt: DepthAttempt,
): Promise<DepthSession> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./depth-worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Depth worker unavailable"));
      return;
    }
    let closed = false;
    let loaded = false;
    let session: DepthSession | undefined;
    let loading: ReturnType<typeof setTimeout> | undefined;
    const waiting = new Map<
      number,
      {
        resolve: (value: { depth: { data: Uint8Array; width: number; height: number } }) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >();
    let next = 1;
    const close = () => {
      if (closed) return;
      closed = true;
      if (session) session.broken = true;
      if (loading !== undefined) clearTimeout(loading);
      loading = undefined;
      const error = new Error("Depth worker closed");
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      waiting.clear();
      worker.terminate();
    };
    const fail = (message: string) => {
      if (closed) return;
      const error = new Error(message);
      if (!loaded) reject(error);
      for (const entry of waiting.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      waiting.clear();
      close();
    };
    // Absolute bound: progress must not renew this. A retired generation that only
    // sends progress still terminates, matching MODEL_PREPARE_TIMEOUT_MS.
    loading = setTimeout(() => fail("Depth worker stopped responding. Try again."), WORKER_LOAD_MS);
    worker.addEventListener("error", () => fail("Depth worker failed"));
    worker.addEventListener("message", (event: MessageEvent<WorkerReply>) => {
      if (closed) return;
      const data = event.data;
      if (data.type === "progress") onProgress?.(data.fraction);
      else if (data.type === "error") fail(data.message);
      else if (data.type === "loaded") {
        loaded = true;
        if (loading !== undefined) clearTimeout(loading);
        loading = undefined;
        session = {
          device: data.device,
          broken: false,
          infer: (blob) =>
            new Promise((resolveInfer, rejectInfer) => {
              if (closed || session?.broken) {
                rejectInfer(new Error("Depth worker closed"));
                return;
              }
              const id = next++;
              const entry = {
                resolve: resolveInfer,
                reject: rejectInfer,
                timer: setTimeout(
                  () => fail("Depth worker stopped responding. Try again."),
                  WORKER_INFER_MS,
                ),
              };
              waiting.set(id, entry);
              try {
                worker.postMessage({ type: "infer", id, blob } satisfies WorkerRequest);
              } catch {
                waiting.delete(id);
                clearTimeout(entry.timer);
                rejectInfer(new Error("Depth worker failed"));
                fail("Depth worker failed");
              }
            }),
          dispose: close,
        };
        resolve(session);
      } else if (data.type === "map") {
        const entry = waiting.get(data.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        waiting.delete(data.id);
        entry.resolve({
          depth: { data: new Uint8Array(data.bytes), width: data.width, height: data.height },
        });
      }
    });
    try {
      worker.postMessage({ type: "load", attempt } satisfies WorkerRequest);
    } catch {
      fail("Depth worker failed");
    }
  });
}

async function loadSession(onProgress?: (fraction: number) => void): Promise<DepthSession> {
  const attempts = await depthAttempts();
  const pageBusy = pagePipelineInFlight !== null;
  let realmPoisoned = false;
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      // Isolate only this retired page realm: remaining waterfall (fp16→fp32→q8)
      // runs in a fresh worker. Not a sticky GPU-failed record.
      if ((realmPoisoned || pageBusy) && depthWorkerSupported())
        return await loadDepthWorker(onProgress, attempt);
      return sessionFromPipeline(await loadDepthPipeline(onProgress, attempt));
    } catch (error) {
      lastError = error;
      if (looksLikeOrtInitPoison(error)) realmPoisoned = true;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Depth model unavailable");
}

/** Depth Anything V2 (small), fp16 on WebGPU or 8-bit on WASM; released when idle. */
let depthModel: ReturnType<typeof idleModel<DepthSession>> | undefined;
function getDepthModel() {
  return (depthModel ??= idleModel(loadSession, (session) => session.dispose(), {
    isBroken: (session) => session.broken,
  }));
}

/** Download and compile the depth model now (offline preparation), then free it. */
export async function prepareDepth(
  onProgress?: (fraction: number) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  options.signal?.throwIfAborted();
  await getDepthModel().use(() => undefined, {
    onProgress,
    retry: true,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
  });
  getDepthModel().release();
  options.signal?.throwIfAborted();
  onProgress?.(1);
}

const maps = new WeakMap<Blob, Promise<DepthMap>>();

/** Resolve `pending`, or the abort as soon as `signal` fires. Shared inference keeps running. */
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/** Relative depth of a photo, cached per file. Runs at most 518 px on the longest side. */
export function depthOf(
  source: Blob,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<DepthMap> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let pending = maps.get(source);
  if (!pending) {
    pending = (async () => {
      // The photo is decoded inside use(): when the model failed a moment ago, use()
      // refuses before a full-size decode that would only be thrown away.
      // No caller signal here: aborting one render must not reject the cached map
      // or dispose the session while another waiter still needs the result.
      const { depth, device } = await getDepthModel().use(
        async (session) => {
          const { processable } = await import("./canvas.ts");
          const file =
            source instanceof File ? source : new File([source], "image", { type: source.type });
          return { ...(await session.infer(await processable(file))), device: session.device };
        },
        { onProgress },
      );
      const data = new Float32Array(depth.width * depth.height);
      for (let i = 0; i < data.length; i++) data[i] = (depth.data[i] ?? 0) / 255;
      return { data, width: depth.width, height: depth.height, device };
    })();
    maps.set(source, pending);
    pending.catch(() => {
      if (maps.get(source) === pending) maps.delete(source);
    });
  }
  return untilAborted(pending, signal);
}

/** Value below which `fraction` of the samples fall (sorted copy of a stride sample). */
export function quantile(data: Float32Array, fraction: number) {
  const step = Math.max(1, Math.floor(data.length / 4096));
  const sample: number[] = [];
  for (let i = 0; i < data.length; i += step) sample.push(data[i]!);
  sample.sort((a, b) => a - b);
  return sample[Math.min(sample.length - 1, Math.floor(fraction * (sample.length - 1)))] ?? 0;
}

/**
 * Per-pixel blend of three blur levels by depth: far pixels take the full
 * blur, near ones the light blur, the middle a mix. The near/far cut-offs are
 * quantiles of this image's own depth so a flat scene still gets a spread;
 * `strength` (0-1) shifts how much of the scene counts as near.
 */
export function blendByDepth(
  out: Uint8ClampedArray,
  light: Uint8ClampedArray,
  medium: Uint8ClampedArray,
  full: Uint8ClampedArray,
  width: number,
  height: number,
  depth: Pick<DepthMap, "data" | "width" | "height">,
  strength = 0.5,
) {
  const near = quantile(depth.data, 0.45 + strength * 0.4); // above: lightly blurred
  const far = Math.min(near - 0.02, quantile(depth.data, 0.2 + strength * 0.2));
  for (let y = 0; y < height; y++) {
    const dy = Math.min(depth.height - 1, Math.floor((y * depth.height) / height));
    for (let x = 0; x < width; x++) {
      const dx = Math.min(depth.width - 1, Math.floor((x * depth.width) / width));
      const d = depth.data[dy * depth.width + dx] ?? 0;
      // t: 0 near → light, 1 far → full, through medium at the midpoint
      const t = d >= near ? 0 : d <= far ? 1 : (near - d) / (near - far);
      const i = (y * width + x) * 4;
      const a = t < 0.5 ? light : medium,
        b = t < 0.5 ? medium : full;
      const m = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      out[i] = a[i]! + (b[i]! - a[i]!) * m;
      out[i + 1] = a[i + 1]! + (b[i + 1]! - a[i + 1]!) * m;
      out[i + 2] = a[i + 2]! + (b[i + 2]! - a[i + 2]!) * m;
      out[i + 3] = 255;
    }
  }
}
