import assert from "node:assert/strict";
import test from "node:test";
import {
  CutoutError,
  MEMORY_COPY,
  classifyError,
  isRetryableEngineError,
  messageFor,
} from "./errors.ts";

test("classifyError maps HEIC and abort", () => {
  const heic = classifyError(new Error("Failed to decode HEIC image"));
  assert.equal(heic.code, "heic");
  assert.equal(heic.retryable, false);

  const abort = classifyError(new DOMException("Stopped", "AbortError"));
  assert.equal(abort.code, "cancelled");
});

test("classifyError maps a prepare TimeoutError to a retryable wait", (t) => {
  t.mock.method(console, "error", () => undefined);
  const timeout = classifyError(new DOMException("Model preparation timed out.", "TimeoutError"));
  assert.equal(timeout.code, "model");
  assert.equal(timeout.retryable, true);
  assert.equal(timeout.message, "That took too long. Try again.");
});

test("classifyError keeps CutoutError fields", () => {
  const err = new CutoutError("drawing", "Couldn’t turn that drawing into an image.", true);
  const classified = classifyError(err);
  assert.equal(classified.code, "drawing");
  assert.equal(classified.retryable, true);
});

test("classifyError maps engine codes to retryable", () => {
  const load = classifyError({
    code: "model-load-failed",
    message: "The local model could not be loaded.",
  });
  assert.equal(load.code, "model");
  assert.equal(load.retryable, true);
  assert.equal(isRetryableEngineError({ code: "model-load-failed" }), true);

  const infer = classifyError({
    code: "inference-failed",
    message: "Local processing could not finish.",
  });
  assert.equal(infer.retryable, true);
  assert.equal(isRetryableEngineError({ code: "inference-failed" }), true);

  const oom = classifyError({ code: "out-of-memory", message: "bad_alloc" });
  assert.equal(oom.code, "memory");
  assert.equal(oom.retryable, false);
  assert.equal(isRetryableEngineError({ code: "out-of-memory" }), false);
  assert.equal(oom.message, MEMORY_COPY, "decode and ingest throw the same copy directly");

  const gpu = classifyError(new Error("WebGPU device lost"));
  assert.equal(gpu.code, "model");
  assert.equal(gpu.retryable, true);
  assert.equal(isRetryableEngineError(new Error("WebGPU device lost")), true);
});

test("classifyError explains a browser that lacks OffscreenCanvas", () => {
  // transformers.js createCanvasFunction in Playwright's Windows WebKit.
  const raw = new Error("OffscreenCanvas not supported by this browser.");
  const direct = classifyError(raw);
  assert.equal(direct.code, "browser");
  assert.equal(direct.retryable, false);
  assert.equal(
    direct.message,
    "This browser can’t run Cutout. Use a current Chrome, Edge, Firefox, or Safari 16.4 or later.",
  );
  // The same error after it is wrapped as an engine failure.
  const wrapped = Object.assign(
    new Error("Local processing could not finish. Try again or use a smaller image.", {
      cause: raw,
    }),
    { name: "BackgroundRemovalError", code: "inference-failed" },
  );
  assert.equal(classifyError(wrapped).code, "browser");
  assert.equal(isRetryableEngineError(wrapped), false);
});

test("classifyError logs the real cause of unknown and model failures once", (t) => {
  const log = t.mock.method(console, "error", () => undefined);
  const odd = new Error("something nobody expected");
  assert.equal(classifyError(odd).code, "unknown");
  assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["[cutout]", "unknown", odd]);
  const load = { code: "model-load-failed", message: "The local model could not be loaded." };
  assert.equal(classifyError(load).code, "model");
  assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["[cutout]", "model", load]);
  assert.equal(log.mock.callCount(), 2);

  // Expected, explained failures stay quiet, and retry checks do not log.
  classifyError(new Error("Failed to decode HEIC image"));
  classifyError(new DOMException("Stopped", "AbortError"));
  isRetryableEngineError(new Error("WebGPU device lost"));
  assert.equal(log.mock.callCount(), 2);
});

test("messageFor stays specific", () => {
  assert.match(messageFor("copy"), /Clipboard/);
  assert.match(messageFor("download"), /save/);
});

test("classifyError tells an open tab that a deploy replaced its code", () => {
  for (const message of [
    "Failed to fetch dynamically imported module: https://cutout.sh/assets/engine-abc.js",
    "error loading dynamically imported module: https://cutout.sh/assets/engine-abc.js",
    "Importing a module script failed.",
  ]) {
    const failure = classifyError(new TypeError(message));
    assert.equal(failure.code, "updated", message);
    assert.equal(failure.retryable, false);
  }
});

// Q12 pins (design r9). Every row passes on HEAD: errors.ts is not edited. They document how
// the engine's minted errors classify, and why Q1 mints `inference-failed` (owner deviation D4:
// at 5522 the primary path let raw throws through uncoded, so the mint is a deviation from
// 5522, not a restoration).
function named(name: string, message: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { name }, extra);
}

test("pin: MaskError and RemovalModelLoadError are model/retryable", (t) => {
  t.mock.method(console, "error", () => undefined);
  const mask = named("MaskError", "invalid alpha mask");
  assert.equal(classifyError(mask).code, "model");
  assert.equal(isRetryableEngineError(mask), true);
  const load = named("RemovalModelLoadError", "on webgpu: opaque failure");
  assert.equal(classifyError(load).code, "model");
  assert.equal(isRetryableEngineError(load), true);
});

test("pin: any error named AbortError, or uncoded text with 'abort', classifies cancelled; only the caller's signal tells a real cancel", () => {
  const abort = new DOMException("Stopped", "AbortError");
  assert.equal(classifyError(abort).code, "cancelled");
  assert.equal(isRetryableEngineError(abort), false);
  // Not only a DOMException: the plain Error the client rebuilds from a worker reply, and any uncoded
  // "abort" text, match the text fallback. So the queue checks the item's own signal (C05).
  assert.equal(classifyError(named("AbortError", "Aborted")).code, "cancelled");
  assert.equal(classifyError(new Error("The operation was aborted")).code, "cancelled");
});

test("pin: a RemovalInferenceError wrapping a cause classifies like the bare cause", (t) => {
  t.mock.method(console, "error", () => undefined);
  const bare = new Error("WebGPU device lost");
  const wrapped = named("RemovalInferenceError", "Local processing could not finish.", {
    cause: bare,
  });
  assert.equal(classifyError(wrapped).code, classifyError(bare).code);
  assert.equal(isRetryableEngineError(wrapped), isRetryableEngineError(bare));
  assert.equal(isRetryableEngineError(wrapped), true);
});

test("pin, documents D4 (mint is a deviation from 5522): an opaque inference throw needs the code to be retryable", (t) => {
  t.mock.method(console, "error", () => undefined);
  const uncoded = named("RemovalInferenceError", "ORT session run failed");
  assert.equal(classifyError(uncoded).code, "unknown");
  assert.equal(isRetryableEngineError(uncoded), false);
  const coded = named("RemovalInferenceError", "ORT session run failed", {
    code: "inference-failed",
  });
  assert.equal(classifyError(coded).code, "model");
  assert.equal(classifyError(coded).retryable, true);
  assert.equal(isRetryableEngineError(coded), true);
});

test("pin: the engine code precedes the memory regex, which is why Q1 carves memory out", (t) => {
  t.mock.method(console, "error", () => undefined);
  const oom = named("RemovalInferenceError", "out of memory", { code: "inference-failed" });
  assert.equal(classifyError(oom).code, "model");
  assert.equal(isRetryableEngineError(oom), true);
  // The carve-out keeps a memory failure uncoded, so the memory regex classifies it.
  const uncoded = named("RemovalInferenceError", "out of memory");
  assert.equal(classifyError(uncoded).code, "memory");
  assert.equal(isRetryableEngineError(uncoded), false);
});

test("pin, documents D4 (Aborted() crashes get a code): uncoded RuntimeError Aborted() is cancelled, coded is model/retryable", (t) => {
  t.mock.method(console, "error", () => undefined);
  const uncoded = named("RuntimeError", "Aborted()");
  assert.equal(classifyError(uncoded).code, "cancelled");
  assert.equal(isRetryableEngineError(uncoded), false);
  const coded = named("RuntimeError", "Aborted()", { code: "inference-failed" });
  assert.equal(classifyError(coded).code, "model");
  assert.equal(isRetryableEngineError(coded), true);
});

test("pin: the five engine error names alone match no classify regex", (t) => {
  t.mock.method(console, "error", () => undefined);
  for (const name of [
    "MaskError",
    "RemovalModelLoadError",
    "RemovalModelOutputError",
    "RemovalInputError",
    "RemovalInferenceError",
  ]) {
    const failure = classifyError(named(name, "x"));
    assert.equal(failure.code, "unknown", name);
  }
});

test("context faults keep specific reload or damaged-model copy across the worker boundary", () => {
  const lost = classifyError(
    Object.assign(
      new Error("The graphics device was lost. Reload the page to continue removing backgrounds."),
      { code: "removal-context-lost" },
    ),
  );
  assert.equal(lost.code, "updated");
  assert.match(lost.message, /graphics device.*Reload/);
  assert.equal(lost.retryable, false);
  const damaged = classifyError(
    Object.assign(new Error("The saved model file was damaged and has been removed. Try again."), {
      code: "removal-model-damaged",
    }),
  );
  assert.equal(damaged.code, "model");
  assert.match(damaged.message, /damaged.*removed/);
  assert.equal(damaged.retryable, true);
});

test("C26: oom is a token, not part of room or zoom", () => {
  for (const word of ["zoom", "room", "Kaboom", "classroom", "mushroom", "vroom", "gloom"]) {
    const failure = classifyError(new Error(`${word} pipeline failed`));
    assert.equal(failure.code, "model", word);
    assert.equal(failure.retryable, true, word);
  }
  for (const word of ["OOM", "oom-killer", "out of memory", "bad_alloc", "allocation failed"]) {
    assert.equal(classifyError(new Error(word)).code, "memory", word);
  }
});

const GPU = "The local remover couldn’t use this device’s graphics. Try again.";
const CONNECTION =
  "The local remover couldn’t start on this device. Check your connection and try again.";

test("E05-02: a stalled worker keeps its own copy, retryable, not the unknown copy", (t) => {
  t.mock.method(console, "error", () => undefined);
  const stalled = Object.assign(new Error("The remover stopped responding. Try again."), {
    code: "removal-worker-stalled",
    failureKind: "network",
  });
  assert.deepEqual(
    (({ code, message, retryable }) => ({ code, message, retryable }))(classifyError(stalled)),
    { code: "model", message: "The remover stopped responding. Try again.", retryable: true },
  );
});

test("E05-05: GPU failures get the graphics copy, never the connection copy; network failures keep it", (t) => {
  t.mock.method(console, "error", () => undefined);
  const load = (message: string, failureKind: string, cause?: Error) =>
    Object.assign(new Error(message, cause ? { cause } : undefined), {
      name: "RemovalModelLoadError",
      code: "model-load-failed",
      failureKind,
    });
  // E05-03's real failure: requestDevice throws inside ORT's WebGPU session creation.
  const device = load(
    "Could not load birefnet on webgpu: no available backend found. ERR: [webgpu] OperationError: The requested device could not be created.",
    "provider-init",
  );
  for (const [label, error] of [
    ["provider-init on webgpu", device],
    [
      "the worker's fresh-context request",
      Object.assign(new Error(GPU), {
        code: "removal-webgpu-init-failed",
        failureKind: "provider-init",
      }),
    ],
    ["device lost", new Error("WebGPU device lost")],
    [
      "gpu-device kind",
      Object.assign(new Error("GPU device was destroyed"), { failureKind: "gpu-device" }),
    ],
    [
      "a flat WebGPU mask",
      Object.assign(new Error("WebGPU returned a flat alpha mask"), { name: "MaskError" }),
    ],
  ] as const) {
    const failure = classifyError(error);
    assert.equal(failure.message, GPU, label);
    assert.deepEqual([failure.code, failure.retryable], ["model", true], label);
  }
  for (const [label, error] of [
    ["fetch on webgpu", load("Could not load birefnet on webgpu: Failed to fetch", "network")],
    [
      "a host error",
      load(
        'Could not load birefnet on wasm: Could not locate file: "https://huggingface.co/x".',
        "model-fetch",
      ),
    ],
    [
      "a catch-all on wasm",
      load("Could not load birefnet on wasm: something odd", "provider-init"),
    ],
    [
      "a JSON parse on webgpu",
      load(
        "Could not load birefnet on webgpu: Unexpected token '<', \"<html>\" is not valid JSON",
        "provider-init",
      ),
    ],
    ["uncoded fetch", new Error("Failed to fetch")],
    // removal-model.ts's real load timeout (a silent download), on either provider.
    [
      "a load timeout",
      Object.assign(
        load(
          "Could not load birefnet on webgpu: Model download stopped making progress",
          "network",
        ),
        { code: "model-load-timeout" },
      ),
    ],
  ] as const)
    assert.equal(classifyError(error).message, CONNECTION, label);
});

test("E06-G-02: the model host's rate limit asks to wait a minute, retryable, through any wrapper", (t) => {
  t.mock.method(console, "error", () => undefined);
  // transformers hub.js handleError: `Error (${status}) occurred while trying to load file: "<url>".`
  const raw = new Error(
    'Error (429) occurred while trying to load file: "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c/onnx/model_fp16.onnx".',
  );
  const loaded = Object.assign(
    new Error(`Could not load birefnet on webgpu: ${raw.message}`, { cause: raw }),
    {
      name: "RemovalModelLoadError",
      code: "model-load-failed",
      failureKind: "model-fetch",
    },
  );
  // As the client rebuilds it from a worker reply: name, message, code, and the cause chain as text.
  const fromWorker = Object.assign(
    new Error(loaded.message, { cause: new Error(`${loaded.message} ← ${raw.message}`) }),
    {
      name: "RemovalModelLoadError",
      code: "model-load-failed",
      failureKind: "model-fetch",
    },
  );
  for (const error of [raw, loaded, fromWorker, new Error("429 Too Many Requests")]) {
    const failure = classifyError(error);
    assert.deepEqual(
      [failure.code, failure.message, failure.retryable],
      ["model", "The model server is busy. Try again in a minute.", true],
    );
  }
  assert.notEqual(
    classifyError(new Error('Error (500) occurred while trying to load file: "x".')).message,
    "The model server is busy. Try again in a minute.",
  );
  assert.equal(isRetryableEngineError(loaded), true);
});

test("model integrity has clear non-looping copy, including the worker's reconstructed error", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const { RemovalModelIntegrityError } = await import("./removal-model-integrity.ts");
  const raw = new RemovalModelIntegrityError("onnx/model.onnx");
  const worker = Object.assign(new Error(raw.message), { code: raw.code, name: raw.name });
  for (const error of [raw, worker]) {
    const failure = classifyError(error);
    assert.equal(failure.code, "model");
    assert.equal(failure.retryable, false);
    assert.match(failure.message, /safety check.*connection or model mirror.*reload/);
    assert.equal(isRetryableEngineError(error), false);
  }
});
