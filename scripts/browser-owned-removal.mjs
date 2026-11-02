// Run with a Vite dev server (never while a native measurement batch is active):
//   node --test --test-concurrency=1 scripts/browser-owned-removal.mjs
//
// The owned-removal suite (design v4 r9, section 7 and Q1-Q12, C4, section 6). The real owned engine,
// runtime, pool, adapter, client and worker run; only the Transformers.js boundary is faked
// (scripts/fake-transformers.mjs) and the page/worker environment is pinned, so every row is
// deterministic on any hardware. Nothing here downloads a model.
//
// ---- The fake contract this suite uses (scripts/fake-transformers.mjs, S7; read at integration) ------
// Builders: transformersFake({ page, worker }), workerPrelude({ deviceMemory, adapter, createImageBitmap }),
// eventLogInit(), readFakeLog(page), liveModels(sorted), runInterceptionSmoke(browser, appUrl).
// Per-context config is { mask?, load?, run? } (function sources the fake inlines):
//   mask(call, h)  the model output of one model() call: number | fn(u, v) | array | "missing"; a throw fails
//                  that run only. call: { n (model runs in this context), model, device, side, srcWidth,
//                  srcHeight, state, emit }. Default 20, which the engine reads as a FLAT mask, so every
//                  row here supplies a real mask (`maskHook` below always has a default subject).
//   load(call, h)  awaited at the start of every from_pretrained; throw to reject. call: { kind, model,
//                  device, dtype, attempt (per kind+model+device), progress(event), state, emit }.
//   run(call, h)   awaited inside every processor() and model() call; call.phase tells which.
// Events (sorted by t): from_pretrained { kind, model, device, dtype, attempt }, model-ready,
//   processor-ready, run { phase, model, device? }, dispose { target: "model"|"processor"|tensor roles,
//   repeat }, sigmoid, worker-created, terminate { url }, module-loaded, prelude, load-error.
// A run hook that returns a value in the processor phase replaces the processor result verbatim (the
// invalid-tensor worker row uses it).
// -----------------------------------------------------------------------------------------------------
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appCandidates } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import {
  TRANSFORMERS_ROUTE,
  WORKER_ROUTE,
  eventLogInit,
  liveModels,
  readFakeLog,
  runInterceptionSmoke,
  transformersFake,
  workerPrelude,
} from "./fake-transformers.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

const SWITCHING = "Switching to compatibility mode";
const NETWORK_503 = "Service unavailable error occurred while trying to load file";
const INIT_FAILURE = "WebGPU session creation failed";
const FETCH_FAILURE = "Failed to fetch";
const GPU_KEY = "cutout:removal-webgpu-failure:v1";

let browser;
/** Every request any row's context made, workers included (the G1 behavioural half reads it). */
const allRequests = [];

before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

// ---- page-side installers (serialised by Playwright; they capture nothing from this module) ---------

/** Pins the page environment before any app script: memory hint, WebGPU adapter, clock, storage. */
function installEnv({ memory, adapter, setItemThrows }) {
  if (memory === "missing") delete Navigator.prototype.deviceMemory;
  else Object.defineProperty(navigator, "deviceMemory", { configurable: true, get: () => memory });
  const fakeAdapter = {
    limits: { maxStorageBufferBindingSize: 1 << 30 },
    // The fp16 BiRefNet route needs shader-f16; "no-f16" is an adapter without it.
    features: new Set(adapter === "no-f16" ? [] : ["shader-f16"]),
    requestDevice: async () => ({ addEventListener() {}, lost: new Promise(() => {}), destroy() {} }),
  };
  Object.defineProperty(navigator, "gpu", {
    configurable: true,
    value:
      adapter === "absent"
        ? undefined
        : { requestAdapter: async () => (adapter === "fake" || adapter === "no-f16" ? fakeAdapter : null) },
  });
  // A mutable offset the fake can bump, so the compatibility clock row needs no real sleep.
  globalThis.__perfOffset = 0;
  const realNow = performance.now.bind(performance);
  performance.now = () => realNow() + globalThis.__perfOffset;
  // What the client posts to the worker (the noWebgpu row reads it).
  globalThis.__posted = [];
  globalThis.__workerOutcomes = [];
  const observed = new WeakSet();
  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (data, ...rest) {
    if (!observed.has(this)) {
      observed.add(this);
      this.addEventListener("message", ({ data }) => {
        if (data?.type === "done" && data.result?.provider)
          globalThis.__workerOutcomes.push({ provider: data.result.provider, workerHadGpu: data.result.workerHadGpu });
      });
    }
    globalThis.__posted.push({ type: data?.type, noWebgpu: data?.noWebgpu });
    return post.call(this, data, ...rest);
  };
  if (setItemThrows)
    Storage.prototype.setItem = function () {
      throw new TypeError("storage is broken");
    };
}

/** Test driver: fixtures, job runners and state snapshots. Installed as `globalThis.__t`. */
function installDriver() {
  const png = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  async function fixture(kind = "gradient", width = 120, height = 80) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#1357d5");
    gradient.addColorStop(0.5, "#f28b12");
    gradient.addColorStop(1, "#45b96b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    if (kind === "gradient") {
      context.fillStyle = "#7020b8";
      context.fillRect(40, 30, 12, 20);
    } else if (kind === "big") {
      context.fillStyle = "#7020b8";
      context.fillRect(width / 3, height / 3, width / 3, height / 3);
    }
    const blob = await png(canvas);
    canvas.width = canvas.height = 0;
    return blob;
  }
  async function pixels(blob) {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return context.getImageData(0, 0, canvas.width, canvas.height);
  }
  async function alphasAt(blob, points) {
    const image = await pixels(blob);
    return points.map(([x, y]) => image.data[(y * image.width + x) * 4 + 3]);
  }
  async function histogram(blob, targets, tolerance) {
    const image = await pixels(blob);
    const counts = targets.map(() => 0);
    for (let index = 3; index < image.data.length; index += 4)
      targets.forEach((target, slot) => {
        if (Math.abs(image.data[index] - target) <= tolerance) counts[slot] += 1;
      });
    return counts;
  }
  async function sha(blob) {
    const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  const describe = async (error, reason, classify) => ({
    name: error?.name,
    message: error?.message,
    code: error?.code,
    sameReason: error === reason,
    classified: classify
      ? (({ code, retryable }) => ({ code, retryable }))((await import("/src/lib/errors.ts")).classifyError(error))
      : undefined,
  });
  async function snapshot() {
    const runtime = await import("/src/lib/removal-runtime.ts");
    const provider = await import("/src/lib/removal-provider.ts");
    return {
      prov: typeof runtime.removalRuntime.provenance === "function" ? runtime.removalRuntime.provenance() : undefined,
      memo: provider.webgpuLoadMemo(),
      gpuFailure: provider.readGpuFailure(),
      keys: Object.keys(localStorage),
      record: localStorage.getItem("cutout:removal-webgpu-failure:v1"),
    };
  }
  const collect = (progress) => (p) => progress.push({ stage: p.stage, progress: p.progress, message: p.message });
  // A missing client provenance API is reported as data (so the row can assert on it), never as a TypeError here.
  const clientProvenance = (client) => ({
    clientProvApi: typeof client?.lastRemovalProvenance,
    clientProv: typeof client?.lastRemovalProvenance === "function" ? client.lastRemovalProvenance() : undefined,
  });

  globalThis.__t = {
    fixture,
    async consts() {
      const engine = await import("/src/lib/engine.ts");
      return { transfer: engine.COMPAT_TRANSFER, edges: engine.COMPAT_EDGES_PROGRESS };
    },
    async budget(provider, memory, pixelsCount) {
      return (await import("/src/lib/removal-budget.ts")).refinementBudget(provider, memory, 0, pixelsCount);
    },
    /** One page-engine job (removeBackgroundLocal). */
    async run(o = {}) {
      const engine = await import("/src/lib/engine.ts");
      const source = await fixture(o.fixture ?? "gradient", o.width, o.height);
      const controller = new AbortController();
      const reason = new DOMException("Superseded image", "AbortError");
      if (o.exposeAbort) globalThis.__abortJob = () => controller.abort(reason);
      const progress = [];
      const out = {};
      try {
        const done = await engine.removeBackgroundLocal(source, {
          mode: o.mode ?? "auto",
          signal: controller.signal,
          onProgress: collect(progress),
        });
        out.provider = done.provider;
        out.method = done.method;
        out.webgpuBroken = done.webgpuBroken;
        out.digest = await sha(done.blob);
        if (o.points) out.alphas = await alphasAt(done.blob, o.points);
        if (o.hist) out.hist = await histogram(done.blob, o.hist, o.tolerance ?? 3);
      } catch (error) {
        out.error = await describe(error, reason, o.classify);
      }
      return { ...out, progress, ...(await snapshot()) };
    },
    /** One manual-refine job (refineWithUserCrops), optionally through the client (page or worker). */
    async refine(o = {}) {
      const source = await fixture("gradient");
      const base = await fixture("base");
      const boxes = o.boxes ?? [{ x: 0.2, y: 0.2, width: 0.5, height: 0.6 }];
      const out = {};
      try {
        const refined = o.viaClient
          ? await (await import("/src/lib/removal-client.ts")).refineCropsAuto(source, base, boxes)
          : await (await import("/src/lib/engine.ts")).refineWithUserCrops(source, base, boxes, {});
        out.sameBase = refined === base;
        out.digest = await sha(refined);
        if (o.hist) out.hist = await histogram(refined, o.hist, o.tolerance ?? 3);
      } catch (error) {
        out.error = await describe(error, undefined, false);
      }
      const client = o.viaClient ? await import("/src/lib/removal-client.ts") : undefined;
      return { ...out, ...clientProvenance(client), ...(await snapshot()) };
    },
    /** Warmup, through the page engine or the worker. */
    async warm(o = {}) {
      const out = { fractions: [] };
      const onProgress = (fraction) => out.fractions.push(fraction);
      try {
        if (o.viaClient) await (await import("/src/lib/removal-client.ts")).warmupRemoval(onProgress);
        else await (await import("/src/lib/engine.ts")).warmupBiRefNet(onProgress);
        out.settled = true;
      } catch (error) {
        out.error = await describe(error, undefined, false);
      }
      return { ...out, ...(await snapshot()) };
    },
    /** One job through the client (the worker when it can, the page when it cannot). */
    async auto(o = {}) {
      if (o.noWorker) Object.defineProperty(window, "Worker", { configurable: true, writable: true, value: undefined });
      const client = await import("/src/lib/removal-client.ts");
      // corrupt: a JPEG header with no image data behind it, which no decoder reads.
      const source = o.corrupt
        ? new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01])], { type: "image/jpeg" })
        : await fixture(o.fixture ?? "gradient", o.width, o.height);
      const progress = [];
      const out = {};
      try {
        const done = await client.removeBackgroundAuto(source, { mode: o.mode ?? "auto", onProgress: collect(progress) });
        out.provider = done.provider;
        out.method = done.method;
        out.model = done.model;
        out.webgpuBroken = done.webgpuBroken;
        out.digest = await sha(done.blob);
      } catch (error) {
        out.error = await describe(error, undefined, o.classify);
      }
      return { ...out, progress, ...clientProvenance(client), ...(await snapshot()) };
    },
    /** Q5: job 1, a job queued behind it that is cancelled while the worker runs it, then jobs 2 and 3. */
    async drain() {
      const client = await import("/src/lib/removal-client.ts");
      const opts = { mode: "quick" };
      // All four sources first, so job 1 and the job queued behind it are posted back to back.
      const blobs = [await fixture("gradient"), await fixture("gradient"), await fixture("gradient"), await fixture("gradient")];
      const first = client.removeBackgroundAuto(blobs[0], opts);
      const controller = new AbortController();
      const cancelled = client.removeBackgroundAuto(blobs[1], { ...opts, signal: controller.signal });
      cancelled.catch(() => {});
      const one = await first;
      controller.abort(); // the worker is mid-run on it: it stays in flight until the worker replies
      const two = await client.removeBackgroundAuto(blobs[2], opts);
      const three = await client.removeBackgroundAuto(blobs[3], opts);
      return { providers: [one.provider, two.provider, three.provider] };
    },
    async clearRecords() {
      (await import("/src/lib/removal-provider.ts")).clearRemovalFailureRecords(null);
    },
    /** A gpu-mask record as an earlier version persisted it (E10-S-01: no longer written, still read). */
    async seedGpuRecord() {
      const provider = await import("/src/lib/removal-provider.ts");
      const record = { version: 1, fingerprint: provider.REMOVAL_RUNTIME_FINGERPRINT, kind: "gpu-mask" };
      localStorage.setItem(provider.REMOVAL_FAILURE_KEY, JSON.stringify(record));
      return provider.readGpuFailure();
    },
    state: snapshot,
    rawSizes: () => globalThis.__rawSizes ?? [],
    posted: () => globalThis.__posted ?? [],
  };
}

// ---- fake config builders (function sources the fake inlines) ---------------------------------------

/** Rejects matching model loads. rule: { model?, device?, from?, to?, message }; attempt counts per model+device. */
const loadHook = (rules) => `async (call) => {
  const rules = ${JSON.stringify(rules)};
  if (call.kind !== "model") return;
  for (const rule of rules) {
    if (rule.model && rule.model !== call.model) continue;
    if (rule.device && rule.device !== call.device) continue;
    if (rule.from !== undefined && call.attempt < rule.from) continue;
    if (rule.to !== undefined && call.attempt > rule.to) continue;
    throw new Error(rule.message);
  }
}`;

/** Emits load progress events (some not for .onnx files), bumps the perf offset on wasm model loads. */
const progressLoadHook = (events, bumpMs = 0) => `async (call) => {
  for (const event of ${JSON.stringify(events)}) call.progress(event);
  if (${bumpMs} && call.kind === "model" && call.device === "wasm") globalThis.__perfOffset += ${bumpMs};
}`;

/**
 * Decides what each model() call does. rules: [{ match: { model?, device?, call?, callFrom?, deviceCall?,
 * deviceCallFrom? }, do: spec }], first match wins, unmatched = a large centred subject. `call` counts model
 * runs in the context, `deviceCall` per model+device.
 * spec: { throw, name } | { missing } | { nan } | { flat } | { bands } | { halves } | { rect, inside, outside } | { hold }
 */
const maskHook = (rules) => `async (call, h) => {
  const rules = ${JSON.stringify(rules)};
  const counts = (call.state.deviceCalls ??= {});
  const key = call.model + ":" + call.device;
  const deviceCall = (counts[key] = (counts[key] ?? 0) + 1);
  const hit = rules.find(({ match: m = {} }) =>
    (m.model === undefined || m.model === call.model) &&
    (m.device === undefined || m.device === call.device) &&
    (m.call === undefined || m.call === call.n) &&
    (m.callFrom === undefined || call.n >= m.callFrom) &&
    (m.deviceCall === undefined || m.deviceCall === deviceCall) &&
    (m.deviceCallFrom === undefined || deviceCall >= m.deviceCallFrom));
  const spec = hit?.do ?? {};
  // BiRefNet emits raw logits, ISNet probabilities (the contract); defaults follow the model.
  const [hi, lo] = call.model === "isnet" ? [1, 0] : [20, -20];
  if (spec.hold) await new Promise((resolve) => setTimeout(resolve, spec.hold));
  if (spec.throw) throw Object.assign(new Error(spec.throw), spec.name ? { name: spec.name } : {});
  if (spec.missing) return "missing";
  if (spec.nan) return h.nonFinite(call);
  if (spec.flat !== undefined) return spec.flat;
  if (spec.bands) return h.bandsX(spec.bands);
  if (spec.halves) return (u) => spec.halves[u < 0.5 ? 0 : 1];
  if (spec.rect) {
    const [u0, v0, u1, v1] = spec.rect;
    return (u, v) => (u >= u0 && u < u1 && v >= v0 && v < v1 ? (spec.inside ?? hi) : (spec.outside ?? lo));
  }
  return (u, v) => (u >= 0.25 && u < 0.75 && v >= 0.2 && v < 0.8 ? hi : lo);
}`;

/** Fires a one-shot page hook on the first processor() call (the run phase of the first engine used). */
const RUN_PHASE_HOOK = `async (call, h) => {
  if (call.phase !== "processor") return;
  await h.once("run-phase", async () => {
    const hook = globalThis.__runPhaseHook;
    globalThis.__runPhaseHook = undefined;
    await hook?.(call);
  });
}`;

/** Records every processor() input size (large-preprocessing row). */
const RAW_SIZE_HOOK = `async (call) => {
  if (call.phase === "processor") (globalThis.__rawSizes ??= []).push([call.width, call.height]);
}`;

/** The processor throws: the message stays verbatim. */
const PROCESSOR_THROW_HOOK = `async (call) => {
  if (call.phase === "processor") throw new Error("Processor exploded");
}`;

/** The processor returns a pixel_values tensor of the wrong shape: the engine maps it to "Image preprocessing failed". */
const INVALID_PROCESSOR_TENSOR_HOOK = `async (call) => {
  if (call.phase === "processor")
    return { pixel_values: { data: new Float32Array(12), dims: [1, 3, 2, 2], type: "float32", dispose() {} } };
}`;

/** The worker's createImageBitmap rejects, as a decode only the page can do would (fake: (original) => replacement). */
const DECODE_FAILURE = `(original) => () => Promise.reject(new DOMException("decode failed", "InvalidStateError"))`;

// ---- rows -------------------------------------------------------------------------------------------

/** Which scope reaches the dedicated worker's module fetches; the smoke decides it ("page" or "context"). */
let routeScope = "context";

/** Every config needs a real model mask: the fake's default (uniform 20) is a flat mask to the engine. */
const withMask = (config = {}) => ({ mask: maskHook([]), ...config });

/**
 * One isolated browser context with the fake boundary, the pinned environment and the driver.
 * adapter: "fake" (with shader-f16) | "no-f16" | "null" (requestAdapter -> null) | "absent" (no navigator.gpu).
 */
async function openRow({
  memory = 8,
  adapter = "null",
  page: pageConfig = {},
  worker: workerConfig = {},
  workerEnv = {},
  setItemThrows = false,
  host = browser,
} = {}) {
  const context = await host.newContext();
  context.on("request", (request) => allRequests.push(request.url()));
  await context.addInitScript(eventLogInit());
  await context.addInitScript(installEnv, { memory, adapter, setItemThrows });
  await context.addInitScript(installDriver);
  const page = await context.newPage();
  const target = routeScope === "page" ? page : context;
  await target.route(TRANSFORMERS_ROUTE, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: transformersFake({ page: withMask(pageConfig), worker: withMask(workerConfig) }),
    }),
  );
  const workerMemory = "memory" in workerEnv ? workerEnv.memory : memory;
  const workerAdapter = workerEnv.adapter ?? adapter;
  const prelude = workerPrelude({
    deviceMemory: workerMemory === "missing" ? undefined : workerMemory,
    adapter: workerAdapter,
    createImageBitmap: workerEnv.createImageBitmap,
  });
  await target.route(WORKER_ROUTE, async (route) => {
    const response = await route.fetch();
    const headers = Object.fromEntries(
      Object.entries(response.headers()).filter(([name]) => !["content-encoding", "content-length"].includes(name)),
    );
    await route.fulfill({ response, headers, body: `${prelude}\n${await response.text()}` });
  });
  await page.goto(appUrl);
  const row = {
    page,
    context,
    run: (o) => page.evaluate((arg) => globalThis.__t.run(arg), o ?? {}),
    refine: (o) => page.evaluate((arg) => globalThis.__t.refine(arg), o ?? {}),
    warm: (o) => page.evaluate((arg) => globalThis.__t.warm(arg), o ?? {}),
    auto: (o) => page.evaluate((arg) => globalThis.__t.auto(arg), o ?? {}),
    drain: () => page.evaluate(() => globalThis.__t.drain()),
    clearRecords: () => page.evaluate(() => globalThis.__t.clearRecords()),
    consts: () => page.evaluate(() => globalThis.__t.consts()),
    state: () => page.evaluate(() => globalThis.__t.state()),
    rawSizes: () => page.evaluate(() => globalThis.__t.rawSizes()),
    posted: () => page.evaluate(() => globalThis.__t.posted()),
    /** The merged, time-sorted event log of both contexts (waits a moment for worker posts). */
    log: () => readFakeLog(page),
    mark: async () => (row.marker = (await row.log()).length),
    /** Events since the last mark() (or all of them). */
    since: async () => (await row.log()).slice(row.marker ?? 0),
    marker: 0,
    close: () => context.close(),
  };
  return row;
}

async function withRow(options, body) {
  const row = await openRow(options);
  try {
    return await body(row);
  } finally {
    await row.close();
  }
}

// log analysis -------------------------------------------------------------------------------------

const where = (e, f) =>
  (f.ctx === undefined || e.ctx === f.ctx) &&
  (f.model === undefined || e.model === f.model) &&
  (f.device === undefined || e.device === f.device) &&
  (f.dtype === undefined || e.dtype === f.dtype);
const modelLoads = (log, f = {}) => log.filter((e) => e.type === "from_pretrained" && e.kind === "model" && where(e, f));
const processorLoads = (log, f = {}) =>
  log.filter((e) => e.type === "from_pretrained" && e.kind === "processor" && where(e, { ctx: f.ctx }));
const loadsTotal = (log, f = {}) => modelLoads(log, f).length + processorLoads(log, f).length;
const modelDisposes = (log, f = {}) =>
  log.filter((e) => e.type === "dispose" && e.target === "model" && !e.repeat && where(e, f));
/** Model inferences only: the fake also logs a `run` for every processor() call. */
const runsOf = (log, f = {}) => log.filter((e) => e.type === "run" && e.phase === "model" && where(e, f));
const sigmoidsOf = (log) => log.filter((e) => e.type === "sigmoid");
const indexOf = (log, predicate) => log.findIndex(predicate);
const livePeak = (log) => {
  const { maxPage, maxWorker, maxTotal } = liveModels(log);
  return { perContext: Math.max(maxPage, maxWorker), across: maxTotal };
};

// progress analysis ------------------------------------------------------------------------------------

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;
const hasProgress = (progress, stage, value) => progress.some((p) => p.stage === stage && near(p.progress, value));
const hasSwitching = (progress) => progress.some((p) => p.message === SWITCHING);
const firstAt = (progress, stage, value) => progress.findIndex((p) => p.stage === stage && near(p.progress, value));

/** The state the failure rows keep asserting: nothing leaked into storage, no GPU record. */
function assertNoGpuRecord(r, label = "") {
  assert.equal(r.gpuFailure, false, `${label} readGpuFailure() is false`);
  assert.deepEqual(
    r.keys.filter((key) => key === GPU_KEY || key.startsWith("bg0:webgpu-failure:")),
    [],
    `${label} no failure record is written`,
  );
}

// ---- 0. Interception smoke (first: if it fails, the worker rows go back to the architect) -------------

let smokeOk = false;
async function requireSmoke() {
  assert.ok(
    smokeOk,
    "the interception smoke did not pass: worker rows are not red-first tests and go back to the architect (design section 7)",
  );
}

test("smoke 1: a route reaches the dedicated removal worker's module fetches (page.route, then context.route)", async () => {
  // fake-transformers.mjs tries both scopes and checks the worker's module-loaded and prelude events.
  const smoke = await runInterceptionSmoke(browser, appUrl, { deviceMemory: 6 });
  assert.ok(smoke.intercepted, `neither scope intercepts dedicated-worker fetches: ${JSON.stringify(smoke.attempts)}`);
  routeScope = smoke.intercepted;
});

test("smoke 2: this suite's own wiring reaches both contexts (prelude deviceMemory 4 gives the worker ISNet)", async () => {
  // Page memory 8, worker prelude memory 4, no adapters anywhere: the worker's low-memory route proves the
  // prelude is in effect, and module-loaded proves the fake served both contexts.
  await withRow({ memory: 8, adapter: "null", workerEnv: { memory: 4, adapter: "null" } }, async (row) => {
    const worker = await row.warm({ viaClient: true });
    assert.equal(worker.settled, true, JSON.stringify(worker.error));
    const page = await row.warm();
    assert.equal(page.settled, true, JSON.stringify(page.error));
    const log = await row.log();
    assert.ok(log.some((e) => e.type === "module-loaded" && e.ctx === "worker"), "the worker imported the fake module");
    assert.ok(log.some((e) => e.type === "module-loaded" && e.ctx === "page"), "the page imported the fake module");
    assert.equal(log.find((e) => e.type === "prelude")?.deviceMemory, 4, "the prelude ran in the worker");
    assert.equal(modelLoads(log, { ctx: "worker", model: "isnet", device: "wasm" }).length, 1, "worker: low memory -> ISNet");
    assert.equal(modelLoads(log, { ctx: "page", model: "birefnet", device: "wasm" }).length, 1, "page: memory 8 -> BiRefNet");
  });
  smokeOk = true;
});

test("R2-C-01: the result names the model that ran, through the worker and on the page", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null", workerEnv: { memory: 4, adapter: "null" } }, async (row) => {
    const r = await row.auto();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.deepEqual([r.provider, r.method, r.model], ["wasm", "model", "isnet"], "worker: low memory -> ISNet");
  });
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const r = await row.auto({ noWorker: true });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.deepEqual([r.provider, r.method, r.model], ["wasm", "model", "birefnet"], "page: memory 8 -> BiRefNet");
  });
});

// ---- Q1: engine boundary errors ----------------------------------------------------------------------

test("Q1 (red on r2, N1): an opaque WebGPU inference throw is retryable and runs one compatibility attempt", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { mask: maskHook([{ match: { device: "webgpu" }, do: { throw: "ORT session run failed" } }]) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.equal(r.method, "model");
      assert.ok(hasSwitching(r.progress), "the transition to compatibility mode is shown");
      const log = await row.log();
      assert.equal(modelLoads(log, { device: "webgpu" }).length, 1);
      assert.equal(modelLoads(log, { device: "wasm" }).length, 1, "exactly one wasm model load");
      assert.ok(processorLoads(log).length >= 1, "the wasm entry loads its processor");
      assert.equal(sigmoidsOf(log).length, 0);
      assertNoGpuRecord(r, "an inference throw is not a mask failure:");
    },
  );
});

test("Q1 (red on r3, F2): a WASM crash named Aborted() is never a cancellation", async () => {
  const crash = { match: { device: "wasm" }, do: { throw: "Aborted()", name: "RuntimeError" } };
  await withRow({ memory: 8, adapter: "null", page: { mask: maskHook([crash]) } }, async (row) => {
    const r = await row.run({ classify: true });
    assert.ok(r.error, "the job rejects (no graphic to fall back to)");
    assert.equal(r.error.name, "RemovalInferenceError");
    assert.equal(r.error.code, "inference-failed");
    assert.deepEqual(r.error.classified, { code: "model", retryable: true }, "classified model/retryable, never cancelled");
    const log = await row.log();
    assert.equal(modelLoads(log).length, 1, "one wasm session serves the primary and the same-target compatibility pass");
    assert.equal(processorLoads(log).length, 1);
    assert.equal(runsOf(log).length, 2, "primary run, then exactly one compatibility run");
    assert.equal(r.prov.outcome, "error");
  });
});

// ---- Q2: missing output ------------------------------------------------------------------------------

test("Q2 (D1): a model that returns {} becomes the shape MaskError, one compatibility attempt, no record", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { mask: maskHook([{ match: { device: "webgpu" }, do: { missing: true } }]) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.ok(hasSwitching(r.progress), "exactly one compatibility attempt");
      assert.equal(modelLoads(await row.log(), { device: "wasm" }).length, 1);
      assertNoGpuRecord(r, "a shape error never persists:");
    },
  );
});

// ---- Q3: ISNet never absorbs -------------------------------------------------------------------------

test("Q3: an ISNet load failure is not absorbed and has no compatibility pass", async () => {
  await withRow(
    { memory: 3, adapter: "null", page: { load: loadHook([{ model: "isnet", message: FETCH_FAILURE }]) } },
    async (row) => {
      const r = await row.run();
      assert.ok(r.error, "the job ends in tryGraphic/throw");
      assert.equal(r.error.name, "RemovalModelLoadError");
      const log = await row.log();
      assert.equal(modelLoads(log, { model: "isnet" }).length, 1, "ISNet is attempted once");
      assert.equal(modelLoads(log, { model: "birefnet" }).length, 0, "no absorb and no compatibility BiRefNet");
      assert.equal(hasSwitching(r.progress), false);
      assert.equal(r.memo, undefined);
    },
  );
});

// ---- Q4: job lifecycle, memo and shapes (page rows) --------------------------------------------------

test("Q4 (m): a persistent WebGPU init failure is compatibility-shaped for jobs 2+ without a new WebGPU attempt", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", message: INIT_FAILURE }]) } },
    async (row) => {
      const { transfer, edges } = await row.consts();
      const first = await row.run();
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      assert.ok(hasSwitching(first.progress));
      assert.equal(first.prov.compat.attempted, true);
      assert.equal(first.prov.globalTransfer, transfer);
      assert.equal(first.prov.cropInferences, 0);
      assert.equal(first.memo, "init");
      for (const [index, name] of ["second", "third"].entries()) {
        await row.mark();
        const job = await row.run();
        const slice = await row.since();
        assert.equal(job.error, undefined, `${name} job: ${JSON.stringify(job.error)}`);
        assert.ok(hasSwitching(job.progress), `${name} job keeps the compatibility shape (transition present)`);
        assert.equal(firstAt(job.progress, "cutting", 0.7), -1, `${name} job has no processing 0.7`);
        assert.ok(hasProgress(job.progress, "finishing", edges), `${name} job emits the 0.92 fingerprint`);
        assert.equal(job.prov.shape, "compat", `${name} job provenance shape (job ${index + 2})`);
        assert.equal(job.prov.compat.attempted, true);
        assert.equal(job.prov.globalTransfer, transfer);
        assert.equal(job.prov.cropInferences, 0);
        assert.equal(loadsTotal(slice), 0, `${name} job: zero from_pretrained`);
        assert.equal(modelDisposes(slice).length, 0, `${name} job: zero dispose`);
        assert.equal(job.memo, "init");
      }
      const before = await row.log();
      assert.equal(modelLoads(before, { device: "webgpu" }).length, 1, "one WebGPU attempt over three jobs");
      assert.equal(modelLoads(before, { device: "wasm" }).length, 1, "one wasm model over three jobs");
      assertNoGpuRecord(await row.state(), "(m)");
      // Delete resets the memo: the next job attempts WebGPU exactly once more.
      await row.clearRecords();
      await row.mark();
      const fourth = await row.run();
      const slice = await row.since();
      assert.equal(fourth.error, undefined, JSON.stringify(fourth.error));
      assert.equal(modelLoads(slice, { device: "webgpu" }).length, 1, "a fourth job attempts WebGPU once more");
      const all = await row.log();
      assert.ok(livePeak(all).perContext <= 1, "never more than one live model");
    },
  );
});

test("Q4 (n, pins D5, default unchanged): a persistent network-class failure is absorbed once, then served from the wasm session", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", message: FETCH_FAILURE }]) } },
    async (row) => {
      const first = await row.run();
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      assert.equal(first.provider, "wasm");
      assert.equal(first.memo, "network");
      await row.mark();
      const second = await row.run();
      const slice = await row.since();
      assert.equal(second.error, undefined, JSON.stringify(second.error));
      assert.equal(loadsTotal(slice), 0, "job 2: zero from_pretrained");
      assert.equal(modelDisposes(slice).length, 0, "job 2: zero dispose");
      assert.equal(second.prov.shape, "primary", "job 2 keeps job 1's absorbed (primary) shape");
      assert.equal(hasSwitching(second.progress), false);
      assert.equal(second.digest, first.digest, "byte-identical result");
      assert.equal(second.memo, "network");
      assertNoGpuRecord(second, "(n)");
      // Delete resets the session memo: job 3 disposes wasm, retries WebGPU, absorbs again.
      await row.clearRecords();
      await row.mark();
      const third = await row.run();
      const after = await row.since();
      assert.equal(third.error, undefined, JSON.stringify(third.error));
      assert.equal(modelDisposes(after).length, 1, "job 3 releases the wasm model before the WebGPU attempt");
      assert.equal(modelLoads(after, { device: "webgpu" }).length, 1);
      assert.equal(modelLoads(after, { device: "wasm" }).length, 1, "wasm model count 2 over the run");
      const log = await row.log();
      assert.equal(modelLoads(log, { device: "webgpu" }).length, 2);
      assert.equal(modelLoads(log, { device: "wasm" }).length, 2);
      assert.ok(livePeak(log).perContext <= 1);
    },
  );
});

test("Q4 (o): the first network-class load failure is recovered in the same job in primary shape", async () => {
  // 503 text: parity-consistent with the registered weight-503 run (no D5 pin).
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", to: 1, message: NETWORK_503 }]) } },
    async (row) => {
      const first = await row.run();
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      assert.equal(first.provider, "wasm");
      assert.equal(first.method, "model");
      assert.equal(hasSwitching(first.progress), false, "no compatibility transition");
      assert.ok(hasProgress(first.progress, "cutting", 0.7), "processing 0.7 is present");
      assert.ok(hasProgress(first.progress, "finishing", 0.94));
      assert.equal(firstAt(first.progress, "finishing", 0.92), -1, "no 0.92 fingerprint");
      const log = await row.log();
      assert.deepEqual(modelLoads(log).map((e) => e.device), ["webgpu", "wasm"], "loads are [webgpu, wasm]");
      assert.ok(processorLoads(log).length >= 1);
      assert.equal(first.memo, "network");
      assertNoGpuRecord(first, "(o)");
      assert.ok(first.prov, "C3 provenance is returned (S5)");
      assert.equal(first.prov.shape, "primary");
      assert.equal(first.prov.absorbAttempted, true);
      assert.equal(first.prov.compat.attempted, false);
      assert.equal(first.prov.globalTransfer, "quality");
      assert.equal(first.prov.cropBudget, await row.page.evaluate(() => globalThis.__t.budget("wasm", 8, 120 * 80)));
      await row.mark();
      const second = await row.run();
      const slice = await row.since();
      assert.equal(loadsTotal(slice), 0);
      assert.equal(modelDisposes(slice).length, 0);
      assert.equal(second.digest, first.digest, "identical bytes on job 2");
      assert.ok(livePeak(await row.log()).perContext <= 1);
    },
  );
});

test("Q4 (p, job-2 tail pins D5, default unchanged): a second consecutive load failure takes the compatibility path", async () => {
  await withRow(
    {
      memory: 8,
      adapter: "fake",
      page: {
        load: loadHook([
          { device: "webgpu", message: FETCH_FAILURE },
          { device: "wasm", to: 1, message: FETCH_FAILURE },
        ]),
      },
    },
    async (row) => {
      const { transfer, edges } = await row.consts();
      const first = await row.run();
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      assert.equal(first.provider, "wasm");
      assert.ok(hasSwitching(first.progress), "the transition is present");
      assert.equal(first.prov.absorbAttempted, true);
      assert.equal(first.prov.compat.attempted, true);
      assert.equal(first.prov.globalTransfer, transfer);
      assert.equal(first.prov.cropInferences, 0);
      const at92 = firstAt(first.progress, "finishing", edges);
      const at94 = firstAt(first.progress, "finishing", 0.94);
      assert.ok(at92 >= 0 && at94 > at92, "finishing 0.92 then 0.94");
      assert.equal(modelLoads(await row.log(), { device: "wasm" }).length, 2, "the pool evicts the rejected entry: wasm count 2");
      assert.equal(first.memo, undefined, "double failure sets no memo");
      // Job 2 with WebGPU still failing: dispose(wasm) before the WebGPU attempt, absorbed, memo set.
      await row.mark();
      const second = await row.run();
      const slice = await row.since();
      assert.equal(second.error, undefined, JSON.stringify(second.error));
      const disposeAt = indexOf(slice, (e) => e.type === "dispose" && e.target === "model" && !e.repeat);
      const webgpuAt = indexOf(slice, (e) => e.type === "from_pretrained" && e.kind === "model" && e.device === "webgpu");
      assert.ok(disposeAt >= 0 && webgpuAt > disposeAt, "dispose(wasm) precedes the second WebGPU attempt");
      const log = await row.log();
      assert.equal(modelLoads(log, { device: "webgpu" }).length, 2);
      assert.equal(modelLoads(log, { device: "wasm" }).length, 3, "job 2 is absorbed: wasm model count 3");
      assert.equal(second.memo, "network");
      assert.ok(livePeak(log).perContext <= 1);
      assertNoGpuRecord(second, "(p)");
    },
  );
});

test("Q4 (p variant, fault provenance): every load rejects, nothing to fall back to", async () => {
  await withRow(
    {
      memory: 8,
      adapter: "fake",
      page: { load: loadHook([{ device: "webgpu", message: FETCH_FAILURE }, { device: "wasm", message: FETCH_FAILURE }]) },
    },
    async (row) => {
      const { transfer } = await row.consts();
      const r = await row.run();
      assert.ok(r.error, "the call rejects");
      assert.equal(r.error.name, "RemovalModelLoadError", "with the absorb's wasm load error");
      assert.equal(r.prov.outcome, "error");
      assert.equal(r.prov.absorbAttempted, true);
      assert.deepEqual(r.prov.compat, { attempted: true, transfer });
      assert.equal(r.memo, undefined, "no replacement engine became ready: no memo");
      assertNoGpuRecord(r, "(p variant)");
    },
  );
});

for (const [name, setup, expected] of [
  ["(t, pins D5, default unchanged) a cancel inside the absorbed run phase keeps the network memo", FETCH_FAILURE, "network"],
  ["(u) a cancel inside the compatibility run phase keeps the init memo", INIT_FAILURE, "init"],
]) {
  test(`Q4 ${name}`, async () => {
    await withRow(
      { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", message: setup }]), run: RUN_PHASE_HOOK } },
      async (row) => {
        // The hook fires on the first processor() call, i.e. in the replacement engine's run phase (never on
        // model-ready: that abort lands in subscriberWait and is a pre-ready cancel, Q4 q7).
        await row.page.evaluate(() => {
          globalThis.__hookSaw = "unset";
          globalThis.__runPhaseHook = async () => {
            globalThis.__hookSaw = (await import("/src/lib/removal-provider.ts")).webgpuLoadMemo() ?? "none";
            globalThis.__abortJob();
          };
        });
        const first = await row.run({ exposeAbort: true });
        assert.equal(await row.page.evaluate(() => globalThis.__hookSaw), expected, "the memo is already set when the run phase starts");
        assert.ok(first.error, "job 1 rejects");
        assert.equal(first.error.sameReason, true, "with the exact abort reason");
        assert.equal(first.memo, expected);
        await row.mark();
        const second = await row.run();
        const slice = await row.since();
        assert.equal(second.error, undefined, JSON.stringify(second.error));
        assert.equal(loadsTotal(slice), 0, "job 2: zero from_pretrained");
        assert.equal(modelDisposes(slice).length, 0, "job 2: zero dispose");
        assert.equal(second.prov.shape, expected === "network" ? "primary" : "compat");
        assert.equal(second.memo, expected);
        assertNoGpuRecord(second, name);
      },
    );
  });
}

test("Q4 (v): no adapter, one WASM-primary load failure takes the single compatibility pass", async () => {
  await withRow(
    { memory: 8, adapter: "null", page: { load: loadHook([{ device: "wasm", to: 1, message: FETCH_FAILURE }]) } },
    async (row) => {
      const { transfer, edges } = await row.consts();
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.equal(r.method, "model");
      assert.ok(hasSwitching(r.progress), "transition present");
      assert.ok(firstAt(r.progress, "finishing", edges) >= 0 && firstAt(r.progress, "finishing", 0.94) > firstAt(r.progress, "finishing", edges));
      assert.equal(firstAt(r.progress, "cutting", 0.7), -1, "no processing 0.7");
      assert.equal(r.prov.shape, "primary", "the route's shape");
      assert.equal(r.prov.absorbAttempted, false);
      assert.deepEqual(r.prov.compat, { attempted: true, transfer });
      assert.equal(r.prov.globalTransfer, transfer);
      assert.equal(r.prov.cropBudget, 0);
      assert.equal(r.prov.cropInferences, 0);
      const log = await row.log();
      assert.equal(modelLoads(log, { device: "webgpu" }).length, 0);
      assert.equal(modelLoads(log, { dtype: "fp16" }).length, 0, "no model_fp16.onnx request");
      assert.equal(modelLoads(log, { device: "wasm" }).length, 2, "wasm model count 2");
      assert.equal(r.memo, undefined);
      assertNoGpuRecord(r, "(v)");
    },
  );
});

test("Q4 (w): no adapter, both WASM loads reject", async () => {
  await withRow(
    { memory: 8, adapter: "null", page: { load: loadHook([{ device: "wasm", message: FETCH_FAILURE }]) } },
    async (row) => {
      const { transfer } = await row.consts();
      const r = await row.run();
      assert.ok(r.error, "the call rejects");
      assert.equal(r.error.name, "RemovalModelLoadError", "with the primary wasm error");
      assert.equal(modelLoads(await row.log(), { device: "wasm" }).length, 2);
      assert.equal(r.prov.outcome, "error");
      assert.equal(r.prov.absorbAttempted, false);
      assert.deepEqual(r.prov.compat, { attempted: true, transfer });
      assert.equal(r.memo, undefined);
      assertNoGpuRecord(r, "(w)");
      // Not reachable with a page fixture (reported): the tryGraphic-positive "fallback" outcome variant. A graphic that
      // tryGraphic accepts is taken before any model is requested, so no fault record is written for it.
    },
  );
});

// ---- Q5: the slow worker drains before the page loads a model ---------------------------------------

for (const adapter of ["fake", "no-f16"]) {
test(`Q5: a slow worker drains before the page model loads (${adapter})`, async () => {
  await requireSmoke();
  await withRow(
    {
      memory: 8,
      adapter, // either page route is faster than a worker with no adapter
      workerEnv: { adapter: "null" },
      worker: { mask: maskHook([{ match: { call: 2 }, do: { hold: 800 } }]) }, // the cancelled job's run outlives job 1
    },
    async (row) => {
      const { providers } = await row.drain();
      assert.equal(providers[0], "wasm", "job 1 ran in the worker on wasm");
      assert.equal(providers[2], "webgpu", "job 3 ran on the page, on WebGPU");
      const log = await row.log();
      const posted = await row.posted();
      assert.equal(log.filter((e) => e.type === "worker-created").length, 1, "jobs 1 and 2 shared one worker");
      assert.equal(log.filter((e) => e.type === "terminate").length, 1, "terminated once, after the drain");
      assert.equal(posted.filter((m) => m.type === "run").length >= 3, true);
      const terminateAt = indexOf(log, (e) => e.type === "terminate");
      const pageLoadAt = indexOf(log, (e) => e.type === "from_pretrained" && e.kind === "model" && e.ctx === "page");
      assert.ok(terminateAt >= 0 && pageLoadAt > terminateAt, "the page's from_pretrained comes after the worker terminate");
      assert.ok(livePeak(log).across <= 1, "never a worker model next to a page model");
    },
  );
});
}

for (const adapter of ["fake", "no-f16", "null"]) {
test(`worker GPU capability matches the runtime and retains WASM fallback (${adapter})`, async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter,
    worker: { mask: maskHook([{ match: { device: "webgpu" }, do: { flat: 0.01 } }]) },
  }, async (row) => {
    for (const job of [1, 2]) {
      const result = await row.auto();
      assert.equal(result.error, undefined, JSON.stringify(result.error));
      assert.equal(result.provider, "wasm", `job ${job}`);
    }
    const outcomes = await row.page.evaluate(() => globalThis.__workerOutcomes);
    assert.deepEqual(outcomes, [1, 2].map(() => ({ provider: "wasm", workerHadGpu: adapter !== "null" })));
    const log = await row.log();
    assert.equal(log.filter((e) => e.type === "worker-created").length, 1);
    assert.equal(log.filter((e) => e.type === "terminate").length, 0);
    assert.equal(loadsTotal(log, { ctx: "page" }), 0);
    assert.ok(livePeak(log).across <= 1);
    if (adapter !== "null") {
      assert.equal(modelLoads(log, { device: "webgpu" }).length, 1, "mask failure memo skips later GPU attempts");
      assert.equal((await row.posted()).filter((m) => m.type === "run").at(-1).noWebgpu, true);
    }
  });
});
}

// ---- Q6: what persists -------------------------------------------------------------------------------

test("Q6 (D6 expectation): a WebGPU device loss at load writes no record", async () => {
  // At 5522 the page wrote the failure key on every absorbed load failure; the owned engine never does (D6).
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", message: "WebGPU device lost" }]) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.ok(!r.webgpuBroken, "webgpuBroken is falsy");
      assertNoGpuRecord(r, "(device lost at load)");
      assert.deepEqual(modelLoads(await row.log()).map((e) => e.device), ["webgpu", "wasm"]);
    },
  );
});

test("Q6: a flat GPU mask that WASM resolves sets the session memo; no record is written (E10-S-01)", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { mask: maskHook([{ match: { device: "webgpu" }, do: { flat: 0.01 } }]) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.equal(r.webgpuBroken, true);
      assert.equal(r.gpuFailure, true);
      assert.equal(r.record, null, "judged from one image: this page only");
      await row.page.reload();
      assert.equal((await row.state()).gpuFailure, false, "the next visit tries WebGPU again");
    },
  );
});

test("Q6: a flat GPU mask with an empty WASM result writes no record", async () => {
  const rules = [
    { match: { device: "webgpu" }, do: { flat: 0.01 } },
    // wasm finds only a sliver (not flat, but empty by cutoutLooksEmpty)
    { match: { device: "wasm" }, do: { rect: [0.5, 0.5, 0.53, 0.53], inside: 1, outside: 0 } },
  ];
  await withRow({ memory: 8, adapter: "fake", page: { mask: maskHook(rules) } }, async (row) => {
    const r = await row.run();
    assert.ok(!r.webgpuBroken, "not a broken GPU: WASM found nothing either");
    assertNoGpuRecord(r, "(flat + empty wasm)");
  });
});

test("Q6/Q8 (F5): a persisted record is honoured after a reload (pins persisted-read, not the flag)", async () => {
  await withRow({ memory: 8, adapter: "fake" }, async (row) => {
    assert.equal(await row.page.evaluate(() => globalThis.__t.seedGpuRecord()), true, "the earlier version's record is read");
    await row.page.reload(); // clears the in-process flag
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.provider, "wasm");
    assert.equal(r.gpuFailure, true);
    const log = await row.log();
    assert.equal(modelLoads(log, { device: "webgpu" }).length, 0, "the stored record skips WebGPU");
    assert.equal(modelLoads(log, { device: "wasm" }).length, 1);
  });
});

// ---- Q7: storage denied or throwing ------------------------------------------------------------------

test("Q7: a storage throw inside the compatibility pass keeps the cut", async () => {
  await withRow(
    { memory: 8, adapter: "fake", setItemThrows: true, page: { mask: maskHook([{ match: { device: "webgpu" }, do: { flat: 0.01 } }]) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      assert.equal(r.webgpuBroken, true, "the cut is kept and reported");
      assert.equal(r.gpuFailure, true, "the in-process flag holds the failure");
      assert.equal(r.record, null, "nothing could be stored");
    },
  );
});

test("Q7: after a worker result with webgpuBroken, the next worker request carries noWebgpu and loads wasm only", async () => {
  await requireSmoke();
  await withRow(
    {
      memory: 8,
      adapter: "fake",
      setItemThrows: true,
      worker: { mask: maskHook([{ match: { device: "webgpu" }, do: { flat: 0.01 } }]) },
    },
    async (row) => {
      const first = await row.auto();
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      assert.equal(first.webgpuBroken, true);
      assert.equal(first.gpuFailure, true, "page flag set although storage throws");
      await row.mark();
      const second = await row.auto();
      assert.equal(second.error, undefined, JSON.stringify(second.error));
      const posted = (await row.posted()).filter((m) => m.type === "run");
      assert.deepEqual(posted.map((m) => Boolean(m.noWebgpu)), [false, true], "the second request carries noWebgpu");
      const slice = await row.since();
      assert.equal(modelLoads(slice, { ctx: "worker", device: "webgpu" }).length, 0, "no WebGPU load for the second job");
      assert.ok(runsOf(slice, { ctx: "worker" }).every((e) => e.device === "wasm"));
    },
  );
});

// ---- Q10: routes ------------------------------------------------------------------------------------

test("Q10: no adapter loads BiRefNet/WASM fp32 only, with no fp16 and no transition (page, warmup, manual refine)", async () => {
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(hasSwitching(r.progress), false);
    assert.equal(r.prov.shape, "primary");
    const log = await row.log();
    assert.deepEqual(modelLoads(log).map((e) => [e.model, e.device, e.dtype]), [["birefnet", "wasm", "fp32"]]);
    assert.equal(modelLoads(log, { dtype: "fp16" }).length, 0);
    // The same route for warmup and manual refine: the one cached entry serves them (no second load).
    await row.mark();
    const warm = await row.warm();
    assert.equal(warm.settled, true);
    const refined = await row.refine();
    assert.equal(refined.error, undefined, JSON.stringify(refined.error));
    assert.equal(loadsTotal(await row.since()), 0, "warmup and manual refine reuse the same entry");
  });
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const warm = await row.warm();
    assert.equal(warm.settled, true);
    assert.deepEqual(modelLoads(await row.log()).map((e) => [e.model, e.device, e.dtype]), [["birefnet", "wasm", "fp32"]], "warmup alone");
  });
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const refined = await row.refine();
    assert.equal(refined.error, undefined, JSON.stringify(refined.error));
    assert.deepEqual(modelLoads(await row.log()).map((e) => [e.model, e.device, e.dtype]), [["birefnet", "wasm", "fp32"]], "manual refine alone");
  });
});

test("Q10 (worker warmup): the worker loads one BiRefNet/WASM fp32 pair and the next job reuses it", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const warm = await row.warm({ viaClient: true });
    assert.equal(warm.settled, true, JSON.stringify(warm.error));
    const log = await row.log();
    const workerLoads = modelLoads(log, { ctx: "worker" });
    assert.deepEqual(workerLoads.map((e) => [e.model, e.device, e.dtype]), [["birefnet", "wasm", "fp32"]]);
    assert.equal(processorLoads(log, { ctx: "worker" }).length, 1);
    assert.equal(loadsTotal(log, { ctx: "page" }), 0, "the page loads nothing");
    await row.mark();
    const job = await row.auto();
    assert.equal(job.error, undefined, JSON.stringify(job.error));
    assert.equal(loadsTotal(await row.since()), 0, "the following job shows no second load");
  });
});

test("S3-A-ENGINE-02: no-f16 adapters use WebGPU fp32 for page, refine and worker", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "no-f16" }, async (row) => {
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.provider, "webgpu");
    assert.equal(r.prov.dtype, "fp32");
    assert.equal(r.prov.onnxFile, "model.onnx");
    assert.equal(r.prov.cropBudget, 1, "fp32 keeps the former WASM crop budget");
    assert.equal(hasSwitching(r.progress), false);
    assert.deepEqual([r.prov.shape, r.prov.globalTransfer, r.prov.compat.attempted], ["primary", "quality", false]);
    const refined = await row.refine();
    assert.equal(refined.error, undefined, JSON.stringify(refined.error));
    assert.deepEqual(modelLoads(await row.log()).map((e) => [e.device, e.dtype]), [["webgpu", "fp32"]]);
  });
  await withRow({ memory: 8, adapter: "no-f16" }, async (row) => {
    for (const job of [1, 2]) {
      const r = await row.auto();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "webgpu", `job ${job}`);
      assert.equal(r.clientProv?.dtype, "fp32");
      assert.equal(r.clientProv?.shape, "primary");
    }
    const log = await row.log();
    assert.deepEqual(modelLoads(log).map((e) => [e.ctx, e.model, e.device, e.dtype]), [["worker", "birefnet", "webgpu", "fp32"]]);
    assert.equal(log.filter((e) => e.type === "terminate").length, 0);
  });
});

test("no-f16 WebGPU fp32 init failure recovers in a fresh WASM worker", async () => {
  for (const message of ["webgpu execution provider initialization failed", "WebGPU device creation failed"]) {
    const fail = { load: loadHook([{ device: "webgpu", message }]) };
    await withRow({ memory: 8, adapter: "no-f16", worker: fail }, async (row) => {
      const r = await row.auto();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "wasm");
      const log = await row.log();
      assert.ok(log.some((e) => e.type === "terminate"));
      assert.deepEqual(modelLoads(log).map((e) => [e.ctx, e.device, e.dtype]), [["worker", "webgpu", "fp32"], ["worker", "wasm", "fp32"]]);
    });
  }
});

test("Q10: an adapter whose WebGPU init fails: warmup rejects and resets (C09), manual refine rejects", async () => {
  const fail = { load: loadHook([{ device: "webgpu", message: INIT_FAILURE }]) };
  await withRow({ memory: 8, adapter: "fake", page: fail }, async (row) => {
    const first = await row.warm();
    assert.equal(first.error?.name, "RemovalModelLoadError", "warmup reports the non-absorbable failure");
    assert.equal(first.memo, undefined, "no memo");
    const second = await row.warm();
    assert.equal(second.error?.name, "RemovalModelLoadError");
    assert.equal(modelLoads(await row.log(), { device: "webgpu" }).length, 2, "the failed warmup promise reset: a second attempt");
  });
  await withRow({ memory: 8, adapter: "fake", page: fail }, async (row) => {
    const refined = await row.refine();
    assert.ok(refined.error, "manual refine rejects");
    assert.equal(refined.error.name, "RemovalModelLoadError");
    assert.equal(refined.memo, undefined);
  });
});

test("C09 (worker): a warmup reports its download as it goes; a load failure rejects with no page warmup", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const warm = await row.warm({ viaClient: true });
    assert.equal(warm.settled, true, JSON.stringify(warm.error));
    assert.deepEqual(warm.fractions, [0.5, 1], "the .onnx download, through the worker");
  });
  await withRow({ memory: 8, adapter: "null", worker: { load: loadHook([{ message: FETCH_FAILURE }]) } }, async (row) => {
    const warm = await row.warm({ viaClient: true });
    assert.equal(warm.error?.name, "RemovalModelLoadError", JSON.stringify(warm));
    const log = await row.log();
    assert.ok(modelLoads(log, { ctx: "worker" }).length > 0, "the worker tried");
    assert.equal(loadsTotal(log, { ctx: "page" }), 0, "no page warmup after a real load failure");
    assert.equal(log.filter((e) => e.type === "terminate").length, 0, "the worker is kept");
  });
});

test("Q10 (warmup absorb, pins D5, default unchanged): a network failure warms BiRefNet/WASM instead", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", to: 1, message: FETCH_FAILURE }]) } },
    async (row) => {
      const warm = await row.warm();
      assert.equal(warm.settled, true, JSON.stringify(warm.error));
      assert.deepEqual(modelLoads(await row.log()).map((e) => e.device), ["webgpu", "wasm"]);
      assert.equal(warm.memo, "network");
      await row.mark();
      const job = await row.run();
      assert.equal(job.error, undefined, JSON.stringify(job.error));
      assert.equal(loadsTotal(await row.since()), 0, "a following job logs zero from_pretrained");
    },
  );
});

test("Q10 (manual-refine absorb, pins D5, default unchanged): a network failure refines on wasm; a double failure rejects", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { load: loadHook([{ device: "webgpu", message: FETCH_FAILURE }]) } },
    async (row) => {
      const refined = await row.refine();
      assert.equal(refined.error, undefined, JSON.stringify(refined.error));
      assert.equal(refined.sameBase, false, "a refined Blob");
      assert.equal(refined.memo, "network");
      assert.deepEqual(modelLoads(await row.log()).map((e) => e.device), ["webgpu", "wasm"]);
    },
  );
  await withRow(
    {
      memory: 8,
      adapter: "fake",
      page: { load: loadHook([{ device: "webgpu", message: FETCH_FAILURE }, { device: "wasm", message: FETCH_FAILURE }]) },
    },
    async (row) => {
      const refined = await row.refine();
      assert.ok(refined.error, "rejects with the wasm load error");
      assert.equal(refined.error.name, "RemovalModelLoadError");
      assert.equal(refined.memo, undefined, "a rejected absorb load sets no memo");
    },
  );
});

// ---- Q11: progress and the compute clock -----------------------------------------------------------------

test("Q11: download progress is monotonic, bounded to [0.08, 0.74] and ignores non-.onnx files", async () => {
  // The fake already reports the model's .onnx at 50% then 100% after this hook. Before them: an .onnx event at
  // 25%, a regression to 10%, and a .json at 100% that would map to 0.66 and hide the 50% value (0.37) if it
  // counted.
  const events = [
    { status: "progress", file: "onnx/model.onnx", progress: 25 },
    { status: "progress", file: "onnx/model.onnx", progress: 10 },
    { status: "progress", file: "config.json", progress: 100 },
  ];
  await withRow({ memory: 8, adapter: "null", page: { load: progressLoadHook(events) } }, async (row) => {
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const values = r.progress.map((p) => p.progress);
    for (let i = 1; i < values.length; i += 1) assert.ok(values[i] >= values[i - 1], `non-decreasing at ${i}`);
    const downloads = r.progress.filter((p) => p.message === "Preparing remover · only needed once").map((p) => p.progress);
    assert.ok(downloads.length > 0, "download progress reached the consumer");
    assert.ok(downloads.every((v) => v >= 0.08 - 1e-9 && v <= 0.74 + 1e-9), "bounded to [0.08, 0.74]");
    for (const percent of [25, 50, 100])
      assert.ok(
        downloads.some((v) => near(v, 0.08 + (percent / 100) * 0.58)),
        `onnx ${percent}% is reported (the .json 100% did not count)`,
      );
  });
});

test("C10: after a WebGPU download fails at 100 %, the absorbing WASM download's progress is shown", async () => {
  const failAfterDownload = `async (call) => {
    if (call.kind !== "model" || call.device !== "webgpu" || call.attempt > 1) return;
    call.progress({ status: "progress", file: call.file, progress: 100 });
    throw new Error(${JSON.stringify(NETWORK_503)});
  }`;
  await withRow({ memory: 8, adapter: "fake", page: { load: failAfterDownload } }, async (row) => {
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.provider, "wasm");
    const downloads = r.progress.filter((p) => p.message === "Preparing remover · only needed once").map((p) => p.progress);
    // WebGPU's 100 % (0.66), then WASM's 50 % (0.37) and 100 %: the restart is not held to the failed mark.
    assert.equal(downloads.length, 3, `downloads: ${downloads.join(", ")}`);
    [0.66, 0.37, 0.66].forEach((want, i) => assert.ok(near(downloads[i], want), `tick ${i}: ${downloads[i]}`));
  });
});

test("Q11: the compatibility compute clock excludes the load", async () => {
  // The wasm model load advances the page clock by 13 s with no real sleep. If the clock started before the
  // load, the 12 s global-inference rule would zero the crop budget; it must stay at Auto/wasm's 1.
  const rules = [
    { match: { device: "webgpu" }, do: { flat: 0.01 } },
    { match: { device: "wasm", deviceCall: 1 }, do: { rect: [0.333, 0.375, 0.433, 0.625], inside: 1, outside: 0 } },
  ];
  await withRow(
    { memory: 8, adapter: "fake", page: { mask: maskHook(rules), load: progressLoadHook([], 13_000) } },
    async (row) => {
      const r = await row.run();
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.prov.compat.attempted, true);
      assert.equal(r.prov.cropBudget, 1, "the budget is Auto/wasm's, not the detected crop count and not zero");
    },
  );
});

// ---- Q12: the worker envelope --------------------------------------------------------------------------

/** The five Q12 rows share these checks: no page inference, worker retained, the caller gets the named error. */
async function assertWorkerRetained(row, r, name) {
  assert.ok(r.error, "the caller gets an error");
  assert.equal(r.error.name, name);
  const log = await row.log();
  assert.equal(loadsTotal(log, { ctx: "page" }), 0, "zero page from_pretrained");
  assert.equal(log.filter((e) => e.type === "terminate").length, 0, "the worker is retained (no terminate)");
  return log;
}

test("Q12: a worker terminal load failure (init class) replaces the worker once, WASM-only, and rethrows by name", async () => {
  await requireSmoke();
  await withRow(
    { memory: 8, adapter: "fake", worker: { load: loadHook([{ message: INIT_FAILURE }]) } },
    async (row) => {
      const r = await row.auto({ classify: true });
      assert.equal(r.error?.name, "RemovalModelLoadError");
      assert.deepEqual(r.error.classified, { code: "model", retryable: true });
      const log = await row.log();
      assert.equal(loadsTotal(log, { ctx: "page" }), 0, "zero page from_pretrained");
      // E05-03: a WebGPU session that would not start poisons its worker; the fresh one skips WebGPU and
      // keeps its own primary and compatibility attempt. It is retained after that engine error.
      assert.equal(log.filter((e) => e.type === "terminate").length, 1, "only the poisoned worker is retired");
      assert.deepEqual(modelLoads(log, { ctx: "worker" }).map((e) => e.device), ["webgpu", "wasm", "wasm"]);
      assert.deepEqual((await row.posted()).filter((p) => p.type === "run").map((p) => p.noWebgpu), [false, true]);
    },
  );
});

test("Q12: a worker terminal load failure (network class) makes three loads and rethrows by name", async () => {
  await requireSmoke();
  await withRow(
    { memory: 8, adapter: "fake", worker: { load: loadHook([{ message: FETCH_FAILURE }]) } },
    async (row) => {
      const r = await row.auto();
      const log = await assertWorkerRetained(row, r, "RemovalModelLoadError");
      assert.deepEqual(modelLoads(log, { ctx: "worker" }).map((e) => e.device), ["webgpu", "wasm", "wasm"], "webgpu, absorb wasm, compatibility wasm");
    },
  );
});

test("Q12: a worker low-memory ISNet nonfinite output surfaces as MaskError without a page rerun", async () => {
  await requireSmoke();
  await withRow(
    {
      memory: 8,
      adapter: "null",
      workerEnv: { memory: 4, adapter: "null" },
      worker: { mask: maskHook([{ match: { model: "isnet" }, do: { nan: true } }]) },
    },
    async (row) => {
      const r = await row.auto();
      await assertWorkerRetained(row, r, "MaskError");
      assert.equal(r.error.message, "The model returned an invalid alpha mask");
    },
  );
});

test("Q12: a worker WebGPU flat mask with a failed compatibility load surfaces the primary MaskError", async () => {
  await requireSmoke();
  await withRow(
    {
      memory: 8,
      adapter: "fake",
      worker: {
        mask: maskHook([{ match: { device: "webgpu" }, do: { flat: 0.01 } }]),
        load: loadHook([{ device: "wasm", message: INIT_FAILURE }]),
      },
    },
    async (row) => {
      const r = await row.auto();
      await assertWorkerRetained(row, r, "MaskError");
    },
  );
});

test("Q12: a worker processor throw surfaces as RemovalInputError", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null", worker: { run: PROCESSOR_THROW_HOOK } }, async (row) => {
    const r = await row.auto();
    await assertWorkerRetained(row, r, "RemovalInputError");
    assert.equal(r.error.message, "Processor exploded", "a processor throw keeps its message verbatim");
  });
});

test("Q12: a worker processor returning an invalid tensor surfaces as RemovalInputError 'Image preprocessing failed'", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null", worker: { run: INVALID_PROCESSOR_TENSOR_HOOK } }, async (row) => {
    const r = await row.auto();
    await assertWorkerRetained(row, r, "RemovalInputError"); // worker retained, zero page loads
    assert.equal(r.error.message, "Image preprocessing failed");
  });
});

test("Q12 (N1): a worker raw inference throw is retried on the one session and surfaces as RemovalInferenceError", async () => {
  await requireSmoke();
  await withRow(
    { memory: 8, adapter: "null", worker: { mask: maskHook([{ do: { throw: "ORT session run failed" } }]) } },
    async (row) => {
      const r = await row.auto();
      const log = await assertWorkerRetained(row, r, "RemovalInferenceError");
      assert.equal(r.error.code, "inference-failed");
      assert.equal(modelLoads(log, { ctx: "worker" }).length, 1, "one processor+model pair");
      assert.equal(processorLoads(log, { ctx: "worker" }).length, 1);
      assert.equal(runsOf(log, { ctx: "worker" }).length, 2, "exactly two model runs (primary, then same-target compatibility)");
    },
  );
});

test("Q12 control: a worker decode failure still reruns the job on the page", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null", workerEnv: { createImageBitmap: DECODE_FAILURE } }, async (row) => {
    const r = await row.auto();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.method, "model");
    const log = await row.log();
    assert.equal(log.filter((e) => e.type === "terminate").length, 1, "the broken worker is terminated");
    assert.equal(modelLoads(log, { ctx: "page", model: "birefnet", device: "wasm" }).length, 1, "the page ran the job");
  });
});

test("C07: a corrupt photo fails as a decode error with no model load; the worker is kept for the next cut", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const bad = await row.auto({ corrupt: true, classify: true });
    assert.equal(bad.error?.name, "InvalidStateError", JSON.stringify(bad.error));
    assert.deepEqual(bad.error?.classified, { code: "decode", retryable: false });
    let log = await row.log();
    assert.equal(modelLoads(log).length, 0, "nothing is loaded for a file nothing can decode");
    assert.equal(log.filter((e) => e.type === "terminate").length, 0, "the worker is kept");
    const good = await row.auto();
    assert.equal(good.error, undefined, JSON.stringify(good.error));
    assert.equal(good.method, "model");
    log = await row.log();
    assert.equal(log.filter((e) => e.type === "worker-created").length, 1, "one worker for both cuts");
    assert.deepEqual(modelLoads(log).map((e) => e.ctx), ["worker"], "the next cut runs in that worker");
  });
});

// ---- C4 (a): global transfer mapping on returned pixels ----------------------------------------------

const BAND_POINTS = [[20, 40], [60, 40], [100, 40]];
const bandRules = (values) => [
  { match: { call: 1 }, do: { bands: values } },
  { match: { callFrom: 2 }, do: { throw: "crop off" } }, // crops neutralised: the pixels are the global cut
];

// A uniform mask is rejected by design on the WebGPU route (engine.ts: max - min < 0.005 is a flat mask),
// so the calibration control is the narrowest non-flat triple around 0.5 (range 0.006); design r9 sec 6 C4 (a)
// said "uniform", which the preserved original check forbids (W3-G4-verify F1).
test("C4 (a) calibration control: near-0.5 raw bands [0.497, 0.5, 0.503] return 128 at the three sample points", async () => {
  await withRow(
    { memory: 8, adapter: "fake", page: { mask: maskHook(bandRules([0.497, 0.5, 0.503])) } },
    async (row) => {
      const r = await row.run({ mode: "auto", points: BAND_POINTS });
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.provider, "webgpu", "the route is fixed to BiRefNet/WebGPU");
      r.alphas.forEach((alpha) => assert.ok(Math.abs(alpha - 128) <= 2, `raw ~0.5 -> 128 +-2, got ${alpha}`));
      assert.equal(sigmoidsOf(await row.log()).length, 0);
    },
  );
});

for (const [row, mode, memory, expected, transfer] of [
  ["a1", "quick", 8, [43, 128, 212], "fast"],
  ["a2", "auto", 3, [43, 128, 212], "fast"],
  ["a3", "auto", 8, [77, 128, 179], "quality"],
  ["a4", "auto", "missing", [77, 128, 179], "quality"],
  ["a5", "maximum", 3, [77, 128, 179], "quality"],
]) {
  test(`C4 (${row}): ${mode}, deviceMemory ${memory} maps raw [0.3, 0.5, 0.7] with the ${transfer} transfer`, async () => {
    await withRow(
      { memory, adapter: "fake", page: { mask: maskHook(bandRules([0.3, 0.5, 0.7])) } },
      async (r) => {
        const result = await r.run({ mode, points: BAND_POINTS });
        assert.equal(result.error, undefined, JSON.stringify(result.error));
        assert.equal(result.provider, "webgpu", "the route is fixed to BiRefNet/WebGPU");
        result.alphas.forEach((alpha, i) => assert.ok(Math.abs(alpha - expected[i]) <= 2, `${row} band ${i}: expected ${expected[i]} +-2, got ${alpha}`));
        assert.equal(sigmoidsOf(await r.log()).length, 0, "raw values are consumed without a sigmoid");
        assert.ok(result.prov, "C3 provenance is returned (S5)");
        assert.equal(result.prov.globalTransfer, transfer);
      },
    );
  });
}

// ---- C4 (c): crops stay on the quality transfer ----------------------------------------------------------

test("C4 (c1): on the compatibility path under a fast global, crops still use the quality transfer", async () => {
  // Its own browser: this row confirms a broken GPU (webgpuBroken), so it never shares a context.
  const own = await launchChrome();
  try {
    const rules = [
      { match: { device: "webgpu" }, do: { flat: 0.01 } },
      // The raw-empty sampler (engine.ts: stride 4*61 over 120x80, 158 samples) must see the wasm subject: the
      // 12x20 rect used before got 0 hits, so rawEmpty was true and webgpuBroken correctly false (W3-G4-verify F2).
      // x 40-64, y 24-56 (768 px) is hit 13 times and still leaves the padding room diagnostics need for a crop.
      { match: { device: "wasm", deviceCall: 1 }, do: { rect: [0.333, 0.3, 0.533, 0.7], inside: 1, outside: 0 } },
      { match: { device: "wasm", deviceCallFrom: 2 }, do: { halves: [0.3, 1.0] } },
    ];
    await withRow({ memory: 8, adapter: "fake", host: own, page: { mask: maskHook(rules) } }, async (row) => {
      const { transfer } = await row.consts();
      const r = await row.run({ mode: "auto", hist: [43, 77] });
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.ok(r.prov, "C3 provenance is returned (S5)");
      assert.equal(r.prov.globalTransfer, transfer);
      assert.equal(r.prov.globalTransfer, "fast");
      assert.equal(r.prov.cropTransfer, "quality");
      assert.ok(r.prov.cropInferences >= 1, `at least one crop inference, got ${r.prov.cropInferences}`);
      assert.equal(r.webgpuBroken, true);
      const [fast43, quality77] = r.hist;
      assert.ok(quality77 >= 10 && quality77 > fast43, `crop alpha follows quality (77: ${quality77}) not fast (43: ${fast43})`);
    });
  } finally {
    await own.close();
  }
});

test("C4 (c2): manual refine keeps the quality transfer (ISNet route)", async () => {
  await withRow(
    { memory: 3, adapter: "null", page: { mask: maskHook([{ match: { model: "isnet" }, do: { halves: [0.3, 1.0] } }]) } },
    async (row) => {
      const r = await row.refine({ hist: [43, 77] });
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      const [fast43, quality77] = r.hist;
      assert.ok(quality77 >= 50 && quality77 > 3 * fast43, `crop-region alpha ~ 77 (${quality77}), not ~ 43 (${fast43})`);
      assert.ok(r.prov, "C3 provenance is returned (S5)");
      assert.equal(r.prov.cropTransfer, "quality");
      assert.ok(r.prov.cropInferences >= 1);
    },
  );
});

// ---- Section 6: the client reports the one rendering ----------------------------------------------------

test("the worker job's client provenance records the original rendering and no sigmoid runs", async () => {
  await requireSmoke();
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const r = await row.auto();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const log = await row.log();
    assert.ok(runsOf(log, { ctx: "worker" }).length >= 1, "the job ran in the worker");
    assert.equal(sigmoidsOf(log).length, 0);
    assert.equal(r.clientProvApi, "function", "lastRemovalProvenance() exists (S6, C3)");
    assert.equal(r.clientProv.renderPolicy, "cutout-original-matte-v1");
  });
});

// ---- Zero-crop manual refine, preprocessing size, whole-job lease --------------------------------------

test("manual refine with no usable crop returns the base Blob and loads nothing", async () => {
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    for (const boxes of [
      [],
      [{ x: 0.99, y: 0.5, width: 0.5, height: 0.5 }], // normalised width min(1 - 0.99, 0.5) = 0.01 <= 0.03
      [{ x: 0.5, y: 0.98, width: 0.5, height: 0.5 }], // normalised height 0.02
    ]) {
      const r = await row.refine({ boxes });
      assert.equal(r.error, undefined, JSON.stringify(r.error));
      assert.equal(r.sameBase, true, `${JSON.stringify(boxes)} returns the identical base Blob`);
    }
    assert.equal(loadsTotal(await row.log()), 0, "zero from_pretrained");
  });
});

test("manual refine positive control: a 0.01 box is normalised to 0.04 and runs exactly one crop", async () => {
  await withRow({ memory: 8, adapter: "null" }, async (row) => {
    const r = await row.refine({ boxes: [{ x: 0.1, y: 0.1, width: 0.01, height: 0.01 }] });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.sameBase, false);
    const log = await row.log();
    assert.equal(r.prov.cropInferences, 1);
    assert.equal(runsOf(log).length, 1, "exactly one crop inference");
    assert.equal(modelLoads(log).length, 1);
    assert.equal(processorLoads(log).length, 1);
  });
});

test("large sources are preprocessed to twice the model side before the processor sees them", async () => {
  await withRow({ memory: 8, adapter: "null", page: { run: RAW_SIZE_HOOK } }, async (row) => {
    const r = await row.run({ fixture: "big", width: 3000, height: 2000, mode: "quick" });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const [first] = await row.rawSizes();
    assert.equal(Math.min(...first), 1024, "BiRefNet: short side 1024, never the full 2000");
  });
  await withRow({ memory: 3, adapter: "null", page: { run: RAW_SIZE_HOOK } }, async (row) => {
    const r = await row.run({ fixture: "big", width: 4000, height: 3000, mode: "quick" });
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    const [first] = await row.rawSizes();
    assert.equal(Math.min(...first), 2048, "ISNet: short side 2048, never the full 3000");
  });
});

test("the whole job holds one lease: no model is disposed before the crops finish", async () => {
  const smallSubjectFirst = [{ match: { call: 1 }, do: { rect: [0.333, 0.375, 0.433, 0.625] } }];
  await withRow({ memory: 8, adapter: "fake", page: { mask: maskHook(smallSubjectFirst) } }, async (row) => {
    const r = await row.run();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.ok(r.prov.cropInferences >= 1, "crops ran");
    const log = await row.log();
    assert.ok(runsOf(log).length >= 2, "the global pass and at least one crop");
    assert.equal(modelDisposes(log).length, 0, "model dispose count is 0 through the whole job");
  });
});

// ---- G1, behavioural half: the retired package is never requested -------------------------------------------

test("G1 (behavioural half): no request in any row, worker rows included, mentions the retired package", async () => {
  assert.ok(allRequests.length > 0, "the collector saw this run's requests");
  assert.ok(allRequests.some((url) => url.includes("/src/lib/engine.ts")), "and the app's own engine among them");
  // Static half: src/lib/no-bg0-import.test.ts. G1 passes only when both pass.
  assert.deepEqual(allRequests.filter((url) => /@bg0[/_]/.test(url)), []);
});


test("S3-A-ENGINE-01: device loss respawns the worker once; the page requires reload", async () => {
  const run = async (call, h) => {
    if (call.phase === "model" && call.device === "webgpu") {
      h.loseDevice();
      await new Promise(() => {});
    }
  };
  for (const adapter of ["fake", "no-f16"]) {
  await withRow({ adapter, worker: { run } }, async (row) => {
    const result = await row.auto();
    assert.equal(result.provider, "wasm");
    assert.equal(result.error, undefined);
    const log = await row.log();
    assert.equal(log.filter((event) => event.type === "worker-created").length, 2);
    assert.equal(log.filter((event) => event.type === "terminate").length, 1);
    assert.equal((await row.state()).record, null);
  });
  await withRow({ adapter, page: { run } }, async (row) => {
    const first = await row.run();
    assert.equal(first.error?.code, "removal-context-lost");
    assert.match(first.error?.message, /Reload/);
    assert.equal((await row.run()).error?.code, "removal-context-lost");
    assert.equal((await row.log()).filter((event) => event.type === "from_pretrained" && event.device === "wasm").length, 0);
  });
  }
});


test("C06: page and worker warmups yield a stalled download to a real job", async () => {
  const load = async (call) => {
    if (call.kind === "model" && call.attempt === 1) {
      call.emit("warmup-stalled");
      await new Promise(() => {});
    }
  };
  for (const viaClient of [false, true]) {
    await withRow({ adapter: "fake", page: { load }, worker: { load } }, async (row) => {
      const warmup = row.warm({ viaClient });
      await row.page.waitForFunction(() => globalThis.__fakeTf?.some((event) => event.type === "warmup-stalled"));
      const job = viaClient ? await row.auto() : await row.run();
      assert.equal(job.error, undefined);
      assert.equal(job.provider, "webgpu");
      assert.equal((await warmup).error?.name, "AbortError");
    });
  }
});

test("C08: pagehide releases the page engine and the next job reloads it", async () => {
  await withRow({}, async (row) => {
    const first = await row.run();
    assert.equal(first.error, undefined);
    await row.page.evaluate(() => dispatchEvent(new Event("pagehide")));
    await row.page.waitForFunction(() => globalThis.__fakeTf.some((event) => event.type === "dispose" && event.target === "model"));
    const next = await row.run();
    assert.equal(next.error, undefined);
    assert.equal(next.digest, first.digest);
    assert.equal((await row.log()).filter((event) => event.type === "from_pretrained" && event.kind === "model").length, 2);
  });
});


test("S3-B-EVIDENCE-01: junk 200 weight is evicted; a fresh worker downloads a healthy replacement", async () => {
  // Real fetch + Cache Storage with the captured ORT parse error at the model boundary.
  const load = async (call) => {
    if (call.kind !== "model" || call.device !== "webgpu") return;
    const url = "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model_fp16.onnx";
    const cache = await caches.open("transformers-cache");
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url);
      await cache.put(url, response.clone());
    }
    if (new Uint8Array(await response.arrayBuffer())[0] === 7) {
      const remove = Cache.prototype.delete;
      Cache.prototype.delete = async function (...args) {
        call.emit("cache-delete-start");
        await fetch(new URL("/__rr2_cache_delete", location.href));
        const removed = await remove.apply(this, args);
        call.emit("cache-delete-done");
        return removed;
      };
      throw new Error("Can't create a session. ERROR_CODE: 7, ERROR_MESSAGE: Failed to load model because protobuf parsing failed.");
    }
  };
  for (const viaWorker of [true, false]) {
    await withRow({ adapter: "fake", page: { load }, worker: { load } }, async (row) => {
      let downloads = 0;
      let releaseDeletion;
      const gate = new Promise((resolve) => { releaseDeletion = resolve; });
      await row.context.route("**/__rr2_cache_delete", async (route) => {
        await gate;
        await route.fulfill({ status: 200, body: "continue" });
      });
      await row.context.route("**/onnx/model_fp16.onnx", (route) => route.fulfill({
        status: 200, headers: { "access-control-allow-origin": "*", "content-type": "application/octet-stream" },
        body: Buffer.alloc(1024, ++downloads === 1 ? 7 : 1),
      }));
      if (viaWorker) {
        const pending = row.auto();
        await row.page.waitForFunction(() => globalThis.__fakeTf.some((event) => event.type === "cache-delete-start"));
        const duringDeletion = await row.log();
        releaseDeletion();
        const first = await pending;
        assert.equal(duringDeletion.filter((event) => event.type === "worker-created").length, 1);
        assert.equal(duringDeletion.filter((event) => event.type === "terminate").length, 0);
        assert.equal(first.error, undefined);
        assert.equal(first.provider, "webgpu");
        const second = await row.auto();
        assert.equal(second.digest, first.digest);
        const log = await row.log();
        assert.equal(log.filter((event) => event.type === "worker-created").length, 2);
        assert.equal(log.filter((event) => event.type === "terminate").length, 1);
        assert.equal(log.filter((event) => event.type === "from_pretrained" && event.device === "wasm").length, 0);
      } else {
        const pending = row.run();
        await row.page.waitForFunction(() => globalThis.__fakeTf.some((event) => event.type === "cache-delete-start"));
        releaseDeletion();
        const first = await pending;
        assert.equal(first.error?.code, "removal-model-damaged");
        assert.match(first.error?.message, /damaged.*removed/);
        assert.equal((await row.run()).error?.code, "removal-model-damaged");
        assert.equal(downloads, 1, "the poisoned page never starts a second session");
        await row.page.reload();
        const second = await row.run();
        assert.equal(second.error, undefined);
        assert.equal(second.provider, "webgpu");
      }
      assert.equal(downloads, 2, "the damaged cached response was actually evicted");
      assert.equal((await row.state()).record, null);
    });
  }
});


test("RR1 S3-A-ENGINE-01: loss during session loading retires the worker and poisons the page", async () => {
  const load = async (call, h) => {
    if (call.kind === "model" && call.device === "webgpu") {
      h.loseDevice();
      await new Promise(() => {});
    }
  };
  for (const adapter of ["fake", "no-f16"]) {
  await withRow({ adapter, worker: { load } }, async (row) => {
    const result = await row.auto();
    assert.equal(result.error, undefined);
    assert.equal(result.provider, "wasm");
    const log = await row.log();
    assert.equal(log.filter((event) => event.type === "worker-created").length, 2);
    assert.equal(log.filter((event) => event.type === "terminate").length, 1);
    assert.equal((await row.state()).record, null);
  });
  await withRow({ adapter, page: { load } }, async (row) => {
    const first = await row.run();
    assert.equal(first.error?.code, "removal-context-lost");
    assert.match(first.error?.message, /Reload/);
    assert.equal((await row.run()).error?.code, "removal-context-lost");
    assert.equal((await row.log()).filter((event) => event.type === "from_pretrained" && event.device === "wasm").length, 0);
  });
  }
});


test("RR1 C08: warmup downloads again after pagehide release and surfaces a later load failure", async () => {
  for (const failReload of [false, true]) {
    const load = failReload ? (call) => {
      if (call.kind === "model" && call.attempt > 1) throw new Error("WebGPU session creation failed");
    } : undefined;
    await withRow({ adapter: "fake", page: { load } }, async (row) => {
      assert.equal((await row.warm()).error, undefined);
      await row.page.evaluate(() => dispatchEvent(new Event("pagehide")));
      await row.page.waitForFunction(() => globalThis.__fakeTf.some((event) => event.type === "dispose" && event.target === "model"));
      const next = await row.warm();
      if (failReload) assert.equal(next.error?.name, "RemovalModelLoadError");
      else {
        assert.equal(next.error, undefined);
        assert.deepEqual(next.fractions, [0.5, 1]);
      }
      assert.equal((await row.log()).filter((event) => event.type === "from_pretrained" && event.kind === "model").length, 2);
    });
  }
});


test("RR2 S3-B-EVIDENCE-01: cancelling during cache deletion keeps the page realm quarantined", async () => {
  const load = async (call) => {
    if (call.kind !== "model" || call.attempt !== 1) return;
    const remove = Cache.prototype.delete;
    Cache.prototype.delete = async function (...args) {
      call.emit("cache-delete-start");
      await new Promise((resolve) => { globalThis.__finishCacheDeletion = resolve; });
      return remove.apply(this, args);
    };
    throw new Error("protobuf parsing failed");
  };
  await withRow({ adapter: "fake", page: { load } }, async (row) => {
    const first = row.run({ exposeAbort: true, mode: "quick" });
    await row.page.waitForFunction(() => typeof globalThis.__finishCacheDeletion === "function");
    await row.page.evaluate(() => { globalThis.__abortJob(); globalThis.__abortJob = undefined; });
    assert.equal((await first).error?.sameReason, true);
    const next = row.run({ exposeAbort: true, mode: "quick" });
    await row.page.waitForFunction(() => typeof globalThis.__abortJob === "function");
    const before = await row.log();
    await row.page.evaluate(() => globalThis.__finishCacheDeletion());
    const failure = await next;
    assert.equal(before.filter((event) => event.type === "from_pretrained" && event.kind === "model").length, 1);
    assert.equal(failure.error?.code, "removal-model-damaged");
    assert.match(failure.error?.message, /has been removed/);
    assert.equal((await row.log()).filter((event) => event.type === "from_pretrained" && event.kind === "model").length, 1);
    assert.equal((await row.state()).record, null);
  });
});


test("C29: a source over the processing side limit is resized before inference", async () => {
  await withRow({ adapter: "null", memory: 8 }, async (row) => {
    const result = await row.page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 20000; canvas.height = 8;
      const ctx = canvas.getContext("2d");
      const pixels = ctx.createImageData(canvas.width, canvas.height);
      for (let i = 0; i < pixels.data.length; i += 4) {
        const x = (i / 4) % canvas.width;
        pixels.data[i] = 40 + x % 170; pixels.data[i + 1] = 60 + x % 130; pixels.data[i + 2] = 90 + x % 90; pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const source = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      const { removeBackgroundLocal } = await import("/src/lib/engine.ts");
      const progress = [];
      const result = await removeBackgroundLocal(source, { mode: "quick", onProgress: (p) => progress.push(p) });
      const bitmap = await createImageBitmap(result.blob);
      const dims = [bitmap.width, bitmap.height]; bitmap.close();
      return { dims, declared: [result.width, result.height], progress };
    });
    assert.deepEqual(result.dims, [16384, 7]);
    assert.deepEqual(result.declared, result.dims);
    assert.ok(result.progress.some((p) => p.message === "Preparing at 16384×7 to fit memory"));
    assert.equal(result.progress.at(-1).progress, 1);
    assert.ok((await row.log()).filter((e) => e.type === "run").length > 0, "the resized source reaches the actual owned model path");
  });
});

test("C30 TESTS-6: an absent worker GPU API reaches the no-adapter path", async () => {
  await requireSmoke();
  await withRow({ adapter: "absent", workerEnv: { adapter: "absent" }, worker: {
    run: `(call) => { if (globalThis.navigator.gpu !== undefined) throw new Error("worker GPU API was not absent"); }`,
  } }, async (row) => {
    const r = await row.auto();
    assert.equal(r.error, undefined, JSON.stringify(r.error));
    assert.equal(r.provider, "wasm");
    assert.ok((await row.log()).some((e) => e.ctx === "worker" && e.type === "run"));
  });
});

// ---- ENG fix batch (engine-check FIX-PLAN-2) -----------------------------------------------------------

test("E05-03: a worker whose WebGPU session would not start finishes on a fresh WASM-only worker", async () => {
  await requireSmoke();
  // Transformers keeps the first session creation as its runtime init: once requestDevice throws inside
  // it, every later session in that context rethrows it, WASM included. The fake reproduces that.
  const poisoned = async (call) => {
    if (call.kind !== "model") return;
    if (call.state.poison) throw call.state.poison;
    if (call.device === "webgpu") {
      call.state.poison = new Error("no available backend found. ERR: [webgpu] OperationError: The requested device could not be created.");
      throw call.state.poison;
    }
  };
  await withRow({ adapter: "fake", worker: { load: poisoned } }, async (row) => {
    const first = await row.auto({ mode: "quick" });
    assert.equal(first.error, undefined, JSON.stringify(first.error));
    assert.equal(first.provider, "wasm");
    assert.ok(!first.progress.some((p) => p.message === SWITCHING), "no compatibility pass in the poisoned worker");
    const second = await row.auto({ mode: "quick" });
    assert.equal(second.provider, "wasm");
    const log = await row.log();
    assert.equal(log.filter((event) => event.type === "worker-created").length, 2);
    assert.equal(log.filter((event) => event.type === "terminate").length, 1);
    assert.deepEqual((await row.posted()).filter((p) => p.type === "run").map((p) => p.noWebgpu), [false, true, true]);
    assert.equal((await row.state()).record, null, "session-only: nothing persisted");
  });
  // The page has no fresh context: one compatibility attempt, then a retryable model error; no loop.
  await withRow({ adapter: "fake", page: { load: poisoned } }, async (row) => {
    const first = await row.run({ mode: "quick", classify: true });
    assert.deepEqual(first.error?.classified, { code: "model", retryable: true });
    assert.equal((await row.run({ mode: "quick" })).error?.name, "RemovalModelLoadError");
  });
});

test("E05-01: a captive portal's HTML 200 for a hub JSON is cleared from the cache and fetched again", async () => {
  await requireSmoke();
  // Real fetch + Cache Storage, as transformers' hub.js does it: the bytes are stored, then parsed.
  const load = async (call) => {
    if (call.kind !== "processor") return;
    const url = "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/preprocessor_config.json";
    const cache = await caches.open("transformers-cache");
    let response = await cache.match(url);
    if (!response) {
      response = await fetch(url);
      await cache.put(url, response.clone());
    }
    JSON.parse(await response.text());
  };
  for (const viaWorker of [true, false]) {
    for (const portalStays of [false, true]) {
      await withRow({ adapter: "fake", page: { load }, worker: { load } }, async (row) => {
        let downloads = 0;
        let portal = true;
        await row.context.route("**/preprocessor_config.json", (route) => {
          downloads += 1;
          const html = portal && (portalStays || downloads === 1);
          return route.fulfill({
            status: 200,
            headers: { "access-control-allow-origin": "*", "content-type": html ? "text/html" : "application/json" },
            body: html ? "<html><body>captive portal login</body></html>" : "{}",
          });
        });
        const job = () => (viaWorker ? row.auto({ mode: "quick" }) : row.run({ mode: "quick" }));
        const first = await job();
        const cached = await row.page.evaluate(async () => {
          const cache = await caches.open("transformers-cache");
          return Promise.all((await cache.keys()).map(async (request) => (await cache.match(request)).text()));
        });
        if (!portalStays) {
          assert.equal(first.error, undefined, JSON.stringify(first.error));
          assert.equal(downloads, 2, "fetched again after the clean, once");
          assert.deepEqual(cached, ["{}"], "the portal page is gone from the cache");
          assert.equal((await row.log()).filter((event) => event.type === "worker-created").length, viaWorker ? 1 : 0, "no worker churn");
          return;
        }
        assert.equal(first.error?.code, "removal-model-damaged");
        assert.match(first.error?.message, /damaged and has been removed/);
        assert.deepEqual(cached, [], "the portal page is not left behind");
        // A worker retries once in a fresh worker; each context loads twice.
        assert.equal(downloads, viaWorker ? 4 : 2);
        portal = false;
        const next = await job();
        assert.equal(next.error, undefined, "the context is not quarantined: the next try loads fresh");
      });
    }
  }
});

test("E03-01: the first worker crash is replaced and the job finishes in the new worker; a second takes the page", async () => {
  await requireSmoke();
  // The first `crashes` model runs anywhere throw uncaught in the worker (an `error` event, not a reply).
  const crashing = async () => {
    const n = Number(await (await fetch(new URL("/__e03_crash", location.href))).text());
    if (n <= Number(await (await fetch(new URL("/__e03_crashes", location.href))).text())) {
      setTimeout(() => { throw new Error("E03 worker crash"); });
      await new Promise(() => {});
    }
    return (u, v) => (u >= 0.25 && u < 0.75 && v >= 0.2 && v < 0.8 ? 20 : -20);
  };
  for (const crashes of [1, 2]) {
    await withRow({ adapter: "fake", worker: { mask: crashing } }, async (row) => {
      let runs = 0;
      await row.context.route("**/__e03_crash", (route) => route.fulfill({ status: 200, body: String(++runs) }));
      await row.context.route("**/__e03_crashes", (route) => route.fulfill({ status: 200, body: String(crashes) }));
      const first = await row.auto({ mode: "quick" });
      assert.equal(first.error, undefined, JSON.stringify(first.error));
      const second = await row.auto({ mode: "quick" });
      assert.equal(second.error, undefined);
      const log = await row.log();
      assert.equal(log.filter((event) => event.type === "worker-created").length, 2, "one respawn, never a third worker");
      const pageRuns = log.filter((event) => event.ctx === "page" && event.type === "run").length;
      if (crashes === 1) assert.equal(pageRuns, 0, "both jobs ran in the replacement worker");
      else assert.ok(pageRuns > 0, "the second crash moved the session to the page");
    });
  }
});
