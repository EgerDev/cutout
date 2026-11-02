import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  if (parent.includes("/src/lib/enhance.ts") && specifier === "./transformers.ts")
    return { url: "cutout-test:enhance-tf", shortCircuit: true };
  const resolved = await next(specifier, context);
  const tag = /[?&]case=([^&#]+)/.exec(parent)?.[1];
  const inSource =
    resolved.url.startsWith("file:") &&
    resolved.url.includes("/src/") &&
    !resolved.url.includes("node_modules");
  if (tag && inSource && !resolved.url.includes("?"))
    return { ...resolved, url: resolved.url + "?case=" + tag };
  return resolved;
}
export async function load(url, context, next) {
  if (url === "cutout-test:enhance-tf")
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function transformers(){return globalThis.__enhanceTf;} export function prefetchRuntime(){}",
    };
  return next(url, context);
}
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

type EnhanceModule = typeof import("./enhance.ts");

class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = [];
  terminated = false;
  sent: { type: string }[] = [];
  constructor() {
    super();
    FakeWorker.instances.push(this);
  }
  postMessage(data: { type: string }) {
    this.sent.push(data);
  }
  terminate() {
    this.terminated = true;
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

function installEnv(adapter: () => Promise<unknown>) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const scope = new EventTarget();
  FakeWorker.instances = [];
  install("document", Object.assign(new EventTarget(), { hidden: false }));
  install("addEventListener", scope.addEventListener.bind(scope));
  install("removeEventListener", scope.removeEventListener.bind(scope));
  install("Worker", FakeWorker);
  install("navigator", { gpu: { requestAdapter: adapter } });
  return {
    scope,
    restore() {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

let enhanceCase = 0;
async function loadEnhance(): Promise<EnhanceModule> {
  enhanceCase += 1;
  return (await import(`./enhance.ts?case=${enhanceCase}`)) as EnhanceModule;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("prepareUpscaler timeout and cancel cover a never-settling page adapter wait", async (t) => {
  const env = installEnv(() => new Promise(() => {}));
  t.after(env.restore);
  const { prepareUpscaler } = await loadEnhance();
  const worker = new Promise<FakeWorker>((resolve) => {
    const watch = setInterval(() => {
      if (FakeWorker.instances[0]) {
        clearInterval(watch);
        resolve(FakeWorker.instances[0]!);
      }
    }, 0);
  });
  const pending = prepareUpscaler(2, undefined, { timeoutMs: 30 });
  (await worker).receive({ type: "loaded", device: "wasm" });
  const started = Date.now();
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.ok(Date.now() - started < 200, "adapter wait must use the original deadline");
  env.scope.dispatchEvent(new Event("pagehide"));
});

test("prepareUpscaler cancel during adapter selection rejects without a full new budget", async (t) => {
  const env = installEnv(() => new Promise(() => {}));
  t.after(env.restore);
  const { prepareUpscaler } = await loadEnhance();
  const cancel = new AbortController();
  const pending = prepareUpscaler(2, undefined, { timeoutMs: 200, signal: cancel.signal });
  await tick(0);
  FakeWorker.instances[0]?.receive({ type: "loaded", device: "wasm" });
  await tick(5);
  cancel.abort();
  const started = Date.now();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(Date.now() - started < 100);
  env.scope.dispatchEvent(new Event("pagehide"));
});

test("worker, adapter and page load share one end-to-end deadline", async (t) => {
  let pageLoads = 0;
  (globalThis as { __enhanceTf?: unknown }).__enhanceTf = {
    env: {},
    pipeline: async () => {
      pageLoads += 1;
      await tick(60);
      return Object.assign(async () => ({ rgba: () => ({ data: new Uint8Array() }) }), {
        dispose: async () => {},
      });
    },
  };
  let adapterCalls = 0;
  const env = installEnv(async () => {
    adapterCalls += 1;
    // Slow page-compat probe only; loadPipeline's own probe stays instant.
    if (adapterCalls === 1) await tick(40);
    return { requestDevice: async () => ({}) };
  });
  t.after(env.restore);
  const { prepareUpscaler } = await loadEnhance();
  const started = Date.now();
  const pending = prepareUpscaler(2, undefined, { timeoutMs: 100 });
  await tick(10);
  FakeWorker.instances[0]?.receive({ type: "loaded", device: "wasm" });
  // Worker ~10ms + adapter ~40ms leaves ~50ms; the ~60ms page load cannot finish
  // inside the original budget and must not get a fresh one.
  await assert.rejects(pending, { name: "TimeoutError" });
  assert.equal(pageLoads, 1);
  assert.ok(Date.now() - started < 170, "page load reused a stale budget past the deadline");
  env.scope.dispatchEvent(new Event("pagehide"));
});

test("a slow worker failure falls back to the page inside the original budget", async (t) => {
  let pageLoads = 0;
  (globalThis as { __enhanceTf?: unknown }).__enhanceTf = {
    env: {},
    pipeline: async () => {
      pageLoads += 1;
      return Object.assign(async () => ({ rgba: () => ({ data: new Uint8Array() }) }), {
        dispose: async () => {},
      });
    },
  };
  const env = installEnv(async () => ({ requestDevice: async () => ({}) }));
  t.after(env.restore);
  const { prepareUpscaler } = await loadEnhance();
  const pending = prepareUpscaler(2, undefined, { timeoutMs: 80 });
  await tick(0);
  FakeWorker.instances[0]?.receive({ type: "error", message: "worker compile failed" });
  await pending;
  assert.equal(pageLoads, 1);
  env.scope.dispatchEvent(new Event("pagehide"));
});

test("already-cancelled prepareUpscaler starts no worker", async (t) => {
  const env = installEnv(async () => null);
  t.after(env.restore);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { prepareUpscaler } = await loadEnhance();
  const cancel = new AbortController();
  cancel.abort();
  await assert.rejects(prepareUpscaler(2, undefined, { signal: cancel.signal, timeoutMs: 20 }), {
    name: "AbortError",
  });
  assert.equal(FakeWorker.instances.length, 0);
  FakeWorker.instances[0]?.dispatchEvent(new Event("error"));
  await tick(10);
  assert.deepEqual(unhandled, []);
});

test("a cancelled in-flight worker load is observed and a sibling still prepares", async (t) => {
  const env = installEnv(async () => ({ requestDevice: async () => ({}) }));
  t.after(env.restore);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const { prepareUpscaler } = await loadEnhance();
  const cancel = new AbortController();
  const first = prepareUpscaler(2, undefined, { signal: cancel.signal, timeoutMs: 1_000 });
  await tick(0);
  assert.equal(FakeWorker.instances.length, 1);
  const live = prepareUpscaler(2, undefined, { timeoutMs: 1_000 });
  cancel.abort();
  await assert.rejects(first, { name: "AbortError" });
  FakeWorker.instances[0]?.receive({ type: "loaded", device: "webgpu" });
  await live;
  await tick(10);
  assert.deepEqual(unhandled, []);
  env.scope.dispatchEvent(new Event("pagehide"));
});
