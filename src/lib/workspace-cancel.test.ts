import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { QueueItem, WorkspaceState } from "./workspace-types.ts";
import { runtime } from "./workspace-runtime.ts";

type RemovalOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { stage: string; progress: number; message: string }) => void;
};
type RemovalCall = {
  options: RemovalOptions;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  rejectOnAbort: boolean;
};

const removalCalls: RemovalCall[] = [];
const revoked: unknown[] = [];
let activeRemovals = 0;
let maxActiveRemovals = 0;
let enhancePending: { resolve: (result: unknown) => void } | null = null;

const globals = globalThis as Record<string, unknown>;
globals.__cutoutRevoked = revoked;
globals.__cutoutRemove = (_source: unknown, options: RemovalOptions) =>
  new Promise((resolve, reject) => {
    const call: RemovalCall = {
      options,
      rejectOnAbort: true,
      resolve: (result) => {
        activeRemovals--;
        resolve(result);
      },
      reject: (error) => {
        activeRemovals--;
        reject(error);
      },
    };
    removalCalls.push(call);
    activeRemovals++;
    maxActiveRemovals = Math.max(maxActiveRemovals, activeRemovals);
    options.signal?.addEventListener(
      "abort",
      () => {
        if (call.rejectOnAbort)
          call.reject(new DOMException("The operation was aborted.", "AbortError"));
      },
      { once: true },
    );
  });
globals.__cutoutEnhance = () =>
  new Promise((resolve) => {
    enhancePending = { resolve };
  });

// Heavy/leaky dependencies of the real store+queue modules, swapped for test doubles.
// Everything else (zustand, queue, process, runtime, editor state, ingest) runs for real.
const stubs: Record<string, string> = {
  "./metadata-client": "export const inspectImageMetadata = async () => null;",
  "./editor/canvas": `export const processable = async (file) => file;
    export const clearSourceBitmapCache = () => {};`,
  "./editor/preview": "export const installEditorPreview = () => {};",
  "./editor/resources": `export const revoke = (url) => { globalThis.__cutoutRevoked.push(url); };
    export const closePreview = () => {};`,
  "./removal-client": `export const removeBackgroundAuto = (source, options) =>
    globalThis.__cutoutRemove(source, options);`,
  "./files": `export const rasterizeSvgFile = async (file) => file;
    export const planIngest = () => ({ images: [], errorMessage: null });
    export const createDisplayPreview = async () => globalThis.__cutoutPreviewResult;
    export const processingLimits = () => ({ side: 4096, pixels: 4096 * 4096 });`,
  "./workspace-lifecycle": `export const resetWorkspace = () => {};
    export const resumeWorkspace = async () => {};`,
  "./workspace-downloads": "export const downloadActions = () => ({});",
  "./enhance": `export const enhanceFile = (file, options) =>
    globalThis.__cutoutEnhance(file, options);`,
  "./editor/alpha": "export const maskWith = async () => null;",
};
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const key = specifier.replace(/\.ts$/, "");
    const stub = stubs[key];
    if (stub)
      return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
    if (specifier.startsWith("./") && !/\.\w+$/.test(specifier))
      return next(`${specifier}.ts`, context);
    return next(specifier, context);
  },
});
test.after(() => hooks.deregister());

const { useWorkspace } = await import("./workspace-store.ts");
const { runQueue } = await import("./workspace-queue.ts");
const { hydratePreview } = await import("./workspace-ingest.ts");
const { defaults } = await import("./editor/model.ts");
// The store checks `typeof window` for its e2e export at load; the queue only uses
// window for the progress-throttle timer at call time.
(globalThis as { window?: unknown }).window = globalThis;

const get = useWorkspace.getState;
const set = useWorkspace.setState;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const drained = async () => {
  await settle();
  await settle();
};
const removalResult = () => ({
  blob: new Blob(["result"], { type: "image/png" }),
  width: 4,
  height: 4,
  provider: "wasm",
  method: "auto",
});

function item(id: string, status: QueueItem["status"], extra: Partial<QueueItem> = {}): QueueItem {
  return {
    id,
    name: `${id}.jpg`,
    source: new File([id], `${id}.jpg`, { type: "image/jpeg" }),
    sourceUrl: `blob:source-${id}`,
    preview: null,
    resultBlob: null,
    resultUrl: null,
    width: 0,
    height: 0,
    status,
    ...extra,
  };
}

function seed(items: QueueItem[], over: Partial<WorkspaceState> = {}) {
  runtime.job += 1;
  runtime.queueToken = null;
  runtime.runAbort = new AbortController();
  runtime.itemAborts.clear();
  removalCalls.length = 0;
  revoked.length = 0;
  activeRemovals = 0;
  maxActiveRemovals = 0;
  enhancePending = null;
  globals.__cutoutPreviewResult = { bitmap: null, url: "", width: 0, height: 0 };
  set({
    items,
    activeId: items[0]?.id ?? null,
    phase: items.length ? "processing" : "idle",
    errorMessage: null,
    enhancing: null,
    progress: { stage: "loading", progress: 0, message: "" },
    settings: {},
    past: [],
    future: [],
    selectedIds: [],
    excludedIds: [],
    removalMode: "auto",
    comparing: false,
    peeking: false,
    inspecting: false,
    copied: false,
    saved: false,
    metadata: null,
    ...over,
  });
}

test("stop preserves finished results and prevents the next queued claim", async () => {
  const done = item("a", "done", {
    resultBlob: new Blob(["r"], { type: "image/png" }),
    resultUrl: "blob:result-a",
    width: 2,
    height: 2,
  });
  const settings = { a: { ...defaults, feather: 3 } };
  const past = [{ settings: { a: { ...defaults, feather: 0 } }, key: "feather", time: 0 }];
  const future = [{ a: { ...defaults, feather: 9 } }];
  seed([done, item("b", "queued"), item("c", "queued")], {
    settings,
    past,
    future,
    excludedIds: ["a"],
  });
  const run = runQueue(runtime.job, get, set);
  await drained();
  assert.equal(get().items[1]!.status, "working");
  assert.equal(removalCalls.length, 1);
  assert.equal(get().activeId, "a", "queue holds selection on the finished item");

  get().cancelProcessing();

  const [a, b, c] = get().items;
  assert.equal(a, done, "finished item object untouched");
  assert.equal(a!.resultUrl, "blob:result-a");
  for (const stopped of [b, c]) {
    assert.equal(stopped!.status, "error");
    assert.equal(stopped!.cancelled, true);
    assert.equal(stopped!.retryable, true);
    assert.equal(stopped!.error, "Stopped.");
  }
  assert.equal(removalCalls[0]!.options.signal!.aborted, true, "owned removal wait aborted");
  assert.equal(runtime.runAbort!.signal.aborted, false, "shared run signal is not the queue's");
  assert.equal(get().settings, settings);
  assert.equal(get().past, past);
  assert.equal(get().future, future);
  assert.deepEqual(get().excludedIds, ["a"]);

  const itemsAfterStop = get().items;
  get().cancelProcessing();
  assert.equal(get().items, itemsAfterStop, "second stop is a no-op");

  await run;
  assert.equal(removalCalls.length, 1, "the next queued item was never claimed");
  assert.equal(get().items[1]!.status, "error", "aborted item was not requeued");
  assert.equal(get().phase, "result");
  assert.equal(get().errorMessage, null, "a deliberate stop is not reported as a failure");
  assert.equal(get().activeId, "a");
});

test("a late success or progress on a stopped item is dropped", async () => {
  seed([item("a", "queued"), item("b", "queued")]);
  const run = runQueue(runtime.job, get, set);
  await drained();
  const call = removalCalls[0]!;
  call.rejectOnAbort = false;
  const progressBefore = get().progress;
  const sourceUrl = get().items[0]!.sourceUrl;

  get().cancelProcessing();
  call.options.onProgress?.({ stage: "loading", progress: 0.5, message: "late" });
  call.resolve(removalResult());
  await run;

  const stopped = get().items[0]!;
  assert.equal(stopped.status, "error");
  assert.equal(stopped.cancelled, true);
  assert.equal(stopped.resultBlob, null);
  assert.equal(stopped.resultUrl, null, "no object URL was created for a dropped result");
  assert.equal(stopped.sourceUrl, sourceUrl, "source bytes and URL preserved");
  assert.equal(revoked.includes(sourceUrl), false);
  assert.equal(get().progress, progressBefore, "late progress was ignored");
  assert.equal(removalCalls.length, 1, "second queued item never started");
});

test("retrying a stopped item runs it once, serialized, without reviving siblings", async () => {
  seed([item("a", "queued"), item("b", "queued"), item("c", "queued")]);
  const run = runQueue(runtime.job, get, set);
  await drained();
  get().cancelProcessing();
  get().retryItem("b");
  await drained();
  assert.equal(
    removalCalls.length,
    2,
    "the retried item was claimed again by the same serial queue",
  );
  assert.equal(maxActiveRemovals, 1, "retry never overlapped the aborted computation");
  assert.equal(get().items[1]!.status, "working");
  assert.equal(get().items[1]!.cancelled, undefined, "stop mark cleared on retry");
  removalCalls[1]!.resolve(removalResult());
  await run;
  assert.equal(get().items[1]!.status, "done");
  assert.ok(get().items[1]!.resultBlob);
  assert.ok(get().items[1]!.resultUrl);
  for (const sibling of [get().items[0]!, get().items[2]!]) {
    assert.equal(sibling.status, "error");
    assert.equal(sibling.cancelled, true, "sibling stays stopped");
  }

  get().reprocessItem("c");
  await drained();
  assert.equal(removalCalls.length, 3);
  removalCalls[2]!.resolve(removalResult());
  await drained();
  assert.equal(get().items[2]!.status, "done");
  assert.equal(get().items[2]!.cancelled, undefined);
  assert.equal(get().items[0]!.cancelled, true, "the untouched sibling is still stopped");
});

test("retrying the same stopped item cannot revive its aborted run's late result or progress", async () => {
  seed([item("a", "queued"), item("b", "queued")]);
  const run = runQueue(runtime.job, get, set);
  await drained();
  const old = removalCalls[0]!;
  old.rejectOnAbort = false;
  get().cancelProcessing();
  get().retryItem("a");
  const progress = get().progress;
  old.options.onProgress?.({ stage: "loading", progress: 0.75, message: "stale after retry" });
  const ignoredProgress = get().progress === progress;
  old.resolve(removalResult());
  await drained();
  const calls = removalCalls.length;
  const healthy = removalResult();
  if (removalCalls[1]) removalCalls[1].resolve(healthy);
  await run;
  assert.equal(ignoredProgress, true, "clearing the stopped flag cannot restore the old wait");
  assert.equal(calls, 2, "the old result must not replace the requested retry");
  assert.equal(get().items[0]!.resultBlob, healthy.blob);
  assert.equal(get().items[1]!.cancelled, true);
  assert.equal(maxActiveRemovals, 1);
});

test("stop is a no-op when nothing is pending", () => {
  const items = [
    item("a", "done", { resultBlob: new Blob(["r"]), resultUrl: "blob:result-a" }),
    item("b", "error", { error: "We couldn’t process this image on this device." }),
  ];
  seed(items, { phase: "result", activeId: "a" });
  const before = get().items;
  get().cancelProcessing();
  assert.equal(get().items, before, "state was not even written");
  assert.equal(get().phase, "result");
  assert.equal(get().items[1]!.cancelled, undefined, "a real failure keeps its own state");
});

test("an old job unwinding cannot mutate a newer upload", async () => {
  seed([item("a", "queued")]);
  const staleToken = runtime.job;
  const run = runQueue(staleToken, get, set);
  await drained();
  const call = removalCalls[0]!;

  // A new upload replaces the workspace: fresh job, fresh items, fresh run signal.
  runtime.job += 1;
  runtime.queueToken = null;
  runtime.runAbort = new AbortController();
  set({ items: [item("n", "queued")], activeId: "n", phase: "processing" });
  const next = runQueue(runtime.job, get, set);

  call.resolve(removalResult());
  await run;
  await drained();
  assert.deepEqual(
    get().items.map((entry) => entry.id),
    ["n"],
    "the old item never reappeared",
  );
  assert.equal(get().items[0]!.resultBlob, null, "late old-job result was not committed");
  assert.equal(removalCalls.length, 2, "the newer job claims its own item");
  removalCalls[1]!.resolve(removalResult());
  await next;
  assert.equal(get().items[0]!.status, "done");
});

test("stop leaves a concurrent enhancement and the shared run signal alone", async () => {
  const done = item("e", "done", {
    resultBlob: new Blob(["r"], { type: "image/png" }),
    resultUrl: "blob:result-e",
    width: 2,
    height: 2,
  });
  seed([done, item("b", "queued")], { activeId: "e" });
  const run = runQueue(runtime.job, get, set);
  const enhancing = get().enhanceActive();
  await drained();
  assert.equal(get().enhancing, "e");
  assert.ok(enhancePending, "enhancement reached its model call");
  const enhanceWait = runtime.itemAborts.get("e")!;
  assert.equal(get().items[1]!.status, "working");

  get().cancelProcessing();
  assert.equal(enhanceWait.signal.aborted, false, "the enhancement's wait is not the queue's");
  assert.equal(get().items[1]!.cancelled, true);
  assert.equal(get().items[0]!.status, "done");

  enhancePending!.resolve({
    file: new File(["up"], "e.png", { type: "image/png" }),
    width: 8,
    height: 8,
    scale: 2,
    model: "swin2sr-x2",
    device: "wasm",
  });
  await enhancing;
  assert.equal(get().enhancing, null, "the completed enhancement was not stranded");
  assert.equal(get().items[0]!.enhanced?.scale, 2);

  await drained();
  assert.equal(removalCalls.length, 2, "enhanced source requeued through removal");
  removalCalls[1]!.resolve(removalResult());
  await run;
  await drained();
  assert.equal(get().items[0]!.status, "done");
  assert.ok(get().items[0]!.resultBlob);
});

test("a stopped item still receives its source preview", async () => {
  seed([{ ...item("b", "error"), cancelled: true, error: "Stopped.", retryable: true }], {
    activeId: "b",
    phase: "error",
  });
  globals.__cutoutPreviewResult = { bitmap: null, url: "blob:preview-b", width: 7, height: 9 };
  await hydratePreview(runtime.job, "b", get().items[0]!.source, get, set);
  const b = get().items[0]!;
  assert.equal(b.sourceUrl, "blob:preview-b");
  assert.equal(b.width, 7);
  assert.equal(b.height, 9);
  assert.equal(b.cancelled, true, "hydration does not clear the stop mark");
  assert.ok(revoked.includes("blob:source-b"), "the replaced source URL was released");
});
