import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

test("silent enhance loads and tiles terminate, evict the worker and allow a fresh retry", async (t) => {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  const scope = new EventTarget();
  const document = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: () => ({ data: new Uint8ClampedArray(16 * 16 * 4).fill(255) }),
      }),
    }),
  });
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
  install("document", document);
  install("addEventListener", scope.addEventListener.bind(scope));
  install("removeEventListener", scope.removeEventListener.bind(scope));
  install("Worker", FakeWorker);
  install("createImageBitmap", async () => ({ width: 16, height: 16, close() {} }));
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.endsWith("/enhance.ts") && specifier === "./transformers.ts")
        return {
          shortCircuit: true,
          url: "data:text/javascript,export function transformers(){throw new Error('page fallback reached')}",
        };
      return next(specifier, context);
    },
  });
  t.after(() => {
    hook.deregister();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { enhanceFile, prepareUpscaler } = await import("./enhance.ts");
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };

  const loading = assert.rejects(prepareUpscaler(2), /page fallback reached/);
  const first = FakeWorker.instances[0]!;
  t.mock.timers.tick(119_000);
  first.receive({ type: "progress", fraction: 0.5 });
  t.mock.timers.tick(119_000);
  assert.equal(first.terminated, false, "download progress renews the inactivity deadline");
  t.mock.timers.tick(1_000);
  await loading;
  assert.equal(first.terminated, true);

  const retry = prepareUpscaler(2);
  const second = FakeWorker.instances[1]!;
  second.receive({ type: "loaded", device: "webgpu" });
  await retry;
  const tile = assert.rejects(enhanceFile(new File([], "small.png")), /stopped responding/);
  await flush();
  assert.deepEqual(
    second.sent.map((data) => data.type),
    ["load", "tile"],
  );
  t.mock.timers.tick(120_000);
  await tile;
  assert.equal(second.terminated, true);

  const final = prepareUpscaler(2);
  const third = FakeWorker.instances[2]!;
  third.receive({ type: "loaded", device: "webgpu" });
  await final;
  scope.dispatchEvent(new Event("pagehide"));
  assert.equal(third.terminated, true);
});
