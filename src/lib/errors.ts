export type ErrorCode =
  | "unsupported"
  | "decode"
  | "heic"
  | "drawing"
  | "model"
  | "memory"
  | "cancelled"
  | "clipboard"
  | "export"
  | "download"
  | "browser"
  | "updated"
  | "unknown";

export type CutoutFailure = {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  detail?: string;
};

export class CutoutError extends Error {
  code: ErrorCode;
  retryable: boolean;
  constructor(code: ErrorCode, message: string, retryable = false, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CutoutError";
    this.code = code;
    this.retryable = retryable;
  }
}

const COPY: Record<ErrorCode, string> = {
  unsupported: "That file isn’t a photo or drawing we can open.",
  decode: "This image is damaged or in a format this browser can’t read.",
  heic: "This browser can’t open HEIC. Export a JPG from Photos and drop that.",
  drawing: "Couldn’t turn that drawing into an image. Try exporting a PNG or PDF from CAD.",
  model: "The local remover couldn’t start on this device. Check your connection and try again.",
  memory: "This image is too large for this device. Try a smaller photo.",
  cancelled: "Stopped.",
  clipboard: "Clipboard is blocked in this browser.",
  export: "Couldn’t export this image.",
  download: "Couldn’t save this file.",
  browser:
    "This browser can’t run Cutout. Use a current Chrome, Edge, Firefox, or Safari 16.4 or later.",
  updated: "Cutout was updated since this page opened. Reload the page to continue.",
  unknown: "We couldn’t process this image on this device.",
};

/** A "model" failure of the graphics rather than the connection (E05-05): retrying the
 *  download will not help, and a lost device or a GPU that would not start is not the network. */
const GPU_COPY = "The local remover couldn’t use this device’s graphics. Try again.";
/** The model host's rate limit (E06-G-02): the files are fine, the host asks us to wait. */
const BUSY_COPY = "The model server is busy. Try again in a minute.";

/** The "memory" copy, for code that throws `CutoutError("memory", …)` itself (decode, ingest). */
export const MEMORY_COPY = COPY.memory;

export function messageFor(kind: "download" | "export" | "copy" | "sample") {
  if (kind === "download") return COPY.download;
  if (kind === "export") return COPY.export;
  if (kind === "copy") return COPY.clipboard;
  return COPY.unknown;
}

const ENGINE_CODES: Record<string, { code: ErrorCode; retryable: boolean }> = {
  "removal-model-integrity": { code: "model", retryable: false },
  "model-load-failed": { code: "model", retryable: true },
  "out-of-memory": { code: "memory", retryable: false },
  "removal-model-damaged": { code: "model", retryable: true },
  "removal-context-lost": { code: "updated", retryable: false },
  "inference-failed": { code: "model", retryable: true },
  "removal-worker-stalled": { code: "model", retryable: true },
  "removal-webgpu-init-failed": { code: "model", retryable: true },
};
/** Engine errors whose own message is the user copy. */
const OWN_COPY = new Set(["removal-model-integrity", "removal-context-lost", "removal-model-damaged", "removal-worker-stalled", "removal-webgpu-init-failed"]);

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "";
}

/**
 * E05-05: a lost device, a mask only the GPU got wrong, or a WebGPU provider that would not
 * start. "provider-init" is also the loader's catch-all for an unclassified failure, so only one
 * that names the GPU counts, and any sign of the connection keeps the connection copy.
 */
function isGpuFailure(error: unknown, lower: string): boolean {
  if (/fetch|network|offline|download|load file|locate file|access to file|json/.test(lower)) return false;
  const kind = error && typeof error === "object" && "failureKind" in error ? error.failureKind : undefined;
  if (kind === "gpu-device" || kind === "gpu-mask") return true;
  if (kind !== undefined && kind !== "provider-init") return false;
  return /webgpu|\bgpu\b|shader|adapter|device lost|device could not be created/.test(lower);
}

/** Transformers reports a host's HTTP status only as text: `Error (429) occurred while trying to load file`. */
function isRateLimited(lower: string): boolean {
  return /\berror \(429\)|too many requests/.test(lower);
}

/**
 * Maps an error to user copy. An unexpected (`unknown`) or `model` failure also logs
 * the original error once, so its real cause shows in devtools; nothing is sent anywhere.
 */
export function classifyError(error: unknown): CutoutFailure {
  const failure = classify(error);
  if (failure.code === "unknown" || failure.code === "model")
    console.error("[cutout]", failure.code, error);
  return failure;
}

function classify(error: unknown): CutoutFailure {
  if (error instanceof CutoutError) {
    return { code: error.code, message: error.message, retryable: error.retryable, detail: error.cause instanceof Error ? error.cause.message : undefined };
  }
  const cause = error instanceof Error && error.cause instanceof Error ? ` ${error.cause.name} ${error.cause.message}` : "";
  const text = error instanceof Error ? `${error.name} ${error.message}${cause}` : String(error ?? "");
  const lower = text.toLowerCase();
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "cancelled", message: COPY.cancelled, retryable: false };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { code: "model", message: "That took too long. Try again.", retryable: true };
  }
  // Checked before the engine codes: an engine failure code would otherwise classify this as a retryable "inference-failed".
  if (/offscreencanvas not supported|not supported by this browser/.test(lower)) {
    return { code: "browser", message: COPY.browser, retryable: false };
  }
  // A deploy replaced the hashed chunks this tab still asks for (Chrome, Firefox, Safari
  // wording). It is not the network, and Retry would fetch the same missing file.
  if (/dynamically imported module|importing a module script failed/.test(lower)) {
    return { code: "updated", message: COPY.updated, retryable: false };
  }
  if (isRateLimited(lower)) return { code: "model", message: BUSY_COPY, retryable: true, detail: text.slice(0, 180) };
  const code = errorCode(error);
  const mapped = ENGINE_CODES[code];
  if (mapped) {
    const message = OWN_COPY.has(code) && error instanceof Error
      ? error.message
      : mapped.code === "model" && isGpuFailure(error, lower) ? GPU_COPY : COPY[mapped.code];
    return { code: mapped.code, message, retryable: mapped.retryable, detail: text.slice(0, 180) };
  }
  if (/abort/i.test(text)) return { code: "cancelled", message: COPY.cancelled, retryable: false };
  if (/heic|heif/i.test(lower)) return { code: "heic", message: COPY.heic, retryable: false };
  if (/dxf|dwg|skp|cad|pdf/i.test(lower)) return { code: "drawing", message: COPY.drawing, retryable: true };
  if (/memory|out of memory|allocation|\boom\b|bad_alloc/i.test(lower)) return { code: "memory", message: COPY.memory, retryable: false };
  if (/unsupported-image|not a photo|not an image/i.test(lower)) {
    return { code: "unsupported", message: COPY.unsupported, retryable: false };
  }
  if (/model-load|onnx|webgpu|gpu|shader|adapter|device lost|wasm|network|fetch|failed to fetch|download/i.test(lower)) {
    return { code: "model", message: isGpuFailure(error, lower) ? GPU_COPY : COPY.model, retryable: true, detail: text.slice(0, 180) };
  }
  if (/inference-failed|invalid alpha|failed to execute|pipeline|commandbuffer|validation error/i.test(lower)) {
    return { code: "model", message: COPY.model, retryable: true, detail: text.slice(0, 180) };
  }
  if (/decode|corrupt|invalid image|encoding|bitmap/i.test(lower)) {
    return { code: "decode", message: COPY.decode, retryable: false };
  }
  if (/clipboard/i.test(lower)) return { code: "clipboard", message: COPY.clipboard, retryable: false };
  return { code: "unknown", message: COPY.unknown, retryable: true, detail: text.slice(0, 180) };
}

/** The failure's code without logging it. */
export function failureCode(error: unknown): CutoutFailure["code"] {
  return classify(error).code;
}

export function isRetryableEngineError(error: unknown) {
  const failure = classify(error);
  return failure.retryable && failure.code === "model";
}
