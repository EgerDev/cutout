import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  if (specifier.endsWith("/transformers.ts") && parent.includes("depth.ts"))
    return { url: "cutout-test:depth-tf", shortCircuit: true };
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
  if (url === "cutout-test:depth-tf")
    return {
      format: "module",
      shortCircuit: true,
      source:
        "export function transformers(){return globalThis.__depthTf;} export function prefetchRuntime(){}",
    };
  return next(url, context);
}
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
globalThis.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
  const handle = nativeSetTimeout(fn, ms as number, ...args);
  if (
    typeof ms === "number" &&
    ms > 1000 &&
    handle &&
    typeof handle === "object" &&
    "unref" in handle
  )
    (handle as NodeJS.Timeout).unref();
  return handle;
}) as typeof setTimeout;

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
const MAGIC = 0x46414b45;

function encodeRaw(width: number, height: number, data: Uint8ClampedArray) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC);
  view.setUint32(4, width);
  view.setUint32(8, height);
  out.set(data, 12);
  return out;
}

function decodeRaw(bytes: Uint8Array): Pixels {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint32(4),
    height: view.getUint32(8),
    data: new Uint8ClampedArray(bytes.slice(12)),
  };
}

class FakeImageData implements Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
    if (typeof a === "number") {
      this.width = a;
      this.height = b;
      this.data = new Uint8ClampedArray(a * b * 4);
    } else {
      this.data = a;
      this.width = b;
      this.height = c ?? a.length / 4 / b;
    }
  }
}

class FakeBitmap implements Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  constructor(width: number, height: number, data: Uint8ClampedArray) {
    this.width = width;
    this.height = height;
    this.data = data;
  }
  close() {}
}

const paints = { count: 0 };

class FakeContext {
  fillStyle = "#000";
  filter = "none";
  imageSmoothingQuality = "low";
  globalCompositeOperation = "source-over";
  private readonly canvas: FakeCanvas;
  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
  }
  save() {}
  restore() {}
  translate() {}
  rotate() {}
  scale() {}
  fillRect() {}
  drawImage() {
    paints.count += 1;
  }
  getImageData(_x: number, _y: number, width: number, height: number) {
    return new FakeImageData(width, height);
  }
  putImageData() {
    paints.count += 1;
  }
  createImageData(width: number, height: number) {
    return new FakeImageData(width, height);
  }
}

class FakeCanvas implements Pixels {
  private w = 300;
  private h = 150;
  data = new Uint8ClampedArray(this.w * this.h * 4);
  private context?: FakeContext;
  get width() {
    return this.w;
  }
  set width(value: number) {
    this.w = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  get height() {
    return this.h;
  }
  set height(value: number) {
    this.h = value;
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }
  getContext() {
    return (this.context ??= new FakeContext(this));
  }
  toBlob(callback: (blob: Blob | null) => void, mime = "image/png") {
    callback(new Blob([encodeRaw(this.w, this.h, this.data)], { type: mime }));
  }
}

async function fakeCreateImageBitmap(source: Blob | Pixels) {
  if (source instanceof Blob) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    if (bytes.length >= 12) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (view.getUint32(0) === MAGIC) {
        const pixels = decodeRaw(bytes);
        return new FakeBitmap(pixels.width, pixels.height, pixels.data);
      }
    }
    return new FakeBitmap(8, 8, new Uint8ClampedArray(8 * 8 * 4).fill(255));
  }
  return new FakeBitmap(source.width, source.height, new Uint8ClampedArray(source.data));
}

Object.assign(globalThis, {
  document: { createElement: () => new FakeCanvas() },
  ImageData: FakeImageData,
  ImageBitmap: FakeBitmap,
  createImageBitmap: fakeCreateImageBitmap,
});

type RenderModule = typeof import("./render.ts");
type ModelModule = typeof import("./model.ts");
type DepthRun = ((image: unknown) => Promise<unknown>) & { dispose?: () => Promise<unknown> };

type DepthGate = {
  loads: number;
  runs: number;
  disposed: number;
  loadStarted: boolean;
  runStarted: boolean;
  finishLoad: () => void;
  finishRun: () => void;
  failLoad: (error: Error) => void;
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(cond: () => boolean, label: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 1000) throw new Error(`timed out waiting for ${label}`);
    await delay(0);
  }
}

function depthResult() {
  return { depth: { width: 2, height: 2, data: new Uint8Array(4).fill(128) } };
}

function installDepthTf(hold?: "load" | "run" | "fail"): DepthGate {
  const gate: DepthGate = {
    loads: 0,
    runs: 0,
    disposed: 0,
    loadStarted: false,
    runStarted: false,
    finishLoad: () => {},
    finishRun: () => {},
    failLoad: () => {},
  };
  const makeRun = (): DepthRun => {
    const run: DepthRun = async () => {
      gate.runs += 1;
      gate.runStarted = true;
      if (hold === "run")
        return new Promise((resolve) => {
          gate.finishRun = () => resolve(depthResult());
        });
      return depthResult();
    };
    run.dispose = async () => {
      gate.disposed += 1;
    };
    return run;
  };
  (globalThis as { __depthTf?: unknown }).__depthTf = {
    env: {},
    RawImage: { fromBlob: async () => ({ width: 8, height: 8 }) },
    pipeline: async () => {
      gate.loads += 1;
      gate.loadStarted = true;
      if (hold === "fail") throw new Error("Depth model unavailable");
      if (hold === "load")
        return new Promise((resolve, reject) => {
          gate.finishLoad = () => resolve(makeRun());
          gate.failLoad = reject;
        });
      return makeRun();
    },
  };
  return gate;
}

let renderCase = 0;
async function loadRender(): Promise<{ render: RenderModule; model: ModelModule }> {
  renderCase += 1;
  const tag = `r${renderCase}`;
  return {
    render: (await import(`./render.ts?case=${tag}`)) as RenderModule,
    model: (await import(`./model.ts?case=${tag}`)) as ModelModule,
  };
}

function photo() {
  const data = new Uint8ClampedArray(8 * 8 * 4).fill(255);
  return new File([encodeRaw(8, 8, data)], "source.png", { type: "image/png" });
}

async function promptly<T>(pending: Promise<T>, ms = 40) {
  return Promise.race([pending, delay(ms).then(() => "pending")]);
}

test("an already-aborted depth render starts no model work", async () => {
  const { render, model } = await loadRender();
  const gate = installDepthTf("load");
  const source = photo();
  const controller = new AbortController();
  const reason = new Error("preabort-render");
  controller.abort(reason);
  try {
    const result = await promptly(
      render
        .renderCanvas(
          {
            result: source,
            source,
            settings: { ...model.defaults, background: { type: "blur" }, blurDepth: true },
          },
          { signal: controller.signal },
        )
        .then(
          (canvas) => {
            canvas.width = 0;
            return "published";
          },
          (error: unknown) => error,
        ),
    );
    assert.equal(result, reason);
    assert.equal(gate.loads, 0);
  } finally {
    gate.finishLoad();
  }
});

test("abort during depth load rejects the render before fallback painting", async () => {
  const { render, model } = await loadRender();
  const gate = installDepthTf("load");
  const source = photo();
  const controller = new AbortController();
  const reason = new Error("left-load");
  try {
    const operation = render
      .renderCanvas(
        {
          result: source,
          source,
          settings: { ...model.defaults, background: { type: "blur" }, blurDepth: true },
        },
        { signal: controller.signal },
      )
      .then(
        (canvas) => {
          canvas.width = 0;
          return "published";
        },
        (error: unknown) => error,
      );
    await waitUntil(() => gate.loadStarted, "depth load");
    paints.count = 0;
    controller.abort(reason);
    assert.equal(await promptly(operation), reason);
    assert.equal(paints.count, 0);
    gate.finishLoad();
    assert.equal(await operation, reason);
    assert.equal(paints.count, 0);
    assert.equal(gate.disposed, 0);
  } finally {
    gate.finishLoad();
  }
});

test("abort during depth inference rejects the render before fallback painting", async () => {
  const { render, model } = await loadRender();
  const gate = installDepthTf("run");
  const source = photo();
  const controller = new AbortController();
  const reason = new DOMException("left-inference", "AbortError");
  try {
    const operation = render
      .renderCanvas(
        {
          result: source,
          source,
          settings: { ...model.defaults, background: { type: "blur" }, blurDepth: true },
        },
        { signal: controller.signal },
      )
      .then(
        (canvas) => {
          canvas.width = 0;
          return "published";
        },
        (error: unknown) => error,
      );
    await waitUntil(() => gate.runStarted, "depth inference");
    paints.count = 0;
    controller.abort(reason);
    assert.equal(await promptly(operation), reason);
    assert.equal(paints.count, 0);
    gate.finishRun();
    assert.equal(await operation, reason);
    assert.equal(paints.count, 0);
    assert.equal(gate.loads, 1);
    assert.equal(gate.disposed, 0);
  } finally {
    gate.finishRun();
  }
});

test("a live-signal depth failure still uses the plain blur fallback", async () => {
  const { render, model } = await loadRender();
  installDepthTf("fail");
  const source = photo();
  const canvas = await render.renderCanvas({
    result: source,
    source,
    settings: { ...model.defaults, background: { type: "blur" }, blurDepth: true },
  });
  assert.ok(canvas.width > 0);
  canvas.width = 0;
});

test("healthy depth blur still renders a canvas", async () => {
  const { render, model } = await loadRender();
  const gate = installDepthTf();
  const source = photo();
  const canvas = await render.renderCanvas({
    result: source,
    source,
    settings: { ...model.defaults, background: { type: "blur" }, blurDepth: true },
  });
  assert.ok(canvas.width > 0);
  assert.equal(gate.loads, 1);
  assert.equal(gate.runs, 1);
  canvas.width = 0;
});
