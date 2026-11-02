// Node tests for the removal engine (src/lib/engine.ts) over the real runtime, pool and adapter.
//
// Only the boundary is faked: a stand-in for ./transformers.ts (the models and the processor) and a
// small DOM (canvas, ImageData, createImageBitmap) that stores pixels in plain arrays. A module hook
// gives every case its own copy of the src/lib module graph (`?case=n`), so singletons (runtime,
// pool, provider flags) never leak between cases. The hook also replaces the retired "@bg0/browser"
// specifier with a module that throws: the engine must not need it, and Node never reads the package.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { register } from "node:module";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { ConsumerProgress } from "./engine.ts";
import { classifyError } from "./errors.ts";

type EngineModule = typeof import("./engine.ts");
type RuntimeModule = typeof import("./removal-runtime.ts");
type ProviderModule = typeof import("./removal-provider.ts");

const HOOKS = `
export async function resolve(specifier, context, next) {
  if (specifier === "@bg0/browser") return { url: "cutout-test:bg0", shortCircuit: true };
  const parent = context.parentURL ?? "";
  if (specifier.endsWith("/transformers.ts") && parent.includes("/src/lib/"))
    return { url: "cutout-test:transformers", shortCircuit: true };
  const resolved = await next(specifier, context);
  const tag = /[?&]case=([^&#]+)/.exec(parent)?.[1];
  const inSource = resolved.url.startsWith("file:") && resolved.url.includes("/src/") && !resolved.url.includes("node_modules");
  if (tag && inSource && !resolved.url.includes("?")) return { ...resolved, url: resolved.url + "?case=" + tag };
  return resolved;
}
export async function load(url, context, next) {
  if (url === "cutout-test:bg0")
    return { format: "module", shortCircuit: true, source: "globalThis.__bg0Imported = true; throw new Error('@bg0/browser must not be imported');" };
  if (url === "cutout-test:transformers")
    return { format: "module", shortCircuit: true, source: "export const transformers = () => globalThis.__fakeTf; export const prefetchRuntime = () => {};" };
  return next(url, context);
}`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

// ---------------------------------------------------------------- fake DOM (pixels in arrays)

type Pixels = { width: number; height: number; data: Uint8ClampedArray };
const MAGIC = 0x46414b45;

function encodeRaw(width: number, height: number, data: Uint8ClampedArray): Uint8Array<ArrayBuffer> {
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
  if (bytes.length < 12 || view.getUint32(0) !== MAGIC)
    throw new DOMException("not an image", "InvalidStateError");
  const copy = bytes.slice(12);
  return {
    width: view.getUint32(4),
    height: view.getUint32(8),
    data: new Uint8ClampedArray(copy.buffer, copy.byteOffset, copy.byteLength),
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

function scaled(source: Pixels, width: number, height: number): Pixels {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
      const from = (sy * source.width + sx) * 4;
      data.set(source.data.subarray(from, from + 4), (y * width + x) * 4);
    }
  }
  return { width, height, data };
}

class FakeContext {
  globalCompositeOperation = "source-over";
  imageSmoothingEnabled = true;
  imageSmoothingQuality = "low";
  private readonly canvas: FakeCanvas;
  constructor(canvas: FakeCanvas) {
    this.canvas = canvas;
  }
  drawImage(source: Pixels, ...a: number[]) {
    let [sx, sy, sw, sh, dx, dy, dw, dh] = [0, 0, source.width, source.height, 0, 0, source.width, source.height];
    if (a.length === 2) [dx, dy] = a as [number, number];
    else if (a.length === 4) [dx, dy, dw, dh] = a as [number, number, number, number];
    else if (a.length === 8) [sx, sy, sw, sh, dx, dy, dw, dh] = a as [number, number, number, number, number, number, number, number];
    const target = this.canvas;
    const out = target.data;
    for (let y = 0; y < dh; y += 1) {
      const ty = Math.round(dy) + y;
      if (ty < 0 || ty >= target.height) continue;
      const fy = Math.min(source.height - 1, Math.max(0, Math.floor(sy + ((y + 0.5) * sh) / dh)));
      for (let x = 0; x < dw; x += 1) {
        const tx = Math.round(dx) + x;
        if (tx < 0 || tx >= target.width) continue;
        const fx = Math.min(source.width - 1, Math.max(0, Math.floor(sx + ((x + 0.5) * sw) / dw)));
        const from = (fy * source.width + fx) * 4;
        const to = (ty * target.width + tx) * 4;
        const sa = source.data[from + 3]!;
        if (this.globalCompositeOperation === "destination-in") {
          out[to + 3] = Math.round((out[to + 3]! * sa) / 255);
        } else if (sa === 255 || out[to + 3] === 0) {
          out.set(source.data.subarray(from, from + 4), to);
        } else if (sa > 0) {
          const k = sa / 255;
          for (let c = 0; c < 3; c += 1) out[to + c] = source.data[from + c]! * k + out[to + c]! * (1 - k);
          out[to + 3] = Math.min(255, sa + out[to + 3]! * (1 - k));
        }
      }
    }
  }
  getImageData(x: number, y: number, width: number, height: number) {
    const image = new FakeImageData(width, height);
    for (let row = 0; row < height; row += 1)
      for (let col = 0; col < width; col += 1) {
        const px = x + col;
        const py = y + row;
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) continue;
        const from = (py * this.canvas.width + px) * 4;
        image.data.set(this.canvas.data.subarray(from, from + 4), (row * width + col) * 4);
      }
    return image;
  }
  putImageData(image: Pixels, x: number, y: number) {
    for (let row = 0; row < image.height; row += 1)
      for (let col = 0; col < image.width; col += 1) {
        const px = x + col;
        const py = y + row;
        if (px < 0 || py < 0 || px >= this.canvas.width || py >= this.canvas.height) continue;
        const from = (row * image.width + col) * 4;
        this.canvas.data.set(image.data.subarray(from, from + 4), (py * this.canvas.width + px) * 4);
      }
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

async function fakeCreateImageBitmap(
  source: Blob | Pixels,
  options?: { resizeWidth?: number; resizeHeight?: number },
) {
  let pixels: Pixels;
  if (source instanceof Blob) pixels = decodeRaw(new Uint8Array(await source.arrayBuffer()));
  else pixels = { width: source.width, height: source.height, data: new Uint8ClampedArray(source.data) };
  if (options?.resizeWidth && options.resizeHeight)
    pixels = scaled(pixels, options.resizeWidth, options.resizeHeight);
  return new FakeBitmap(pixels.width, pixels.height, pixels.data);
}

Object.assign(globalThis, {
  document: { createElement: () => new FakeCanvas() },
  ImageData: FakeImageData,
  ImageBitmap: FakeBitmap,
  createImageBitmap: fakeCreateImageBitmap,
});

// ---------------------------------------------------------------- fake Transformers.js

type Ev = { type: string } & Record<string, unknown>;
type MaskSpec = number | ((u: number, v: number) => number) | Error | "missing" | "malformed" | "nonfinite";
type Fx = {
  events: Ev[];
  /** n counts the load attempts of this model on this provider, from 1. */
  loadFail?: (model: string, provider: string, n: number, dtype: string) => Error | undefined;
  mask: (ctx: { model: string; provider: string; run: number }) => MaskSpec;
  /** Runs inside every processor call; `ready` is the provider of the last model that finished loading. */
  processorHook?: (ctx: { ready: string; call: number }) => void | Promise<void>;
  processorReturns?: "corrupt";
  modelLoadHook?: (model: string, provider: string) => void;
};

const SUBJECT: MaskSpec = (u, v) => (u > 0.33 && u < 0.67 && v > 0.25 && v < 0.75 ? 1 : 0);
const bands = (a: number, b: number, c: number): MaskSpec => (u) => (u < 1 / 3 ? a : u < 2 / 3 ? b : c);
const onlyFirstRun = (first: MaskSpec) => (ctx: { run: number }): MaskSpec =>
  ctx.run === 1 ? first : new Error("crop off");

function fakeTransformers(fx: Fx) {
  const loads = new Map<string, number>();
  let ready = "";
  let processorCalls = 0;
  let runs = 0;
  let tensors = 0;
  const modelOf = (id: string) => (id.includes("isnet") ? "isnet" : "birefnet");
  const tensor = (dims: number[], value: (i: number) => number, label: string) => {
    const data = new Float32Array(dims.reduce((a, b) => a * b, 1));
    for (let i = 0; i < data.length; i += 1) data[i] = value(i);
    const id = ++tensors;
    fx.events.push({ type: "tensor", label, id });
    return {
      data,
      dims,
      dispose() {
        fx.events.push({ type: "dispose-tensor", label, id });
      },
      sigmoid() {
        fx.events.push({ type: "sigmoid" });
        return tensor(dims, (i) => 1 / (1 + Math.exp(-data[i]!)), "sigmoid-result");
      },
    };
  };
  class RawImage {
    data: Uint8ClampedArray;
    width: number;
    height: number;
    channels: number;
    constructor(data: Uint8ClampedArray, width: number, height: number, channels: number) {
      this.data = data;
      this.width = width;
      this.height = height;
      this.channels = channels;
    }
  }
  return {
    env: {},
    RawImage,
    AutoProcessor: {
      async from_pretrained(id: string, options: { revision?: string }) {
        const model = modelOf(id);
        fx.events.push({ type: "load-processor", model, revision: options.revision });
        return async (image: RawImage) => {
          processorCalls += 1;
          fx.events.push({ type: "processor-run", model, width: image.width, height: image.height });
          await fx.processorHook?.({ ready, call: processorCalls });
          if (fx.processorReturns === "corrupt") return { pixel_values: {} };
          const side = model === "isnet" ? 1024 : 512;
          return { pixel_values: tensor([1, 3, side, side], () => 0, "pixel_values") };
        };
      },
    },
    AutoModel: {
      async from_pretrained(
        id: string,
        options: { device: string; dtype: string; revision?: string; progress_callback?: (event: unknown) => void },
      ) {
        const model = modelOf(id);
        const provider = options.device;
        const key = `${model}:${provider}`;
        const n = (loads.get(key) ?? 0) + 1;
        loads.set(key, n);
        fx.events.push({ type: "load-model", model, provider, dtype: options.dtype, revision: options.revision, n });
        await fx.modelLoadHook?.(model, provider);
        options.progress_callback?.({ status: "progress", file: "config.json", progress: 100 });
        options.progress_callback?.({ status: "progress", file: "onnx/model.onnx", progress: 40 });
        options.progress_callback?.({ status: "progress", file: "onnx/model.onnx", progress: 100 });
        const failure = fx.loadFail?.(model, provider, n, options.dtype);
        if (failure) throw failure;
        ready = provider;
        fx.events.push({ type: "model-ready", model, provider });
        const side = model === "isnet" ? 1024 : 512;
        const call = async () => {
          runs += 1;
          fx.events.push({ type: "run", model, provider, run: runs });
          const spec = fx.mask({ model, provider, run: runs });
          if (spec instanceof Error) throw spec;
          if (spec === "missing") return {};
          if (spec === "malformed") return { [model === "isnet" ? "output" : "output_image"]: tensor([1, 1, 4, 4], () => 1, "output") };
          const value = (i: number) => {
            if (spec === "nonfinite") return Number.NaN;
            if (typeof spec === "number") return spec;
            return spec((i % side) / side, Math.floor(i / side) / side);
          };
          return { [model === "isnet" ? "output" : "output_image"]: tensor([1, 1, side, side], value, "output") };
        };
        return Object.assign(call, {
          dispose: async () => {
            fx.events.push({ type: "dispose-model", model, provider });
          },
        });
      },
    },
  };
}

// ---------------------------------------------------------------- environment per case

type Env = {
  fx: Fx;
  engine: EngineModule;
  runtime: RuntimeModule["removalRuntime"];
  provider: ProviderModule;
};

let caseCounter = 0;
const navigatorBefore = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** true: an adapter with `shader-f16`; "no-f16": one without; "discrete-f16": only the high-performance
 *  adapter has it, the default one (transformers' fp16 gate and ORT use that) does not. */
type AdapterMode = boolean | "no-f16" | "discrete-f16";

async function boot(
  options: { memory?: number | null; adapter?: AdapterMode; mask?: Fx["mask"] } = {},
): Promise<Env> {
  const fx: Fx = { events: [], mask: options.mask ?? (() => SUBJECT) };
  const memory = options.memory === undefined ? 8 : options.memory;
  const adapter = options.adapter ?? true;
  const f16 = { limits: {}, features: new Set(["shader-f16"]) };
  const plain = { limits: {}, features: new Set<string>() };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    writable: true,
    value: {
      userAgent: "engine-test",
      ...(memory === null ? {} : { deviceMemory: memory }),
      gpu: {
        requestAdapter: async (o?: { powerPreference?: string }) =>
          adapter === true
            ? f16
            : adapter === "no-f16"
              ? plain
              : adapter === "discrete-f16"
                ? o?.powerPreference === "high-performance" ? f16 : plain
                : null,
      },
    },
  });
  Object.assign(globalThis, { __fakeTf: fakeTransformers(fx), __bg0Imported: false });
  const tag = (caseCounter += 1);
  const engine = (await import(`./engine.ts?case=${tag}`)) as EngineModule;
  const runtime = (await import(`./removal-runtime.ts?case=${tag}`)) as RuntimeModule;
  const provider = (await import(`./removal-provider.ts?case=${tag}`)) as ProviderModule;
  provider.clearRemovalFailureRecords(null);
  return { fx, engine, runtime: runtime.removalRuntime, provider };
}

test.afterEach(() => {
  if (navigatorBefore) Object.defineProperty(globalThis, "navigator", navigatorBefore);
});

function sourceImage(width = 120, height = 80): File {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      data[i] = 40 + (x * 150) / width + ((x * y) % 17);
      data[i + 1] = 60 + (y * 130) / height + ((x + y) % 11);
      data[i + 2] = 90 + ((x * 7 + y * 13) % 90);
      data[i + 3] = 255;
    }
  return new File([encodeRaw(width, height, data)], "photo.png", { type: "image/png" });
}

type Cut = Awaited<ReturnType<EngineModule["removeBackgroundLocal"]>>;

async function cut(
  env: Env,
  options: {
    mode?: "quick" | "auto" | "maximum";
    signal?: AbortSignal;
    file?: File;
  } = {},
): Promise<{ result: Cut; progress: ConsumerProgress[] }> {
  const progress: ConsumerProgress[] = [];
  const result = await env.engine.removeBackgroundLocal(options.file ?? sourceImage(), {
    mode: options.mode ?? "auto",
    ...(options.signal ? { signal: options.signal } : {}),
    onProgress: (p) => progress.push(p),
  });
  return { result, progress };
}

async function pixelsOf(blob: Blob): Promise<Pixels> {
  return decodeRaw(new Uint8Array(await blob.arrayBuffer()));
}

function alphaAt(image: Pixels, x: number, y: number): number {
  return image.data[(y * image.width + x) * 4 + 3]!;
}

const count = (env: Env, type: string, match: Record<string, unknown> = {}) =>
  env.fx.events.filter((e) => e.type === type && Object.entries(match).every(([k, v]) => e[k] === v)).length;
const modelLoads = (env: Env, provider?: string) =>
  env.fx.events.filter((e) => e.type === "load-model" && (!provider || e.provider === provider)).length;
const fromPretrained = (env: Env) => count(env, "load-processor") + count(env, "load-model");
const sawProgress = (progress: ConsumerProgress[], stage: string, value: number) =>
  progress.some((p) => p.stage === stage && Math.abs(p.progress - value) < 1e-9);
const switching = (progress: ConsumerProgress[]) =>
  progress.some((p) => p.message === "Switching to compatibility mode");

function provenanceOf(env: Env) {
  return env.runtime.provenance() as Record<string, any> | undefined;
}

/** Every tensor the fake created was disposed exactly once. */
function assertTensorsBalanced(env: Env) {
  const made = env.fx.events.filter((e) => e.type === "tensor").map((e) => e.id as number).sort((a, b) => a - b);
  const gone = env.fx.events.filter((e) => e.type === "dispose-tensor").map((e) => e.id as number).sort((a, b) => a - b);
  assert.ok(made.every(Number.isSafeInteger), "every tensor has an instance id");
  assert.equal(new Set(made).size, made.length, "tensor ids are unique");
  assert.deepEqual(gone, made, "every tensor instance is disposed exactly once");
}

const FETCH_FAILURE = () => new Error("Failed to fetch");
const SESSION_FAILURE = () => new Error("WebGPU session creation failed");
const SERVICE_503 = () => new Error("Service unavailable error occurred while trying to load file");

// ---------------------------------------------------------------- rows

test("S5 G1: the engine never imports bg0 and needs nothing from it", async () => {
  const env = await boot();
  await cut(env, { mode: "quick" });
  assert.equal((globalThis as { __bg0Imported?: boolean }).__bg0Imported, false);
});

test("one 96x96 probe per job, closed after reading; a JPEG never takes the alpha passthrough", async () => {
  // A subject on a transparent field: as a PNG it is returned as-is; a JPEG has no alpha to trust.
  const width = 120,
    height = 80;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 20; y < 60; y += 1)
    for (let x = 30; x < 90; x += 1) data.set([200, 100, 50, 255], (y * width + x) * 4);
  const pixels = encodeRaw(width, height, data);
  const decode = globalThis.createImageBitmap;
  try {
    for (const [type, name] of [["image/png", "cut.png"], ["image/jpeg", "cut.jpg"]] as const) {
      const env = await boot();
      let probes = 0;
      let closed = 0;
      globalThis.createImageBitmap = (async (source: Blob, options?: ImageBitmapOptions) => {
        const bitmap = await decode(source, options);
        if (source instanceof Blob && options?.resizeWidth === 96 && options.resizeHeight === 96) {
          probes += 1;
          const close = bitmap.close.bind(bitmap);
          bitmap.close = () => {
            closed += 1;
            close();
          };
        }
        return bitmap;
      }) as typeof createImageBitmap;
      const { result } = await cut(env, { file: new File([pixels], name, { type }) });
      if (type === "image/png") {
        assert.equal(result.method, "passthrough");
        assert.equal(fromPretrained(env), 0, "a passthrough loads no model");
      } else {
        assert.notEqual(result.method, "passthrough", "a JPEG skips the alpha probe");
      }
      assert.equal(probes, 1, `${type}: the passthrough and graphic checks share one probe decode`);
      assert.equal(closed, 1, `${type}: the probe bitmap is closed once read`);
    }
  } finally {
    globalThis.createImageBitmap = decode;
  }
});

test("C4 (a1-a5): the global transfer follows mode and memory on returned pixels, raw values consumed", async () => {
  const rows = [
    { name: "a1 quick, 8", mode: "quick", memory: 8, expected: [43, 128, 212], transfer: "fast" },
    { name: "a2 auto, 3", mode: "auto", memory: 3, expected: [43, 128, 212], transfer: "fast" },
    { name: "a3 auto, 8", mode: "auto", memory: 8, expected: [77, 128, 179], transfer: "quality" },
    { name: "a4 auto, missing", mode: "auto", memory: null, expected: [77, 128, 179], transfer: "quality" },
    { name: "a5 maximum, 3", mode: "maximum", memory: 3, expected: [77, 128, 179], transfer: "quality" },
  ] as const;
  for (const row of rows) {
    const env = await boot({ memory: row.memory, mask: onlyFirstRun(bands(0.3, 0.5, 0.7)) });
    const { result } = await cut(env, { mode: row.mode });
    const image = await pixelsOf(result.blob);
    const sampled = [20, 60, 100].map((x) => alphaAt(image, x, 40));
    sampled.forEach((value, i) =>
      assert.ok(Math.abs(value - row.expected[i]!) <= 2, `${row.name}: band ${i} is ${value}, wanted ${row.expected[i]}`),
    );
    assert.equal(count(env, "sigmoid"), 0, `${row.name}: no sigmoid under the original policy`);
    assert.equal(provenanceOf(env)?.globalTransfer, row.transfer, row.name);
    assert.equal(result.provider, "webgpu");
    assert.equal(result.model, "birefnet", row.name);
  }
});

test("original rendering: raw logits [-2,0,2] stay raw", async () => {
  const original = await boot({ mask: onlyFirstRun(bands(-2, 0, 2)) });
  const a = await cut(original, { mode: "maximum" });
  const imageA = await pixelsOf(a.result.blob);
  [0, 0, 255].forEach((want, i) => assert.ok(Math.abs(alphaAt(imageA, [20, 60, 100][i]!, 40) - want) <= 2));
  assert.equal(count(original, "sigmoid"), 0);
  assert.equal(provenanceOf(original)?.renderPolicy, "cutout-original-matte-v1");
  assert.equal(provenanceOf(original)?.rawOutputSemantics, "logits");
  assertTensorsBalanced(original);
});

test("tensor ownership: pixel_values and output disposed once, no sigmoid result; ISNet {1,1}", async () => {
  const original = await boot();
  await cut(original, { mode: "quick" });
  assert.equal(count(original, "dispose-tensor", { label: "pixel_values" }), 1);
  assert.equal(count(original, "dispose-tensor", { label: "output" }), 1);
  assert.equal(count(original, "dispose-tensor", { label: "sigmoid-result" }), 0);
  assert.equal(count(original, "dispose-model"), 0, "the model stays loaded after the job");

  const isnet = await boot({ memory: 4, adapter: false });
  const { result } = await cut(isnet, { mode: "quick" });
  assert.equal(result.provider, "wasm");
  assert.equal(result.model, "isnet", "the outcome names the model that ran (R2-C-01)");
  assert.equal(count(isnet, "load-model", { model: "isnet", provider: "wasm" }), 1);
  assert.equal(count(isnet, "sigmoid"), 0);
  assert.equal(provenanceOf(isnet)?.model, "isnet");
  assert.equal(provenanceOf(isnet)?.rawOutputSemantics, "probabilities");
  assertTensorsBalanced(isnet);
});

test("tensor ownership on early exits: abort before the model, flat and malformed outputs", async () => {
  const aborted = await boot();
  const controller = new AbortController();
  const reason = new Error("stop");
  aborted.fx.processorHook = () => controller.abort(reason);
  await assert.rejects(cut(aborted, { signal: controller.signal, mode: "quick" }), (error) => error === reason);
  assert.equal(count(aborted, "run"), 0, "no model run after the abort");
  assertTensorsBalanced(aborted);

  const flat = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : SUBJECT) });
  await cut(flat, { mode: "quick" });
  assertTensorsBalanced(flat);

  const nonfinite = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? "nonfinite" : SUBJECT) });
  const { result } = await cut(nonfinite, { mode: "quick" });
  assert.equal(result.provider, "wasm");
  assertTensorsBalanced(nonfinite);
});

test("Q1: an opaque WebGPU inference throw is retryable and recovers on WASM without a GPU record", async () => {
  const env = await boot({
    mask: (ctx) => (ctx.provider === "webgpu" ? new Error("ORT session run failed") : SUBJECT),
  });
  const { result, progress } = await cut(env);
  assert.equal(result.provider, "wasm");
  assert.ok(switching(progress));
  assert.equal(modelLoads(env, "webgpu"), 1);
  assert.equal(modelLoads(env, "wasm"), 1);
  assert.equal(env.provider.readGpuFailure(null), false);
  assert.equal(result.webgpuBroken, false);
});

test("Q1 (F2): a WASM 'Aborted()' crash is a retryable model failure, never a cancellation", async () => {
  const env = await boot({
    adapter: false,
    mask: () => Object.assign(new Error("Aborted()"), { name: "RuntimeError" }),
  });
  const error = await cut(env).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.equal(error.name, "RemovalInferenceError");
  assert.equal((error as { code?: string }).code, "inference-failed");
  assert.equal(count(env, "run"), 2, "primary run and one same-target compatibility run");
  assert.equal(modelLoads(env), 1, "the one session is reused");
  const log = console.error;
  console.error = () => undefined; // classifyError logs what it classifies
  const failure = classifyError(error);
  console.error = log;
  assert.deepEqual(
    { code: failure.code, retryable: failure.retryable },
    { code: "model", retryable: true },
  );
  assertTensorsBalanced(env);
});

test("C05: an error named AbortError with a live signal is a failure, never a cancel; only the job's signal cancels", async () => {
  // WebGPU rejects mapAsync after a device loss with this; the worker's reply rebuilds a plain Error so named.
  const lost = () => new DOMException("Failed to execute 'mapAsync' on 'GPUBuffer': Device is lost", "AbortError");
  const named = () => Object.assign(new Error("Aborted"), { name: "AbortError" });
  const log = console.error;
  console.error = () => undefined; // classifyError logs what it classifies
  try {
    for (const [label, make] of [["DOMException", lost], ["named Error", named]] as const) {
      // On the global WebGPU run: the compatibility pass recovers the job on WASM, with no GPU record.
      const env = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? make() : SUBJECT) });
      const { result, progress } = await cut(env, { signal: new AbortController().signal });
      assert.equal(result.provider, "wasm", label);
      assert.ok(switching(progress), `${label}: one compatibility pass`);
      assert.equal(provenanceOf(env)?.compat.attempted, true, label);
      assert.equal(env.provider.readGpuFailure(null), false, label);

      // In an automatic crop: the crop is skipped and the job keeps its WebGPU cut.
      const crop = await boot({ mask: (ctx) => (ctx.provider === "webgpu" && ctx.run >= 2 ? make() : SUBJECT) });
      assert.equal((await cut(crop, { signal: new AbortController().signal })).result.provider, "webgpu", label);
      assert.ok((provenanceOf(crop)!.cropInferences as number) >= 1, `${label}: precondition, a crop ran`);

      // Everywhere: the job fails with a retryable model error instead of reading as "Stopped".
      const always = await boot({ mask: () => make() });
      const error = await cut(always, { signal: new AbortController().signal }).then(
        () => assert.fail("expected a rejection"),
        (e: unknown) => e,
      );
      assert.deepEqual(
        (({ code, retryable }) => ({ code, retryable }))(classifyError(error)),
        { code: "model", retryable: true },
        label,
      );
      assert.equal(provenanceOf(always)?.outcome, "error", `${label}: a fault record`);
    }
  } finally {
    console.error = log;
  }
});

test("Q1/Q2: a processor that returns junk is an input error; a model that returns nothing gets one compatibility attempt", async () => {
  const junk = await boot({ adapter: false });
  junk.fx.processorReturns = "corrupt";
  await assert.rejects(cut(junk), (e: Error) => e.name === "RemovalInputError" && e.message === "Image preprocessing failed");
  assert.equal(count(junk, "run"), 0);

  const missing = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? "missing" : SUBJECT) });
  const { result, progress } = await cut(missing);
  assert.equal(result.provider, "wasm");
  assert.ok(switching(progress));
  assert.equal(missing.provider.readGpuFailure(null), false, "a missing output is never a GPU record");
});

test("Q4 (o): the first network-class load failure is absorbed in the primary shape", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? SERVICE_503() : undefined);
  const first = await cut(env);
  assert.equal(first.result.provider, "wasm");
  assert.equal(first.result.method, "model");
  assert.ok(!switching(first.progress));
  assert.ok(sawProgress(first.progress, "cutting", 0.7), "processing 0.7");
  assert.ok(sawProgress(first.progress, "finishing", 0.94));
  assert.ok(!sawProgress(first.progress, "finishing", 0.92), "no compatibility fingerprint");
  assert.deepEqual(
    env.fx.events.filter((e) => e.type === "load-model").map((e) => e.provider),
    ["webgpu", "wasm"],
  );
  const p = provenanceOf(env)!;
  assert.equal(p.shape, "primary");
  assert.equal(p.absorbAttempted, true);
  assert.equal(p.compat.attempted, false);
  assert.equal(p.globalTransfer, "quality");
  assert.equal(p.cropBudget, 1, "Auto on WASM");
  assert.equal(p.provider, "wasm");
  assert.equal(p.dtype, "fp32");
  assert.equal(p.onnxFile, "model.onnx");
  assert.equal(env.provider.webgpuLoadMemo(), "network");

  const before = env.fx.events.length;
  const second = await cut(env);
  assert.equal(env.fx.events.slice(before).filter((e) => e.type.startsWith("load") || e.type.startsWith("dispose-model")).length, 0);
  assert.deepEqual(
    new Uint8Array(await second.result.blob.arrayBuffer()),
    new Uint8Array(await first.result.blob.arrayBuffer()),
    "job 2 reuses the session and returns identical bytes",
  );
  assert.equal(env.provider.readGpuFailure(null), false);
});

test("C02: real transformers hub failures and WebKit's 'Load failed' are absorbed like 503; jobs 2+ stay primary on WASM", async () => {
  const url = "https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model_fp16.onnx";
  // Verbatim from node_modules/@huggingface/transformers/src/utils/hub.js (ERROR_MAPPING, handleError).
  const rows: Array<[string, () => Error]> = [
    ["404", () => Error(`Could not locate file: "${url}".`)],
    ["403", () => Error(`Forbidden access to file: "${url}".`)],
    ["502", () => Error(`Bad gateway error occurred while trying to load file: "${url}".`)],
    ["429", () => Error(`Error (429) occurred while trying to load file: "${url}".`)],
    ["WebKit", () => new TypeError("Load failed")],
  ];
  for (const [label, failure] of rows) {
    const env = await boot();
    env.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? failure() : undefined);
    const first = await cut(env);
    assert.equal(first.result.provider, "wasm", label);
    assert.ok(!switching(first.progress), `${label}: job 1 takes no compatibility pass`);
    const p = provenanceOf(env)!;
    assert.deepEqual([p.shape, p.absorbAttempted, p.compat.attempted, p.globalTransfer], ["primary", true, false, "quality"], label);
    assert.equal(p.cropBudget, 1, `${label}: job 1 keeps its refinement`);
    assert.equal(env.provider.webgpuLoadMemo(), "network", label);
    const before = env.fx.events.length;
    const second = await cut(env);
    assert.equal(env.fx.events.slice(before).filter((e) => e.type === "load-model").length, 0, `${label}: job 2 loads nothing`);
    assert.ok(!switching(second.progress), `${label}: job 2 is not compatibility-shaped`);
    assert.deepEqual([provenanceOf(env)!.shape, provenanceOf(env)!.provider], ["primary", "wasm"], label);
    assert.equal(env.provider.readGpuFailure(null), false, label);
  }
});

test("Q4 (n), pins D5 (fetch-layer memo), default unchanged: a network failure is remembered for the session only", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider) => (provider === "webgpu" ? FETCH_FAILURE() : undefined);
  await cut(env);
  assert.equal(env.provider.webgpuLoadMemo(), "network");
  const before = env.fx.events.length;
  await cut(env);
  const added = env.fx.events.slice(before);
  assert.equal(added.filter((e) => e.type.startsWith("load") || e.type === "dispose-model").length, 0);
  env.provider.clearRemovalFailureRecords(null);
  await cut(env);
  assert.equal(modelLoads(env, "webgpu"), 2, "the memo is gone: WebGPU is attempted again");
  assert.equal(modelLoads(env, "wasm"), 2, "and absorbed again");
  assert.equal(count(env, "dispose-model", { provider: "wasm" }), 1, "the old WASM session was released first");
});

test("Q4 (p): a second consecutive load failure takes the compatibility shape; no memo after a double failure", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider, n) =>
    provider === "webgpu" || (provider === "wasm" && n === 1) ? FETCH_FAILURE() : undefined;
  const { result, progress } = await cut(env);
  assert.equal(result.provider, "wasm");
  assert.ok(switching(progress));
  const finishing = progress.filter((p) => p.stage === "finishing").map((p) => p.progress);
  assert.ok(finishing.indexOf(0.92) >= 0 && finishing.indexOf(0.92) < finishing.indexOf(0.94), "0.92 then 0.94");
  assert.ok(!sawProgress(progress, "cutting", 0.7), "no processing 0.7");
  assert.ok(sawProgress(progress, "cutting", 0.72), "processing 0.72 starts the compatibility clock after the load");
  const p = provenanceOf(env)!;
  assert.equal(p.absorbAttempted, true);
  assert.equal(p.compat.attempted, true);
  assert.equal(p.compat.transfer, "fast");
  assert.equal(p.globalTransfer, "fast");
  assert.equal(p.cropInferences, 0);
  assert.equal(p.cropBudget, 0, "direct compatibility result");
  assert.equal(modelLoads(env, "wasm"), 2, "the pool evicted the rejected WASM entry");
  assert.equal(env.provider.webgpuLoadMemo(), undefined);

  const before = env.fx.events.length;
  await cut(env);
  const added = env.fx.events.slice(before).filter((e) => e.type === "dispose-model" || e.type === "load-model");
  assert.equal(added[0]?.type, "dispose-model", "dispose(wasm) comes first");
  assert.equal(added[1]?.provider, "webgpu", "then WebGPU is attempted again");
  assert.equal(modelLoads(env, "webgpu"), 2);
  assert.equal(modelLoads(env, "wasm"), 3, "and absorbed");
  assert.equal(env.provider.webgpuLoadMemo(), "network");
});

test("Q4 (p) variant: every load fails and nothing is keyable -> the absorb's WASM error, with a fault record", async () => {
  const env = await boot();
  env.fx.loadFail = () => FETCH_FAILURE();
  const error = await cut(env).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.equal(error.name, "RemovalModelLoadError");
  assert.match(error.message, /birefnet on wasm/);
  const p = provenanceOf(env)!;
  assert.equal(p.outcome, "error");
  assert.equal(p.absorbAttempted, true);
  assert.deepEqual(p.compat, { attempted: true, transfer: "fast" });
  assert.equal(env.provider.webgpuLoadMemo(), undefined);
});

test("Q4 (m): a persistent WebGPU init failure leaves jobs 2+ compatibility-shaped with no loads", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider) => (provider === "webgpu" ? SESSION_FAILURE() : undefined);
  const one = await cut(env);
  assert.equal(one.result.provider, "wasm");
  assert.ok(switching(one.progress));
  assert.equal(provenanceOf(env)?.compat.attempted, true);
  assert.equal(env.provider.webgpuLoadMemo(), "init");
  assert.equal(env.provider.readGpuFailure(null), false);
  assert.equal(modelLoads(env, "webgpu"), 1);
  assert.equal(modelLoads(env, "wasm"), 1);
  for (const job of [2, 3]) {
    const before = env.fx.events.length;
    const { result, progress } = await cut(env);
    assert.equal(result.model, "birefnet", `job ${job}: the compatibility shape names its model`);
    const added = env.fx.events.slice(before);
    assert.equal(added.filter((e) => e.type.startsWith("load") || e.type === "dispose-model").length, 0, `job ${job}`);
    assert.ok(switching(progress), `job ${job}: transition present`);
    assert.ok(!sawProgress(progress, "cutting", 0.7), `job ${job}: no processing 0.7`);
    const p = provenanceOf(env)!;
    assert.equal(p.shape, "compat");
    assert.equal(p.compat.attempted, true);
    assert.equal(p.globalTransfer, "fast");
    assert.equal(p.cropInferences, 0);
  }
  env.provider.clearRemovalFailureRecords(null);
  await cut(env);
  assert.equal(modelLoads(env, "webgpu"), 2, "after the memo is cleared WebGPU is attempted once more");
});

test("Q4 (t): a cancel after the absorb's engine is ready keeps the memo; job 2 loads and disposes nothing", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider) => (provider === "webgpu" ? FETCH_FAILURE() : undefined);
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  let fired = false;
  env.fx.processorHook = ({ ready }) => {
    if (fired || ready !== "wasm") return;
    fired = true;
    assert.equal(env.provider.webgpuLoadMemo(), "network", "already set when the engine is ready");
    controller.abort(reason);
  };
  await assert.rejects(cut(env, { signal: controller.signal }), (e) => e === reason);
  assert.equal(env.provider.webgpuLoadMemo(), "network");
  const before = env.fx.events.length;
  await cut(env);
  const added = env.fx.events.slice(before);
  assert.equal(added.filter((e) => e.type.startsWith("load") || e.type === "dispose-model").length, 0);
  assert.equal(provenanceOf(env)?.shape, "primary");
});

test("Q4 (u): the init variant of the post-ready cancel keeps the memo and the compatibility shape", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider) => (provider === "webgpu" ? SESSION_FAILURE() : undefined);
  const controller = new AbortController();
  const reason = new Error("user cancelled");
  let fired = false;
  env.fx.processorHook = ({ ready }) => {
    if (fired || ready !== "wasm") return;
    fired = true;
    assert.equal(env.provider.webgpuLoadMemo(), "init");
    controller.abort(reason);
  };
  await assert.rejects(cut(env, { signal: controller.signal }), (e) => e === reason);
  const before = env.fx.events.length;
  const { progress } = await cut(env);
  assert.equal(env.fx.events.slice(before).filter((e) => e.type.startsWith("load") || e.type === "dispose-model").length, 0);
  assert.ok(switching(progress));
  assert.equal(provenanceOf(env)?.shape, "compat");
});

test("Q4 (v): no adapter, one WASM load failure -> one compatibility pass; no fp16, no webgpu", async () => {
  const env = await boot({ adapter: false });
  env.fx.loadFail = (_m, provider, n) => (provider === "wasm" && n === 1 ? FETCH_FAILURE() : undefined);
  const { result, progress } = await cut(env);
  assert.equal(result.provider, "wasm");
  assert.equal(result.method, "model");
  assert.ok(switching(progress));
  const finishing = progress.filter((p) => p.stage === "finishing").map((p) => p.progress);
  assert.ok(finishing.indexOf(0.92) >= 0 && finishing.indexOf(0.92) < finishing.indexOf(0.94));
  assert.ok(!sawProgress(progress, "cutting", 0.7));
  const p = provenanceOf(env)!;
  assert.equal(p.shape, "primary");
  assert.equal(p.absorbAttempted, false);
  assert.deepEqual(p.compat, { attempted: true, transfer: "fast" });
  assert.equal(p.globalTransfer, "fast");
  assert.equal(p.cropBudget, 0);
  assert.equal(p.cropInferences, 0);
  assert.equal(modelLoads(env, "webgpu"), 0);
  assert.equal(modelLoads(env, "wasm"), 2);
  assert.ok(env.fx.events.filter((e) => e.type === "load-model").every((e) => e.dtype === "fp32"), "no fp16");
  assert.equal(env.provider.webgpuLoadMemo(), undefined);
  assert.equal(env.provider.readGpuFailure(null), false);
});

test("Q4 (w): no adapter, both WASM loads fail -> the primary load error, fault record, no memo", async () => {
  const env = await boot({ adapter: false });
  env.fx.loadFail = () => FETCH_FAILURE();
  const error = await cut(env).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.equal(error.name, "RemovalModelLoadError");
  assert.equal(modelLoads(env, "wasm"), 2);
  const p = provenanceOf(env)!;
  assert.equal(p.outcome, "error");
  assert.equal(p.absorbAttempted, false);
  assert.deepEqual(p.compat, { attempted: true, transfer: "fast" });
  assert.equal(env.provider.webgpuLoadMemo(), undefined);
});

test("Q6: only a confirmed flat GPU mask is persisted; load failures and device loss are not", async () => {
  const broken = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : SUBJECT) });
  const { result, progress } = await cut(broken);
  assert.equal(result.provider, "wasm");
  assert.equal(result.webgpuBroken, true);
  assert.ok(switching(progress));
  assert.equal(broken.provider.readGpuFailure(null), true);
  assert.equal(modelLoads(broken, "webgpu"), 1);
  assert.equal(modelLoads(broken, "wasm"), 1);

  const empty = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : 0) });
  const second = await cut(empty);
  assert.equal(second.result.webgpuBroken, false, "WASM found nothing either: not a broken GPU");
  assert.equal(empty.provider.readGpuFailure(null), false);

  const lost = await boot();
  lost.fx.loadFail = (_m, provider) => (provider === "webgpu" ? new Error("WebGPU device lost") : undefined);
  const third = await cut(lost);
  assert.equal(third.result.provider, "wasm");
  assert.equal(lost.provider.readGpuFailure(null), false);
});

test("C03: the compatibility pass decides a broken GPU from memory; a failing re-encode cannot discard the WASM cut", async (t) => {
  // Control, same threshold as before: a WASM cut at alpha 12 everywhere (0.19 through the fast transfer)
  // is not "nothing" to the mask check, but is under cutoutLooksEmpty's alpha 16, so it confirms nothing.
  const faint = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : 0.19) });
  assert.equal((await cut(faint)).result.webgpuBroken, false);
  assert.equal(faint.provider.readGpuFailure(null), false);

  const env = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : SUBJECT) });
  // toBlob(null) is what a browser gives under canvas memory pressure; here only for the raw cutout's encode.
  const toBlob = FakeCanvas.prototype.toBlob;
  FakeCanvas.prototype.toBlob = function (this: FakeCanvas, callback, mime) {
    if (new Error().stack?.includes("encodeImageData")) return callback(null);
    return toBlob.call(this, callback, mime);
  };
  t.after(() => {
    FakeCanvas.prototype.toBlob = toBlob;
  });
  const { result, progress } = await cut(env);
  assert.ok(switching(progress));
  assert.deepEqual([result.provider, result.method], ["wasm", "model"]);
  assert.equal(result.webgpuBroken, true, "WebGPU's mask was flat and WASM's has a subject");
  assert.equal(env.provider.readGpuFailure(null), true);
});

test("C03: raw-alpha diagnostics preserve crops and bytes just below the Auto time cutoff", async () => {
  const now = Object.getOwnPropertyDescriptor(performance, "now");
  const floor = Math.floor;
  const rows = [];
  try {
    // Compare a zero-cost control with the reviewer's simulated 1 microsecond per diagnostic floor.
    for (const cost of [0, 0.001]) {
      const env = await boot({ adapter: true });
      let clock = 100;
      let probes = 0;
      Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
      Math.floor = (value) => {
        if (new Error().stack?.includes("at alphaLooksEmpty")) {
          probes += 1;
          clock += cost;
        }
        return floor(value);
      };
      env.fx.processorHook = ({ call }) => {
        if (call === 1) clock += 11_999;
      };
      const { result } = await cut(env);
      const provenance = provenanceOf(env)!;
      rows.push({
        provider: result.provider,
        method: result.method,
        cropBudget: provenance.cropBudget,
        cropInferences: provenance.cropInferences,
        bytes: new Uint8Array(await result.blob.arrayBuffer()),
        probes,
      });
    }
  } finally {
    Math.floor = floor;
    if (now) Object.defineProperty(performance, "now", now);
    else Reflect.deleteProperty(performance, "now");
  }
  const [control, charged] = rows;
  assert.deepEqual([control!.cropBudget, control!.cropInferences], [2, 2]);
  assert.deepEqual([charged!.cropBudget, charged!.cropInferences], [2, 2]);
  assert.deepEqual(charged, control, "diagnostic cost must not change crops or output bytes");
  assert.deepEqual([charged!.provider, charged!.method, charged!.probes], ["webgpu", "model", 0]);
  // These are the post-shadow-suppression bytes: contact-shadow attenuation alters
  // partial-alpha pixels of this fixture's matte fringe versus the pre-C03 base.
  assert.equal(createHash("sha256").update(charged!.bytes).digest("hex"),
    "19c619fdc1bf29b10f592cf6d07af9bb7e88cf78005fc909821709007e302b31");
});

test("C03: a failed raw-alpha diagnostic cannot discard the successful WASM cut", async () => {
  const env = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : SUBJECT) });
  const floor = Math.floor;
  let probes = 0;
  Math.floor = (value) => {
    if (new Error().stack?.includes("at alphaLooksEmpty")) {
      probes += 1;
      throw new Error("diagnostic unavailable");
    }
    return floor(value);
  };
  try {
    const { result } = await cut(env);
    assert.deepEqual([result.provider, result.method, result.webgpuBroken], ["wasm", "model", false]);
    assert.equal(env.provider.readGpuFailure(null), false, "an unconfirmed GPU is not recorded");
    assert.equal(probes, 1, "only the compatibility decision attempts the diagnostic");
  } finally {
    Math.floor = floor;
  }
});

test("A-01: the full-size source pixels a cut held are freed before its first crop runs (primary and compatibility)", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  const read = FakeContext.prototype.getImageData;
  try {
    for (const row of [
      { label: "primary", mask: (): MaskSpec => SUBJECT, firstCrop: 2 },
      { label: "compatibility", mask: (ctx: { provider: string }): MaskSpec => (ctx.provider === "webgpu" ? 0.01 : SUBJECT), firstCrop: 3 },
    ]) {
      const env = await boot({ mask: row.mask });
      const source = sourceImage();
      // Every full-size readback the global run made: the source pixels and the uncleaned cutout.
      const full: WeakRef<object>[] = [];
      let cropping = false;
      FakeContext.prototype.getImageData = function (...args: Parameters<typeof read>) {
        const image = read.apply(this, args);
        if (!cropping && image.width === 120 && image.height === 80) full.push(new WeakRef(image));
        return image;
      };
      let alive = -1;
      env.fx.processorHook = async ({ call }) => {
        if (call !== row.firstCrop) return;
        cropping = true;
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
        alive = full.filter((ref) => ref.deref() !== undefined).length;
      };
      const { result } = await cut(env, { file: source });
      assert.equal(result.provider, row.label === "primary" ? "webgpu" : "wasm", row.label);
      assert.ok(full.length >= 2, `${row.label}: precondition, the global run read its pixels`);
      assert.equal(alive, 0, `${row.label}: no full-size pixels of the global run survive into the crops`);
    }
  } finally {
    FakeContext.prototype.getImageData = read;
  }
});

test("C01: an automatic WebGPU crop that finds nothing writes no GPU record; job 2 stays on WebGPU", async () => {
  // Realistic background logits (every value below 0.05), a flat near-zero field, and a non-finite one:
  // the crop is skipped, but the global WebGPU run of the same job succeeded, so nothing is confirmed.
  const lowField: MaskSpec = (u, v) => -3 - 0.5 * u - 0.3 * v;
  for (const [label, crop] of [["low logits", lowField], ["flat", 0.01], ["nonfinite", "nonfinite"]] as const) {
    const env = await boot({ mask: (ctx) => (ctx.provider === "webgpu" && ctx.run >= 2 ? crop : SUBJECT) });
    const first = await cut(env);
    assert.equal(first.result.provider, "webgpu", label);
    assert.ok((provenanceOf(env)!.cropInferences as number) >= 1, `${label}: precondition, an automatic crop ran`);
    assert.equal(env.provider.readGpuFailure(null), false, `${label}: a skipped crop is not a broken GPU`);
    env.fx.mask = () => SUBJECT;
    const before = env.fx.events.length;
    const second = await cut(env);
    assert.equal(second.result.provider, "webgpu", `${label}: job 2 stays on WebGPU`);
    assert.equal(env.fx.events.slice(before).filter((e) => e.type === "load-model").length, 0, `${label}: job 2 loads nothing`);
  }
});

test("Q10: no adapter fetches only the fp32 BiRefNet/WASM pair, with the primary shape", async () => {
  const env = await boot({ adapter: false });
  const { result, progress } = await cut(env);
  assert.equal(result.provider, "wasm");
  assert.deepEqual(
    env.fx.events.filter((e) => e.type === "load-model").map((e) => [e.model, e.provider, e.dtype]),
    [["birefnet", "wasm", "fp32"]],
  );
  assert.ok(!switching(progress));
  assert.ok(sawProgress(progress, "cutting", 0.7));
  assert.equal(provenanceOf(env)?.shape, "primary");
});

test("S3-A-ENGINE-02: a no-f16 adapter runs BiRefNet/WebGPU fp32 with the former WASM crop budget", async () => {
  // Transformers' own gate, thrown before any weight is requested when the adapter lacks shader-f16.
  const fp16Gate = (_m: string, provider: string, _n: number, dtype: string) =>
    provider === "webgpu" && dtype === "fp16" ? new Error("The device (webgpu) does not support fp16.") : undefined;
  for (const adapter of ["no-f16", "discrete-f16"] as const) {
    const env = await boot({ adapter });
    env.fx.loadFail = fp16Gate;
    for (const job of [1, 2]) {
      const { result, progress } = await cut(env);
      assert.equal(result.provider, "webgpu", `${adapter} job ${job}`);
      assert.ok(!switching(progress), `${adapter} job ${job}: no compatibility pass`);
      const p = provenanceOf(env)!;
      assert.deepEqual([p.shape, p.absorbAttempted, p.compat.attempted, p.globalTransfer], ["primary", false, false, "quality"]);
      assert.equal(p.dtype, "fp32");
      assert.equal(p.cropBudget, 1, `${adapter} job ${job}: keep the former WASM budget`);
    }
    assert.deepEqual(
      env.fx.events.filter((e) => e.type === "load-model").map((e) => [e.model, e.provider, e.dtype]),
      [["birefnet", "webgpu", "fp32"]],
      `${adapter}: one BiRefNet/WebGPU fp32 load`,
    );
    assert.equal(env.provider.webgpuLoadMemo(), undefined);
    assert.equal(env.provider.readGpuFailure(null), false);
  }
  // Manual re-cut uses the same fp32 GPU route in a fresh context.
  const fresh = await boot({ adapter: "no-f16" });
  fresh.fx.loadFail = fp16Gate;
  const base = new Blob([encodeRaw(60, 40, new Uint8ClampedArray(60 * 40 * 4).fill(255))], { type: "image/png" });
  assert.ok((await fresh.engine.refineWithUserCrops(sourceImage(), base, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }])) instanceof Blob);
  assert.equal(modelLoads(fresh, "webgpu"), 1);
  // Low memory with an adapter keeps BiRefNet (the original chose ISNet only without any adapter).
  const small = await boot({ memory: 4, adapter: "no-f16" });
  await cut(small);
  assert.deepEqual(small.fx.events.filter((e) => e.type === "load-model").map((e) => [e.model, e.provider, e.dtype]), [["birefnet", "webgpu", "fp32"]]);
  // An adapter with shader-f16 is unchanged: WebGPU.
  const f16 = await boot({ adapter: true });
  assert.equal((await cut(f16)).result.provider, "webgpu");
});

test("Q10 warmup: one shared load, no compatibility path; an absorbable failure warms WASM and sets the memo", async () => {
  const plain = await boot({ adapter: false });
  const first = plain.engine.warmupBiRefNet();
  const second = plain.engine.warmupBiRefNet();
  assert.equal(first, second, "signal-free concurrent callers keep the shared promise identity");
  await Promise.all([first, second]);
  assert.equal(modelLoads(plain), 1);
  const before = plain.fx.events.length;
  await cut(plain);
  assert.equal(plain.fx.events.slice(before).filter((e) => e.type === "load-model").length, 0, "the job reuses the warmed session");

  const absorb = await boot();
  absorb.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? FETCH_FAILURE() : undefined);
  await absorb.engine.warmupBiRefNet();
  assert.deepEqual(absorb.fx.events.filter((e) => e.type === "load-model").map((e) => e.provider), ["webgpu", "wasm"]);
  assert.equal(absorb.provider.webgpuLoadMemo(), "network");
  const mark = absorb.fx.events.length;
  await cut(absorb);
  assert.equal(absorb.fx.events.slice(mark).filter((e) => e.type === "load-model").length, 0);

  const init = await boot();
  init.fx.loadFail = (_m, provider) => (provider === "webgpu" ? SESSION_FAILURE() : undefined);
  await assert.rejects(init.engine.warmupBiRefNet(), { name: "RemovalModelLoadError" }, "a non-absorbable failure rejects (C09)");
  assert.equal(init.provider.webgpuLoadMemo(), undefined, "with no memo");
  await assert.rejects(init.engine.warmupBiRefNet(), { name: "RemovalModelLoadError" });
  assert.equal(modelLoads(init, "webgpu"), 2, "and warmup is attempted again");
});

test("C09: warmup reports the model download to every caller waiting on it, and rejects once the shared load fails", async () => {
  const env = await boot({ adapter: false });
  const [a, b]: number[][] = [[], []];
  await Promise.all([env.engine.warmupBiRefNet((f) => a.push(f)), env.engine.warmupBiRefNet((f) => b.push(f))]);
  assert.deepEqual(a, [0.4, 1], "the .onnx download, as a fraction");
  assert.deepEqual(b, [0.4, 1], "a second caller joins the same load and its progress");
  assert.equal(modelLoads(env), 1);
  const late: number[] = [];
  await env.engine.warmupBiRefNet((f) => late.push(f));
  assert.deepEqual(late, [1], "a later warmup rechecks the live lease and replays its ready progress");

  const failing = await boot({ adapter: false });
  failing.fx.loadFail = () => FETCH_FAILURE();
  const seen: number[] = [];
  const error = await failing.engine.warmupBiRefNet((f) => seen.push(f)).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.equal(error.name, "RemovalModelLoadError");
  assert.deepEqual(seen, [0.4, 1], "the progress it made is still reported");
  failing.fx.loadFail = undefined;
  await failing.engine.warmupBiRefNet();
  assert.equal(count(failing, "model-ready"), 1, "the cleared promise lets the next call load");
});

test("Q10/Q12: a low-memory ISNet load failure gets no compatibility pass", async () => {
  const env = await boot({ memory: 4, adapter: false });
  env.fx.loadFail = () => FETCH_FAILURE();
  const error = await cut(env).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.equal(error.name, "RemovalModelLoadError");
  assert.equal(count(env, "load-model", { model: "isnet" }), 1);
  assert.equal(count(env, "load-model", { model: "birefnet" }), 0);
  const p = provenanceOf(env)!;
  assert.equal(p.outcome, "error");
  assert.deepEqual(p.compat, { attempted: false });
});

test("Q11: loading progress comes only from .onnx files, bounded and monotonic; the compat clock excludes the load", async () => {
  const env = await boot();
  const { progress } = await cut(env, { mode: "quick" });
  const downloading = progress.filter((p) => p.message === "Preparing remover · only needed once");
  assert.equal(downloading.length, 2, "two .onnx events, the .json one is ignored");
  assert.ok(downloading.every((p) => p.progress >= 0.08 && p.progress <= 0.74));
  progress.reduce((last, p) => {
    assert.ok(p.progress >= last, `progress never decreases (${last} -> ${p.progress})`);
    return p.progress;
  }, 0);

  const clock = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0.01 : ctx.run <= 2 ? SUBJECT : new Error("crop off")) });
  const realNow = performance.now.bind(performance);
  let offset = 0;
  clock.fx.modelLoadHook = (_m, provider) => {
    if (provider === "wasm") offset += 13_000;
  };
  performance.now = () => realNow() + offset;
  try {
    await cut(clock);
  } finally {
    performance.now = realNow;
  }
  assert.equal(provenanceOf(clock)?.cropBudget, 1, "13 s of loading must not count as inference time");
});

test("C07: a file the probe could not decode and that does not decode fails as a decode error before any model load", async () => {
  const env = await boot();
  const corrupt = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 1, 2, 3])], "broken.jpg", { type: "image/jpeg" });
  const error = await cut(env, { file: corrupt }).then(
    () => assert.fail("expected a rejection"),
    (e: unknown) => e as Error,
  );
  assert.deepEqual([error.name, error.message], ["InvalidStateError", "not an image"], "the decoder's own error");
  assert.equal(fromPretrained(env), 0, "no model or processor is loaded for it");
});

test("C10: an absorbed WebGPU load failure restarts the progress band, so the WASM download's ticks reach the caller", async () => {
  const env = await boot();
  env.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? FETCH_FAILURE() : undefined);
  const { result, progress } = await cut(env, { mode: "quick" });
  assert.equal(result.provider, "wasm");
  const downloads = progress.filter((p) => p.message === "Preparing remover · only needed once").map((p) => p.progress);
  // Each load reports 40 % then 100 % of its .onnx file (0.312 and 0.66 of the bar): WebGPU's, then WASM's.
  assert.equal(downloads.length, 4, `both downloads are shown: ${downloads.join(", ")}`);
  [0.312, 0.66, 0.312, 0.66].forEach((want, i) => assert.ok(Math.abs(downloads[i]! - want) < 1e-9, `tick ${i}`));
  const after = progress.slice(progress.findIndex((p) => p.message === "Preparing remover · only needed once") + 2);
  after.reduce((last, p) => {
    assert.ok(p.progress >= last, `monotonic again after the restart (${last} -> ${p.progress})`);
    return p.progress;
  }, 0);
});

test("large photos are downscaled before the processor: short side 2x the model input", async () => {
  const env = await boot();
  await cut(env, { mode: "quick", file: sourceImage(1200, 1300) });
  const run = env.fx.events.find((e) => e.type === "processor-run")!;
  assert.equal(Math.min(run.width as number, run.height as number), 1024);
});

test("cancellation: a pre-aborted signal loads nothing; any abort is rethrown as its own reason", async () => {
  const env = await boot();
  const controller = new AbortController();
  const reason = new Error("gone");
  controller.abort(reason);
  await assert.rejects(cut(env, { signal: controller.signal }), (e) => e === reason);
  assert.equal(fromPretrained(env), 0);
});

test("manual refine: zero usable crops return the base untouched with no model work", async () => {
  const env = await boot();
  const base = new Blob([encodeRaw(2, 2, new Uint8ClampedArray(16).fill(255))], { type: "image/png" });
  const source = sourceImage();
  for (const boxes of [[], [{ x: 0.99, y: 0.5, width: 0.5, height: 0.5 }], [{ x: 0.5, y: 0.98, width: 0.5, height: 0.5 }]]) {
    assert.equal(await env.engine.refineWithUserCrops(source, base, boxes), base);
  }
  assert.equal(fromPretrained(env), 0);
});

test("manual refine: one lease, one crop inference per crop, quality transfer, no dispose until after", async () => {
  const env = await boot({ memory: 3, adapter: false, mask: () => (u) => (u < 0.5 ? 0.3 : 1) });
  const { result } = await cut(env, { mode: "quick", file: sourceImage() });
  const base = result.blob;
  const mark = env.fx.events.length;
  const refined = await env.engine.refineWithUserCrops(sourceImage(), base, [
    { x: 0.1, y: 0.1, width: 0.01, height: 0.01 },
  ]);
  assert.ok(refined instanceof Blob);
  const added = env.fx.events.slice(mark);
  assert.equal(added.filter((e) => e.type === "load-model").length, 0, "the engine from the cut is reused");
  assert.equal(added.filter((e) => e.type === "run").length, 1, "exactly one crop inference");
  assert.equal(added.filter((e) => e.type === "dispose-model").length, 0);
  const p = provenanceOf(env)!;
  assert.equal(p.cropTransfer, "quality");
  assert.equal(p.cropInferences, 1);
  assert.equal(p.renderPolicy, "cutout-original-matte-v1");
  assert.equal(count(env, "sigmoid"), 0);
});

test("C4 (c2): manual crops render with the quality transfer and no sigmoid", async () => {
  const opaque = new Blob([encodeRaw(120, 80, new Uint8ClampedArray(120 * 80 * 4).fill(255))], { type: "image/png" });
  const box = [{ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }];
  const half: MaskSpec = (u) => (u < 0.5 ? 0.3 : 1);
  const original = await boot({ memory: 3, adapter: false, mask: () => half });
  const refined = await original.engine.refineWithUserCrops(sourceImage(), opaque, box);
  const image = await pixelsOf(refined);
  const left = alphaAt(image, 40, 40);
  assert.ok(Math.abs(left - 77) <= 6, `crop region where the model said 0.3 is ${left}, wanted about 77 (quality), not 43 (fast)`);
  assert.equal(provenanceOf(original)?.cropTransfer, "quality");
  assert.equal(provenanceOf(original)?.model, "isnet");
  assert.equal(count(original, "sigmoid"), 0);
  assert.equal(provenanceOf(original)?.cropInferences, 1);
  assertTensorsBalanced(original);
});

test("manual refine: an absorbable WebGPU load failure refines on WASM; two failures reject and set no memo", async () => {
  const base = new Blob([encodeRaw(60, 40, new Uint8ClampedArray(60 * 40 * 4).fill(255))], { type: "image/png" });
  const box = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }];
  const ok = await boot();
  ok.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? FETCH_FAILURE() : undefined);
  const refined = await ok.engine.refineWithUserCrops(sourceImage(), base, box);
  assert.ok(refined instanceof Blob);
  assert.deepEqual(ok.fx.events.filter((e) => e.type === "load-model").map((e) => e.provider), ["webgpu", "wasm"]);
  assert.equal(ok.provider.webgpuLoadMemo(), "network");

  const bad = await boot();
  bad.fx.loadFail = () => FETCH_FAILURE();
  await assert.rejects(bad.engine.refineWithUserCrops(sourceImage(), base, box), (e: Error) => e.name === "RemovalModelLoadError");
  assert.equal(bad.provider.webgpuLoadMemo(), undefined);
});


test("S3-A-ENGINE-01: page device loss escapes without compat and later jobs require reload", async () => {
  const env = await boot();
  let lose!: (value: unknown) => void;
  const lost = new Promise<unknown>((resolve) => { lose = resolve; });
  (globalThis as unknown as { __fakeTf: { env: unknown } }).__fakeTf.env = { backends: { onnx: { webgpu: { device: { lost } } } } };
  env.fx.processorHook = async () => { lose({ reason: "destroyed" }); await new Promise(() => {}); };
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("page run wedged")), 100).unref());
  await assert.rejects(Promise.race([env.engine.removeBackgroundLocal(sourceImage()), deadline]), { code: "removal-context-lost" });
  await assert.rejects(env.engine.removeBackgroundLocal(sourceImage()), { code: "removal-context-lost" });
  assert.equal(modelLoads(env, "wasm"), 0, "no in-context compatibility inference");
});


test("C06: a real page job preempts stalled warmup instead of queuing behind it", async () => {
  const env = await boot();
  let started!: () => void;
  const loading = new Promise<void>((resolve) => { started = resolve; });
  let loads = 0;
  env.fx.modelLoadHook = () => {
    if (++loads === 1) { started(); return new Promise<void>(() => {}); }
  };
  const warmed = assert.rejects(env.engine.warmupBiRefNet(), { name: "AbortError" });
  await loading;
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("job blocked by warmup")), 1000).unref());
  const result = await Promise.race([cut(env, { mode: "quick" }), deadline]);
  await warmed;
  assert.equal(result.result.provider, "webgpu");
  assert.equal(loads, 2);
});


test("S3-B-EVIDENCE-01: a damaged page model requests a fresh context with no compatibility load", async () => {
  const env = await boot();
  env.fx.loadFail = () => new Error("Can't create a session. ERROR_CODE: 7, protobuf parsing failed");
  const first = await cut(env).catch((error: unknown) => error);
  assert.equal(Reflect.get(first as object, "code"), "removal-model-damaged");
  assert.match((first as Error).message, /damaged.*Delete.*reload/);
  assert.equal(classifyError(first).retryable, true);
  await assert.rejects(cut(env), { code: "removal-model-damaged" });
  assert.equal(modelLoads(env), 1);
});


test("RR1 warmup: supported Safari without AbortSignal.any can warm with a caller signal", async () => {
  const prior = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  try {
    const env = await boot();
    await env.engine.warmupBiRefNet(undefined, new AbortController().signal);
    assert.equal(modelLoads(env), 1);
  } finally { if (prior) Object.defineProperty(AbortSignal, "any", prior); }
});

test("RR1 warmup: caller abort identity and sharing survive independent cancellation", async () => {
  const env = await boot();
  let start!: () => void;
  let finish!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  env.fx.modelLoadHook = () => { start(); return new Promise<void>((resolve) => { finish = resolve; }); };
  const a = new AbortController();
  const reason = new Error("caller left");
  const first = env.engine.warmupBiRefNet(undefined, a.signal);
  const rejected = assert.rejects(first, (error) => error === reason);
  const progress: number[] = [];
  const second = env.engine.warmupBiRefNet((value) => progress.push(value));
  await started;
  a.abort(reason);
  finish();
  await rejected;
  await second;
  assert.equal(modelLoads(env), 1);
  assert.deepEqual(progress, [0.4, 1]);
});

for (const release of ["idle", "pagehide"] as const) test(`RR1 warmup: ${release} release requires fresh readiness and download progress`, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prior = Object.getOwnPropertyDescriptor(globalThis, "addEventListener");
  let hide!: () => void;
  Object.defineProperty(globalThis, "addEventListener", { configurable: true, value: (type: string, listener: () => void) => { if (type === "pagehide") hide = listener; } });
  try {
    const env = await boot();
    await env.engine.warmupBiRefNet();
    if (release === "idle") t.mock.timers.tick(60_000); else hide();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(count(env, "dispose-model"), 1);
    const progress: number[] = [];
    await env.engine.warmupBiRefNet((value) => progress.push(value));
    assert.equal(modelLoads(env), 2);
    assert.deepEqual(progress, [0.4, 1]);
    hide();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    env.fx.loadFail = () => new Error("WebGPU session creation failed");
    await assert.rejects(env.engine.warmupBiRefNet(), { name: "RemovalModelLoadError" });
  } finally {
    if (prior) Object.defineProperty(globalThis, "addEventListener", prior); else Reflect.deleteProperty(globalThis, "addEventListener");
  }
});

test("RR1 warmup: completed readiness cannot hide a fatal idle context", async () => {
  const env = await boot();
  let lose!: (value: unknown) => void;
  const lost = new Promise<unknown>((resolve) => { lose = resolve; });
  (globalThis as unknown as { __fakeTf: { env: unknown } }).__fakeTf.env = { backends: { onnx: { webgpu: { device: { lost } } } } };
  await env.engine.warmupBiRefNet();
  lose({});
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await assert.rejects(env.engine.warmupBiRefNet(), { code: "removal-context-lost" });
  assert.equal(modelLoads(env), 1);
});


test("RR1 cache: actual ORT allocation failure follows standard provider recovery, without deletion", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let deletes = 0;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { async open() { return { async delete() { deletes++; return true; } }; } } });
  try {
    const env = await boot();
    env.fx.loadFail = (_m, provider) => provider === "webgpu" ? new Error("Can't create a session. failed to allocate a buffer of size 268435456.") : undefined;
    const { result } = await cut(env, { mode: "quick" });
    assert.equal(result.provider, "wasm");
    assert.equal(deletes, 0);
    assert.equal(env.provider.readGpuFailure(null), false);
    assert.deepEqual(env.fx.events.filter((event) => event.type === "load-model").map((event) => event.provider), ["webgpu", "wasm"]);
    assert.equal((await cut(env, { mode: "quick" })).result.provider, "wasm");
    assert.equal(deletes, 0);
  } finally {
    if (prior) Object.defineProperty(globalThis, "caches", prior); else Reflect.deleteProperty(globalThis, "caches");
  }
});


test("RR1 warmup: last caller cancellation releases a stalled load and removes its signal listener", async () => {
  const { EventEmitter } = await import("node:events");
  const env = await boot();
  let start!: () => void;
  const started = new Promise<void>((resolve) => { start = resolve; });
  env.fx.modelLoadHook = () => { start(); return new Promise(() => {}); };
  const controller = new AbortController();
  const reason = new Error("warmup dismissed");
  const rejected = assert.rejects(env.engine.warmupBiRefNet(undefined, controller.signal), (error) => error === reason);
  await started;
  controller.abort(reason);
  await rejected;
  assert.equal(EventEmitter.getEventListeners(controller.signal, "abort").length, 0);
  env.fx.modelLoadHook = undefined;
  await env.engine.warmupBiRefNet();
  assert.equal(modelLoads(env), 2);
  const ready = new AbortController();
  await env.engine.warmupBiRefNet(undefined, ready.signal);
  assert.equal(EventEmitter.getEventListeners(ready.signal, "abort").length, 0);
  ready.abort(reason);
  await env.engine.warmupBiRefNet();
  assert.equal(modelLoads(env), 2);
});


for (const warmup of [false, true]) test(`RR2 cache interleaving: cancellation during deletion cannot admit another page model, warmup=${warmup}`, async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "caches");
  let started!: () => void;
  let finish!: (value: boolean) => void;
  const deletion = new Promise<boolean>((resolve) => { finish = resolve; });
  const deleting = new Promise<void>((resolve) => { started = resolve; });
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {
    async open() { return { async delete() { started(); return deletion; } }; },
  } });
  try {
    const env = await boot();
    env.fx.loadFail = () => new Error("Can't create a session. protobuf parsing failed");
    const controller = new AbortController();
    const reason = new Error("new image");
    const first = warmup ? env.engine.warmupBiRefNet(undefined, controller.signal)
      : env.engine.removeBackgroundLocal(sourceImage(), { mode: "quick", signal: controller.signal });
    void first.catch(() => {});
    await deleting;
    if (!warmup) controller.abort(reason);
    env.fx.loadFail = undefined;
    const next = cut(env, { mode: "quick" }).catch((error: unknown) => error);
    await assert.rejects(first, warmup ? { name: "AbortError" } : (error: unknown) => error === reason);
    for (let i = 0; i < 60; i++) await Promise.resolve();
    const before = modelLoads(env);
    finish(true);
    const failure = await next;
    assert.equal(before, 1, "cancellation/preemption must not unquarantine the realm");
    assert.equal(Reflect.get(failure as object, "code"), "removal-model-damaged");
    assert.match((failure as Error).message, /has been removed/);
    assert.equal(modelLoads(env), 1);
  } finally {
    finish(false);
    if (prior) Object.defineProperty(globalThis, "caches", prior);
    else Reflect.deleteProperty(globalThis, "caches");
  }
});

test("S3-A-ENGINE-03: numeric ORT OOM gets memory copy and no same-target compatibility run", async () => {
  const env = await boot({ adapter: false, mask: () => { throw 10023264; } });
  await assert.rejects(cut(env), (error) => {
    const failure = classifyError(error);
    assert.equal(failure.code, "memory"); assert.equal(failure.retryable, false);
    return true;
  });
  assert.equal(count(env, "run"), 1);
});

function floodRecoverySource(): File {
  const width = 160, height = 120;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (x > 45 && x < 115 && y > 30 && y < 90) {
      data[i] = Math.floor(rand() * 140); data[i + 1] = Math.floor(rand() * 140); data[i + 2] = Math.floor(rand() * 200);
    } else data[i] = data[i + 1] = data[i + 2] = 250;
    data[i + 3] = 255;
  }
  return new File([encodeRaw(width, height, data)], "photo.png", { type: "image/png" });
}

test("C20: a flood recovery reports the method that produced its pixels", async () => {
  const env = await boot({ adapter: false, mask: () => 0 });
  const { result } = await cut(env, { file: floodRecoverySource(), mode: "quick" });
  const pixels = await pixelsOf(result.blob);
  assert.ok(pixels.data.filter((v, i) => i % 4 === 3 && v > 16).length > 100);
  assert.equal(result.method, "flood");
  assert.equal(result.provider, "wasm", "model execution provider remains diagnostic truth");
});

/** E01-O-02: a 24x20 subject (0.4 %) on a 400x300 textured photo the border flood cannot clear. */
const TINY = { x0: 200, y0: 140, x1: 224, y1: 160 };
function tinySubjectSource(): File {
  const width = 400, height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  let seed = 99173;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, n = rand() * 16, t = y / height;
    if (x >= TINY.x0 && x < TINY.x1 && y >= TINY.y0 && y < TINY.y1) {
      data[i] = 200 + n; data[i + 1] = 40 + n; data[i + 2] = 60 + n;
    } else {
      data[i] = 110 + t * 70 + n + 40 * Math.sin(x / 41) * Math.cos(y / 53);
      data[i + 1] = 128 + t * 60 + n + 30 * Math.cos(x / 29);
      data[i + 2] = 150 + t * 50 + n + 35 * Math.sin((x + y) / 47);
    }
    data[i + 3] = 255;
  }
  return new File([encodeRaw(width, height, data)], "photo.png", { type: "image/png" });
}
/** A mask that is 1 on the source box [x0, x1) x [y0, y1) of the 400x300 frame, 0 elsewhere. */
const boxMask = (box: typeof TINY) => (u: number, v: number) =>
  u * 400 >= box.x0 && u * 400 < box.x1 && v * 300 >= box.y0 && v * 300 < box.y1 ? 1 : 0;
async function tinyCut(mask: MaskSpec, options: { adapter?: boolean; webgpu?: MaskSpec } = {}) {
  const env = await boot({
    adapter: options.adapter ?? false,
    mask: ({ provider }) => (provider === "webgpu" && options.webgpu !== undefined ? options.webgpu : mask),
  });
  const { result } = await cut(env, { file: tinySubjectSource(), mode: "quick" });
  const pixels = await pixelsOf(result.blob);
  let opaque = 0;
  for (let i = 3; i < pixels.data.length; i += 4) if (pixels.data[i]! > 128) opaque += 1;
  return { env, result, pixels, opaque };
}

test("E01-O-02: a solid subject under 0.8 % of the frame keeps the model's cut, not the border flood", async () => {
  const { result, pixels, opaque } = await tinyCut(boxMask(TINY));
  assert.deepEqual([result.provider, result.method], ["wasm", "model"]);
  assert.ok(alphaAt(pixels, 212, 150) >= 240, "the subject is kept");
  assert.equal(alphaAt(pixels, 20, 20), 0, "the background is cleared");
  assert.ok(Math.abs(opaque - 24 * 20) <= 24, `opaque pixels ${opaque}, the subject has 480`);
});

test("E01-O-02 control: an empty mask, or one with only a speck of solid cells, still takes the keying paths", async () => {
  for (const mask of [0, boxMask({ x0: 300, y0: 60, x1: 303, y1: 62 })]) {
    const { result, opaque } = await tinyCut(mask);
    assert.equal(result.method, "flood", "the flood's own result, as before");
    assert.ok(opaque > 400 * 300 * 0.5, `the flood leaves most of this texture: ${opaque}`);
  }
});

test("E01-O-02: a weak tiny matte, even with one opaque peak, still takes the flood", async () => {
  for (const peak of [false, true]) {
    const { result, opaque } = await tinyCut((u, v) => {
      if (peak && Math.abs(u - 0.53) < 0.002 && Math.abs(v - 0.5) < 0.002) return 1;
      return boxMask(TINY)(u, v) ? 0.65 : 0;
    });
    assert.equal(result.method, "flood", "a few uncertain cells do not establish a near-opaque core");
    assert.ok(opaque > 400 * 300 * 0.5);
  }
});

test("E01-O-02: a confident raw core erased by cleaning still takes the flood", async (t) => {
  const encode = FakeCanvas.prototype.toBlob;
  let cleaned: { solid: number; visible: number } | undefined;
  FakeCanvas.prototype.toBlob = function (callback, mime) {
    if (!cleaned && this.width === 400 && this.height === 300) {
      cleaned = { solid: 0, visible: 0 };
      for (let i = 3; i < this.data.length; i += 4) {
        if (this.data[i]! >= 239) cleaned.solid += 1;
        if (this.data[i]! > 16) cleaned.visible += 1;
      }
    }
    return encode.call(this, callback, mime);
  };
  t.after(() => { FakeCanvas.prototype.toBlob = encode; });
  const subject = boxMask(TINY);
  let rawSolid = 0;
  const { result, opaque } = await tinyCut((u, v) => {
    if (subject(u, v) && Math.floor(u * 512) % 2 === 0) { rawSolid += 1; return 1; }
    return 0;
  });
  assert.ok(rawSolid >= 128, "the raw model mask has a confident core");
  assert.ok(cleaned && cleaned.visible > 0 && cleaned.solid < 400 * 300 / 2048,
    `cleaning left a weak matte: ${JSON.stringify(cleaned)}`);
  assert.equal(result.method, "flood");
  assert.ok(opaque > 400 * 300 * 0.5);
});

test("E01-O-02: a tiny WASM subject after a flat WebGPU mask is kept but records no broken GPU", async () => {
  const { env, result, pixels } = await tinyCut(boxMask(TINY), { adapter: true, webgpu: 0.01 });
  assert.deepEqual([result.provider, result.method, result.webgpuBroken], ["wasm", "model", false]);
  assert.ok(alphaAt(pixels, 212, 150) >= 240);
  assert.equal(alphaAt(pixels, 20, 20), 0);
  assert.equal(env.provider.readGpuFailure(null), false, "a subject this small cannot confirm the GPU is broken");
});

test("C21: cold manual refine emits download progress and terminal completion", async () => {
  const env = await boot({ adapter: false });
  const seen: ConsumerProgress[] = [];
  const base = sourceImage();
  await env.engine.refineWithUserCrops(sourceImage(), base, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }], { onProgress: (p) => seen.push(p) });
  assert.ok(seen.some((p) => p.stage === "loading" && p.progress > 0 && p.progress < 0.7));
  assert.equal(seen.at(-1)?.progress, 1);
  assert.ok(seen.every((p, i) => i === 0 || p.progress >= seen[i - 1]!.progress));
});

test("C24: failed manual refine records this job's route and absorb attempt; abort records nothing", async () => {
  const env = await boot();
  env.fx.loadFail = () => FETCH_FAILURE();
  const boxes = [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }];
  await assert.rejects(env.engine.refineWithUserCrops(sourceImage(), sourceImage(), boxes));
  const p = provenanceOf(env)!;
  assert.equal(p.outcome, "error");
  assert.deepEqual(p.route, { model: "birefnet", provider: "webgpu" });
  assert.equal(p.absorbAttempted, true);
  assert.deepEqual(p.compat, { attempted: false });
  assert.equal(p.ranOn, undefined, "neither load became ready");
  const controller = new AbortController(); controller.abort(new Error("gone"));
  await assert.rejects(env.engine.refineWithUserCrops(sourceImage(), sourceImage(), boxes, { signal: controller.signal }), (e) => e === controller.signal.reason);
  assert.equal(provenanceOf(env), p, "an abort writes no record");
});

test("C25: an overlapping page passthrough cannot claim another job's provenance", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
  t.after(() => { if (saved) Object.defineProperty(globalThis, "Worker", saved); else Reflect.deleteProperty(globalThis, "Worker"); });
  const env = await boot({ adapter: false });
  const client = await import(`./removal-client.ts?case=${caseCounter}`) as typeof import("./removal-client.ts");
  let releaseA!: () => void, startA!: () => void, releaseB!: () => void, startB!: () => void;
  const aGate = new Promise<void>((r) => { releaseA = r; });
  const aStarted = new Promise<void>((r) => { startA = r; });
  const bGate = new Promise<void>((r) => { releaseB = r; });
  const bStarted = new Promise<void>((r) => { startB = r; });
  env.fx.processorHook = async ({ call }) => { if (call === 1) { startA(); await aGate; } };
  const transparent = new File([encodeRaw(120, 80, new Uint8ClampedArray(120 * 80 * 4))], "empty.png", { type: "image/png" });
  const bitmap = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async (source: Blob, ...args: unknown[]) => {
    if (source === transparent) { startB(); await bGate; }
    return (bitmap as any)(source, ...args);
  }) as typeof createImageBitmap;
  t.after(() => { globalThis.createImageBitmap = bitmap; });
  const a = client.removeBackgroundAuto(sourceImage(), { mode: "quick" });
  await aStarted;
  const b = client.removeBackgroundAuto(transparent);
  await bStarted;
  releaseA(); await a;
  assert.equal((client.lastRemovalProvenance() as { model: string }).model, "birefnet");
  releaseB();
  assert.equal((await b).method, "passthrough");
  assert.equal(client.lastRemovalProvenance(), undefined);
});

test("C24 C25: a page-client refine failure exposes only its own fault handoff", async (t) => {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: undefined });
  t.after(() => { if (saved) Object.defineProperty(globalThis, "Worker", saved); else Reflect.deleteProperty(globalThis, "Worker"); });
  const env = await boot();
  const client = await import(`./removal-client.ts?case=${caseCounter}`) as typeof import("./removal-client.ts");
  env.fx.loadFail = () => FETCH_FAILURE();
  await assert.rejects(client.refineCropsAuto(sourceImage(), sourceImage(), [{ x: 0.1, y: 0.1, width: 0.4, height: 0.4 }]));
  assert.equal(client.lastRemovalProvenance(), env.runtime.provenance());
  assert.equal((client.lastRemovalProvenance() as { outcome: string }).outcome, "error");
  assert.equal(await client.refineCropsAuto(sourceImage(), sourceImage(), [] ) instanceof Blob, true);
  assert.equal(client.lastRemovalProvenance(), undefined, "a later no-op clears this client's prior fault");
});

test("C30 ENGINE-07: compatibility download restarts below the failed run's high watermark", async () => {
  const env = await boot({ mask: ({ provider }) => provider === "webgpu" ? 0.01 : SUBJECT });
  const { progress } = await cut(env, { mode: "quick" });
  const switchAt = progress.findIndex((p) => p.message === "Switching to compatibility mode");
  assert.ok(switchAt > 0);
  assert.deepEqual(progress.slice(switchAt + 1).filter((p) => p.message === COPY_DOWNLOAD).map((p) => Math.round(p.progress * 1000) / 1000), [0.312, 0.66]);
});
const COPY_DOWNLOAD = "Preparing remover · only needed once";

test("C30 TESTS-4: tensor assertion rejects a same-label leak hidden by a double disposal", async () => {
  const env = await boot();
  env.fx.events = [
    { type: "tensor", label: "output", id: 1 }, { type: "tensor", label: "output", id: 2 },
    { type: "dispose-tensor", label: "output", id: 2 }, { type: "dispose-tensor", label: "output", id: 2 },
  ];
  assert.throws(() => assertTensorsBalanced(env));
});

test("C30 TESTS-8: actual default factories pass pinned revisions and route dtypes", async () => {
  for (const route of [
    { memory: 8, adapter: true, model: "birefnet", provider: "webgpu", dtype: "fp16", revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7" },
    { memory: 8, adapter: false, model: "birefnet", provider: "wasm", dtype: "fp32", revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7" },
    { memory: 4, adapter: false, model: "isnet", provider: "wasm", dtype: "fp16", revision: "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f" },
  ]) {
    const env = await boot(route);
    await env.engine.warmupBiRefNet();
    const proc = env.fx.events.find((e) => e.type === "load-processor")!;
    const model = env.fx.events.find((e) => e.type === "load-model")!;
    assert.deepEqual([proc.model, proc.revision], [route.model, route.revision]);
    assert.deepEqual([model.model, model.provider, model.revision, model.dtype], [route.model, route.provider, route.revision, route.dtype]);
  }
});

test("C16: malformed WebGPU output is confirmed by WASM and later jobs skip GPU", async () => {
  const env = await boot({ mask: ({ provider }) => provider === "webgpu" ? "malformed" : SUBJECT });
  const first = await cut(env, { mode: "quick" });
  assert.equal(first.result.webgpuBroken, true);
  assert.equal(first.result.model, "birefnet");
  const loads = modelLoads(env, "webgpu");
  const second = await cut(env, { mode: "quick" });
  assert.equal(second.result.provider, "wasm");
  assert.equal(modelLoads(env, "webgpu"), loads);
  assert.equal(env.provider.readGpuFailure(null), true);
});

test("C30 TESTS-4: separate crop tensors with the same label are each disposed once", async () => {
  const env = await boot({ adapter: false });
  await env.engine.refineWithUserCrops(sourceImage(), sourceImage(), [
    { x: 0.1, y: 0.1, width: 0.3, height: 0.4 },
    { x: 0.6, y: 0.4, width: 0.3, height: 0.4 },
  ]);
  assert.equal(count(env, "run"), 2);
  assertTensorsBalanced(env);
});

test("E05-03: in a worker, a WebGPU session that would not start asks for a fresh WASM context instead of a compatibility pass here", async (t) => {
  t.mock.method(console, "error", () => undefined);
  // Transformers keeps the first session creation as its runtime init: once that rejects, every
  // later session in the same JS context fails too. Only a fresh worker can run WASM.
  Object.defineProperty(globalThis, "WorkerGlobalScope", { configurable: true, value: class {} });
  try {
    const env = await boot();
    env.fx.loadFail = (_m, provider) => (provider === "webgpu" ? SESSION_FAILURE() : undefined);
    const progress: ConsumerProgress[] = [];
    const error = await env.engine.removeBackgroundLocal(sourceImage(), { onProgress: (p: ConsumerProgress) => progress.push(p) }).catch((e: unknown) => e);
    assert.equal(Reflect.get(error as object, "code"), "removal-webgpu-init-failed");
    assert.equal(Reflect.get((error as Error).cause as object, "name"), "RemovalModelLoadError", "the load error rides as the cause");
    assert.equal(modelLoads(env, "wasm"), 0, "no WASM session in this context");
    assert.ok(!switching(progress));
    assert.equal(provenanceOf(env)?.outcome, "error");
    assert.equal(env.provider.readGpuFailure(null), false, "nothing recorded: the fresh context decides");
    const failure = classifyError(error);
    assert.deepEqual([failure.code, failure.retryable], ["model", true]);
    assert.equal(failure.message, "The local remover couldn’t use this device’s graphics. Try again.");

    const base = new Blob([encodeRaw(60, 40, new Uint8ClampedArray(60 * 40 * 4).fill(255))], { type: "image/png" });
    await assert.rejects(env.engine.refineWithUserCrops(sourceImage(), base, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }]), { code: "removal-webgpu-init-failed" });
    await assert.rejects(env.engine.warmupBiRefNet(), { code: "removal-webgpu-init-failed" });
    assert.equal(modelLoads(env, "wasm"), 0);

    // A network-class WebGPU load failure is still absorbed on WASM in place: no fresh context.
    const network = await boot();
    network.fx.loadFail = (_m, provider, n) => (provider === "webgpu" && n === 1 ? FETCH_FAILURE() : undefined);
    assert.equal((await cut(network)).result.provider, "wasm");
  } finally {
    Reflect.deleteProperty(globalThis, "WorkerGlobalScope");
  }
  // The page has no fresh context: it keeps its compatibility pass (Q4 (m) pins the rest).
  const page = await boot();
  page.fx.loadFail = (_m, provider) => (provider === "webgpu" ? SESSION_FAILURE() : undefined);
  assert.equal((await cut(page)).result.provider, "wasm");
});

test("E01-01: a cut is never more opaque than its source (a translucent patch, a transparent hole)", async () => {
  // A photo with a translucent patch and a transparent hole inside the subject, as an edited PNG has.
  const width = 120, height = 80;
  const photo = sourceImage(width, height);
  const { data } = decodeRaw(new Uint8Array(await photo.arrayBuffer()));
  const holed = data.slice();
  for (let y = 30; y < 40; y += 1) for (let x = 50; x < 60; x += 1) holed[(y * width + x) * 4 + 3] = 128;
  for (let y = 20; y < 26; y += 1) for (let x = 20; x < 26; x += 1) holed[(y * width + x) * 4 + 3] = 0;
  const file = new File([encodeRaw(width, height, holed)], "holed.png", { type: "image/png" });
  for (const mode of ["quick", "auto", "maximum"] as const) {
    const env = await boot({ mask: () => 1 });
    const { result } = await cut(env, { mode, file });
    assert.equal(result.method, "model", `${mode}: the alpha source reaches the model`);
    const out = await pixelsOf(result.blob);
    let over = 0;
    for (let i = 3; i < out.data.length; i += 4) if (out.data[i]! > holed[i]!) over += 1;
    assert.equal(over, 0, `${mode}: no pixel above its source alpha`);
    assert.equal(alphaAt(out, 55, 35), 128, `${mode}: the translucent patch keeps its alpha`);
  }
});

// E10-04 / E10-S-01 (Sol's controlled masks): a flat source, or a WASM mask without both background
// and subject, cannot tell a broken GPU from the image; a real subject after a zeroed GPU mask can.
for (const row of [
  { name: "flat source and flat WASM", white: true, wasm: 1, expected: false },
  { name: "flat source with hallucinated structure", white: true, wasm: SUBJECT, expected: false },
  { name: "nonflat photo and broken GPU", white: false, wasm: SUBJECT, expected: true },
] as const) test(`E10-S memo: ${row.name}`, async () => {
  const env = await boot({ mask: (ctx) => (ctx.provider === "webgpu" ? 0 : row.wasm) });
  const pixels = new Uint8ClampedArray(120 * 80 * 4).fill(255);
  const file = row.white ? new File([encodeRaw(120, 80, pixels)], "white.png", { type: "image/png" }) : sourceImage();
  const { result } = await cut(env, { file, mode: "quick" });
  assert.equal(result.provider, "wasm");
  assert.equal(result.webgpuBroken, row.expected);
  assert.equal(env.provider.readGpuFailure(null), row.expected, "the session memo follows the confirmation");
});

// E10-02 (M15): the decode that feeds the model applies the EXIF orientation.
test("E10-S M15: model decode requests EXIF from-image", async () => {
  const env = await boot();
  const seen: Array<ImageBitmapOptions | undefined> = [];
  const original = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (async (source: Blob, options?: ImageBitmapOptions) => {
    seen.push(options);
    return original(source, options);
  }) as typeof createImageBitmap;
  try {
    await cut(env, { file: sourceImage(120, 80), mode: "quick" });
    const modelCalls = seen.filter((o) => o && "imageOrientation" in o);
    assert.ok(modelCalls.length > 0, "model decoder must run");
    for (const options of modelCalls) assert.equal(options!.imageOrientation, "from-image");
  } finally {
    globalThis.createImageBitmap = original;
  }
});

test("fp32 device-creation load errors request a fresh WASM context for run, refine and warmup", async () => {
  Object.defineProperty(globalThis, "WorkerGlobalScope", { configurable: true, value: class {} });
  try {
    const env = await boot({ adapter: "no-f16" });
    env.fx.loadFail = (_model, provider) => provider === "webgpu" ? new Error("WebGPU device creation failed") : undefined;
    await assert.rejects(env.engine.removeBackgroundLocal(sourceImage()), { code: "removal-webgpu-init-failed" });
    const base = new Blob([encodeRaw(60, 40, new Uint8ClampedArray(60 * 40 * 4).fill(255))], { type: "image/png" });
    await assert.rejects(env.engine.refineWithUserCrops(sourceImage(), base, [{ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }]), { code: "removal-webgpu-init-failed" });
    await assert.rejects(env.engine.warmupBiRefNet(), { code: "removal-webgpu-init-failed" });
    assert.equal(modelLoads(env, "wasm"), 0, "never try WASM in the failed GPU realm");
  } finally {
    Reflect.deleteProperty(globalThis, "WorkerGlobalScope");
  }
});
