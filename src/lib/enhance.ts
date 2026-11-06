/**
 * On-device super-resolution: Swin2SR (Conde et al., 2022) ×2 through
 * transformers.js, the same runtime the background remover uses. Doubles the
 * resolution and cleans compression artefacts before the cutout is re-run, so
 * small or low-quality sources get real edge detail rather than a blurred mask.
 *
 * The image is processed in fixed-size tiles: WebGPU compiles shaders per input
 * shape, so constant tiles compile once, and memory stays bounded. Tiles overlap
 * and are blended with a linear ramp so seams do not show.
 */
// enhance-worker imports this module: keep its static imports worker-safe.
import { CutoutError } from "./errors.ts";
import { navigatorGpu, requestCompatibleAdapter } from "./gpu-compat.ts";
import { idleModel, isPrepareTimeout, remainingPrepareMs, waitForIdle } from "./idle-model.ts";

export type EnhanceScale = 2 | 4;

export type EnhanceVariant = Readonly<{
  model: string;
  /** Pinned commit: an upstream change must not alter or break every visitor's enhance. */
  revision: string;
  /** Input tile edge; WebGPU compiles per shape, so it stays constant. */
  tile: number;
  overlap: number;
  /** Longest input side accepted. */
  maxSide: number;
  /** Approximate one-off download. */
  downloadMB: number;
}>;

/**
 * Measured on an integrated GPU, fp32 (fp16 fails in a Slice kernel and q8 hangs
 * on WebGPU for these models): x2 does a 512 px tile in about 10 s, x4 a 256 px
 * tile in about 7 s. Each cap is four tiles, under a minute after the one-off
 * shader compile. The x4 model was trained on JPEG-degraded inputs: it removes
 * compression artefacts as it upscales, so it is the one for heavily compressed
 * photos; x2 is the general choice.
 */
export const ENHANCE_VARIANTS: Readonly<Record<EnhanceScale, EnhanceVariant>> = {
  2: {
    model: "Xenova/swin2SR-lightweight-x2-64",
    revision: "92a21aca5713f20faf9a87590cdfbdce2e34112c",
    tile: 512,
    overlap: 32,
    maxSide: 2048,
    downloadMB: 8,
  },
  4: {
    model: "Xenova/swin2SR-compressed-sr-x4-48",
    revision: "7d3f2242026e00cbd998056c2a11e200fce198a7",
    tile: 256,
    overlap: 16,
    maxSide: 1024,
    downloadMB: 55,
  },
};

/** Longest side of an enhanced image; phones lower it to their canvas limits. */
export const ENHANCE_MAX_OUTPUT = 4096;

/** Milliseconds per tile measured on an integrated GPU; refined from real runs. */
const DEFAULT_TILE_MS: Record<EnhanceScale, number> = { 2: 10_000, 4: 7_000 };
const TILE_MS_KEY = "cutout.enhance.tileMs";
const tileMs: Partial<Record<EnhanceScale, number>> = {};

function readStoredTileMs(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(TILE_MS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

function estimateTileMs(scale: EnhanceScale) {
  const known = tileMs[scale];
  if (known) return known;
  const stored = readStoredTileMs()[scale];
  if (typeof stored === "number" && stored > 0) return (tileMs[scale] = stored);
  return DEFAULT_TILE_MS[scale];
}

function recordTileMs(scale: EnhanceScale, ms: number) {
  const next = Math.round(estimateTileMs(scale) * 0.5 + ms * 0.5);
  tileMs[scale] = next;
  try {
    const stored = readStoredTileMs();
    stored[scale] = next;
    globalThis.localStorage?.setItem(TILE_MS_KEY, JSON.stringify(stored));
  } catch {
    /* no storage */
  }
}

export type EnhancePlan = Readonly<{
  scale: EnhanceScale;
  /** The variant accepts an input this size. */
  allowed: boolean;
  tiles: number;
  /** Raw model output. */
  outWidth: number;
  outHeight: number;
  /** After the output cap. */
  finalWidth: number;
  finalHeight: number;
  capped: boolean;
  estimatedMs: number;
}>;

/**
 * What enhancing a `width` x `height` source at `scale` produces: tile count,
 * output size after the cap (4096 px, or less on a device with smaller canvas
 * limits) and a time estimate from the last measured tile speed.
 */
export function planEnhance(
  width: number,
  height: number,
  scale: EnhanceScale,
  limits: { side: number; pixels: number } = { side: Infinity, pixels: Infinity },
): EnhancePlan {
  const variant = ENHANCE_VARIANTS[scale];
  const allowed = width > 0 && height > 0 && Math.max(width, height) <= variant.maxSide;
  const tiles = allowed
    ? planTiles(
        Math.max(width, variant.tile),
        Math.max(height, variant.tile),
        variant.tile,
        variant.overlap,
      ).length
    : 0;
  const outWidth = width * scale;
  const outHeight = height * scale;
  const maxSide = Math.min(ENHANCE_MAX_OUTPUT, limits.side);
  const shrink = Math.min(
    1,
    maxSide / Math.max(outWidth, outHeight, 1),
    Math.sqrt(limits.pixels / Math.max(outWidth * outHeight, 1)),
  );
  return {
    scale,
    allowed,
    tiles,
    outWidth,
    outHeight,
    finalWidth: Math.max(1, Math.round(outWidth * shrink)),
    finalHeight: Math.max(1, Math.round(outHeight * shrink)),
    capped: shrink < 1,
    estimatedMs: tiles * estimateTileMs(scale),
  };
}

const ENHANCE_SCALE: EnhanceScale = 2;
const ENHANCE_TILE = ENHANCE_VARIANTS[2].tile;
const ENHANCE_OVERLAP = ENHANCE_VARIANTS[2].overlap;

export type EnhanceProgress = Readonly<{
  stage: "loading" | "upscaling" | "encoding";
  /** 0..1 within the stage. */
  fraction: number;
  message: string;
}>;

export type Tile = Readonly<{ x: number; y: number; size: number }>;

/**
 * Fixed-size tiles covering a `width` x `height` image, each overlapping its
 * neighbour by `overlap`. The last tile in a row or column is pulled back so
 * every tile is exactly `size` square; the image must be at least `size` in
 * both dimensions (pad it first).
 */
export function planTiles(width: number, height: number, size: number, overlap: number): Tile[] {
  if (width < size || height < size) throw new RangeError("image smaller than a tile");
  const step = Math.max(1, size - overlap);
  const starts = (extent: number) => {
    const out: number[] = [];
    for (let s = 0; ; s += step) {
      if (s + size >= extent) {
        out.push(extent - size);
        break;
      }
      out.push(s);
    }
    return out;
  };
  const tiles: Tile[] = [];
  for (const y of starts(height)) for (const x of starts(width)) tiles.push({ x, y, size });
  return tiles;
}

/** Copies RGBA into a `toW` x `toH` buffer, replicating edge pixels into the padding. */
export function padReplicate(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  toW: number,
  toH: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(toW * toH * 4);
  for (let y = 0; y < toH; y += 1) {
    const sy = Math.min(height - 1, y);
    for (let x = 0; x < toW; x += 1) {
      const sx = Math.min(width - 1, x);
      const si = (sy * width + sx) * 4;
      const di = (y * toW + x) * 4;
      out[di] = rgba[si]!;
      out[di + 1] = rgba[si + 1]!;
      out[di + 2] = rgba[si + 2]!;
      out[di + 3] = 255;
    }
  }
  return out;
}

export function cropRgba(
  rgba: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  w: number,
  h: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row += 1) {
    const src = ((y + row) * width + x) * 4;
    out.set(rgba.subarray(src, src + w * 4), row * w * 4);
  }
  return out;
}

/** Linear ramp weight for position `u` within an output tile of `size`, `ramp` px wide. */
function hat(u: number, size: number, ramp: number) {
  return Math.max(0.02, Math.min(1, (u + 1) / ramp, (size - u) / ramp));
}

/**
 * Blends an upscaled tile into the accumulation buffers at (`ox`, `oy`), weighting
 * each pixel by the product of horizontal and vertical ramps.
 */
export function accumulateTile(
  acc: Float32Array,
  weight: Float32Array,
  outWidth: number,
  tile: Uint8ClampedArray,
  tileSize: number,
  ox: number,
  oy: number,
  ramp: number,
) {
  for (let ty = 0; ty < tileSize; ty += 1) {
    const wy = hat(ty, tileSize, ramp);
    for (let tx = 0; tx < tileSize; tx += 1) {
      const w = wy * hat(tx, tileSize, ramp);
      const p = (oy + ty) * outWidth + (ox + tx);
      const ti = (ty * tileSize + tx) * 4;
      acc[p * 3] += tile[ti]! * w;
      acc[p * 3 + 1] += tile[ti + 1]! * w;
      acc[p * 3 + 2] += tile[ti + 2]! * w;
      weight[p] += w;
    }
  }
}

export type TileUpscaler = (
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
) => Promise<Uint8ClampedArray>;

/** Refuse the full accumulation footprint before allocating or loading a model.
 * Device pixel limits describe an RGBA canvas budget; the float buffers need
 * substantially more memory than that final canvas alone. */
function checkEnhanceMemory(
  width: number,
  height: number,
  scale: number,
  tile: number,
  limits?: { pixels: number },
) {
  if (!limits) return;
  const padded = Math.max(width, tile) * Math.max(height, tile);
  const bytes = padded * scale * scale * 16 + width * height * scale * scale * 4 + padded * 4;
  if (bytes > limits.pixels * 4)
    throw new CutoutError(
      "memory",
      "Enhance needs more memory than this device allows. Use a smaller image or another device.",
    );
}

/**
 * Upscales an RGBA image by `scale` with `run`, which upscales one `tile`-sized
 * RGBA tile. Pure apart from `run`, so the tiling and blending are testable.
 */
export async function enhanceRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  run: TileUpscaler,
  options: {
    scale?: number;
    limits?: { pixels: number; side: number };
    tile?: number;
    overlap?: number;
    signal?: AbortSignal;
    onTile?: (done: number, total: number) => void;
    /** Tiles to leave black (they are fully transparent in the cutout). */
    skip?: (tile: Tile) => boolean;
  } = {},
): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const scale = options.scale ?? ENHANCE_SCALE;
  // A small image only needs a small tile: padding 96 px up to 512 cost ~28x the compute.
  // Multiples of 64 keep Swin2SR's 8 px windows aligned.
  const tile = Math.min(options.tile ?? ENHANCE_TILE, Math.ceil(Math.max(width, height) / 64) * 64);
  options.signal?.throwIfAborted();
  checkEnhanceMemory(width, height, scale, tile, options.limits);
  const overlap = options.overlap ?? ENHANCE_OVERLAP;
  const padW = Math.max(width, tile);
  const padH = Math.max(height, tile);
  const padded =
    padW !== width || padH !== height ? padReplicate(rgba, width, height, padW, padH) : rgba;
  const tiles = planTiles(padW, padH, tile, overlap);
  const outW = padW * scale;
  const outH = padH * scale;
  const outTile = tile * scale;
  const acc = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);
  let done = 0;
  for (const t of tiles) {
    options.signal?.throwIfAborted();
    if (options.skip?.(t)) {
      done += 1;
      options.onTile?.(done, tiles.length);
      continue;
    }
    const input = cropRgba(padded, padW, t.x, t.y, tile, tile);
    const up = await untilAborted(run(input, tile, tile), options.signal);
    options.signal?.throwIfAborted();
    if (up.length !== outTile * outTile * 4)
      throw new Error("upscaler returned an unexpected size");
    accumulateTile(acc, weight, outW, up, outTile, t.x * scale, t.y * scale, overlap * scale);
    done += 1;
    options.onTile?.(done, tiles.length);
  }
  const finalW = width * scale;
  const finalH = height * scale;
  const out = new Uint8ClampedArray(finalW * finalH * 4);
  for (let y = 0; y < finalH; y += 1)
    for (let x = 0; x < finalW; x += 1) {
      const p = y * outW + x;
      const w = weight[p]! || 1;
      const o = (y * finalW + x) * 4;
      out[o] = acc[p * 3]! / w;
      out[o + 1] = acc[p * 3 + 1]! / w;
      out[o + 2] = acc[p * 3 + 2]! / w;
      out[o + 3] = 255;
    }
  return out;
}

/**
 * Whether a tile touches any visible pixel of the cutout's alpha (source size,
 * one byte or RGBA per pixel). Tiles past the image edge are clipped.
 */
export function tileHasAlpha(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  tile: Tile,
): boolean {
  const stride = alpha.length >= width * height * 4 ? 4 : 1;
  const x1 = Math.min(width, tile.x + tile.size),
    y1 = Math.min(height, tile.y + tile.size);
  for (let y = Math.max(0, tile.y); y < y1; y += 1) {
    const row = y * width;
    for (let x = Math.max(0, tile.x); x < x1; x += 1)
      if (alpha[(row + x) * stride + stride - 1]! > 0) return true;
  }
  return false;
}

/** Tiles that would run for a cutout with this alpha, out of the full plan. */
export function countActiveTiles(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  scale: EnhanceScale,
  /** Size of the image the alpha was sampled from, when `alpha` is a smaller copy. */
  image: { width: number; height: number } = { width, height },
): { active: number; total: number } {
  const variant = ENHANCE_VARIANTS[scale];
  const tiles = planTiles(
    Math.max(image.width, variant.tile),
    Math.max(image.height, variant.tile),
    variant.tile,
    variant.overlap,
  );
  const sx = width / image.width,
    sy = height / image.height;
  let active = 0;
  for (const tile of tiles) {
    const scaled = {
      x: Math.floor(tile.x * sx),
      y: Math.floor(tile.y * sy),
      size: Math.ceil(tile.size * Math.max(sx, sy)) + 1,
    };
    if (tileHasAlpha(alpha, width, height, scaled)) active += 1;
  }
  return { active, total: tiles.length };
}

type Pipeline = {
  (image: unknown): Promise<{ rgba(): { data: Uint8ClampedArray | Uint8Array } }>;
  dispose?: () => Promise<void>;
};

type Upscaler = { run: TileUpscaler; device: "webgpu" | "wasm" };
const workers = new Map<string, Promise<Upscaler>>();
/** Every run waiting on a worker's load hears its progress, not only the one that started it. */
const workerListeners = new Map<string, Set<(p: EnhanceProgress) => void>>();
/** Deadline of the last waiter retires a never-settling worker load so retry is fresh. */
const workerAbandon = new Map<string, () => void>();

/**
 * `pending`, or the abort as soon as `signal` fires. A load is shared (the next run, or an
 * offline download, joins it), so a cancelled run stops waiting instead of stopping the load.
 */
function untilAborted<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // Always observed, so a load that fails after the run gave up is not an unhandled rejection.
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}

/**
 * The upscaler in a Web Worker so tiles do not block the page. Falls back to
 * the main thread when workers or WebGPU in workers are unavailable; a worker
 * that only got WASM yields to main-thread WebGPU when the page has it.
 */
async function loadWorkerUpscaler(
  model: string,
  onProgress: (p: EnhanceProgress) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<Upscaler | null> {
  if (typeof Worker === "undefined") return null;
  let pending = workers.get(model);
  if (!pending) {
    signal?.throwIfAborted();
    const listeners = new Set<(p: EnhanceProgress) => void>();
    workerListeners.set(model, listeners);
    pending = new Promise<Upscaler>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./enhance-worker.ts", import.meta.url), { type: "module" });
      } catch (error) {
        reject(error instanceof Error ? error : new Error("worker unavailable"));
        return;
      }
      let next = 1;
      const waiting = new Map<
        number,
        {
          resolve: (rgba: Uint8ClampedArray) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      >();
      // The loaded model pins the worker's WASM heap; free it a minute after the last
      // tile, or sooner once the tab is hidden. Tiles follow each other without a pause.
      let idle: ReturnType<typeof setTimeout> | undefined;
      let loading: ReturnType<typeof setTimeout> | undefined;
      let loaded = false;
      let closed = false;
      const watchLoad = () => {
        clearTimeout(loading);
        loading = setTimeout(() => fail("Enhance worker stopped responding. Try again."), 120_000);
      };
      const rest = () => {
        clearTimeout(idle);
        idle = setTimeout(
          () => {
            if (!waiting.size) close();
          },
          document.hidden ? 10_000 : 60_000,
        );
      };
      const onVisibility = () => {
        if (loaded && !waiting.size) rest();
      };
      // Frozen in the back/forward cache, the idle timer never fires: free it on the way out.
      const onPageHide = () => {
        if (!loaded || waiting.size) fail("Enhance was interrupted. Try again.");
        else close();
      };
      document.addEventListener("visibilitychange", onVisibility);
      addEventListener("pagehide", onPageHide);
      const close = () => {
        if (closed) return;
        clearTimeout(idle);
        clearTimeout(loading);
        for (const entry of waiting.values()) clearTimeout(entry.timer);
        closed = true;
        document.removeEventListener("visibilitychange", onVisibility);
        removeEventListener("pagehide", onPageHide);
        workers.delete(model);
        if (workerListeners.get(model) === listeners) workerListeners.delete(model);
        workerAbandon.delete(model);
        worker.terminate();
      };
      const fail = (message: string) => {
        if (closed) return;
        const error = new Error(message);
        reject(error);
        for (const entry of waiting.values()) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
        waiting.clear();
        close();
      };
      worker.addEventListener("error", () => fail("Enhance worker failed"));
      worker.addEventListener(
        "message",
        (
          event: MessageEvent<
            | { type: "progress"; fraction: number }
            | { type: "loaded"; device: "webgpu" | "wasm" }
            | { type: "error"; message: string }
            | { type: "tile"; id: number; rgba?: ArrayBuffer; error?: string }
          >,
        ) => {
          if (closed) return;
          const data = event.data;
          if (data.type === "progress") {
            if (!loaded) watchLoad();
            for (const listener of listeners)
              listener({
                stage: "loading",
                fraction: data.fraction,
                message: "Getting the enhancer ready · first time only",
              });
          } else if (data.type === "error") fail(data.message);
          else if (data.type === "loaded") {
            loaded = true;
            clearTimeout(loading);
            rest();
            resolve({
              device: data.device,
              run: (rgba, w, h) =>
                new Promise((resolveTile, rejectTile) => {
                  if (closed) return rejectTile(new Error("Enhance worker closed"));
                  clearTimeout(idle);
                  const id = next++;
                  waiting.set(id, {
                    resolve: resolveTile,
                    reject: rejectTile,
                    timer: setTimeout(
                      () => fail("Enhance worker stopped responding. Try again."),
                      120_000,
                    ),
                  });
                  try {
                    const copy = new Uint8ClampedArray(rgba);
                    worker.postMessage(
                      { type: "tile", id, rgba: copy.buffer, width: w, height: h },
                      [copy.buffer],
                    );
                  } catch {
                    fail("Enhance worker failed. Try again.");
                  }
                }),
            });
          } else if (data.type === "tile") {
            const entry = waiting.get(data.id);
            if (!entry) return;
            clearTimeout(entry.timer);
            waiting.delete(data.id);
            if (!waiting.size) rest();
            if (data.rgba) entry.resolve(new Uint8ClampedArray(data.rgba));
            else entry.reject(new Error(data.error ?? "tile failed"));
          }
        },
      );
      watchLoad();
      workerAbandon.set(model, () => fail("Enhance model preparation timed out."));
      try {
        worker.postMessage({ type: "load", model });
      } catch {
        fail("Enhance worker failed. Try again.");
      }
    });
    workers.set(model, pending);
  }
  const listeners = workerListeners.get(model);
  listeners?.add(onProgress);
  try {
    return await waitForIdle(pending, {
      signal,
      timeoutMs,
      onTimeout: () => {
        listeners?.delete(onProgress);
        if (!listeners?.size) workerAbandon.get(model)?.();
      },
    });
  } catch (error) {
    listeners?.delete(onProgress);
    // Last cancelled waiter must not leave a never-settling worker for the next prepare.
    if (signal?.aborted || isPrepareTimeout(error)) {
      if (signal?.aborted && !listeners?.size) workerAbandon.get(model)?.();
      throw error;
    }
    workers.delete(model);
    return null;
  } finally {
    listeners?.delete(onProgress);
  }
}

/** Download and compile a variant now (offline preparation). */
export async function prepareUpscaler(
  scale: EnhanceScale,
  onProgress?: (fraction: number) => void,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  options.signal?.throwIfAborted();
  const { model } = ENHANCE_VARIANTS[scale];
  await loadTileUpscaler(
    model,
    (p) => {
      if (p.stage === "loading") onProgress?.(p.fraction);
    },
    options.signal,
    options.timeoutMs,
  );
  options.signal?.throwIfAborted();
  // Not released here: an enhance may be between its load and its first tile, and would
  // reload and recompile the model. The idle timer frees it a minute later.
  onProgress?.(1);
}

async function loadTileUpscaler(
  model: string,
  onProgress: (p: EnhanceProgress) => void,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<Upscaler> {
  signal?.throwIfAborted();
  const started = Date.now();
  const inWorker = await loadWorkerUpscaler(model, onProgress, signal, timeoutMs);
  signal?.throwIfAborted();
  if (inWorker?.device === "webgpu") return inWorker;
  const left = remainingPrepareMs(started, timeoutMs);
  // An exposed `navigator.gpu` without an adapter would load a second, WASM copy on the page.
  if (inWorker) {
    const adapter = await waitForIdle(requestCompatibleAdapter(navigatorGpu()), {
      signal,
      timeoutMs: left,
    });
    if (!adapter) return inWorker;
  }
  if (inWorker && pageRunsWasm.has(model)) return inWorker;
  // A cancelled run must not start a second download on the page.
  signal?.throwIfAborted();
  const upscaler = pageUpscaler(model);
  const device = await upscaler.use(({ device }) => device, {
    onProgress: (fraction) =>
      onProgress({
        stage: "loading",
        fraction,
        message: "Getting the enhancer ready · first time only",
      }),
    retry: true,
    signal,
    // Adapter probing consumed part of the budget: the page load gets what is left.
    timeoutMs: remainingPrepareMs(started, timeoutMs),
  });
  if (inWorker && device === "wasm") {
    // No faster than the worker's copy: free this one now instead of keeping both, and
    // do not load it again on the next enhance.
    pageRunsWasm.add(model);
    upscaler.release();
    return inWorker;
  }
  const tf = (await import("./transformers.ts")).transformers();
  return {
    device,
    // Each tile holds the model; it is freed a minute after the last one.
    run: (tileRgba, w, h) =>
      upscaler.use(async ({ run }) => {
        const image = new tf.RawImage(tileRgba, w, h, 4).rgb();
        const result = await run(image);
        return new Uint8ClampedArray(result.rgba().data);
      }),
  };
}

/** Swin2SR through transformers.js: WebGPU fp32 when present, 8-bit WASM otherwise.
 *  Shared by the page and enhance-worker. */
export async function loadPipeline(model: string, onFraction: (fraction: number) => void) {
  const tf = (await import("./transformers.ts")).transformers();
  if (typeof caches !== "undefined") tf.env.useBrowserCache = true;
  const progress_callback = (event: { status?: string; progress?: number }) => {
    if (event.status === "progress" && typeof event.progress === "number")
      onFraction(event.progress / 100);
  };
  const revision = Object.values(ENHANCE_VARIANTS).find((v) => v.model === model)?.revision;
  // A failed WebGPU session leaves the WASM retry failing too; skip it without an adapter.
  const gpu =
    typeof navigator !== "undefined" && Boolean(await requestCompatibleAdapter(navigatorGpu()));
  try {
    if (!gpu) throw new Error("no WebGPU");
    const run = (await tf.pipeline("image-to-image", model, {
      device: "webgpu",
      dtype: "fp32",
      revision,
      progress_callback,
    })) as unknown as Pipeline;
    return { run, device: "webgpu" as const };
  } catch {
    const run = (await tf.pipeline("image-to-image", model, {
      device: "wasm",
      dtype: "q8",
      revision,
      progress_callback,
    })) as unknown as Pipeline;
    return { run, device: "wasm" as const };
  }
}

/** Page-side pipelines (the worker's are freed with the worker), released when idle. */
const pageUpscalers = new Map<string, ReturnType<typeof pageUpscalerFor>>();
/** Models whose page pipeline fell back to WASM: the worker's copy is as fast. */
const pageRunsWasm = new Set<string>();

function pageUpscalerFor(model: string) {
  return idleModel(
    (onProgress) => loadPipeline(model, (fraction) => onProgress?.(fraction)),
    ({ run }) => run.dispose?.(),
  );
}

function pageUpscaler(model: string) {
  let upscaler = pageUpscalers.get(model);
  if (!upscaler) pageUpscalers.set(model, (upscaler = pageUpscalerFor(model)));
  return upscaler;
}

/**
 * Upscales a file with Swin2SR (x2 general, x4 for compressed sources) and
 * returns it as a PNG. Rejects sources above the variant's cap: they already
 * carry the detail this restores, and the run would take minutes.
 */
export async function enhanceFile(
  file: File,
  options: {
    scale?: EnhanceScale;
    /** Device canvas limits; the output is scaled to fit them (see planEnhance). */
    limits?: { side: number; pixels: number };
    /** The current cutout: tiles with no visible pixel are skipped. */
    mask?: Blob;
    signal?: AbortSignal;
    onProgress?: (p: EnhanceProgress) => void;
  } = {},
): Promise<{
  file: File;
  width: number;
  height: number;
  scale: EnhanceScale;
  model: string;
  device: "webgpu" | "wasm";
}> {
  const scale = options.scale ?? ENHANCE_SCALE;
  const variant = ENHANCE_VARIANTS[scale];
  const report = options.onProgress ?? (() => undefined);
  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = bitmap;
    const plan = planEnhance(width, height, scale, options.limits);
    if (!plan.allowed)
      throw new CutoutError(
        "unsupported",
        `Enhance ×${scale} works on images up to ${variant.maxSide} px on the longest side; this one is ${width}×${height}.`,
      );
    const tile = Math.min(variant.tile, Math.ceil(Math.max(width, height) / 64) * 64);
    checkEnhanceMemory(width, height, scale, tile, options.limits);
    options.signal?.throwIfAborted();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
    ctx.drawImage(bitmap, 0, 0);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    canvas.width = 0;
    canvas.height = 0;

    report({ stage: "loading", fraction: 0, message: "Getting the enhancer ready" });
    const { run: upscaleTile, device } = await loadTileUpscaler(
      variant.model,
      report,
      options.signal,
    );
    options.signal?.throwIfAborted();
    const alpha = options.mask
      ? await (await import("./editor/alpha.ts")).readAlpha(options.mask, width, height)
      : undefined;
    options.signal?.throwIfAborted();
    report({ stage: "upscaling", fraction: 0, message: "Enhancing · 0%" });
    let lastTileAt = performance.now();
    let firstTile = true;
    const out = await enhanceRgba(rgba, width, height, upscaleTile, {
      scale,
      tile: variant.tile,
      limits: options.limits,
      overlap: variant.overlap,
      signal: options.signal,
      skip: alpha ? (tile) => !tileHasAlpha(alpha, width, height, tile) : undefined,
      onTile: (done, total) => {
        const now = performance.now();
        // The first tile includes the one-off shader compile; do not learn from it.
        // Skipped tiles return instantly and are not a measurement either.
        if (!firstTile && now - lastTileAt > 50) recordTileMs(scale, now - lastTileAt);
        firstTile = false;
        lastTileAt = now;
        report({
          stage: "upscaling",
          fraction: done / total,
          message: `Enhancing · ${Math.round((done / total) * 100)}%`,
        });
      },
    });
    report({ stage: "encoding", fraction: 1, message: "Almost done" });
    const outCanvas = document.createElement("canvas");
    outCanvas.width = plan.outWidth;
    outCanvas.height = plan.outHeight;
    const outCtx = outCanvas.getContext("2d");
    if (!outCtx) throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
    outCtx.putImageData(new ImageData(out, plan.outWidth, plan.outHeight), 0, 0);
    let finalCanvas = outCanvas;
    if (plan.capped) {
      // Over the output cap: bring the enhanced result down to it.
      finalCanvas = document.createElement("canvas");
      finalCanvas.width = plan.finalWidth;
      finalCanvas.height = plan.finalHeight;
      const finalCtx = finalCanvas.getContext("2d");
      if (!finalCtx) throw new CutoutError("decode", "Canvas is unavailable. Try another browser.");
      finalCtx.imageSmoothingQuality = "high";
      finalCtx.drawImage(outCanvas, 0, 0, plan.finalWidth, plan.finalHeight);
      outCanvas.width = 0;
      outCanvas.height = 0;
    }
    const blob = await new Promise<Blob | null>((resolve) =>
      finalCanvas.toBlob(resolve, "image/png"),
    );
    finalCanvas.width = 0;
    finalCanvas.height = 0;
    if (!blob) throw new CutoutError("decode", "Could not encode the enhanced image.");
    const base = (file.name || "image").replace(/\.[^.]+$/, "");
    return {
      file: new File([blob], `${base}-enhanced-x${scale}.png`, { type: "image/png" }),
      width: plan.finalWidth,
      height: plan.finalHeight,
      scale,
      model: variant.model,
      device,
    };
  } finally {
    bitmap.close();
  }
}
