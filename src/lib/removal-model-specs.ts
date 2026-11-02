import {
  REMOVAL_RUNTIME_FINGERPRINT,
  field as unknownField,
  type RemovalModelKind,
  type RemovalProvider,
  type RemovalDtype,
} from "./removal-provider.ts";
import type { MaskSemantics, MaskTensor } from "./model-mask.ts";

export type RemovalLoadProgress = {
  readonly status: string;
  readonly file?: string;
  readonly progress?: number;
};

export type RemovalTensor = MaskTensor & { dispose(): void };
export type RemovalLoadRequest = {
  readonly model: RemovalModelKind;
  readonly provider: RemovalProvider;
  readonly context: "page" | "worker";
  readonly dtype?: RemovalDtype;
};
export type PreparedRemovalEngine = {
  readonly identity: RemovalModelIdentity;
  readonly provider: RemovalProvider;
  readonly outputImageSemantics: MaskSemantics;
  readonly processor: (image: unknown) => Promise<{ readonly pixel_values: RemovalTensor }>;
  readonly model: (inputs: { readonly input_image: unknown }) => Promise<{ readonly output_image: RemovalTensor }>;
  dispose(): Promise<void>;
};
export type RemovalGpuDevice = { readonly lost: Promise<unknown> };

/** Transformers 3.8.1 exposes ORT's own device here during backend initialization. */
export function removalGpuDevice(env: unknown): RemovalGpuDevice | undefined {
  const device = unknownField(unknownField(unknownField(unknownField(env, "backends"), "onnx"), "webgpu"), "device");
  return unknownField(device, "lost") instanceof Promise ? device as RemovalGpuDevice : undefined;
}

export interface RemovalLoadFactories {
  gpuDevice?(): Promise<RemovalGpuDevice | undefined>;
  evictModelFile?(model: RemovalModelKind, provider: RemovalProvider, dtype?: RemovalDtype): Promise<boolean>;
  /** Removes every cached file of the model id (E05-01); true when the cache was reachable. */
  evictModelCache?(model: RemovalModelKind): Promise<boolean>;

  loadProcessor(model: RemovalModelKind, progress: (event: RemovalLoadProgress) => void): Promise<unknown>;
  loadModel(model: RemovalModelKind, provider: RemovalProvider, progress: (event: RemovalLoadProgress) => void, dtype?: RemovalDtype): Promise<unknown>;
}
export type RemovalModelIdentity = {
  readonly model: RemovalModelKind;
  readonly modelId: string;
  readonly revision: string;
  readonly dtype: "fp16" | "fp32";
  readonly onnxFile: "model.onnx" | "model_fp16.onnx";
  readonly inputName: "input" | "input_image";
  readonly inputDims: readonly number[];
  readonly outputName: "output" | "output_image";
  readonly outputDims: readonly number[];
  readonly fingerprint: typeof REMOVAL_RUNTIME_FINGERPRINT;
};

export type RemovalModelSpec = {
  readonly modelId: string;
  readonly revision: string;
  readonly semantics: MaskSemantics;
  readonly inputName: "input" | "input_image";
  readonly inputDims: readonly number[];
  readonly outputName: "output" | "output_image";
  readonly outputDims: readonly number[];
  readonly routes: Readonly<Record<RemovalProvider, RemovalModelRoute | undefined>> & { readonly webgpuFp32?: RemovalModelRoute };
};

export type RemovalModelRoute = {
  readonly dtype: "fp16" | "fp32";
  readonly onnxFile: "model.onnx" | "model_fp16.onnx";
};

export const REMOVAL_MODELS = {
  birefnet: {
    modelId: "studioludens/birefnet-lite-512",
    revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
    semantics: "logits",
    inputName: "input_image",
    inputDims: [1, 3, 512, 512],
    outputName: "output_image",
    outputDims: [1, 1, 512, 512],
    routes: {
      webgpu: { dtype: "fp16", onnxFile: "model_fp16.onnx" },
      webgpuFp32: { dtype: "fp32", onnxFile: "model.onnx" },
      wasm: { dtype: "fp32", onnxFile: "model.onnx" },
    },
  },
  isnet: {
    modelId: "imgly/isnet-general-onnx",
    revision: "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f",
    semantics: "probabilities",
    inputName: "input",
    inputDims: [1, 3, 1024, 1024],
    outputName: "output",
    outputDims: [1, 1, 1024, 1024],
    routes: {
      webgpu: undefined,
      wasm: { dtype: "fp16", onnxFile: "model_fp16.onnx" },
    },
  },
} as const satisfies Record<RemovalModelKind, RemovalModelSpec>;

/** ONNX: HF x-linked-etag (LFS SHA-256); JSON: SHA-256 of the exact resolved bytes.
 *  Revisions above and these hashes must be reviewed together. */
export const REMOVAL_MODEL_SHA256: Readonly<Record<RemovalModelKind, Readonly<Record<string, string>>>> = {
  birefnet: {
    "onnx/model.onnx": "1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2",
    "onnx/model_fp16.onnx": "eff9216bb2f9d3f023d9c2b7196845a7485739ab1f231593633e4d2344ffc516",
    "config.json": "561965f7aa366c48b95ab1c24220d59a718df4025c2ecb359dd5736ceb49e912",
    "preprocessor_config.json": "a79663b311d8404dfb329f7b45bc9f970a0c155aeedae8ac15b6b77d76789613",
  },
  isnet: {
    "onnx/model.onnx": "cc2c9f5c1751b9737cb81e708ff0c5e9542c2205daed22418a4fd2ab5d4c481a",
    "onnx/model_fp16.onnx": "2eb4b5dda7ec41c617e59706e5aafa1f978c9a5f983d2518d9f0ae4d6eb04f20",
    "config.json": "d0b94ab052ace79177085c66a00a3f014a973edb09999cb0108bb01e65ded060",
    "preprocessor_config.json": "7f6ea1f0aa49cdc77487e172f3dd67820a842512b4a203b14ffadfb8bd027d40",
  },
};

export function removalModelRoute(request: Pick<RemovalLoadRequest, "model" | "provider" | "dtype">): RemovalModelRoute | undefined {
  const spec: RemovalModelSpec = REMOVAL_MODELS[request.model];
  const route = request.provider === "webgpu" && request.dtype === "fp32"
    ? spec.routes.webgpuFp32 : spec.routes[request.provider];
  return request.dtype === undefined || request.dtype === route?.dtype ? route : undefined;
}

export function parseRemovalTensor(value: unknown, expectedDims: readonly number[]): RemovalTensor | undefined {
  try {
    if (!isRemovalTensor(value)) return undefined;
    if (!sameDims(value.dims, expectedDims)) return undefined;
    const expectedSize = expectedDims.reduce((size, dimension) => size * dimension, 1);
    return value.data.length === expectedSize ? value : undefined;
  } catch {
    // Non-CPU tensor accessors can throw. The caller owns rejection and cleanup.
    return undefined;
  }
}

export function removalProgressEvent(value: unknown): RemovalLoadProgress {
  const status = unknownField(value, "status");
  const file = unknownField(value, "file");
  const progress = unknownField(value, "progress");
  return {
    status: typeof status === "string" ? status : "unknown",
    ...(typeof file === "string" ? { file } : {}),
    ...(typeof progress === "number" ? { progress } : {}),
  };
}

export function removalCleanupFailure(source: unknown, cleanup: readonly unknown[]): AggregateError {
  return new AggregateError([source, ...cleanup], "Removal load failed and cleanup also failed", { cause: source });
}

export async function disposeRemovalResource(value: unknown): Promise<void> {
  const dispose = unknownField(value, "dispose");
  if (!isUnknownCallable(dispose)) return;
  await dispose.call(value);
}

export async function disposeRemovalResources(values: readonly unknown[]): Promise<readonly unknown[]> {
  const seen = new Set<unknown>();
  const failures: unknown[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    try {
      await disposeRemovalResource(value);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

export function removalResourceFailure(failures: readonly unknown[]): unknown {
  return failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Multiple removal resources failed to dispose");
}

export function isUnknownCallable(value: unknown): value is (...args: readonly unknown[]) => unknown {
  return typeof value === "function";
}

function isRemovalTensor(value: unknown): value is RemovalTensor {
  const dims = unknownField(value, "dims");
  const data = unknownField(value, "data");
  return (
    isNumberArray(dims) &&
    data instanceof Float32Array &&
    isUnknownCallable(unknownField(value, "dispose")) &&
    isUnknownCallable(unknownField(value, "sigmoid"))
  );
}

function isNumberArray(value: unknown): value is readonly number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number");
}

function sameDims(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((dimension, index) => dimension === expected[index]);
}


/** Only explicit protobuf corruption warrants deleting weights and replacing the realm. */
export function isRemovalSessionFailure(error: unknown): boolean {
  for (let depth = 0; error && depth < 5; depth++, error = unknownField(error, "cause")) {
    const message = typeof error === "string" ? error : unknownField(error, "message");
    if (typeof message === "string" && /protobuf parsing failed|invalid[ _-]protobuf/i.test(message)) return true;
  }
  return false;
}

/**
 * A hub JSON file (config.json, preprocessor_config.json) that does not parse: a captive portal's
 * HTML page served with 200, or a cut-short body. Transformers caches the bytes before it parses
 * them, so every later load reads the same bytes back (E05-01).
 */
export function isHubJsonFailure(error: unknown): boolean {
  for (let depth = 0; error && depth < 5; depth++, error = unknownField(error, "cause")) {
    const message = unknownField(error, "message");
    if (unknownField(error, "name") === "SyntaxError" && typeof message === "string" && /json/i.test(message)) return true;
  }
  return false;
}

/** Deletes every `transformers-cache` entry of one model id, whatever its file or revision, as the
 *  Models panel's Delete does. False when there is no cache to clean; already absent is true. */
export async function evictRemovalModelCache(
  model: RemovalModelKind,
  env: unknown,
  store: { open(name: string): Promise<{ keys(): Promise<readonly { url: string }[]>; delete(key: string): Promise<boolean> }> } | undefined = undefined,
): Promise<boolean> {
  if (unknownField(env, "useBrowserCache") === false) return false;
  try { store ??= globalThis.caches; } catch { return false; }
  if (!store) return false;
  const repository = `/${REMOVAL_MODELS[model].modelId}/`;
  try {
    const cache = await store.open("transformers-cache");
    for (const request of await cache.keys()) if (request.url.includes(repository)) await cache.delete(request.url);
    return true;
  } catch {
    return false;
  }
}

/** The cache keys used by transformers 3.8.1 hub.js: full remote URL, or a local model path. */
export async function evictRemovalModelFile(
  request: RemovalLoadRequest,
  env: unknown,
  store: { open(name: string): Promise<{ delete(key: string): Promise<boolean> }> } | undefined = undefined,
): Promise<boolean> {
  if (unknownField(env, "useBrowserCache") === false) return false;
  try { store ??= globalThis.caches; } catch { return false; }
  if (!store) return false;
  const spec = REMOVAL_MODELS[request.model];
  const route = removalModelRoute(request);
  if (!route) return false;
  const host = unknownField(env, "remoteHost");
  const template = unknownField(env, "remotePathTemplate");
  const remote = (typeof template === "string" ? template : "{model}/resolve/{revision}/")
    .replaceAll("{model}", spec.modelId).replaceAll("{revision}", encodeURIComponent(spec.revision));
  const join = (...parts: string[]) => parts.map((part, index) => index === 0 ? part.replace(/\/+$/, "") : part.replace(/^\/+|\/+$/g, "")).join("/");
  const url = join(typeof host === "string" ? host : "https://huggingface.co/", remote, "onnx", route.onnxFile);
  try {
    const cache = await store.open("transformers-cache");
    await cache.delete(url);
    const local = unknownField(env, "localModelPath");
    if (typeof local === "string") await cache.delete(join(local, spec.modelId, "onnx", route.onnxFile));
    return true; // Already absent is also safe for the next download.
  } catch {
    return false;
  }
}
