/**
 * The on-device models, where transformers.js caches them (the Cache API,
 * one "transformers-cache" store shared by every model), and how to fetch
 * each one ahead of time so features start without waiting.
 */
import { MODEL_NOTICES, type ModelGroup } from "./model-notices.ts";
import { remainingPrepareMs, waitForIdle } from "./idle-model.ts";

export type ModelId = ModelGroup;

/** Matches cached URLs of every repository in one group (model-notices.ts is the source of truth). */
const repos = (id: ModelId) =>
  new RegExp(
    MODEL_NOTICES.filter((m) => m.group === id)
      .map((m) => m.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
  );

export type ModelInfo = Readonly<{
  id: ModelId;
  label: string;
  use: string;
  /** Matches the cached URLs that belong to this model. */
  match: RegExp;
}>;

export const MODELS: readonly ModelInfo[] = [
  {
    id: "birefnet",
    label: "BiRefNet lite",
    use: "Background removal",
    // ISNet stands in for BiRefNet on low-memory devices without WebGPU (removal-provider.ts).
    match: repos("birefnet"),
  },
  {
    id: "swin2sr-x2",
    label: "Swin2SR ×2",
    use: "Enhance 2×",
    match: repos("swin2sr-x2"),
  },
  {
    id: "swin2sr-x4",
    label: "Swin2SR ×4",
    use: "Enhance 4× (small or low-quality photos)",
    match: repos("swin2sr-x4"),
  },
  {
    id: "depth",
    label: "Depth Anything V2 small",
    use: "Depth-aware blur",
    match: repos("depth"),
  },
];

const MODEL_CACHE = "transformers-cache";

export type ModelStatus = Readonly<{ id: ModelId; cachedBytes: number; files: number }>;

async function openCache() {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(MODEL_CACHE);
  } catch {
    return null;
  }
}

/** Bytes cached per model; 0 when it has never been downloaded. */
export async function listModelCache(): Promise<ModelStatus[]> {
  const cache = await openCache();
  const totals = new Map<ModelId, { bytes: number; files: number }>();
  for (const model of MODELS) totals.set(model.id, { bytes: 0, files: 0 });
  if (!cache) return MODELS.map((m) => ({ id: m.id, cachedBytes: 0, files: 0 }));
  for (const request of await cache.keys()) {
    const model = MODELS.find((m) => m.match.test(request.url));
    if (!model) continue;
    const response = await cache.match(request);
    if (!response) continue;
    const declared = Number(response.headers.get("content-length"));
    const bytes =
      Number.isFinite(declared) && declared > 0 ? declared : (await response.clone().blob()).size;
    const entry = totals.get(model.id)!;
    entry.bytes += bytes;
    entry.files += 1;
  }
  return MODELS.map((m) => ({
    id: m.id,
    cachedBytes: totals.get(m.id)!.bytes,
    files: totals.get(m.id)!.files,
  }));
}

/** Removes every cached file of one model (including variants a failed attempt left behind). */
export async function clearModelCache(id: ModelId): Promise<number> {
  const cache = await openCache();
  const model = MODELS.find((m) => m.id === id);
  if (!cache || !model) return 0;
  let removed = 0;
  for (const request of await cache.keys())
    if (model.match.test(request.url) && (await cache.delete(request))) removed += 1;
  return removed;
}

export type PrepareModelOptions = {
  readonly signal?: AbortSignal;
  /** Bound this wait only. The download/compile may continue for other callers. */
  readonly timeoutMs?: number;
};

/** Default wait bound for `prepareModel`. Pass `Infinity` to wait without a deadline. */
export const MODEL_PREPARE_TIMEOUT_MS = 120_000;

/** Downloads (and compiles) a model now, reporting 0..1. Resolves when it is ready to use. */
export async function prepareModel(
  id: ModelId,
  onProgress?: (fraction: number) => void,
  options: PrepareModelOptions = {},
) {
  const timeoutMs = options.timeoutMs ?? MODEL_PREPARE_TIMEOUT_MS;
  const started = Date.now();
  options.signal?.throwIfAborted();
  // The lazy backend import shares this wait: a fetch that never settles must not
  // escape the deadline, and a late completion must never start a backend.
  const importing = { signal: options.signal, timeoutMs };
  // The backend's own wait gets the budget the import left; its shared loader
  // keeps owning generation retirement (idle-model.ts), which this does not hide.
  const remaining = () => ({
    signal: options.signal,
    timeoutMs: remainingPrepareMs(started, timeoutMs),
  });
  switch (id) {
    case "birefnet": {
      const { warmupRemoval } = await waitForIdle(import("./removal-client.ts"), importing);
      options.signal?.throwIfAborted();
      await warmupRemoval(onProgress, remaining());
      options.signal?.throwIfAborted();
      onProgress?.(1);
      return;
    }
    case "swin2sr-x2":
    case "swin2sr-x4": {
      const { prepareUpscaler } = await waitForIdle(import("./enhance.ts"), importing);
      options.signal?.throwIfAborted();
      await prepareUpscaler(id === "swin2sr-x2" ? 2 : 4, onProgress, remaining());
      return;
    }
    case "depth": {
      const { prepareDepth } = await waitForIdle(import("./editor/depth.ts"), importing);
      options.signal?.throwIfAborted();
      await prepareDepth(onProgress, remaining());
      return;
    }
  }
}

export async function storageSummary() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate)
    return { usage: 0, quota: 0, persisted: false };
  const [estimate, persisted] = await Promise.all([
    navigator.storage.estimate(),
    navigator.storage.persisted?.() ?? Promise.resolve(false),
  ]);
  return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0, persisted };
}

/** Asks the browser not to evict the cache under storage pressure. */
export async function persistStorage() {
  if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export function formatMB(bytes: number) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
