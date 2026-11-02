// S6 (design r9 Q5 N4, Q7, Q12, C3): the removal client and worker, driven with a stub
// `Worker` under Node. No browser, no model, no network: every page-path fallthrough is
// stopped by a sentinel `onProgress` (the engine reports before it touches the file), and
// the worker tests stub `fetch` and the decoder.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, test, type TestContext } from "node:test";
import { removalRuntime } from "./removal-runtime.ts";
import {
  ENGINE_ERROR_NAMES,
  clearRemovalFailureRecords,
  readGpuFailure,
  rememberGpuFailure,
} from "./removal-provider.ts";

type Client = typeof import("./removal-client.ts");
type Sent = Record<string, unknown> & { type: string; id: number };

const SENTINEL = new Error("page engine reached");
const stopAtPageEngine = () => {
  throw SENTINEL;
};

class StubWorker {
  static all: StubWorker[] = [];
  static cloneFailure = false;
  posts: Sent[] = [];
  terminated = 0;
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(_url: unknown, _options: unknown) {
    StubWorker.all.push(this);
  }
  postMessage(message: Sent) {
    if (StubWorker.cloneFailure && message.type !== "abort") throw new DOMException("cannot clone payload", "DataCloneError");
    this.posts.push(message);
  }
  terminate() {
    this.terminated++;
  }
  addEventListener(type: string, listener: (event: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  reply(data: Record<string, unknown>) {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
  fail() {
    for (const listener of this.listeners.get("error") ?? []) listener({});
  }
  runs() {
    return this.posts.filter((message) => message.type === "run");
  }
}

const GLOBALS = [
  "Worker",
  "OffscreenCanvas",
  "createImageBitmap",
  "document",
  "addEventListener",
  "navigator",
  "self",
  "postMessage",
  "fetch",
] as const;
const saved = new Map<string, PropertyDescriptor | undefined>();
function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let instance = 0;
async function freshClient(): Promise<Client> {
  return (await import(`./removal-client.ts?case=${instance++}`)) as Client;
}
const blob = () => new Blob(["x"]);

beforeEach((hookContext) => {
  const t = hookContext as TestContext;
  for (const name of GLOBALS) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  StubWorker.all = [];
  StubWorker.cloneFailure = false;
  define("Worker", StubWorker);
  define("OffscreenCanvas", class {});
  define("createImageBitmap", async () => ({ close() {} }));
  define("document", { hidden: false, visibilityState: "visible", addEventListener() {} });
  define("addEventListener", () => {});
  // The page has a WebGPU adapter that can run the fp16 route: a WASM-only worker is "slow".
  define("navigator", {
    userAgent: "removal-client-test",
    gpu: { requestAdapter: async () => ({ features: new Set(["shader-f16"]) }) },
  });
  // The idle release is a 60 s timer; never let it hold the test process open.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "warn", () => {});
  clearRemovalFailureRecords(null);
});
afterEach(() => {
  clearRemovalFailureRecords(null);
  for (const name of GLOBALS) {
    const original = saved.get(name);
    if (original) Object.defineProperty(globalThis, name, original);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const run = (client: Client, extra: { signal?: AbortSignal } = {}) =>
  client.removeBackgroundAuto(blob(), { onProgress: stopAtPageEngine, ...extra });
const latest = () => StubWorker.all.at(-1)!;
const lastRunId = () => latest().runs().at(-1)!.id;
const wasmNoGpu = { provider: "wasm", workerHadGpu: false, blob: blob(), width: 1, height: 1 };

// ---------------------------------------------------------------------------------------
// Q5 (N4): drain, then retire
// ---------------------------------------------------------------------------------------

for (const features of [["shader-f16"], []]) {
test(`Q5: a worker found slow drains before retirement (page features: ${features})`, async () => {
  define("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(features) }) } });
  const client = await freshClient();
  const abortA = new AbortController();
  const jobA = run(client, { signal: abortA.signal });
  const worker = latest();
  const idA = lastRunId();
  abortA.abort();
  await assert.rejects(jobA, { name: "AbortError" });

  const job1 = run(client);
  worker.reply({ type: "done", id: lastRunId(), result: wasmNoGpu });
  await job1;
  assert.equal(worker.terminated, 0, "A is still running in the worker: no terminate yet");

  // Not yet slow: a new job queues behind A on the same worker.
  const job2 = run(client);
  assert.equal(StubWorker.all.length, 1, "no replacement worker");
  assert.equal(worker.runs().length, 3);
  const id2 = lastRunId();

  worker.reply({ type: "done", id: idA, result: { provider: "wasm", workerHadGpu: true } });
  assert.equal(worker.terminated, 0, "job 2 is still pending");
  worker.reply({ type: "done", id: id2, result: { provider: "webgpu", workerHadGpu: true } });
  assert.equal(worker.terminated, 1, "terminate is synchronous once the worker is idle");
  await job2;

  const postsBefore = worker.posts.length;
  await assert.rejects(run(client), SENTINEL, "job 3 runs on the page");
  assert.equal(worker.posts.length, postsBefore, "job 3 posts nothing to the worker");
  assert.equal(StubWorker.all.length, 1);
  assert.equal(worker.terminated, 1);
});

test("Q5: an idle worker found slow is retired at once (unchanged)", async () => {
  define("navigator", { gpu: { requestAdapter: async () => ({ features: new Set(features) }) } });
  const client = await freshClient();
  const job1 = run(client);
  const worker = latest();
  worker.reply({ type: "done", id: lastRunId(), result: wasmNoGpu });
  await job1;
  assert.equal(worker.terminated, 1);
  await assert.rejects(run(client), SENTINEL);
  assert.equal(StubWorker.all.length, 1);
});
}

test("no-f16 GPU compatibility fallback retains the capable worker", async () => {
  define("navigator", { userAgent: "removal-client-test", gpu: { requestAdapter: async () => ({ features: new Set() }) } });
  const client = await freshClient();
  const job1 = run(client);
  const worker = latest();
  worker.reply({ type: "done", id: lastRunId(), result: { ...wasmNoGpu, workerHadGpu: true } });
  await job1;
  assert.equal(worker.terminated, 0, "the page shares the worker's GPU; keep its fallback");
  void run(client).catch(() => {});
  assert.equal(StubWorker.all.length, 1);
  assert.equal(worker.runs().length, 2, "the same worker takes the next job");
});

for (const gpu of [undefined, { requestAdapter: async () => null }, { requestAdapter: async () => { throw new Error("adapter unavailable"); } }]) {
test("a successful WASM-only worker stays when the page has no compatible adapter", async () => {
  define("navigator", { gpu });
  const client = await freshClient();
  const first = run(client), worker = latest();
  worker.reply({ type: "done", id: lastRunId(), result: wasmNoGpu });
  await first;
  assert.equal(worker.terminated, 0);
  const second = run(client);
  worker.reply({ type: "done", id: lastRunId(), result: wasmNoGpu });
  await second;
  assert.equal(StubWorker.all.length, 1);
  assert.equal(worker.runs().length, 2);
});
}

// ---------------------------------------------------------------------------------------
// Q7: GPU state crosses the page/worker boundary through the owned provider
// ---------------------------------------------------------------------------------------

test("Q7: the request carries noWebgpu from the page's persisted or in-process failure", async () => {
  const client = await freshClient();
  void run(client).catch(() => {});
  assert.equal(latest().runs().at(-1)!.noWebgpu, false);

  rememberGpuFailure("gpu-mask", null);
  void run(client).catch(() => {});
  assert.equal(latest().runs().at(-1)!.noWebgpu, true);
});

test("Q7: a worker result with webgpuBroken records the failure on the page through the owned provider", async () => {
  const client = await freshClient();
  const job = run(client);
  latest().reply({
    type: "done",
    id: lastRunId(),
    result: { provider: "wasm", workerHadGpu: true, webgpuBroken: true, blob: blob() },
  });
  await job;
  assert.equal(readGpuFailure(null), true);
  void run(client).catch(() => {});
  assert.equal(latest().runs().at(-1)!.noWebgpu, true);
});

// ---------------------------------------------------------------------------------------
// Q12: engine-origin errors are rethrown by name; the worker is kept
// ---------------------------------------------------------------------------------------

test("Q12: ENGINE_ERROR_NAMES is the five engine-minted names", () => {
  assert.deepEqual(
    [...ENGINE_ERROR_NAMES].sort(),
    ["MaskError", "RemovalInferenceError", "RemovalInputError", "RemovalModelLoadError", "RemovalModelOutputError"],
  );
});

for (const name of ENGINE_ERROR_NAMES) {
  test(`Q12: a code-less ${name} from the worker is rethrown: no page rerun, worker kept`, async () => {
    const client = await freshClient();
    const job = run(client);
    const worker = latest();
    worker.reply({ type: "error", id: lastRunId(), aborted: false, name, message: "engine said no", detail: "d" });
    await assert.rejects(job, (error: Error) => {
      assert.equal(error.name, name);
      assert.notEqual(error, SENTINEL);
      return true;
    });
    assert.equal(worker.terminated, 0);
    void run(client).catch(() => {});
    assert.equal(StubWorker.all.length, 1);
    assert.equal(worker.runs().length, 2, "the same worker takes the next job");
  });
}

test("Q12: a worker-infrastructure failure still retires the worker and reruns on the page", async () => {
  const client = await freshClient();
  const job = run(client);
  const worker = latest();
  worker.reply({
    type: "error",
    id: lastRunId(),
    aborted: false,
    name: "Error",
    message: "OffscreenCanvas 2D context unavailable",
    detail: "d",
  });
  await assert.rejects(job, SENTINEL);
  assert.equal(worker.terminated, 1);
});

test("Q12: a worker DOMException decode failure (numeric legacy code 11) the page can decode retires the worker and reruns on the page", async () => {
  const client = await freshClient();
  const job = run(client);
  const worker = latest();
  worker.reply({
    type: "error",
    id: lastRunId(),
    aborted: false,
    name: "InvalidStateError",
    message: "decode failed",
    detail: "d",
    code: 11,
  });
  await assert.rejects(job, SENTINEL);
  assert.equal(worker.terminated, 1);
});

test("C07: a worker decode failure the page cannot decode either is the file's: rethrown, worker kept, no page rerun", async () => {
  const undecodable = new DOMException("The source image could not be decoded.", "InvalidStateError");
  define("createImageBitmap", async () => {
    throw undecodable;
  });
  const client = await freshClient();
  for (const [label, job] of [
    ["run", () => run(client)],
    ["refine", () => client.refineCropsAuto(blob(), blob(), [{ x: 0, y: 0, width: 1, height: 1 }], { onProgress: stopAtPageEngine })],
  ] as const) {
    const pending = job();
    const worker = latest();
    worker.reply({ type: "error", id: worker.posts.at(-1)!.id, aborted: false, name: "InvalidStateError", message: undecodable.message, detail: "d", code: 11 });
    await assert.rejects(pending, (error: Error) => {
      assert.notEqual(error, SENTINEL, `${label}: no page rerun`);
      assert.equal(error.name, "InvalidStateError", label);
      return true;
    });
    assert.equal(worker.terminated, 0, `${label}: the worker is kept`);
  }
  void run(client).catch(() => {});
  assert.equal(StubWorker.all.length, 1, "no replacement worker");
  assert.equal(latest().runs().length, 2, "the same worker takes the next job");
});

test("warmupRemoval deadline rejects with TimeoutError and aborts the worker job", async (t) => {
  const client = await freshClient();
  const warm = client.warmupRemoval(undefined, { timeoutMs: 20 });
  const worker = latest();
  t.mock.timers.tick(20);
  await assert.rejects(warm, (error: unknown) => error instanceof DOMException && error.name === "TimeoutError");
  assert.ok(worker.posts.some((message) => message.type === "abort"));
});

test("C09: warmupRemoval hands the worker's download progress back as a fraction", async () => {
  const client = await freshClient();
  const seen: number[] = [];
  const warm = client.warmupRemoval((fraction) => seen.push(fraction));
  const worker = latest();
  const id = worker.posts.at(-1)!.id;
  worker.reply({ type: "progress", id, progress: { stage: "loading", progress: 0.5, message: "" } });
  worker.reply({ type: "done", id, result: null });
  await warm;
  assert.deepEqual(seen, [0.5]);
});

test("C09: a worker warmup's load failure rejects with it: no page warmup, worker kept", async () => {
  const client = await freshClient();
  const warm = client.warmupRemoval();
  const worker = latest();
  worker.reply({
    type: "error",
    id: worker.posts.at(-1)!.id,
    aborted: false,
    name: "RemovalModelLoadError",
    message: "Could not load birefnet on wasm: Failed to fetch",
    detail: "d",
    code: "model-load-failed",
  });
  await assert.rejects(warm, { name: "RemovalModelLoadError", message: "Could not load birefnet on wasm: Failed to fetch" });
  assert.equal(worker.terminated, 0);
});

// ---------------------------------------------------------------------------------------
// C3: provenance is stripped from the reply and kept for lastRemovalProvenance()
// ---------------------------------------------------------------------------------------

const provenance = { renderPolicy: "cutout-original-matte-v1" } as never;
// A fresh record per use: the runtime compares identity to tell a new record from an old one.
const newFault = () => ({ outcome: "error", absorbAttempted: true }) as never;

test("C3: a worker result's provenance is stripped from the result and exposed", async () => {
  const client = await freshClient();
  assert.equal(client.lastRemovalProvenance(), undefined);
  const job = run(client);
  latest().reply({
    type: "done",
    id: lastRunId(),
    result: { provider: "webgpu", workerHadGpu: true, blob: blob(), provenance },
  });
  const result = (await job) as Record<string, unknown>;
  assert.equal("provenance" in result, false);
  assert.equal("workerHadGpu" in result, false);
  assert.deepEqual(client.lastRemovalProvenance(), provenance);

  const next = run(client);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu", workerHadGpu: true } });
  await next;
  assert.equal(client.lastRemovalProvenance(), undefined, "a job without a record does not keep the last one");
});

test("C3: a worker error's fault provenance is stripped and exposed, the error unchanged", async () => {
  const faultRecord = newFault();
  const client = await freshClient();
  const job = run(client);
  latest().reply({
    type: "error",
    id: lastRunId(),
    aborted: false,
    name: "MaskError",
    message: "invalid alpha",
    detail: "d",
    provenance: faultRecord,
  });
  await assert.rejects(job, (error: Error & { provenance?: unknown }) => {
    assert.equal(error.name, "MaskError");
    assert.equal("provenance" in error, false);
    return true;
  });
  assert.deepEqual(client.lastRemovalProvenance(), faultRecord);
});

test("C3: a page job does not claim runtime records written outside its engine invocation", async () => {
  define("Worker", undefined); // worker unsupported: the page engine runs
  const pageFault = newFault();
  const client = await freshClient();
  await assert.rejects(
    client.removeBackgroundAuto(blob(), {
      onProgress: () => {
        removalRuntime.recordProvenance(pageFault); // as the engine does while it runs
        throw SENTINEL;
      },
    }),
    SENTINEL,
  );
  assert.equal(client.lastRemovalProvenance(), undefined, "a shared runtime write is not an invocation handoff");
  await assert.rejects(run(client), SENTINEL);
  assert.equal(client.lastRemovalProvenance(), undefined, "an older runtime record is not this job's");
});

// ---------------------------------------------------------------------------------------
// Worker side (removal-worker.ts), with the engine unreachable: no fetch, no decode
// ---------------------------------------------------------------------------------------

let fetchCalls = 0;
type WorkerHarness = { send(data: Record<string, unknown>): void; done(id?: number): Promise<Record<string, unknown>> };

async function loadWorker(onPosted: (message: Record<string, unknown>) => void = () => {}): Promise<WorkerHarness> {
  const posted: Array<Record<string, unknown>> = [];
  let handler: ((event: { data: unknown }) => void) | undefined;
  define("self", globalThis);
  define("addEventListener", (type: string, listener: (event: { data: unknown }) => void) => {
    if (type === "message") handler = listener;
  });
  define("postMessage", (message: Record<string, unknown>) => {
    onPosted(message);
    posted.push(message);
  });
  fetchCalls = 0;
  define("fetch", async () => {
    fetchCalls++;
    throw new Error("network is off in unit tests");
  });
  define("createImageBitmap", async () => {
    throw new Error("decoder is off in unit tests");
  });
  await import(`./removal-worker.ts?case=${instance++}`);
  return {
    send: (data) => handler!({ data }),
    async done(id?: number) {
      for (let i = 0; i < 400; i++) {
        const end = posted.find((m) => (m.type === "done" || m.type === "error") && (id === undefined || m.id === id));
        if (end) return end;
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error("worker never replied");
    },
  };
}

// The engine reports its first progress before it fetches or decodes, so a worker whose
// `postMessage` throws on "progress" stops there: the job never reaches the model-load path
// (which writes a fault record of its own and would replace the injected one).
const stopAtFirstProgress = (message: Record<string, unknown>) => {
  if (message.type === "progress") throw SENTINEL;
};

test("Q7 (worker): noWebgpu sets the in-process flag through the owned provider", async () => {
  const worker = await loadWorker(stopAtFirstProgress);
  worker.send({ type: "run", id: 1, file: blob(), mode: "auto", noWebgpu: true });
  await worker.done();
  assert.equal(readGpuFailure(null), true);
  assert.equal(fetchCalls, 0, "no model request in a unit test");
});

test("C3 (worker): provenance recorded during the job rides the reply; an older record does not", async () => {
  let record = false;
  const workerFault = newFault();
  const worker = await loadWorker((message) => {
    if (record && message.type === "progress") removalRuntime.recordProvenance(workerFault);
    stopAtFirstProgress(message);
  });
  record = true;
  worker.send({ type: "run", id: 1, file: blob(), mode: "auto" });
  const reply = await worker.done();
  assert.equal(reply.type, "error");
  assert.equal(reply.provenance, workerFault);

  record = false;
  const stale = await loadWorker(stopAtFirstProgress);
  stale.send({ type: "run", id: 2, file: blob(), mode: "auto" });
  assert.equal((await stale.done()).provenance, undefined, "the earlier record is not this job's");
  assert.equal(fetchCalls, 0, "no model request in a unit test");
});


test("S3-A-ENGINE-01: a lost worker context is replaced and the job redriven once, session-only", async () => {
  const client = await freshClient();
  const job = run(client);
  const first = latest();
  first.reply({ type: "error", id: lastRunId(), name: "RemovalContextLostError", code: "removal-context-lost", failureKind: "gpu-device", message: "Reload", detail: "device lost", aborted: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(first.terminated, 1);
  assert.equal(StubWorker.all.length, 2);
  assert.equal(latest().runs()[0]!.noWebgpu, true);
  assert.equal(readGpuFailure(null), false, "the device loss is not persisted or recorded on the page");
  latest().reply({ type: "done", id: lastRunId(), result: { ...wasmNoGpu, workerHadGpu: true } });
  assert.equal((await job).provider, "wasm");

  const again = run(client);
  const rejected = assert.rejects(again, { code: "removal-context-lost" });
  latest().reply({ type: "error", id: lastRunId(), name: "RemovalContextLostError", code: "removal-context-lost", message: "Reload", detail: "lost", aborted: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  latest().reply({ type: "error", id: lastRunId(), name: "RemovalContextLostError", code: "removal-context-lost", message: "Reload", detail: "lost", aborted: false });
  await rejected;
  assert.equal(StubWorker.all.length, 3, "one retry per job");
  assert.equal(latest().terminated, 1, "even the failed retry context is retired");
});


test("C06: inactivity replaces a stalled worker and retries once; progress resets the clock", async (t) => {
  const client = await freshClient();
  const job = client.removeBackgroundAuto(blob());
  const first = latest();
  t.mock.timers.tick(119_000);
  first.reply({ type: "progress", id: lastRunId(), progress: { stage: "loading", progress: 0.5, message: "" } });
  t.mock.timers.tick(119_000);
  assert.equal(first.terminated, 0, "silence, not total duration");
  t.mock.timers.tick(1_000);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(first.terminated, 1);
  assert.equal(StubWorker.all.length, 2);
  const rejected = assert.rejects(job, { code: "removal-worker-stalled" });
  t.mock.timers.tick(120_000);
  await rejected;
  assert.equal(latest().terminated, 1);
  assert.equal(StubWorker.all.length, 2, "no third attempt");
  const next = run(client);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  await next;
  assert.equal(StubWorker.all.length, 3, "next job can still spawn");
});

test("C06: a cancelled but still running job cannot pin a stalled worker forever", async (t) => {
  const client = await freshClient();
  const controller = new AbortController();
  const job = assert.rejects(run(client, { signal: controller.signal }), { name: "AbortError" });
  const stalled = latest();
  controller.abort(); await job;
  t.mock.timers.tick(120_000);
  assert.equal(stalled.terminated, 1);
  const next = run(client);
  assert.equal(StubWorker.all.length, 2);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  await next;
});

test("S3-B-EVIDENCE-01: a damaged-model worker is retired and retried fresh without disabling WebGPU", async () => {
  const client = await freshClient();
  const job = run(client);
  const old = latest();
  old.reply({ type: "error", id: lastRunId(), name: "RemovalModelCacheError", code: "removal-model-damaged", message: "Model file damaged, removed; try again.", detail: "protobuf parsing failed", aborted: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(old.terminated, 1);
  assert.equal(StubWorker.all.length, 2);
  assert.equal(latest().runs()[0]!.noWebgpu, false);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  await job;
});

test("context retirement also handles a fatal reply after its caller has cancelled", async () => {
  for (const code of ["removal-context-lost", "removal-model-damaged"]) {
    const client = await freshClient();
    const controller = new AbortController();
    const job = assert.rejects(run(client, { signal: controller.signal }), { name: "AbortError" });
    const old = latest();
    const id = lastRunId();
    controller.abort(); await job;
    old.reply({ type: "error", id, code, name: "Error", message: "fresh context required", detail: "fault", aborted: false });
    assert.equal(old.terminated, 1);
    const next = run(client);
    assert.notEqual(latest(), old);
    latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
    await next;
  }
});


for (const cancelled of [false, true]) test(`RR1 C06: queued ${cancelled ? "cancelled" : "live"} B cannot expire progressing A`, async (t) => {
  const client = await freshClient();
  const a = client.removeBackgroundAuto(blob());
  void a.catch(() => {});
  const worker = latest();
  const idA = lastRunId();
  const controller = new AbortController();
  const b = client.removeBackgroundAuto(blob(), { signal: controller.signal });
  void b.catch(() => {});
  const idB = lastRunId();
  if (cancelled) { controller.abort(); await assert.rejects(b, { name: "AbortError" }); }
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(40_000);
    worker.reply({ type: "progress", id: idA, progress: { stage: "loading", progress: i / 5, message: "" } });
    await Promise.resolve();
    assert.equal(worker.terminated, 0, "queue residence is not worker inactivity");
  }
  worker.reply({ type: "done", id: idA, result: { provider: "webgpu" } });
  await a;
  // B gets a full inactivity interval after A drains, even when its abort is queued.
  t.mock.timers.tick(119_000);
  assert.equal(worker.terminated, 0);
  worker.reply({ type: "done", id: idB, result: { provider: "webgpu" } });
  if (!cancelled) await b;
  assert.equal(StubWorker.all.length, 1);
});


test("C27: success, error and worker death detach each caller's abort listener", async () => {
  for (const end of ["done", "error", "death"] as const) {
    const client = await freshClient();
    const controller = new AbortController();
    const job = run(client, { signal: controller.signal });
    const outcome = end === "done" ? job : assert.rejects(job);
    const w = latest();
    if (end === "death") {
      // The first crash redrives the job in a fresh worker (E03-01); the second takes the page.
      w.fail();
      for (let i = 0; i < 10; i++) await Promise.resolve();
      latest().fail();
    } else w.reply({ type: end, id: lastRunId(), result: { provider: "webgpu" }, name: "MaskError", message: "invalid alpha", detail: "d", aborted: false });
    await outcome;
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, end);
    const posts = w.posts.length;
    controller.abort();
    assert.equal(w.posts.length, posts, "no stale abort post after settlement");
  }
});


test("C30 TESTS-5: a clone failure drains bookkeeping and retires infrastructure once", async (t) => {
  const client = await freshClient();
  StubWorker.cloneFailure = true;
  await assert.rejects(run(client), SENTINEL); // uncoded infrastructure errors take the page
  assert.equal(latest().terminated, 1);
  // A directly coded clone error is an infrastructure failure, so the worker was deliberately retired.
  // No pending/inFlight entry may keep its inactivity/idle timers alive.
  t.mock.timers.tick(120_000);
  assert.equal(latest().terminated, 1);
});

test("C30 TESTS-7: refine message, progress and result cross the client boundary", async () => {
  const client = await freshClient();
  const source = blob(), base = blob(), boxes = [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }];
  const seen: number[] = [];
  const refined = client.refineCropsAuto(source, base, boxes, { onProgress: (p) => seen.push(p.progress) });
  const w = latest(), request = w.posts.at(-1)!;
  assert.deepEqual([request.type, request.source, request.base, request.boxes], ["refine", source, base, boxes]);
  w.reply({ type: "progress", id: request.id, progress: { stage: "finishing", progress: 0.98, message: "" } });
  w.reply({ type: "done", id: request.id, result: { blob: base, provenance } });
  assert.equal(await refined, base);
  assert.deepEqual(seen, [0.98]);
  assert.equal(client.lastRemovalProvenance(), provenance);
});

for (const hidden of [false, true]) test(`C30 TESTS-7: ${hidden ? "hidden" : "visible"} idle release waits for drain and respawns`, async (t) => {
  let visibility!: () => void;
  const doc = { hidden: false, addEventListener(type: string, fn: () => void) { if (type === "visibilitychange") visibility = fn; } };
  define("document", doc);
  const client = await freshClient();
  const job = run(client), w = latest();
  doc.hidden = hidden; visibility();
  t.mock.timers.tick(60_000);
  assert.equal(w.terminated, 0, "active work pins its worker");
  w.reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } }); await job;
  const delay = hidden ? 5_000 : 60_000;
  t.mock.timers.tick(delay - 1); assert.equal(w.terminated, 0);
  t.mock.timers.tick(1); assert.equal(w.terminated, 1);
  const next = run(client);
  assert.equal(StubWorker.all.length, 2);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } }); await next;
});

test("C30 TESTS-5: worker queue catches an uncloneable error reply and services the next request", async () => {
  let throwErrorReply = true;
  const worker = await loadWorker((message) => {
    if (message.type === "progress") throw SENTINEL;
    if (message.type === "error" && throwErrorReply) { throwErrorReply = false; throw new DOMException("reply cannot clone", "DataCloneError"); }
  });
  worker.send({ type: "run", id: 61, file: blob(), mode: "auto" });
  const fallback = await worker.done();
  assert.equal(fallback.id, 61);
  assert.equal(fallback.message, "reply cannot clone");
  worker.send({ type: "run", id: 62, file: blob(), mode: "auto" });
  const second = await worker.done(62);
  assert.equal(second.id, 62);
  assert.equal(second.message, SENTINEL.message);
  assert.equal(fetchCalls, 0);
});


test("C30 TESTS-5: a slow worker dying before drain retains the page-routing decision", async () => {
  const client = await freshClient();
  const controller = new AbortController();
  const a = run(client, { signal: controller.signal });
  const w = latest(); controller.abort(); await assert.rejects(a);
  const b = run(client);
  w.reply({ type: "done", id: lastRunId(), result: wasmNoGpu }); await b;
  assert.equal(w.terminated, 0, "cancelled A still pins drain");
  w.fail(); assert.equal(w.terminated, 1);
  await assert.rejects(run(client), SENTINEL);
  assert.equal(StubWorker.all.length, 1, "the slow decision survives worker death");
});

test("C30 TESTS-7: idle pagehide releases the worker and a later call respawns", async () => {
  let hide!: () => void;
  define("addEventListener", (type: string, listener: () => void) => { if (type === "pagehide") hide = listener; });
  const client = await freshClient();
  const a = run(client), w = latest();
  w.reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } }); await a;
  hide(); assert.equal(w.terminated, 1);
  const b = run(client); assert.equal(StubWorker.all.length, 2);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } }); await b;
});

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test("E03-01: the first worker crash is replaced and its job redriven there; the second moves the session to the page", async () => {
  const client = await freshClient();
  const job = run(client);
  const first = latest();
  first.fail();
  await flush();
  assert.equal(first.terminated, 1);
  assert.equal(StubWorker.all.length, 2, "a fresh worker, not the page");
  assert.equal(latest().runs().length, 1, "the crashed job is redriven in the fresh worker");
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  assert.equal((await job).provider, "webgpu");

  const second = run(client);
  latest().fail();
  await assert.rejects(second, SENTINEL, "the second crash runs the job on the page");
  await assert.rejects(run(client), SENTINEL, "and later jobs stay there");
  assert.equal(StubWorker.all.length, 2, "one respawn per session");
});

test("E03-01: a crash with nothing in flight uses the one respawn; the next job starts a fresh worker", async () => {
  const client = await freshClient();
  const job = run(client);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  await job;
  latest().fail();
  const next = run(client);
  assert.equal(StubWorker.all.length, 2);
  latest().reply({ type: "done", id: lastRunId(), result: { provider: "webgpu" } });
  await next;
  latest().fail();
  await assert.rejects(run(client), SENTINEL);
});

test("E05-03: a worker whose WebGPU would not start is replaced by a WASM-only worker and the job redriven once", async () => {
  const client = await freshClient();
  const job = run(client);
  const old = latest();
  const gpuInit = { type: "error", name: "RemovalWebgpuInitError", code: "removal-webgpu-init-failed", failureKind: "provider-init", message: "The local remover couldn’t use this device’s graphics. Try again.", detail: "no available backend found", aborted: false };
  old.reply({ ...gpuInit, id: lastRunId() });
  await flush();
  assert.equal(old.terminated, 1);
  assert.equal(StubWorker.all.length, 2);
  assert.equal(latest().runs()[0]!.noWebgpu, true, "the fresh worker skips WebGPU");
  latest().reply({ type: "done", id: lastRunId(), result: { ...wasmNoGpu, workerHadGpu: true } });
  assert.equal((await job).provider, "wasm");
  assert.equal(readGpuFailure(null), false, "session-only: nothing persisted on the page");
  void run(client).catch(() => {});
  assert.equal(latest().runs().at(-1)!.noWebgpu, true, "later jobs skip WebGPU too");

  // A redriven job that fails the same way is not redriven again: no loop.
  const fresh = await freshClient();
  const again = fresh.removeBackgroundAuto(blob(), { onProgress: stopAtPageEngine });
  const count = StubWorker.all.length;
  latest().reply({ ...gpuInit, id: lastRunId() });
  await flush();
  latest().reply({ ...gpuInit, id: lastRunId() });
  await assert.rejects(again, { code: "removal-webgpu-init-failed" });
  assert.equal(StubWorker.all.length, count + 1, "one retry per job");
});
