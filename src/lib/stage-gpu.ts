import {
  navigatorGpu,
  requestCompatibleAdapter,
  requestCompatibleDevice,
  watchDeviceLoss,
} from "./gpu-compat.ts";
import { liveBitmap } from "./editor/resources.ts";

const GPU_UPLOAD_CAP = 2048;

export const STAGE_ANISO = 4;
export const CHECKER_CELL = 16;
export const CHECKER_LIGHT = { a: "#e7e3d8", b: "#f6f3eb" } as const;
export const CHECKER_DARK = { a: "#5a574c", b: "#3f3d36" } as const;

export function stageThemeDark() {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function checkerTint(node?: Element | null) {
  const styles =
    typeof getComputedStyle === "function"
      ? getComputedStyle(node ?? document.documentElement)
      : null;
  const a = styles?.getPropertyValue("--color-checker-a").trim() || CHECKER_LIGHT.a;
  const b = styles?.getPropertyValue("--color-checker-b").trim() || CHECKER_LIGHT.b;
  return { a, b, ar: parseCssColor(a), br: parseCssColor(b) };
}

export const CHECKER_CONTRAST_MIN = 3;

function srgbToLin(channel: number) {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

export function relativeLuma(rgb: [number, number, number]) {
  return 0.2126 * srgbToLin(rgb[0]) + 0.7152 * srgbToLin(rgb[1]) + 0.0722 * srgbToLin(rgb[2]);
}

export function contrastRatio(a: number, b: number) {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

export function checkerPaperLuma(dark: boolean) {
  const pair = dark ? CHECKER_DARK : CHECKER_LIGHT;
  return (relativeLuma(parseCssColor(pair.a)) + relativeLuma(parseCssColor(pair.b))) / 2;
}

export function checkerNeedsFlip(subjectLuma: number, themeDark: boolean) {
  return contrastRatio(subjectLuma, checkerPaperLuma(themeDark)) < CHECKER_CONTRAST_MIN;
}

export function opaqueMeanLuma(data: Uint8ClampedArray | Uint8Array) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! < 32) continue;
    sum += relativeLuma([data[i]! / 255, data[i + 1]! / 255, data[i + 2]! / 255]);
    n += 1;
  }
  return n ? sum / n : 0.5;
}

export async function probeCheckerFlip(source: CanvasImageSource): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return false;
  try {
    ctx.drawImage(source, 0, 0, 64, 64);
    const image = ctx.getImageData(0, 0, 64, 64);
    return checkerNeedsFlip(opaqueMeanLuma(image.data), stageThemeDark());
  } catch {
    return false;
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

const UNIFORM = 0x0040;
const COPY_DST = 0x0008;
const TEX_COPY_DST = 0x02;
const TEX_BINDING = 0x04;

const SHADER = /* wgsl */ `
struct Uniforms {
  wipe: f32,
  comparing: f32,
  _pad3: f32,
  mask: f32,
  peek: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  checkerA: vec4f,
  checkerB: vec4f,
  _pad4: vec4f,
};

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
};

@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var resultTex: texture_2d<f32>;
@group(0) @binding(2) var sourceTex: texture_2d<f32>;
@group(0) @binding(4) var<uniform> u: Uniforms;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> VsOut {
  var out: VsOut;
  let x = f32(i32(i & 1u) * 4 - 1);
  let y = f32(i32(i >> 1u) * 4 - 1);
  out.pos = vec4f(x, y, 0.0, 1.0);
  out.uv = vec2f(x * 0.5 + 0.5, 0.5 - y * 0.5);
  return out;
}

fn checker(pos: vec2f) -> vec3f {
  let cell = floor(pos / 16.0);
  let odd = (i32(cell.x) + i32(cell.y)) & 1;
  return select(u.checkerA.xyz, u.checkerB.xyz, odd != 0);
}

fn sampleSubject(uv: vec2f) -> vec4f {
  if (u.peek > 0.5) {
    return textureSample(sourceTex, samp, uv);
  }
  if (u.comparing > 0.5) {
    let tile = select(0.0, 1.0, uv.x >= u.wipe);
    let u2 = (clamp(uv.x, 0.001, 0.999) + tile) * 0.5;
    return textureSample(resultTex, samp, vec2f(u2, uv.y));
  }
  return textureSample(resultTex, samp, uv);
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  if (u.mask > 0.5) {
    let a = textureSample(resultTex, samp, in.uv).a;
    return vec4f(mix(vec3f(0.07, 0.067, 0.055), vec3f(0.965, 0.953, 0.922), a), 1.0);
  }
  let src = sampleSubject(in.uv);
  let ground = checker(in.pos.xy);
  // Textures are uploaded premultiplied so the sampler's filtering never bleeds the
  // zeroed colour of transparent texels into an edge; composite with the over operator.
  let rgb = ground * (1.0 - src.a) + src.rgb;
  return vec4f(rgb, 1.0);
}
`;

type GpuTex = {
  destroy: () => void;
  createView: () => unknown;
  width?: number;
  height?: number;
};

type GpuBuffer = { destroy: () => void };

type GpuDevice = {
  createShaderModule: (desc: { code: string }) => unknown;
  createRenderPipeline: (desc: unknown) => { getBindGroupLayout: (i: number) => unknown };
  createBindGroup: (desc: unknown) => unknown;
  createSampler: (desc: unknown) => unknown;
  createTexture: (desc: unknown) => GpuTex;
  createBuffer: (desc: { size: number; usage: number }) => GpuBuffer;
  createCommandEncoder: () => {
    beginRenderPass: (desc: unknown) => {
      setPipeline: (p: unknown) => void;
      setBindGroup: (i: number, g: unknown) => void;
      draw: (n: number) => void;
      end: () => void;
    };
    copyTextureToTexture: (src: unknown, dst: unknown, size: unknown) => void;
    finish: () => unknown;
  };
  queue: {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: BufferSource) => void;
    writeTexture: (dest: unknown, data: BufferSource, layout: unknown, size: unknown) => void;
    copyExternalImageToTexture: (src: unknown, dst: unknown, size: unknown) => void;
    submit: (cmds: unknown[]) => void;
  };
  destroy?: () => void;
  lost?: Promise<unknown>;
  addEventListener?: (
    type: string,
    listener: () => void,
    options?: { signal?: AbortSignal },
  ) => void;
};

type GpuCanvasContext = {
  configure: (desc: { device: GpuDevice; format: string; alphaMode: string }) => void;
  unconfigure: () => void;
  getCurrentTexture: () => { createView: () => unknown };
};

type Shared = {
  device: GpuDevice;
  format: string;
  pipeline: { getBindGroupLayout: (i: number) => unknown };
  sampler: unknown;
  placeholder: GpuTex;
};

/**
 * `device.lost` cannot be unsubscribed: it gets a holder that the stage empties on
 * destroy, so only this small object (not the stage's closure) waits on the device.
 */
function onDeviceLost(device: GpuDevice, run: () => void) {
  const holder: { run: (() => void) | null } = { run };
  void device.lost?.then(() => holder.run?.());
  return () => {
    holder.run = null;
  };
}

let shared: Shared | null = null;
let sharedPending: Promise<Shared | null> | null = null;
const webGpuCanvases = new WeakSet<HTMLCanvasElement>();
const webGpuOwners = new WeakMap<HTMLCanvasElement, object>();

export function compareReady(comparing: boolean, result: unknown, source: unknown) {
  return Boolean(comparing && result && source && result !== source);
}

export function parseCssColor(color: string): [number, number, number] {
  const hex = color.trim().replace("#", "");
  if (hex.length >= 6 && /^[0-9a-fA-F]+$/.test(hex)) {
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
    ];
  }
  return [0.35, 0.34, 0.3];
}

/** Tried in this order; WebGL1 was dropped, its devices get the 2D compositor. */
export type StageBackend = "webgpu" | "webgl2" | "2d";

export function gpuStageSupported() {
  return typeof document !== "undefined";
}

export function stageTabVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

export function preserveContextOnLost(event: Event) {
  event.preventDefault();
}

function getShared(): Promise<Shared | null> {
  if (shared) return Promise.resolve(shared);
  if (sharedPending) return sharedPending;
  const pending = createShared();
  sharedPending = pending;
  const clear = () => {
    if (sharedPending === pending) sharedPending = null;
  };
  void pending.then(clear, clear);
  return pending;
}

async function createShared(): Promise<Shared | null> {
  const api = navigatorGpu() as
    (ReturnType<typeof navigatorGpu> & { getPreferredCanvasFormat?: () => string }) | undefined;
  if (!api) return null;
  try {
    const adapter = await requestCompatibleAdapter(api);
    if (!adapter) return null;
    const device = (await requestCompatibleDevice(adapter)) as GpuDevice;
    watchDeviceLoss(device as Parameters<typeof watchDeviceLoss>[0], () => {
      if (shared?.device === device) shared = null;
    });
    const format =
      typeof api.getPreferredCanvasFormat === "function"
        ? api.getPreferredCanvasFormat()
        : "bgra8unorm";
    const module = device.createShaderModule({ code: SHADER });
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
    });
    const linear = {
      magFilter: "linear" as const,
      minFilter: "linear" as const,
      mipmapFilter: "linear" as const,
      addressModeU: "clamp-to-edge" as const,
      addressModeV: "clamp-to-edge" as const,
    };
    const sampler = (() => {
      try {
        return device.createSampler({ ...linear, maxAnisotropy: STAGE_ANISO });
      } catch {
        return device.createSampler(linear);
      }
    })();
    const placeholder = device.createTexture({
      size: { width: 1, height: 1 },
      format: "rgba8unorm",
      usage: TEX_COPY_DST | TEX_BINDING,
    });
    device.queue.writeTexture(
      { texture: placeholder },
      new Uint8Array([0, 0, 0, 0]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    shared = { device, format, pipeline, sampler, placeholder };
    return shared;
  } catch {
    shared = null;
    return null;
  }
}

export type StageGpuFrame = {
  result?: TexImageSource | null;
  source?: TexImageSource | null;
  comparing: boolean;
  peeking: boolean;
  masking: boolean;
  wipe: number;
  invertChecker?: boolean;
};

export type StageGpu = {
  kind: StageBackend;
  paint: (frame: StageGpuFrame) => boolean;
  destroy: () => void;
};

function fitCanvas(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width || 1) * dpr));
  const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height || 1) * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  return { width, height };
}

export function gpuTexFit(srcW: number, srcH: number, viewW: number, viewH: number) {
  const cap = Math.min(GPU_UPLOAD_CAP, Math.max(1, viewW, viewH) * 2);
  const scale = Math.min(1, cap / Math.max(1, srcW), cap / Math.max(1, srcH));
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

function fitTexSource(source: TexImageSource, viewW: number, viewH: number): TexImageSource {
  const { width, height } = sourceSize(source);
  const fit = gpuTexFit(width, height, viewW, viewH);
  if (fit.width >= width && fit.height >= height) return source;
  if (typeof document === "undefined") return source;
  const canvas = document.createElement("canvas");
  canvas.width = fit.width;
  canvas.height = fit.height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(source as CanvasImageSource, 0, 0, fit.width, fit.height);
  return canvas;
}

/**
 * Zeroes a scratch canvas made for one upload. Safari frees a canvas backing store only
 * on GC and caps their total; past it getContext returns null and previews fail.
 */
function dropScratch(made: TexImageSource | null | undefined, original: unknown) {
  if (made && made !== original && typeof HTMLCanvasElement !== "undefined")
    if (made instanceof HTMLCanvasElement) {
      made.width = 0;
      made.height = 0;
    }
}

function sourceSize(source: TexImageSource) {
  const anySource = source as {
    width?: number;
    height?: number;
    videoWidth?: number;
    videoHeight?: number;
    naturalWidth?: number;
    naturalHeight?: number;
    displayWidth?: number;
    displayHeight?: number;
  };
  const width =
    anySource.naturalWidth ||
    anySource.videoWidth ||
    anySource.displayWidth ||
    anySource.width ||
    1;
  const height =
    anySource.naturalHeight ||
    anySource.videoHeight ||
    anySource.displayHeight ||
    anySource.height ||
    1;
  return { width, height };
}

function releaseTex(texture: GpuTex | null, fallback: GpuTex) {
  if (texture && texture !== fallback) texture.destroy();
}

function upload(
  device: GpuDevice,
  previous: GpuTex | null,
  dim: { w: number; h: number },
  source: TexImageSource | null | undefined,
  fallback: GpuTex,
  viewW: number,
  viewH: number,
) {
  if (!source) {
    releaseTex(previous, fallback);
    dim.w = 0;
    dim.h = 0;
    return fallback;
  }
  const fitted = fitTexSource(source, viewW, viewH);
  try {
    return uploadFitted(device, previous, dim, fitted, fallback);
  } finally {
    dropScratch(fitted, source);
  }
}

function uploadFitted(
  device: GpuDevice,
  previous: GpuTex | null,
  dim: { w: number; h: number },
  fitted: TexImageSource,
  fallback: GpuTex,
) {
  const { width, height } = sourceSize(fitted);
  if (width < 1 || height < 1) {
    releaseTex(previous, fallback);
    dim.w = 0;
    dim.h = 0;
    return fallback;
  }
  if (previous && previous !== fallback && dim.w === width && dim.h === height) {
    device.queue.copyExternalImageToTexture(
      { source: fitted },
      { texture: previous, premultipliedAlpha: true },
      { width, height },
    );
    return previous;
  }
  // Keep the previous handle until the replacement exists and the copy lands. A throw
  // must not destroy the texture still bound to lastSource/lastResult.
  const texture = device.createTexture({
    size: { width, height },
    format: "rgba8unorm",
    usage: TEX_COPY_DST | TEX_BINDING | 0x10,
  });
  try {
    device.queue.copyExternalImageToTexture(
      { source: fitted },
      { texture, premultipliedAlpha: true },
      { width, height },
    );
  } catch (error) {
    texture.destroy();
    throw error;
  }
  releaseTex(previous, fallback);
  dim.w = width;
  dim.h = height;
  return texture;
}

function uploadAtlas(
  device: GpuDevice,
  previous: GpuTex | null,
  dim: { w: number; h: number },
  result: TexImageSource,
  original: TexImageSource,
  fallback: GpuTex,
  viewW: number,
  viewH: number,
) {
  const packed = packStageAtlas(result, original, viewW, viewH);
  if (packed) {
    try {
      return upload(device, previous, dim, packed, fallback, viewW * 2, viewH);
    } catch {
      /* GPU copies below */
    } finally {
      dropScratch(packed, null);
    }
  }
  let fittedR: TexImageSource | undefined;
  let fittedO: TexImageSource | undefined;
  let left: GpuTex | null = null;
  let right: GpuTex | null = null;
  let atlas: GpuTex | null = null;
  // Keep the assigned atlas until every copy and submission succeeds. Scratch
  // textures and an uncommitted replacement belong to this attempt alone.
  try {
    fittedR = fitTexSource(result, viewW, viewH);
    fittedO = fitTexSource(original, viewW, viewH);
    const a = sourceSize(fittedR);
    const b = sourceSize(fittedO);
    requireMatchingTiles(a, b);
    const tileW = Math.max(1, a.width, b.width);
    const tileH = Math.max(1, a.height, b.height);
    const copySrc = TEX_COPY_DST | 0x01 | 0x10;
    left = device.createTexture({
      size: { width: b.width, height: b.height },
      format: "rgba8unorm",
      usage: copySrc,
    });
    right = device.createTexture({
      size: { width: a.width, height: a.height },
      format: "rgba8unorm",
      usage: copySrc,
    });
    device.queue.copyExternalImageToTexture(
      { source: fittedO },
      { texture: left, premultipliedAlpha: true },
      { width: b.width, height: b.height },
    );
    device.queue.copyExternalImageToTexture(
      { source: fittedR },
      { texture: right, premultipliedAlpha: true },
      { width: a.width, height: a.height },
    );
    atlas = device.createTexture({
      size: { width: tileW * 2, height: tileH },
      format: "rgba8unorm",
      usage: TEX_COPY_DST | TEX_BINDING | 0x10 | 0x01,
    });
    const encoder = device.createCommandEncoder();
    encoder.copyTextureToTexture(
      { texture: left },
      { texture: atlas, origin: [0, 0, 0] },
      { width: b.width, height: b.height },
    );
    encoder.copyTextureToTexture(
      { texture: right },
      { texture: atlas, origin: [tileW, 0, 0] },
      { width: a.width, height: a.height },
    );
    device.queue.submit([encoder.finish()]);
    releaseTex(previous, fallback);
    dim.w = tileW * 2;
    dim.h = tileH;
    const committed = atlas;
    atlas = null;
    return committed;
  } finally {
    left?.destroy();
    right?.destroy();
    atlas?.destroy();
    dropScratch(fittedR, result);
    dropScratch(fittedO, original);
  }
}

async function attachWebGpu(
  canvas: HTMLCanvasElement,
  onInvalidate: () => void,
): Promise<StageGpu | null> {
  let gpu = await getShared();
  if (!gpu) return null;
  const context = canvas.getContext("webgpu") as GpuCanvasContext | null;
  if (!context) return null;
  webGpuCanvases.add(canvas);
  let uniform = gpu.device.createBuffer({ size: 80, usage: UNIFORM | COPY_DST });
  let resultTex: GpuTex | null = null;
  let sourceTex: GpuTex | null = null;
  let lastResult: TexImageSource | null | undefined;
  let lastSource: TexImageSource | null | undefined;
  let lastPacked = false;
  const resultDim = { w: 0, h: 0 };
  const sourceDim = { w: 0, h: 0 };
  let alive = true;
  let closed = false;
  let configured = false;
  let recovering = false;
  const owner = {};

  const configure = (force = false) => {
    const before = canvas.width + "x" + canvas.height;
    fitCanvas(canvas);
    if (canvas.width + "x" + canvas.height === before && configured && !force) return;
    context.configure({ device: gpu!.device, format: gpu!.format, alphaMode: "opaque" });
    webGpuOwners.set(canvas, owner);
    configured = true;
  };

  const resetUploads = () => {
    resultTex = null;
    sourceTex = null;
    lastResult = undefined;
    lastSource = undefined;
    lastPacked = false;
    resultDim.w = 0;
    resultDim.h = 0;
    sourceDim.w = 0;
    sourceDim.h = 0;
  };

  // The device outlives this stage (it is shared), so its listeners must let go on
  // destroy, or every remount kept the old canvas and full-size images alive.
  const listening = new AbortController();
  const unwatch: (() => void)[] = [];
  const watchRenderer = (device: GpuDevice) => {
    device.addEventListener?.(
      "uncapturederror",
      () => {
        if (closed || gpu?.device !== device || !alive) return;
        // Validation failures cannot be repaired by repeatedly recreating a device.
        alive = false;
        onInvalidate();
      },
      { signal: listening.signal },
    );
    unwatch.push(
      onDeviceLost(device, () => {
        if (!closed && gpu?.device === device) void recover();
      }),
    );
  };

  const recover = async () => {
    if (closed || recovering) return;
    recovering = true;
    alive = false;
    onInvalidate();
    shared = null;
    configured = false;
    try {
      const next = await getShared();
      if (closed || !next) return;
      gpu = next;
      watchRenderer(next.device);
      uniform = next.device.createBuffer({ size: 80, usage: UNIFORM | COPY_DST });
      resetUploads();
      configure(true);
      alive = true;
    } catch {
      alive = false;
    } finally {
      recovering = false;
      if (!closed) onInvalidate();
    }
  };

  try {
    configure();
  } catch {
    uniform.destroy();
    return null;
  }
  // Only once the stage exists: a failed attach must leave nothing waiting on the device.
  watchRenderer(gpu.device);

  const paint = (frame: StageGpuFrame) => {
    if (!alive || closed || !gpu || shared !== gpu) return false;
    frame = liveFrame(frame);
    try {
      configure();
      const view = { width: canvas.width, height: canvas.height };
      if (frame.source !== lastSource) {
        sourceTex = upload(
          gpu.device,
          sourceTex,
          sourceDim,
          frame.source,
          gpu.placeholder,
          view.width,
          view.height,
        );
      }
      const split = compareReady(frame.comparing, frame.result, frame.source);
      if (split && frame.result && frame.source) {
        if (!lastPacked || frame.result !== lastResult || frame.source !== lastSource) {
          resultTex = uploadAtlas(
            gpu.device,
            resultTex,
            resultDim,
            frame.result,
            frame.source,
            gpu.placeholder,
            view.width,
            view.height,
          );
          lastPacked = true;
        }
      } else if (lastPacked || frame.result !== lastResult) {
        resultTex = upload(
          gpu.device,
          resultTex,
          resultDim,
          frame.result,
          gpu.placeholder,
          view.width,
          view.height,
        );
        lastPacked = false;
      }
      lastResult = frame.result;
      lastSource = frame.source;
      if (!resultTex || !sourceTex) return false;
      const tint = checkerTint(canvas);
      const data = new Float32Array(20);
      data[0] = Math.min(1, Math.max(0, frame.wipe));
      data[1] = split && lastPacked ? 1 : 0;
      data[3] = frame.masking ? 1 : 0;
      data[4] = frame.peeking ? 1 : 0;
      data[8] = tint.ar[0];
      data[9] = tint.ar[1];
      data[10] = tint.ar[2];
      data[12] = tint.br[0];
      data[13] = tint.br[1];
      data[14] = tint.br[2];
      gpu.device.queue.writeBuffer(uniform, 0, data);
      const group = gpu.device.createBindGroup({
        layout: gpu.pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: gpu.sampler },
          { binding: 1, resource: resultTex.createView() },
          { binding: 2, resource: sourceTex.createView() },
          { binding: 4, resource: { buffer: uniform } },
        ],
      });
      const encoder = gpu.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: { r: 0.07, g: 0.067, b: 0.055, a: 1 },
          },
        ],
      });
      pass.setPipeline(gpu.pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
      return true;
    } catch {
      return false;
    }
  };

  const destroy = () => {
    closed = true;
    alive = false;
    listening.abort();
    for (const stop of unwatch.splice(0)) stop();
    try {
      // A superseded async attachment must not unconfigure its replacement.
      if (webGpuOwners.get(canvas) === owner) {
        webGpuOwners.delete(canvas);
        context.unconfigure();
      }
    } catch {
      /* already gone */
    }
    if (gpu) {
      if (resultTex !== gpu.placeholder) resultTex?.destroy();
      if (sourceTex !== gpu.placeholder) sourceTex?.destroy();
    }
    try {
      uniform.destroy();
    } catch {
      /* device already lost */
    }
  };

  return { kind: "webgpu", paint, destroy };
}

const GL_VS2 = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 1.0 - (a_pos.y * 0.5 + 0.5));
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const GL_FS2 = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_result;
uniform sampler2D u_source;
uniform float u_wipe;
uniform float u_comparing;
uniform float u_mask;
uniform float u_peek;
uniform vec3 u_checkA;
uniform vec3 u_checkB;
vec3 checker(vec2 pos) {
  vec2 cell = floor(pos / 16.0);
  return mix(u_checkA, u_checkB, mod(cell.x + cell.y, 2.0));
}
vec4 sampleSubject(vec2 uv) {
  if (u_peek > 0.5) return texture(u_source, uv);
  if (u_comparing > 0.5) {
    float tile = uv.x >= u_wipe ? 1.0 : 0.0;
    float u2 = (clamp(uv.x, 0.001, 0.999) + tile) * 0.5;
    return texture(u_result, vec2(u2, uv.y));
  }
  return texture(u_result, uv);
}
void main() {
  if (u_mask > 0.5) {
    float a = texture(u_result, v_uv).a;
    outColor = vec4(mix(vec3(0.07, 0.067, 0.055), vec3(0.965, 0.953, 0.922), a), 1.0);
    return;
  }
  vec4 src = sampleSubject(v_uv);
  outColor = vec4(checker(gl_FragCoord.xy) * (1.0 - src.a) + src.rgb, 1.0);
}`;

type Gl = WebGL2RenderingContext;

function compileGl(gl: Gl, type: number, source: string) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function linkGl(gl: Gl, vsSrc: string, fsSrc: string) {
  const vs = compileGl(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileGl(gl, gl.FRAGMENT_SHADER, fsSrc);
  if (!vs || !fs) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "a_pos");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function glTex(
  gl: Gl,
  unit: number,
  texture: WebGLTexture,
  dim: { w: number; h: number },
  image: TexImageSource | null | undefined,
  viewW: number,
  viewH: number,
) {
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  const empty = new Uint8Array(4);
  const fitted = image ? fitTexSource(image, viewW, viewH) : null;
  const width = fitted ? sourceSize(fitted).width : 1;
  const height = fitted ? sourceSize(fitted).height : 1;
  if (dim.w !== width || dim.h !== height) {
    if (fitted) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, fitted);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, empty);
    dim.w = width;
    dim.h = height;
  } else if (fitted) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, fitted);
  else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, empty);
  dropScratch(fitted, image);
  const shrink = width / Math.max(1, viewW) > 1.35 || height / Math.max(1, viewH) > 1.35;
  if (shrink) {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.generateMipmap(gl.TEXTURE_2D);
  } else {
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
}

// Native copies cannot scale either half. If packing is unavailable, let Stage
// show its DOM compare rather than sample unequal images as full-size atlas tiles.
function requireMatchingTiles(
  a: { width: number; height: number },
  b: { width: number; height: number },
) {
  if (a.width !== b.width || a.height !== b.height)
    throw new Error("Compare atlas tiles need the packed compositor.");
}

function glTexAtlas(
  gl: Gl,
  texture: WebGLTexture,
  dim: { w: number; h: number },
  result: TexImageSource,
  original: TexImageSource,
) {
  const a = sourceSize(result);
  const b = sourceSize(original);
  requireMatchingTiles(a, b);
  const tileW = Math.max(1, a.width, b.width);
  const tileH = Math.max(1, a.height, b.height);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  if (dim.w !== tileW * 2 || dim.h !== tileH) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, tileW * 2, tileH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    dim.w = tileW * 2;
    dim.h = tileH;
  }
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, original);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, tileW, 0, gl.RGBA, gl.UNSIGNED_BYTE, result);
}

function bootGl(gl: Gl) {
  const program = linkGl(gl, GL_VS2, GL_FS2);
  if (!program) return null;
  const buffer = gl.createBuffer();
  const resultTex = gl.createTexture();
  const sourceTex = gl.createTexture();
  if (!buffer || !resultTex || !sourceTex) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  gl.useProgram(program);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const aniso = gl.getExtension("EXT_texture_filter_anisotropic");
  const anisoCap = aniso
    ? Math.min(STAGE_ANISO, Number(gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1)
    : 1;
  for (const texture of [resultTex, sourceTex]) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (aniso && anisoCap > 1) {
      gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, anisoCap);
    }
  }
  gl.uniform1i(gl.getUniformLocation(program, "u_result"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "u_source"), 1);
  return { program, resultTex, sourceTex, locs: glLocs(gl, program) };
}

function rebuildGl(session: GlSession) {
  if (session.gl.isContextLost()) return false;
  const boot = bootGl(session.gl);
  if (!boot) return false;
  session.program = boot.program;
  session.locs = boot.locs;
  session.resultTex = boot.resultTex;
  session.sourceTex = boot.sourceTex;
  session.lastResult = undefined;
  session.lastSource = undefined;
  session.lastPacked = false;
  session.resultDim = { w: 0, h: 0 };
  session.sourceDim = { w: 0, h: 0 };
  session.lastW = 0;
  session.lastH = 0;
  session.alive = true;
  return true;
}

type GlLocs = {
  wipe: WebGLUniformLocation | null;
  comparing: WebGLUniformLocation | null;
  mask: WebGLUniformLocation | null;
  peek: WebGLUniformLocation | null;
  checkA: WebGLUniformLocation | null;
  checkB: WebGLUniformLocation | null;
};

type GlSession = {
  gl: Gl;
  program: WebGLProgram;
  locs: GlLocs;
  resultTex: WebGLTexture;
  sourceTex: WebGLTexture;
  lastResult: TexImageSource | null | undefined;
  lastSource: TexImageSource | null | undefined;
  lastPacked: boolean;
  resultDim: { w: number; h: number };
  sourceDim: { w: number; h: number };
  lastW: number;
  lastH: number;
  alive: boolean;
};

const glSessions = new WeakMap<HTMLCanvasElement, GlSession>();

function glLocs(gl: Gl, program: WebGLProgram): GlLocs {
  return {
    wipe: gl.getUniformLocation(program, "u_wipe"),
    comparing: gl.getUniformLocation(program, "u_comparing"),
    mask: gl.getUniformLocation(program, "u_mask"),
    peek: gl.getUniformLocation(program, "u_peek"),
    checkA: gl.getUniformLocation(program, "u_checkA"),
    checkB: gl.getUniformLocation(program, "u_checkB"),
  };
}

function paintGl(canvas: HTMLCanvasElement, session: GlSession, frame: StageGpuFrame) {
  frame = liveFrame(frame);
  if (session.gl.isContextLost()) {
    session.alive = false;
    return false;
  }
  if (!session.alive && !rebuildGl(session)) return false;
  const { gl, program, locs, resultTex, sourceTex } = session;
  try {
    const { width, height } = fitCanvas(canvas);
    if (width !== session.lastW || height !== session.lastH) {
      gl.viewport(0, 0, width, height);
      session.lastW = width;
      session.lastH = height;
    }
    if (frame.source !== session.lastSource) {
      glTex(gl, 1, sourceTex, session.sourceDim, frame.source, width, height);
    }
    const split = compareReady(frame.comparing, frame.result, frame.source);
    if (split && frame.result && frame.source) {
      if (
        !session.lastPacked ||
        frame.result !== session.lastResult ||
        frame.source !== session.lastSource
      ) {
        const packed = packStageAtlas(frame.result, frame.source, width, height);
        if (packed) {
          glTex(gl, 0, resultTex, session.resultDim, packed, width * 2, height);
          dropScratch(packed, null);
        } else glTexAtlas(gl, resultTex, session.resultDim, frame.result, frame.source);
        session.lastPacked = true;
      }
    } else if (session.lastPacked || frame.result !== session.lastResult) {
      glTex(gl, 0, resultTex, session.resultDim, frame.result, width, height);
      session.lastPacked = false;
    }
    session.lastResult = frame.result;
    session.lastSource = frame.source;
    gl.useProgram(program);
    const tint = checkerTint(canvas);
    gl.uniform3f(locs.checkA, tint.ar[0], tint.ar[1], tint.ar[2]);
    gl.uniform3f(locs.checkB, tint.br[0], tint.br[1], tint.br[2]);
    gl.uniform1f(locs.wipe, Math.min(1, Math.max(0, frame.wipe)));
    gl.uniform1f(locs.comparing, split && session.lastPacked ? 1 : 0);
    gl.uniform1f(locs.mask, frame.masking ? 1 : 0);
    gl.uniform1f(locs.peek, frame.peeking ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  } catch {
    return false;
  }
}

const glWatched = new WeakSet<HTMLCanvasElement>();

function watchGlContext(canvas: HTMLCanvasElement) {
  if (glWatched.has(canvas)) return;
  glWatched.add(canvas);
  canvas.addEventListener("webglcontextlost", (event) => {
    preserveContextOnLost(event);
    const session = glSessions.get(canvas);
    if (session) session.alive = false;
  });
  canvas.addEventListener("webglcontextrestored", () => {
    const session = glSessions.get(canvas);
    if (session) rebuildGl(session);
  });
}

function attachGl(canvas: HTMLCanvasElement): StageGpu | null {
  const existing = glSessions.get(canvas);
  if (existing) {
    if (existing.gl.isContextLost()) return null;
    if (!existing.alive && !rebuildGl(existing)) return null;
    existing.gl.useProgram(existing.program);
    return {
      kind: "webgl2",
      paint: (frame) => paintGl(canvas, existing, frame),
      destroy: () => {
        existing.alive = false;
      },
    };
  }
  const opts = {
    alpha: false,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power" as const,
  };
  const gl = canvas.getContext("webgl2", opts) as Gl | null;
  if (!gl || gl.isContextLost()) return null;
  const boot = bootGl(gl);
  if (!boot) return null;
  const session: GlSession = {
    gl,
    program: boot.program,
    locs: boot.locs,
    resultTex: boot.resultTex,
    sourceTex: boot.sourceTex,
    lastResult: undefined,
    lastSource: undefined,
    lastPacked: false,
    resultDim: { w: 0, h: 0 },
    sourceDim: { w: 0, h: 0 },
    lastW: 0,
    lastH: 0,
    alive: true,
  };
  glSessions.set(canvas, session);
  watchGlContext(canvas);

  return {
    kind: "webgl2",
    paint: (frame) => paintGl(canvas, session, frame),
    destroy: () => {
      session.alive = false;
    },
  };
}

const maskScratch = typeof document === "undefined" ? null : document.createElement("canvas");

function packStageAtlas(
  result: TexImageSource | null | undefined,
  source: TexImageSource | null | undefined,
  viewW = 1600,
  viewH = 900,
) {
  const left = asDraw(result);
  const right = asDraw(source);
  if (!left || !right || !result || !source) return null;
  const a = sourceSize(result);
  const b = sourceSize(source);
  const tile = gpuTexFit(
    Math.max(1, a.width, b.width),
    Math.max(1, a.height, b.height),
    viewW,
    viewH,
  );
  // Tile 0 is the original, tile 1 is the cutout.
  const canvas = document.createElement("canvas");
  canvas.width = tile.width * 2;
  canvas.height = tile.height;
  const ctx = canvas.getContext("2d", { alpha: true });
  if (!ctx) return null;
  ctx.drawImage(right, 0, 0, tile.width, tile.height);
  ctx.drawImage(left, tile.width, 0, tile.width, tile.height);
  return canvas;
}

function asDraw(source: TexImageSource | null | undefined): CanvasImageSource | null {
  if (!source || (!("width" in source) && !("naturalWidth" in source) && !("videoWidth" in source)))
    return null;
  if (typeof ImageData !== "undefined" && source instanceof ImageData) return null;
  return source as CanvasImageSource;
}

function liveFrame(frame: StageGpuFrame): StageGpuFrame {
  const result = liveBitmap(frame.result),
    source = liveBitmap(frame.source);
  return result === frame.result && source === frame.source ? frame : { ...frame, result, source };
}

function attach2d(canvas: HTMLCanvasElement): StageGpu | null {
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  if (!ctx) return null;
  let alive = true;
  let atlas: HTMLCanvasElement | null = null;
  let atlasResult: TexImageSource | null | undefined;
  let atlasSource: TexImageSource | null | undefined;
  let closed = false;
  const lost = (event: Event) => {
    preserveContextOnLost(event);
    alive = false;
  };
  const restored = () => {
    if (!closed) alive = true;
  };
  canvas.addEventListener("contextlost", lost);
  canvas.addEventListener("contextrestored", restored);
  const paint = (frame: StageGpuFrame) => {
    if (!alive) return false;
    frame = liveFrame(frame);
    try {
      const { width, height } = fitCanvas(canvas);
      const tint = checkerTint(canvas);
      const cell = CHECKER_CELL;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.filter = "none";
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.imageSmoothingEnabled = true;
      if (frame.masking) {
        ctx.fillStyle = "#12110e";
        ctx.fillRect(0, 0, width, height);
        if (frame.result && maskScratch) {
          maskScratch.width = width;
          maskScratch.height = height;
          const mask = maskScratch.getContext("2d");
          if (mask) {
            mask.globalCompositeOperation = "source-over";
            mask.fillStyle = "#f6f3eb";
            mask.fillRect(0, 0, width, height);
            mask.globalCompositeOperation = "destination-in";
            const cutout = asDraw(frame.result);
            if (cutout) mask.drawImage(cutout, 0, 0, width, height);
            ctx.drawImage(maskScratch, 0, 0);
          }
        }
        return true;
      }
      ctx.fillStyle = tint.b;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = tint.a;
      for (let y = 0; y < height; y += cell) {
        for (let x = 0; x < width; x += cell) {
          if ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) ctx.fillRect(x, y, cell, cell);
        }
      }
      if (compareReady(frame.comparing, frame.result, frame.source)) {
        if (!atlas || frame.result !== atlasResult || frame.source !== atlasSource) {
          dropScratch(atlas, null);
          atlas = packStageAtlas(frame.result, frame.source);
          atlasResult = frame.result;
          atlasSource = frame.source;
        }
        if (!atlas) return false;
        const split = Math.round(Math.min(1, Math.max(0, frame.wipe)) * width);
        const tileW = atlas ? atlas.width / 2 : 0;
        const tileH = atlas ? atlas.height : 0;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, split, height);
        ctx.clip();
        if (atlas) ctx.drawImage(atlas, 0, 0, tileW, tileH, 0, 0, width, height);
        ctx.restore();
        ctx.save();
        ctx.beginPath();
        ctx.rect(split, 0, width - split, height);
        ctx.clip();
        if (atlas) ctx.drawImage(atlas, tileW, 0, tileW, tileH, 0, 0, width, height);
        ctx.restore();
      } else {
        const photo = asDraw(frame.peeking ? frame.source : frame.result);
        if (photo) ctx.drawImage(photo, 0, 0, width, height);
      }
      return true;
    } catch {
      return false;
    }
  };
  return {
    kind: "2d",
    paint,
    destroy: () => {
      closed = true;
      alive = false;
      canvas.removeEventListener("contextlost", lost);
      canvas.removeEventListener("contextrestored", restored);
      dropScratch(atlas, null);
      atlas = null;
    },
  };
}

export async function attachStageGpu(
  canvas: HTMLCanvasElement,
  onInvalidate: () => void = () => {},
  backend?: StageBackend,
): Promise<StageGpu | null> {
  if (backend === "2d") return attach2d(canvas);
  if (backend === "webgl2") return attachGl(canvas);
  const webgpu = await attachWebGpu(canvas, onInvalidate);
  // A context-acquired canvas is mode-locked even if configuration failed.
  // Stage owns the DOM element and mounts a fresh one for its next backend.
  if (webgpu || backend === "webgpu" || webGpuCanvases.has(canvas)) return webgpu;
  return attachGl(canvas) ?? attach2d(canvas);
}
