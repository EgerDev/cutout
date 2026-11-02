/**
 * transformers.js, with ONNX Runtime's WASM served by this app. Its default is
 * cdn.jsdelivr.net, which self-hosted and firewalled installs may not reach, while the
 * build already ships the same files with precompressed, immutable caching. Load
 * transformers through `transformers()` so every page and worker context is set up
 * before its first session (every consumer shares the same `env`). A function, not a top-level
 * assignment: package.json declares no side effects, so that would be tree-shaken.
 */
import { removalModelCache } from "./removal-model-integrity.ts";
import * as tf from "@huggingface/transformers";
// The package exports only its entry point, so the runtime files are addressed by path.
import ortMjs from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs?url";
import ortWasm from "../../node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm?url";

let prefetched = false;
let cacheInstalled = false;

/**
 * Starts downloading ONNX Runtime's files (3 MB brotli) now. The runtime asks for them
 * only once the model (~100 MB) has arrived; both are immutable, so the later request is
 * answered from the browser cache and the runtime is off the critical path.
 */
export function prefetchRuntime() {
  if (prefetched || typeof fetch !== "function") return;
  prefetched = true;
  for (const url of [ortWasm, ortMjs]) void fetch(url).catch(() => {});
}

export function transformers(): typeof tf {
  const wasm = tf.env.backends.onnx.wasm;
  if (wasm) wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
  // A deployment can serve the pinned model files from its own mirror, laid out like
  // Hugging Face (`{model}/resolve/{revision}/…`), so an outage there does not stop removal.
  const host = import.meta.env.VITE_MODEL_HOST;
  if (host) tf.env.remoteHost = host.endsWith("/") ? host : `${host}/`;
  if (!cacheInstalled) {
    tf.env.customCache = removalModelCache(tf.env);
    tf.env.useCustomCache = true;
    cacheInstalled = true;
  }
  return tf;
}
