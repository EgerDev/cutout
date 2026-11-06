// Browser-test fake for the Transformers.js boundary (W3 design §7).
//
// The owned removal engine talks to `@huggingface/transformers` only through
// `transformers()` in src/lib/transformers.ts: `env`, `RawImage`, `AutoProcessor.from_pretrained`
// and `AutoModel.from_pretrained`. The browser scripts replace that Vite-optimised module
// (`TRANSFORMERS_ROUTE`) with the module `transformersFake()` builds, so the real adapter
// (removal-model.ts), runtime, engine, finishing, graphics and worker all run unchanged, and only
// the model weights are fake.
//
// Support module only: it registers no tests and imports nothing, so a script can import it
// without pulling in Playwright. Builders return code strings; `installFake` wires them to a
// Playwright page or context; the log helpers run in Node.
//
// Everything that runs inside the page or the worker is an ordinary function in this file
// (so it is linted and syntax-checked) that is serialised with `String(fn)` and therefore must
// not close over anything outside itself.

export const TRANSFORMERS_ROUTE = "**/node_modules/.vite/deps/@huggingface_transformers.js*";
export const WORKER_ROUTE = "**/src/lib/removal-worker.ts*";
export const LOG_CHANNEL = "cutout-fake-tf";

const sourceOf = (value, what) => {
  if (typeof value === "function" || typeof value === "string") return String(value);
  throw new TypeError(`fake-transformers: ${what} must be a function or function source`);
};

// ---------------------------------------------------------------------------------------------
// In-page code (serialised). Nothing below this line up to "Node-side" may use outer bindings.
// ---------------------------------------------------------------------------------------------

/**
 * One event log per context. Events are `{ ctx, t, seq, type, ...fields }`. `t` is
 * `performance.timeOrigin + performance.now()` so page and worker events sort on one clock,
 * clamped strictly increasing so equal times only occur across contexts. The page appends to
 * `globalThis.__fakeTf` directly; a worker also posts every event on a BroadcastChannel that the
 * page collector (`eventLogInit`) merges. The page never posts: its own collector channel would
 * hear it twice.
 */
function makeEmitter() {
  const ctx = "WorkerGlobalScope" in globalThis ? "worker" : "page";
  const log = (globalThis.__fakeTf ??= []);
  const clock = (globalThis.__fakeTfClock ??= { seq: 0, last: 0 });
  const channel =
    ctx === "worker" && typeof BroadcastChannel === "function"
      ? new BroadcastChannel("cutout-fake-tf")
      : null;
  channel?.unref?.();
  const emit = (type, fields = {}) => {
    clock.last = Math.max(clock.last + 0.001, performance.timeOrigin + performance.now());
    clock.seq += 1;
    const event = { ctx, t: clock.last, seq: clock.seq, type, ...fields };
    log.push(event);
    channel?.postMessage(event);
    return event;
  };
  return { ctx, log, emit };
}

/** Defines own navigator properties, so a headless default can never decide a route. */
function applyEnv(o) {
  if (o.setMemory) {
    Object.defineProperty(navigator, "deviceMemory", {
      value: o.deviceMemory === null ? undefined : o.deviceMemory,
      configurable: true,
    });
  }
  if (o.setAdapter) {
    const adapter = {
      limits: {},
      // The fp16 BiRefNet route runs only on an adapter with shader-f16 (as transformers' gate requires).
      features: new Set(o.adapter === "no-f16" ? [] : ["shader-f16"]),
      requestDevice: async () => ({
        lost: new Promise(() => {}),
        addEventListener() {},
        destroy() {},
      }),
    };
    // "absent": no navigator.gpu at all; "null": requestAdapter resolves null; "fake": an adapter;
    // "no-f16": an adapter without shader-f16.
    const present = o.adapter === "fake" || o.adapter === "no-f16";
    Object.defineProperty(navigator, "gpu", {
      value:
        o.adapter === "absent"
          ? undefined
          : { requestAdapter: async () => (present ? adapter : null) },
      configurable: true,
    });
  }
}

/** The module `transformersFake` serialises. Returns the four exports Cutout uses. */
function fakeBody(cfgs) {
  const { ctx, emit } = makeEmitter();
  const cfg = cfgs[ctx] ?? {};
  const state = {};
  let loseDevice;
  const device = {
    lost: new Promise((resolve) => {
      loseDevice = resolve;
    }),
  };
  const counts = { loads: new Map(), deviceRuns: new Map(), processorRuns: 0, modelRuns: 0 };
  const onceKeys = new Set();
  const SIDES = { birefnet: 512, isnet: 1024 };
  const INPUT = { birefnet: "input_image", isnet: "input" };
  const OUTPUT = { birefnet: "output_image", isnet: "output" };
  const kindOf = (id) => (/isnet/i.test(String(id)) ? "isnet" : "birefnet");

  // Mask and hook helpers, passed as the second argument of `mask`, `load` and `run`.
  const h = {
    loseDevice: () => loseDevice({ reason: "destroyed" }),
    uniform: (value) => value,
    // Vertical bands of equal width: `bandsX([a, b, c])` is a at u<1/3, b at u<2/3, c after.
    bandsX: (values) => (u) => values[Math.min(values.length - 1, Math.floor(u * values.length))],
    // A rectangle in the coordinates of the image the processor received (`c.srcWidth/srcHeight`).
    rect:
      (c, { x0, y0, x1, y1, inside, outside }) =>
      (u, v) => {
        const x = u * c.srcWidth;
        const y = v * c.srcHeight;
        return x >= x0 && x < x1 && y >= y0 && y < y1 ? inside : outside;
      },
    nonFinite: (c) => {
      const data = new Float32Array(c.side * c.side);
      data[0] = Infinity;
      return data;
    },
    fail: (message) => {
      throw new Error(message);
    },
    // Runs `fn` the first time `key` is seen in this context; later calls do nothing.
    once: async (key, fn) => {
      if (onceKeys.has(key)) return undefined;
      onceKeys.add(key);
      return fn();
    },
  };

  const env = {
    backends: { onnx: { wasm: {}, webgpu: { device } } },
    remoteHost: "https://huggingface.co/",
    useBrowserCache: false,
  };

  class RawImage {
    constructor(data, width, height, channels) {
      this.data = data;
      this.width = width;
      this.height = height;
      this.channels = channels;
    }
  }

  class FakeTensor {
    constructor(data, dims, role, info) {
      this.data = data;
      this.dims = dims;
      this.role = role;
      this.info = info;
      this.disposed = false;
    }
    dispose() {
      const repeat = this.disposed;
      this.disposed = true;
      emit("dispose", { target: this.role, model: this.info.model, repeat });
    }
    sigmoid() {
      emit("sigmoid", { model: this.info.model, role: this.role });
      const data = Float32Array.from(this.data, (value) => 1 / (1 + Math.exp(-value)));
      return new FakeTensor(data, this.dims.slice(), "sigmoid-result", this.info);
    }
  }

  const render = (spec, side) => {
    const size = side * side;
    if (typeof spec === "number") return new Float32Array(size).fill(spec);
    if (typeof spec === "function") {
      const data = new Float32Array(size);
      for (let y = 0; y < side; y += 1) {
        const v = (y + 0.5) / side;
        for (let x = 0; x < side; x += 1) data[y * side + x] = spec((x + 0.5) / side, v);
      }
      return data;
    }
    // Any other array is used as given, so a wrong length makes a malformed output.
    return Float32Array.from(spec);
  };

  const makeProcessor = (id, deliver) => {
    const model = kindOf(id);
    const side = SIDES[model];
    let disposed = false;
    const processor = async (image) => {
      counts.processorRuns += 1;
      const n = counts.processorRuns;
      emit("run", {
        phase: "processor",
        model,
        n,
        width: image?.width,
        height: image?.height,
        channels: image?.channels,
      });
      if (!(image instanceof RawImage)) throw new TypeError("fake processor: expected a RawImage");
      const override = await cfg.run?.(
        {
          phase: "processor",
          model,
          n,
          width: image.width,
          height: image.height,
          image: { width: image.width, height: image.height, channels: image.channels },
          progress: deliver,
          state,
          emit,
        },
        h,
      );
      // A hook result replaces the processor result verbatim (for example an invalid tensor).
      if (override !== undefined) return override;
      const info = { model, side, srcWidth: image.width, srcHeight: image.height };
      return {
        pixel_values: new FakeTensor(
          new Float32Array(3 * side * side),
          [1, 3, side, side],
          "pixel_values",
          info,
        ),
      };
    };
    processor.dispose = async () => {
      emit("dispose", { target: "processor", model, repeat: disposed });
      disposed = true;
    };
    return processor;
  };

  const makeModel = (id, device, deliver) => {
    const model = kindOf(id);
    const side = SIDES[model];
    let disposed = false;
    const run = async (inputs) => {
      counts.modelRuns += 1;
      const n = counts.modelRuns;
      emit("run", {
        phase: "model",
        model,
        device,
        n,
        inputName: Object.keys(inputs ?? {}).join(","),
      });
      const input = inputs?.[INPUT[model]];
      if (!(input instanceof FakeTensor))
        throw new TypeError("fake model: missing " + INPUT[model]);
      const deviceKey = model + ":" + String(device);
      const deviceCall = (counts.deviceRuns.get(deviceKey) ?? 0) + 1;
      counts.deviceRuns.set(deviceKey, deviceCall);
      const call = {
        n,
        deviceCall,
        model,
        device,
        side,
        srcWidth: input.info.srcWidth,
        srcHeight: input.info.srcHeight,
        progress: deliver,
        state,
        emit,
      };
      // A hook result replaces the model result verbatim; undefined falls through to `mask`.
      const override = await cfg.run?.({ phase: "model", ...call }, h);
      if (override !== undefined) return override;
      const spec = cfg.mask ? await cfg.mask(call, h) : model === "isnet" ? 1 : 20;
      // "missing": the session returned no named output at all.
      if (spec === "missing") return {};
      const info = { model, side, srcWidth: input.info.srcWidth, srcHeight: input.info.srcHeight };
      return {
        [OUTPUT[model]]: new FakeTensor(
          render(spec, side),
          [1, 1, side, side],
          OUTPUT[model],
          info,
        ),
      };
    };
    run.dispose = async () => {
      emit("dispose", { target: "model", model, device, repeat: disposed });
      disposed = true;
    };
    return run;
  };

  const fromPretrained = async (kind, id, options = {}) => {
    const model = kindOf(id);
    const device = options.device;
    const dtype = options.dtype;
    const key = kind + ":" + model + ":" + String(device);
    const attempt = (counts.loads.get(key) ?? 0) + 1;
    counts.loads.set(key, attempt);
    const file =
      kind === "model"
        ? "onnx/" + (dtype === "fp16" ? "model_fp16.onnx" : "model.onnx")
        : "preprocessor_config.json";
    const progress = (event) => {
      try {
        options.progress_callback?.(event);
      } catch {
        // A throwing consumer must not fail the load, as in the real loader.
      }
    };
    emit("from_pretrained", {
      kind,
      id: String(id),
      model,
      device,
      dtype,
      revision: options.revision,
      file,
      attempt,
    });
    try {
      await cfg.load?.(
        {
          kind,
          id: String(id),
          model,
          device,
          dtype,
          revision: options.revision,
          file,
          attempt,
          progress,
          state,
          emit,
        },
        h,
      );
    } catch (error) {
      emit("load-error", { kind, model, device, message: String(error?.message ?? error) });
      throw error;
    }
    progress({ status: "initiate", file });
    if (kind === "model") {
      progress({ status: "progress", file, progress: 50, loaded: 50, total: 100 });
      progress({ status: "progress", file, progress: 100, loaded: 100, total: 100 });
    }
    progress({ status: "done", file });
    const value = kind === "model" ? makeModel(id, device, progress) : makeProcessor(id, progress);
    emit(kind === "model" ? "model-ready" : "processor-ready", { model, device, dtype, file });
    return value;
  };

  emit("module-loaded", {});
  return {
    env,
    RawImage,
    AutoProcessor: { from_pretrained: (id, options) => fromPretrained("processor", id, options) },
    AutoModel: { from_pretrained: (id, options) => fromPretrained("model", id, options) },
  };
}

/** Prepended to the worker entry: own navigator properties, an optional createImageBitmap wrapper. */
function preludeBody(makeEmitterFn, applyEnvFn, o, wrapCreateImageBitmap) {
  const { emit } = makeEmitterFn();
  applyEnvFn(o);
  if (wrapCreateImageBitmap && typeof globalThis.createImageBitmap === "function") {
    globalThis.createImageBitmap = wrapCreateImageBitmap(
      globalThis.createImageBitmap.bind(globalThis),
    );
  }
  emit("prelude", {
    deviceMemory: navigator.deviceMemory ?? null,
    adapter: Boolean(o.setAdapter && (o.adapter === "fake" || o.adapter === "no-f16")),
    gpu: Boolean(navigator.gpu),
  });
}

/** The page collector: owns `__fakeTf`, merges worker events, logs Worker create/terminate. */
function collectorBody(makeEmitterFn) {
  const { emit, log } = makeEmitterFn();
  const channel = new BroadcastChannel("cutout-fake-tf");
  channel.onmessage = (message) => {
    log.push(message.data);
  };
  channel.unref?.();
  const Native = globalThis.Worker;
  if (typeof Native !== "function" || Native.__fakeTfWrapped) return;
  class LoggedWorker extends Native {
    constructor(url, options) {
      super(url, options);
      this.__fakeTfUrl = String(url);
      emit("worker-created", { url: this.__fakeTfUrl });
    }
  }
  LoggedWorker.__fakeTfWrapped = true;
  const terminate = Native.prototype.terminate;
  Native.prototype.terminate = function () {
    emit("terminate", { url: this.__fakeTfUrl ?? "" });
    return terminate.call(this);
  };
  globalThis.Worker = LoggedWorker;
}

/** `window.__fx`: small helpers for building and reading source images in the page. */
function fixtureFactory() {
  const canvasOf = (width, height) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  };
  const toBlob = (canvas) => new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const fx = {
    async blob(width, height, draw) {
      const canvas = canvasOf(width, height);
      draw(canvas.getContext("2d"), width, height);
      const blob = await toBlob(canvas);
      canvas.width = canvas.height = 0;
      return blob;
    },
    // The 120x80 three-stop gradient of the refinement tests, optionally with its purple subject.
    gradientPhoto({ subject = true } = {}) {
      return fx.blob(120, 80, (ctx) => {
        const gradient = ctx.createLinearGradient(0, 0, 120, 80);
        gradient.addColorStop(0, "#1357d5");
        gradient.addColorStop(0.5, "#f28b12");
        gradient.addColorStop(1, "#45b96b");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 120, 80);
        if (subject) {
          ctx.fillStyle = "#7020b8";
          ctx.fillRect(40, 30, 12, 20);
        }
      });
    },
    // A photo of a shaded subject (x 30-90, y 15-65) on a flat field: not graphic art (the
    // subject's tones spread over many luma bands), and the field floods from the border.
    floodable() {
      return fx.blob(120, 80, (ctx) => {
        ctx.fillStyle = "rgb(216, 208, 192)";
        ctx.fillRect(0, 0, 120, 80);
        const gradient = ctx.createLinearGradient(30, 0, 90, 0);
        gradient.addColorStop(0, "rgb(20, 20, 40)");
        gradient.addColorStop(0.5, "rgb(120, 40, 120)");
        gradient.addColorStop(1, "rgb(240, 140, 40)");
        ctx.fillStyle = gradient;
        ctx.fillRect(30, 15, 60, 50);
      });
    },
    // E01-O-02: a 40x30 subject (0.25 %) at x 400-440, y 300-330 of an 800x600 textured photo,
    // under the 0.8 % the empty-mask probes need, on a field the border flood cannot clear.
    smallSubjectPhoto() {
      return fx.blob(800, 600, (ctx, width, height) => {
        const image = ctx.createImageData(width, height);
        let seed = 99173;
        const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
        for (let y = 0; y < height; y += 1)
          for (let x = 0; x < width; x += 1) {
            const i = (y * width + x) * 4;
            const n = rand() * 16;
            const t = y / height;
            const subject = x >= 400 && x < 440 && y >= 300 && y < 330;
            image.data[i] = subject
              ? 200 + n
              : 110 + t * 70 + n + 40 * Math.sin(x / 41) * Math.cos(y / 53);
            image.data[i + 1] = subject ? 40 + n : 128 + t * 60 + n + 30 * Math.cos(x / 29);
            image.data[i + 2] = subject ? 60 + n : 150 + t * 50 + n + 35 * Math.sin((x + y) / 47);
            image.data[i + 3] = 255;
          }
        ctx.putImageData(image, 0, 0);
      });
    },
    flat(width, height, color) {
      return fx.blob(width, height, (ctx) => {
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, width, height);
      });
    },
    // Black ink on white paper: classified as a logo, keyed locally.
    logo() {
      return fx.blob(96, 96, (ctx) => {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, 96, 96);
        ctx.fillStyle = "#040404";
        ctx.fillRect(24, 24, 48, 48);
      });
    },
    async alphaAt(blob, points) {
      const bitmap = await createImageBitmap(blob);
      const canvas = canvasOf(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const alphas = points.map(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3]);
      canvas.width = canvas.height = 0;
      return alphas;
    },
  };
  return fx;
}

// ---------------------------------------------------------------------------------------------
// Builders (strings for Playwright)
// ---------------------------------------------------------------------------------------------

const envOptions = (options) => ({
  setMemory: "deviceMemory" in options,
  deviceMemory: options.deviceMemory ?? null,
  setAdapter: "adapter" in options,
  adapter:
    options.adapter === "absent" || options.adapter === "no-f16"
      ? options.adapter
      : options.adapter && options.adapter !== "null"
        ? "fake"
        : "null",
});

const configLiteral = (config = {}) =>
  `{ ${["mask", "load", "run"]
    .filter((key) => config[key] != null)
    .map((key) => `${key}: (${sourceOf(config[key], key)})`)
    .join(", ")} }`;

/**
 * The ES module that replaces `@huggingface/transformers`. `page` and `worker` configure the fake
 * per context (it picks `"WorkerGlobalScope" in globalThis ? worker : page` when it evaluates).
 * Each config may hold three functions, passed as real functions or function source (no closures):
 *   mask(call, h)  -> number | (u, v) => number | array | "missing"   the model output, in model space
 *                     (BiRefNet 512 raw logits, ISNet 1024 probabilities). Default 20 / 1.
 *                     call: { n, model, device, side, srcWidth, srcHeight, state, emit }; n counts
 *                     model runs in this context from 1. A throw fails that run only.
 *   load(call, h)  -> awaited at the start of every from_pretrained (after it is logged). Throw to fail
 *                     the load, await to hold it. call: { kind, id, model, device, dtype, revision,
 *                     file, attempt, progress(event), state, emit }; attempt counts per kind+model+device.
 *   run(call, h)   -> awaited inside every processor() and model() call before its tensor is produced
 *                     (`call.phase` is "processor" or "model"). Hold it open, throw, or call a page hook;
 *                     `h.once(key, fn)` makes a one-shot hook. A result other than undefined replaces that
 *                     call's result verbatim (an invalid tensor, a model result without mask). call:
 *                     { phase, model, n, progress(event), state, emit, ... } plus width/height for the
 *                     processor (also as image: { width, height, channels }) and device, deviceCall (per model+device), side, srcWidth/srcHeight for the
 *                     model. progress(event) re-emits a load event through the progress_callback of the
 *                     load that created this model or processor, as a download that outlives its job does.
 * `h` offers `bandsX`, `rect`, `nonFinite`, `uniform`, `fail` and `once`.
 */
export function transformersFake({ page = {}, worker = {} } = {}) {
  return [
    `const makeEmitter = ${makeEmitter};`,
    `const __fake = (${fakeBody})({ page: ${configLiteral(page)}, worker: ${configLiteral(worker)} });`,
    "export const env = __fake.env;",
    "export const RawImage = __fake.RawImage;",
    "export const AutoProcessor = __fake.AutoProcessor;",
    "export const AutoModel = __fake.AutoModel;",
  ].join("\n");
}

/**
 * Code prepended to the worker entry (`addInitScript` does not reach dedicated workers). It
 * defines own `navigator.deviceMemory` / `navigator.gpu` on the worker's navigator, logs a
 * `prelude` event with the values the worker observes, and can replace `createImageBitmap`:
 * `createImageBitmap` is function source `(original) => replacement`. Static imports of the entry
 * are hoisted above this, but every navigator read happens at message-handling time.
 */
export function workerPrelude(options = {}) {
  const wrap =
    options.createImageBitmap == null
      ? "undefined"
      : `(${sourceOf(options.createImageBitmap, "createImageBitmap")})`;
  return `(() => { const makeEmitter = ${makeEmitter}; (${preludeBody})(makeEmitter, ${applyEnv}, ${JSON.stringify(envOptions(options))}, ${wrap}); })();`;
}

/** The page `addInitScript` body that owns the log: collector, Worker instrumentation, clock. */
export function eventLogInit() {
  return `(() => { const makeEmitter = ${makeEmitter}; (${collectorBody})(makeEmitter); })();`;
}

/** The page `addInitScript` body that defines `navigator.deviceMemory` and/or `navigator.gpu`. */
export function pageEnvInit(options = {}) {
  return `(${applyEnv})(${JSON.stringify(envOptions(options))});`;
}

/** The page `addInitScript` body that defines `window.__fx` (source image helpers). */
export function fixtureInit() {
  return `window.__fx = (${fixtureFactory})();`;
}

/**
 * Registers the fake on a Playwright page or browser context, before navigation:
 * the event log, the page environment (`deviceMemory`; `adapter` true or "fake", "no-f16" for an adapter
 * without shader-f16, false or "null", or "absent" for no navigator.gpu at all, defaulting to none so the
 * headless GPU never decides a route), fixtures, the transformers route and, when
 * `workerEnv` is given, the worker entry route that prepends `workerPrelude(workerEnv)`.
 */
export async function installFake(target, options = {}) {
  const { page, worker, workerEnv, ...env } = options;
  await target.addInitScript(eventLogInit());
  await target.addInitScript(pageEnvInit({ adapter: false, ...env }));
  await target.addInitScript(fixtureInit());
  await target.route(TRANSFORMERS_ROUTE, (route) =>
    route.fulfill({ contentType: "text/javascript", body: transformersFake({ page, worker }) }),
  );
  if (workerEnv) {
    await target.route(WORKER_ROUTE, async (route) => {
      const response = await route.fetch();
      const headers = Object.fromEntries(
        Object.entries(response.headers?.() ?? {}).filter(
          ([name]) => !["content-encoding", "content-length"].includes(name.toLowerCase()),
        ),
      );
      await route.fulfill({
        response,
        headers,
        body: `${workerPrelude(workerEnv)}\n${await response.text()}`,
      });
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Node-side log helpers
// ---------------------------------------------------------------------------------------------

/** Events in time order. Arrival order alone is wrong for synchronous page events vs worker posts. */
export function sortLog(log) {
  return [...log].sort((a, b) => a.t - b.t);
}

/** Events matching every key of `match`; a function value is a predicate on that field. */
export function select(log, match = {}) {
  return log.filter((event) =>
    Object.entries(match).every(([key, expected]) =>
      typeof expected === "function" ? expected(event[key]) : event[key] === expected,
    ),
  );
}

/**
 * Live-model counter over a time-sorted log: `model-ready` adds one, a first `dispose` of a model
 * removes one (a repeated dispose is ignored), and terminating a removal worker drops that
 * worker's count to zero. G9 is `maxPage <= 1`, `maxWorker <= 1` and `maxTotal <= 1`.
 */
export function liveModels(sorted) {
  const live = { page: 0, worker: 0 };
  let maxPage = 0;
  let maxWorker = 0;
  let maxTotal = 0;
  for (const event of sorted) {
    if (event.type === "model-ready") live[event.ctx] += 1;
    else if (event.type === "dispose" && event.target === "model" && !event.repeat) {
      live[event.ctx] = Math.max(0, live[event.ctx] - 1);
    } else if (event.type === "terminate" && /removal-worker/.test(event.url ?? ""))
      live.worker = 0;
    else continue;
    maxPage = Math.max(maxPage, live.page);
    maxWorker = Math.max(maxWorker, live.worker);
    maxTotal = Math.max(maxTotal, live.page + live.worker);
  }
  return { maxPage, maxWorker, maxTotal, final: { ...live } };
}

/** The merged, time-sorted log of a page, after giving worker posts a moment to arrive. */
export async function readFakeLog(page, { settleMs = 50 } = {}) {
  await page.evaluate((ms) => new Promise((resolve) => setTimeout(resolve, ms)), settleMs);
  return sortLog(await page.evaluate(() => globalThis.__fakeTf ?? []));
}

/**
 * Step 1 of the W3 browser rows: does a route reach the dedicated removal worker? For `page.route`
 * and then `context.route` it installs the fake with a worker prelude, warms the removal worker up
 * and checks the log for the worker's `module-loaded` (the fake served to the worker) and a
 * `prelude` event carrying the expected `deviceMemory` (the worker entry was rewritten). Returns
 * `{ intercepted: "page" | "context" | null, attempts }`. If it is null neither route reaches
 * dedicated workers in the installed Chromium, and every worker row goes back to the architect:
 * no production test seam is added to make them pass.
 */
export async function runInterceptionSmoke(browser, appUrl, { deviceMemory = 6 } = {}) {
  const attempts = [];
  for (const scope of ["page", "context"]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await installFake(scope === "page" ? page : context, {
        deviceMemory,
        adapter: false,
        workerEnv: { deviceMemory, adapter: false },
      });
      await page.goto(appUrl);
      const warmup = await page.evaluate(async () => {
        try {
          const { warmupRemoval } = await import("/src/lib/removal-client.ts");
          await warmupRemoval();
          return "ok";
        } catch (error) {
          return String(error?.message ?? error);
        }
      });
      const log = await readFakeLog(page);
      const worker = log.filter((event) => event.ctx === "worker");
      const attempt = {
        scope,
        warmup,
        moduleLoaded: worker.some((event) => event.type === "module-loaded"),
        prelude: worker.find((event) => event.type === "prelude") ?? null,
        workerFromPretrained: worker.filter((event) => event.type === "from_pretrained").length,
      };
      attempts.push(attempt);
      if (attempt.moduleLoaded && attempt.prelude?.deviceMemory === deviceMemory) {
        return { intercepted: scope, attempts };
      }
    } finally {
      await context.close();
    }
  }
  return { intercepted: null, attempts };
}
