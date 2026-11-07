import assert from "node:assert/strict";
import test from "node:test";
import { RemovalModelLoadError } from "./removal-model.ts";
import {
  REMOVAL_FAILURE_KEY,
  REMOVAL_RUNTIME_FINGERPRINT,
  classifyRemovalFailure,
  selectRemovalRoute,
  type RemovalFailureStore,
} from "./removal-provider.ts";

type Provider = typeof import("./removal-provider.ts");

// The provider keeps process-local state (confirmed GPU failure flag, session load memo).
// Every stateful case imports its own module instance through a query-suffixed specifier.
let instance = 0;
async function load(): Promise<Provider> {
  instance += 1;
  return (await import(`./removal-provider.ts?case=${instance}`)) as Provider;
}

class MemoryStore implements RemovalFailureStore {
  readonly values = new Map<string, string>();
  get length(): number {
    return this.values.size;
  }
  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function throwingStore(make: () => Error): RemovalFailureStore {
  const fail = (): never => {
    throw make();
  };
  return {
    get length(): number {
      return fail();
    },
    key: fail,
    getItem: fail,
    setItem: fail,
    removeItem: fail,
  };
}

const denied = (): RemovalFailureStore =>
  throwingStore(() => new DOMException("denied", "SecurityError"));
const broken = (): RemovalFailureStore => throwingStore(() => new TypeError("storage exploded"));

function loadError(failureKind: string, name = "RemovalModelLoadError"): unknown {
  return Object.assign(new Error(`Could not load birefnet on webgpu: ${failureKind}`), {
    name,
    failureKind,
  });
}

function currentUserAgent(): string {
  return navigator.userAgent;
}

const LEGACY_KEY = "bg0:webgpu-failure:4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7";

test("selects ISNet on a low-memory CPU and keeps the default WebGPU attempt on a usable adapter", () => {
  // Given: a four-GB CPU-only browser and a browser with a usable adapter but no memory hint.
  const lowMemory = selectRemovalRoute({ deviceMemory: 4, compatibleGpu: false, gpuFailed: true });
  const unknownMemory = selectRemovalRoute({ compatibleGpu: true, gpuFailed: false });

  // When/Then: only the measured low-memory case changes model.
  assert.deepEqual(lowMemory, { primary: { model: "isnet", provider: "wasm" } });
  assert.deepEqual(unknownMemory, { primary: { model: "birefnet", provider: "webgpu" } });
});

test("PIN (Q10): the runtime folds a missing adapter into gpuFailed and gets BiRefNet/WASM, no WebGPU", () => {
  // Given/When: automaticRoute() passes gpuFailed = !compatibleGpu || recorded failure || memo.
  const noAdapter = selectRemovalRoute({ deviceMemory: 8, compatibleGpu: false, gpuFailed: true });
  const lowMemoryNoAdapter = selectRemovalRoute({
    deviceMemory: 4,
    compatibleGpu: false,
    gpuFailed: true,
  });
  const adapterButFailed = selectRemovalRoute({
    deviceMemory: 8,
    compatibleGpu: true,
    gpuFailed: true,
  });

  // Then: the unchanged selector yields the original's no-adapter route; low memory still wins to ISNet.
  assert.deepEqual(noAdapter, { primary: { model: "birefnet", provider: "wasm" } });
  assert.deepEqual(lowMemoryNoAdapter, { primary: { model: "isnet", provider: "wasm" } });
  assert.deepEqual(adapterButFailed, { primary: { model: "birefnet", provider: "wasm" } });
});

test("classifies abort, delivery, cache, and genuine GPU failures separately", () => {
  // Given: representative public-boundary failures.
  const cases = [
    [new DOMException("stopped", "AbortError"), "abort"],
    [new TypeError("Failed to fetch"), "network"],
    [hubError(503), "network"],
    [{ code: "cache-miss" }, "cache"],
    [{ code: "model-fetch-failed" }, "model-fetch"],
    [{ code: "device-lost" }, "gpu-device"],
    [{ code: "invalid-gpu-mask" }, "gpu-mask"],
  ] as const;

  // When/Then: each failure keeps the actionable class needed by fallback policy.
  assert.deepEqual(
    cases.map(([error]) => classifyRemovalFailure(error)),
    cases.map(([, kind]) => kind),
  );
  assert.equal(classifyRemovalFailure(new Error("wrapped", { cause: hubError(503) })), "network");
});

// Verbatim transformers.js 3.8.1 load failures (node_modules/@huggingface/transformers/src/utils/hub.js,
// ERROR_MAPPING and handleError: a plain Error, no status, code or cause) and WebKit's fetch
// rejection. Each must be absorbed into the same job on WASM and set the "network" memo.
const HF_FP16 =
  "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model_fp16.onnx";
const HUB_TEXT: Record<number, string> = {
  400: "Bad request error occurred while trying to load file",
  401: "Unauthorized access to file",
  403: "Forbidden access to file",
  404: "Could not locate file",
  408: "Request timeout error occurred while trying to load file",
  500: "Internal server error error occurred while trying to load file",
  502: "Bad gateway error occurred while trying to load file",
  503: "Service unavailable error occurred while trying to load file",
  504: "Gateway timeout error occurred while trying to load file",
};
function hubError(status: number): Error {
  return Error(
    `${HUB_TEXT[status] ?? `Error (${status}) occurred while trying to load file`}: "${HF_FP16}".`,
  );
}

test("C02: real transformers hub texts and WebKit's 'Load failed' are fetch-class, absorbed, memo network", async () => {
  const request = { model: "birefnet", provider: "webgpu", context: "worker" } as const;
  const rows: Array<[string, Error, string]> = [
    ...[400, 401, 403, 404, 408, 429, 500, 502, 504].map((status): [string, Error, string] => [
      `hub ${status}`,
      hubError(status),
      "model-fetch",
    ]),
    ["hub 503", hubError(503), "network"],
    ["WebKit fetch", new TypeError("Load failed"), "network"],
    ["Chromium fetch", new TypeError("Failed to fetch"), "network"],
  ];
  for (const [label, cause, kind] of rows) {
    const provider = await load();
    assert.equal(classifyRemovalFailure(cause), kind, label);
    const error = new RemovalModelLoadError(request, cause);
    assert.equal(error.failureKind, kind, label);
    assert.equal(provider.absorbsLoadFailure(error), true, `${label}: absorbed`);
    provider.noteWebgpuLoadFailure(error);
    assert.equal(provider.webgpuLoadMemo(), "network", `${label}: memo`);
  }
  // Still init-class: transformers' own fp16 gate and a session failure are not fetch failures.
  assert.equal(
    classifyRemovalFailure(new Error("The device (webgpu) does not support fp16.")),
    "provider-init",
  );
  assert.equal(
    classifyRemovalFailure(new Error("Load failed")),
    "unknown",
    "only WebKit's fetch TypeError",
  );
});

test("persists only genuine GPU failures and preserves their fingerprint", async () => {
  // Given: clean page storage.
  const { rememberGpuFailure, readGpuFailure } = await load();
  const store = new MemoryStore();

  // When: delivery and provider timing failures are offered before device loss.
  assert.equal(rememberGpuFailure("network", store), false);
  assert.equal(rememberGpuFailure("provider-init", store), false);
  assert.equal(store.length, 0);
  assert.equal(readGpuFailure(null), false);
  assert.equal(rememberGpuFailure("gpu-device", store), true);

  // Then: the current runtime reads the record as a usable failure signal.
  assert.equal(readGpuFailure(store), true);
  const record: unknown = JSON.parse(store.getItem(REMOVAL_FAILURE_KEY) ?? "null");
  assert.equal(
    typeof record === "object" && record !== null ? Reflect.get(record, "fingerprint") : undefined,
    REMOVAL_RUNTIME_FINGERPRINT,
  );
});

test("cleans stale fingerprints and legacy records while denied storage stays safe", async () => {
  // Given: a stale current record, two legacy records, and a denied-storage implementation.
  const { rememberGpuFailure, readGpuFailure, clearRemovalFailureRecords } = await load();
  const store = new MemoryStore();
  store.setItem(
    REMOVAL_FAILURE_KEY,
    JSON.stringify({ version: 1, fingerprint: "stale", kind: "gpu-mask" }),
  );
  store.setItem("bg0:webgpu-failure:a", "old");
  store.setItem("bg0:webgpu-failure:b", "old");

  // When/Then: a stale record is rejected and removed, legacy state is removable, and denial never escapes.
  assert.equal(readGpuFailure(store), false);
  assert.equal(store.getItem(REMOVAL_FAILURE_KEY), null);
  clearRemovalFailureRecords(store);
  assert.equal(store.length, 0);
  assert.equal(readGpuFailure(denied()), false);
  assert.equal(rememberGpuFailure("gpu-device", denied()), false);
  assert.doesNotThrow(() => clearRemovalFailureRecords(denied()));
});

// ---- Q7: GPU state when storage is denied or throws -------------------------------------------

test("Q7: denied storage keeps the in-process failure", async () => {
  // Given: a store whose every method throws SecurityError.
  const { rememberGpuFailure, readGpuFailure } = await load();
  const store = denied();

  // When: a genuine GPU failure cannot be persisted.
  const persisted = rememberGpuFailure("gpu-device", store);

  // Then: the write reports false, but the process still knows, even through the throwing store.
  assert.equal(persisted, false);
  assert.equal(readGpuFailure(store), true);
});

test("Q7: a non-denial setItem throw returns false instead of escaping, and the flag is already set", async () => {
  // Given: a store whose setItem throws a TypeError (red on r1: only denials were swallowed).
  const { rememberGpuFailure, readGpuFailure } = await load();
  const store = new MemoryStore();
  store.setItem = () => {
    throw new TypeError("quota-ish");
  };

  // When/Then: no throw, false return, and the failure is still readable without any store.
  assert.equal(rememberGpuFailure("gpu-device", store), false);
  assert.equal(readGpuFailure(null), true);
});

test("Q7: a non-denial getItem throw reads as no failure without escaping", async () => {
  // Given: fresh state and a store whose getItem throws a TypeError (red on r1).
  const { readGpuFailure } = await load();
  const store = new MemoryStore();
  store.getItem = () => {
    throw new TypeError("read exploded");
  };

  // When/Then: nothing was confirmed in-process, so the answer is false and nothing throws.
  assert.doesNotThrow(() => readGpuFailure(store));
  assert.equal(readGpuFailure(store), false);
  assert.equal(readGpuFailure(broken()), false);
});

test("Q7: clear resets the in-process failure even when the store throws", async () => {
  // Given: a confirmed failure.
  const { rememberGpuFailure, readGpuFailure, clearRemovalFailureRecords } = await load();
  rememberGpuFailure("gpu-mask", null);
  assert.equal(readGpuFailure(null), true);

  // When: Delete runs against a healthy store, and again against a broken one.
  clearRemovalFailureRecords(new MemoryStore());
  assert.equal(readGpuFailure(null), false);
  rememberGpuFailure("gpu-device", null);
  assert.doesNotThrow(() => clearRemovalFailureRecords(broken()));

  // Then: the flag is gone both times.
  assert.equal(readGpuFailure(null), false);
});

test("Q7: with no store at all the failure lives in the process flag only", async () => {
  // Given/When: the worker case, where there is no storage.
  const { rememberGpuFailure, readGpuFailure } = await load();
  assert.equal(readGpuFailure(null), false);
  const persisted = rememberGpuFailure("gpu-mask", null);

  // Then: nothing is persisted, the flag answers, and non-GPU kinds never set it.
  assert.equal(persisted, false);
  assert.equal(readGpuFailure(null), true);
  const fresh = await load();
  fresh.rememberGpuFailure("network", null);
  fresh.rememberGpuFailure("provider-init", null);
  fresh.rememberGpuFailure("abort", null);
  assert.equal(fresh.readGpuFailure(null), false);
});

test("Q7: a throwing localStorage getter never escapes remember, read, clear or availableStorage", async () => {
  // Given: (red on r2) a localStorage accessor that throws a non-denial error.
  const { rememberGpuFailure, readGpuFailure, clearRemovalFailureRecords, availableStorage } =
    await load();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get(): never {
      throw new TypeError("storage getter exploded");
    },
  });
  try {
    // When/Then: the default parameter cannot throw outside the functions.
    assert.equal(availableStorage(), undefined);
    assert.equal(rememberGpuFailure("gpu-device"), false);
    assert.equal(readGpuFailure(), true);
    assert.doesNotThrow(() => clearRemovalFailureRecords());
    assert.equal(readGpuFailure(), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

// ---- Q8: legacy bg0 records ---------------------------------------------------------------------

test("Q8: a legacy record for the current user agent is honoured and never migrated", async () => {
  // Given: only a legacy key whose value is this browser's user agent.
  const { readGpuFailure } = await load();
  const store = new MemoryStore();
  store.setItem(LEGACY_KEY, currentUserAgent());
  const before = JSON.stringify([...store.values]);

  // When/Then: it counts as a GPU failure but storage is read-only.
  assert.equal(readGpuFailure(store), true);
  assert.equal(JSON.stringify([...store.values]), before);
  assert.equal(store.getItem(REMOVAL_FAILURE_KEY), null);

  // And removing the legacy key restores WebGPU.
  store.removeItem(LEGACY_KEY);
  assert.equal(readGpuFailure(store), false);
});

test("Q8: a legacy record for another user agent is ignored", async () => {
  const { readGpuFailure } = await load();
  const store = new MemoryStore();
  store.setItem(LEGACY_KEY, `${currentUserAgent()} (another browser)`);
  store.setItem("unrelated:webgpu-failure:x", currentUserAgent());

  assert.equal(readGpuFailure(store), false);
  assert.equal(store.length, 2);
});

test("Q8: clear removes the legacy and the current record", async () => {
  const { rememberGpuFailure, readGpuFailure, clearRemovalFailureRecords } = await load();
  const store = new MemoryStore();
  store.setItem(LEGACY_KEY, currentUserAgent());
  store.setItem("bg0:webgpu-failure:other", "whatever");
  store.setItem("keep", "me");
  // The current record as an earlier version wrote it for a mask failure, and as gpu-device writes it now.
  store.setItem(
    REMOVAL_FAILURE_KEY,
    JSON.stringify({ version: 1, fingerprint: REMOVAL_RUNTIME_FINGERPRINT, kind: "gpu-mask" }),
  );
  assert.equal(readGpuFailure(store), true);

  clearRemovalFailureRecords(store);
  assert.deepEqual([...store.values.keys()], ["keep"]);
  assert.equal(rememberGpuFailure("gpu-device", store), true);
  clearRemovalFailureRecords(store);

  assert.deepEqual([...store.values.keys()], ["keep"]);
});

test("Q8: with no store the legacy key is not consulted", async () => {
  // Given: a matching legacy key in a store that the caller does not pass.
  const { readGpuFailure, legacyGpuFailure } = await load();
  const separate = new MemoryStore();
  separate.setItem(LEGACY_KEY, currentUserAgent());

  // When/Then: null and undefined both mean "no store" for the legacy check.
  assert.equal(readGpuFailure(null), false);
  assert.equal(legacyGpuFailure(null), false);
  assert.equal(legacyGpuFailure(undefined), false);
  assert.equal(legacyGpuFailure(separate), true);
});

test("Q8: legacyGpuFailure swallows storage errors and reads nothing outside the prefix", async () => {
  const { legacyGpuFailure } = await load();
  const store = new MemoryStore();
  store.setItem("other", currentUserAgent());

  assert.equal(legacyGpuFailure(store), false);
  assert.equal(legacyGpuFailure(denied()), false);
  assert.equal(legacyGpuFailure(broken()), false);
});

// ---- Q4 / Q3: session load memo, absorb predicate ---------------------------------------------------

test("Q4: absorbsLoadFailure accepts only fetch-layer load errors", async () => {
  // Given: load errors of every kind.
  const { absorbsLoadFailure } = await load();
  const absorbed = ["network", "model-fetch", "cache"];
  const refused = ["provider-init", "gpu-device", "gpu-mask", "model-output", "unknown", "abort"];

  // When/Then: only the network class is absorbed.
  for (const kind of absorbed) assert.equal(absorbsLoadFailure(loadError(kind)), true, kind);
  for (const kind of refused) assert.equal(absorbsLoadFailure(loadError(kind)), false, kind);
});

test("Q4: absorbsLoadFailure requires a RemovalModelLoadError", async () => {
  const { absorbsLoadFailure } = await load();
  const impostors: readonly unknown[] = [
    loadError("network", "RemovalModelOutputError"),
    loadError("network", "Error"),
    new TypeError("Failed to fetch"),
    { failureKind: "network" },
    { name: "RemovalModelLoadError" },
    undefined,
    null,
    "RemovalModelLoadError",
  ];

  for (const impostor of impostors) assert.equal(absorbsLoadFailure(impostor), false);
});

test("Q4: the session memo starts unset and ignores errors that are not load failures", async () => {
  const { noteWebgpuLoadFailure, webgpuLoadMemo } = await load();
  assert.equal(webgpuLoadMemo(), undefined);

  noteWebgpuLoadFailure(new TypeError("Failed to fetch"));
  noteWebgpuLoadFailure({ failureKind: "network" });
  noteWebgpuLoadFailure(loadError("network", "RemovalModelOutputError"));
  noteWebgpuLoadFailure(loadError("abort"));
  noteWebgpuLoadFailure({ name: "RemovalModelLoadError" });
  noteWebgpuLoadFailure(loadError("not-a-kind"));
  noteWebgpuLoadFailure(undefined);
  noteWebgpuLoadFailure(null);

  assert.equal(webgpuLoadMemo(), undefined);
});

test("Q4: network, model-fetch and cache load failures memoise the network class", async () => {
  for (const kind of ["network", "model-fetch", "cache"]) {
    const { noteWebgpuLoadFailure, webgpuLoadMemo } = await load();
    noteWebgpuLoadFailure(loadError(kind));
    assert.equal(webgpuLoadMemo(), "network", kind);
  }
});

test("Q4: every other non-abort load failure memoises the init class", async () => {
  for (const kind of ["provider-init", "gpu-device", "gpu-mask", "model-output", "unknown"]) {
    const { noteWebgpuLoadFailure, webgpuLoadMemo } = await load();
    noteWebgpuLoadFailure(loadError(kind));
    assert.equal(webgpuLoadMemo(), "init", kind);
  }
});

test("Q4: the first memo value stands until cleared", async () => {
  // Given: a network-class memo.
  const { noteWebgpuLoadFailure, webgpuLoadMemo, clearRemovalFailureRecords } = await load();
  noteWebgpuLoadFailure(loadError("network"));

  // When: an init-class failure arrives later.
  noteWebgpuLoadFailure(loadError("provider-init"));

  // Then: the first class stands; clear resets it and the next value then wins.
  assert.equal(webgpuLoadMemo(), "network");
  clearRemovalFailureRecords(new MemoryStore());
  assert.equal(webgpuLoadMemo(), undefined);
  noteWebgpuLoadFailure(loadError("provider-init"));
  assert.equal(webgpuLoadMemo(), "init");
});

test("Q4: the memo is session-only: never persisted and never read as a GPU failure", async () => {
  // Given: both memo classes set in separate module instances, and a healthy store.
  for (const kind of ["network", "provider-init"]) {
    const { noteWebgpuLoadFailure, webgpuLoadMemo, readGpuFailure } = await load();
    const store = new MemoryStore();
    noteWebgpuLoadFailure(loadError(kind));

    // When/Then: nothing is written, and readGpuFailure stays false with and without a store.
    assert.notEqual(webgpuLoadMemo(), undefined);
    assert.equal(store.length, 0);
    assert.equal(readGpuFailure(store), false);
    assert.equal(readGpuFailure(null), false);
  }
});

test("Q4: a confirmed GPU failure and the load memo are independent, and one clear resets both", async () => {
  const {
    noteWebgpuLoadFailure,
    webgpuLoadMemo,
    rememberGpuFailure,
    readGpuFailure,
    clearRemovalFailureRecords,
  } = await load();
  noteWebgpuLoadFailure(loadError("network"));
  assert.equal(readGpuFailure(null), false);
  rememberGpuFailure("gpu-mask", null);
  assert.equal(readGpuFailure(null), true);
  assert.equal(webgpuLoadMemo(), "network");

  clearRemovalFailureRecords(null);

  assert.equal(readGpuFailure(null), false);
  assert.equal(webgpuLoadMemo(), undefined);
});

// ---- Q12: engine-origin error names -----------------------------------------------------------------

test("Q12: ENGINE_ERROR_NAMES is exactly the five engine-minted error names", async () => {
  const { ENGINE_ERROR_NAMES } = await load();

  assert.deepEqual([...ENGINE_ERROR_NAMES].sort(), [
    "MaskError",
    "RemovalInferenceError",
    "RemovalInputError",
    "RemovalModelLoadError",
    "RemovalModelOutputError",
  ]);
  assert.equal(ENGINE_ERROR_NAMES.has("AbortError"), false);
  assert.equal(ENGINE_ERROR_NAMES.has("Error"), false);
});

test("C05 load: an AbortError-named loader failure with a live job is a coded failure", () => {
  const error = new RemovalModelLoadError(
    { model: "birefnet", provider: "webgpu", context: "worker" },
    new DOMException("The operation was aborted.", "AbortError"),
  );
  assert.equal(classifyRemovalFailure(error), "provider-init");
  assert.equal(error.code, "model-load-failed");
});

// ---- E10-S-01: a mask failure judged from one image holds for this page only ----------------------

test("E10-S-01: gpu-mask sets the session flag but writes no record; gpu-device still persists", async () => {
  const { rememberGpuFailure, readGpuFailure } = await load();
  const store = new MemoryStore();
  assert.equal(rememberGpuFailure("gpu-mask", store), false, "nothing persisted");
  assert.equal(store.length, 0);
  assert.equal(readGpuFailure(store), true, "this page still skips the GPU");
  // The next visit (a fresh module) starts on WebGPU again.
  const nextVisit = await load();
  assert.equal(nextVisit.readGpuFailure(store), false);
  // A lost device is still remembered across visits, as before.
  assert.equal(nextVisit.rememberGpuFailure("gpu-device", store), true);
  assert.equal(JSON.parse(store.getItem(REMOVAL_FAILURE_KEY) ?? "null").kind, "gpu-device");
  assert.equal((await load()).readGpuFailure(store), true);
});

test("E10-S-01: a gpu-mask record an earlier version wrote is still read, expires on a new fingerprint, and Delete clears it", async () => {
  const { readGpuFailure, clearRemovalFailureRecords } = await load();
  const store = new MemoryStore();
  const record = (fingerprint: string) =>
    JSON.stringify({ version: 1, fingerprint, kind: "gpu-mask" });
  store.setItem(REMOVAL_FAILURE_KEY, record(REMOVAL_RUNTIME_FINGERPRINT));
  assert.equal(readGpuFailure(store), true);
  clearRemovalFailureRecords(store);
  assert.equal(store.getItem(REMOVAL_FAILURE_KEY), null);
  store.setItem(REMOVAL_FAILURE_KEY, record("transformers@older"));
  assert.equal((await load()).readGpuFailure(store), false);
  assert.equal(store.getItem(REMOVAL_FAILURE_KEY), null, "the stale record is removed on read");
});
