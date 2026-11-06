export type RemovalProvider = "webgpu" | "wasm";
export type RemovalModelKind = "birefnet" | "isnet";
export type RemovalDtype = "fp16" | "fp32";
export type RemovalFailureKind =
  | "abort"
  | "network"
  | "cache"
  | "model-fetch"
  | "provider-init"
  | "gpu-device"
  | "gpu-mask"
  | "model-output"
  | "unknown";

/** A hung ORT call poisons transformers' inference queue for this entire JS context. */
export class RemovalContextLostError extends Error {
  readonly name = "RemovalContextLostError";
  readonly code = "removal-context-lost";
  readonly failureKind = "gpu-device";
  constructor() {
    super("The graphics device was lost. Reload the page to continue removing backgrounds.");
  }
}

export class RemovalModelCacheError extends Error {
  readonly name = "RemovalModelCacheError";
  readonly code = "removal-model-damaged";
  readonly failureKind = "cache";
  constructor(removed: boolean, cause: unknown) {
    super(
      removed
        ? "The saved model file was damaged and has been removed. Try again."
        : "The saved model file is damaged. Delete the local remover model and reload the page to try again.",
      { cause },
    );
  }
}

/**
 * A WebGPU session that would not start (E05-03). Transformers keeps the first session's creation as
 * its one-time runtime init (onnx.js `wasmInitPromise ??=`), so once that rejects every later session
 * in the same JS context fails the same way, WASM included. Only a fresh worker can run WASM.
 */
export class RemovalWebgpuInitError extends Error {
  readonly name = "RemovalWebgpuInitError";
  readonly code = "removal-webgpu-init-failed";
  readonly failureKind = "provider-init";
  constructor(cause: unknown) {
    super("The local remover couldn’t use this device’s graphics. Try again.", { cause });
  }
}

export function requiresFreshRemovalContext(error: unknown): boolean {
  return (
    isRemovalContextLost(error) ||
    isWebgpuInitFailure(error) ||
    field(error, "code") === "removal-model-damaged"
  );
}

export function isRemovalContextLost(error: unknown): boolean {
  return field(error, "code") === "removal-context-lost";
}

export function isWebgpuInitFailure(error: unknown): boolean {
  return field(error, "code") === "removal-webgpu-init-failed";
}

/** The fresh context must run without WebGPU: its device was lost, or it would not start. */
export function requiresWasmContext(error: unknown): boolean {
  return isRemovalContextLost(error) || isWebgpuInitFailure(error);
}

export const REMOVAL_RUNTIME_FINGERPRINT =
  "transformers@3.8.1|birefnet@4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7|isnet@440dea96dd4a3b06bbbf5abec3e26569dd7ec49f" as const;
export const REMOVAL_FAILURE_KEY = "cutout:removal-webgpu-failure:v1" as const;
const LEGACY_FAILURE_PREFIX = "bg0:webgpu-failure:";

export interface RemovalFailureStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const ENGINE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MaskError",
  "RemovalModelLoadError",
  "RemovalModelOutputError",
  "RemovalInputError",
  "RemovalInferenceError",
]);

export type RemovalRoute = {
  readonly primary: {
    readonly model: RemovalModelKind;
    readonly provider: RemovalProvider;
    readonly dtype?: RemovalDtype;
  };
};

/** A healthy no-f16 adapter runs the fp32 weights; failed GPUs retain the WASM safety net. */
export function selectRemovalRoute(options: {
  readonly deviceMemory?: number;
  readonly compatibleGpu: boolean;
  readonly gpuFailed: boolean;
  readonly fp16?: boolean;
}): RemovalRoute {
  if (
    typeof options.deviceMemory === "number" &&
    options.deviceMemory <= 4 &&
    !options.compatibleGpu
  ) {
    return { primary: { model: "isnet", provider: "wasm" } };
  }
  if (options.compatibleGpu && !options.gpuFailed && options.fp16 === false) {
    return { primary: { model: "birefnet", provider: "webgpu", dtype: "fp32" } };
  }
  return { primary: { model: "birefnet", provider: options.gpuFailed ? "wasm" : "webgpu" } };
}

export function classifyRemovalFailure(error: unknown): RemovalFailureKind {
  if (error instanceof DOMException && error.name === "AbortError") return "abort";
  if (error instanceof Error && error.name === "AbortError") return "abort";
  const explicit = field(error, "failureKind");
  if (isFailureKind(explicit)) return explicit;
  const cause = field(error, "cause");
  if (cause !== undefined && cause !== error) {
    const caused = classifyRemovalFailure(cause);
    if (caused !== "unknown") return caused;
  }
  const code = field(error, "code");
  if (code === "cache-miss" || code === "cache-corrupt") return "cache";
  if (code === "model-fetch-failed") return "model-fetch";
  if (code === "device-lost" || code === "gpu-device-lost") return "gpu-device";
  if (code === "invalid-gpu-mask") return "gpu-mask";
  const status = field(error, "status");
  if (typeof status === "number" && status >= 500 && status <= 599) return "network";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (/offline|failed to fetch|network|http 50[0-9]|service unavailable/.test(message))
    return "network";
  if (/cache (miss|corrupt|unavailable)/.test(message)) return "cache";
  // WebKit's fetch rejection, the same layer as Chromium's "Failed to fetch".
  if (error instanceof TypeError && message === "load failed") return "network";
  // Transformers.js reports an HTTP failure only as text (hub.js ERROR_MAPPING / handleError),
  // with no status: 4xx/5xx from the model host or a mirror is a fetch failure, not the GPU.
  if (
    /occurred while trying to load file|could not locate file|(unauthorized|forbidden) access to file/.test(
      message,
    )
  )
    return "model-fetch";
  if (/model.*(download|fetch)|weight.*(download|fetch)/.test(message)) return "model-fetch";
  if (/device lost|gpu device/.test(message)) return "gpu-device";
  if (/invalid.*gpu.*mask|gpu.*nonfinite|gpu.*flat mask/.test(message)) return "gpu-mask";
  if (/webgpu|execution provider|adapter|shader/.test(message)) return "provider-init";
  return "unknown";
}

// Process-local state. Neither value is ever persisted.
let confirmedGpuFailure = false;
let loadMemo: "network" | "init" | undefined;

const NETWORK_KINDS: readonly RemovalFailureKind[] = ["network", "model-fetch", "cache"];

function loadFailureKind(error: unknown): RemovalFailureKind | undefined {
  if (field(error, "name") !== "RemovalModelLoadError") return undefined;
  const kind = field(error, "failureKind");
  return isFailureKind(kind) ? kind : undefined;
}

/** True when a load error is absorbed by one same-job BiRefNet/WASM attempt (Q3 a). */
export function absorbsLoadFailure(error: unknown): boolean {
  const kind = loadFailureKind(error);
  return kind !== undefined && NETWORK_KINDS.includes(kind);
}

/** Session route memo (Q4). Only `use()` calls this, at engine-ready. The first value stands. */
export function noteWebgpuLoadFailure(error: unknown): void {
  const kind = loadFailureKind(error);
  if (kind === undefined || kind === "abort" || loadMemo !== undefined) return;
  loadMemo = NETWORK_KINDS.includes(kind) ? "network" : "init";
}

export function webgpuLoadMemo(): "network" | "init" | undefined {
  return loadMemo;
}

/**
 * Records a genuine GPU failure. The process flag is set first so a denied or broken store
 * cannot lose it; the return value reports only whether the record was persisted.
 * A "gpu-mask" failure is judged from one image's content, so it holds for this page only
 * (E10-S-01): persisted, a flat image downgraded every later visit to WASM. Records an earlier
 * version wrote are still read and cleared as before.
 */
export function rememberGpuFailure(
  kind: RemovalFailureKind,
  storage: RemovalFailureStore | null | undefined = availableStorage(),
): boolean {
  if (kind !== "gpu-device" && kind !== "gpu-mask") return false;
  confirmedGpuFailure = true;
  if (kind === "gpu-mask") return false;
  try {
    if (!storage) return false;
    storage.setItem(
      REMOVAL_FAILURE_KEY,
      JSON.stringify({ version: 1, fingerprint: REMOVAL_RUNTIME_FINGERPRINT, kind }),
    );
    return true;
  } catch {
    return false;
  }
}

export function readGpuFailure(
  storage: RemovalFailureStore | null | undefined = availableStorage(),
): boolean {
  if (confirmedGpuFailure) return true;
  try {
    const encoded = storage?.getItem(REMOVAL_FAILURE_KEY);
    if (encoded) {
      let current = false;
      try {
        const value: unknown = JSON.parse(encoded);
        current =
          field(value, "version") === 1 &&
          field(value, "fingerprint") === REMOVAL_RUNTIME_FINGERPRINT &&
          (field(value, "kind") === "gpu-device" || field(value, "kind") === "gpu-mask");
      } catch {
        // A malformed record is stale: removed below.
      }
      if (current) return true;
      storage?.removeItem(REMOVAL_FAILURE_KEY);
    }
    return legacyGpuFailure(storage);
  } catch {
    return confirmedGpuFailure;
  }
}

/**
 * Honours bg0's old failure note in place (Q8): a `bg0:webgpu-failure:` key whose value is this
 * user agent. Read-only (never migrated or deleted at runtime) and false without a store.
 */
export function legacyGpuFailure(storage: RemovalFailureStore | null | undefined): boolean {
  if (!storage) return false;
  try {
    const userAgent = navigator.userAgent;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LEGACY_FAILURE_PREFIX) && storage.getItem(key) === userAgent) return true;
    }
  } catch {
    // Unreadable storage or no navigator: no legacy signal.
  }
  return false;
}

/** Clears both stored records, the process flag and the session memo (Delete resets them all). */
export function clearRemovalFailureRecords(
  storage: RemovalFailureStore | null | undefined = availableStorage(),
): void {
  confirmedGpuFailure = false;
  loadMemo = undefined;
  try {
    const keys: string[] = [];
    for (let index = 0; index < (storage?.length ?? 0); index += 1) {
      const key = storage?.key(index);
      if (key === REMOVAL_FAILURE_KEY || key?.startsWith(LEGACY_FAILURE_PREFIX)) keys.push(key);
    }
    for (const key of keys) storage?.removeItem(key);
  } catch {
    // Denied or broken storage: nothing more to clear.
  }
}

/** A property of an untrusted value, or undefined when it is not an object. */
export function field(value: unknown, key: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || value === null)
    return undefined;
  return Reflect.get(value, key);
}

function isFailureKind(value: unknown): value is RemovalFailureKind {
  return (
    typeof value === "string" &&
    [
      "abort",
      "network",
      "cache",
      "model-fetch",
      "provider-init",
      "gpu-device",
      "gpu-mask",
      "model-output",
      "unknown",
    ].includes(value)
  );
}

export function availableStorage(): RemovalFailureStore | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}
