import {
  navigatorGpu,
  requestCompatibleAdapter,
  requestCompatibleDevice,
  watchDeviceLoss,
} from "./gpu-compat.ts";
import type { BackdropGrid, Scene } from "./defringe.ts";

type GpuDevice = {
  limits?: { maxStorageBufferBindingSize?: number; maxBufferSize?: number };
  createShaderModule: (desc: { code: string }) => unknown;
  createComputePipeline: (desc: unknown) => { getBindGroupLayout: (i: number) => unknown };
  createBindGroup: (desc: unknown) => unknown;
  createBuffer: (desc: { size: number; usage: number }) => GpuBuffer;
  createCommandEncoder: () => GpuEncoder;
  queue: {
    writeBuffer: (buffer: GpuBuffer, offset: number, data: BufferSource) => void;
    submit: (cmds: unknown[]) => void;
  };
  addEventListener?: (
    type: string,
    listener: (event: { error?: { message?: string } }) => void,
  ) => void;
  lost?: Promise<{ reason?: string }>;
  destroy?: () => void;
};

type GpuBuffer = {
  mapAsync: (mode: number) => Promise<void>;
  getMappedRange: () => ArrayBuffer;
  unmap: () => void;
  destroy: () => void;
};

type GpuEncoder = {
  beginComputePass: () => {
    setPipeline: (p: unknown) => void;
    setBindGroup: (i: number, g: unknown) => void;
    dispatchWorkgroups: (x: number, y: number) => void;
    end: () => void;
  };
  copyBufferToBuffer: (
    src: GpuBuffer,
    srcOffset: number,
    dst: GpuBuffer,
    dstOffset: number,
    size: number,
  ) => void;
  finish: () => unknown;
};

const WORKGROUP = 16;

/**
 * GPU twin of the CPU `unblendSpill` for photographic scenes on a blank field. Works in
 * byte units and mirrors it decision for decision: the per-cell backdrop grid rather
 * than one global field colour, the `maskWorked`/alpha-220 gate before zeroing an
 * exact-field pixel, and the gamut-limited unblend that keeps faint edges in hue.
 * Keep the two in step.
 */
export const MATTE_SHADER = /* wgsl */ `
struct Params { exact: f32, width: u32, height: u32, gridW: u32, gridH: u32, cell: u32, maskWorked: u32, _pad: u32 };

@group(0) @binding(0) var<storage, read> srcBuf: array<u32>;
@group(0) @binding(1) var<storage, read> maskBuf: array<u32>;
@group(0) @binding(2) var<storage, read_write> destBuf: array<u32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var<storage, read> gridBuf: array<f32>;

fn unpack(p: u32) -> vec4f {
  return vec4f(f32(p & 255u), f32((p >> 8u) & 255u), f32((p >> 16u) & 255u), f32(p >> 24u));
}

fn pack(c: vec4f) -> u32 {
  let v = vec4u(clamp(c, vec4f(0.0), vec4f(255.0)) + 0.5);
  return v.x | (v.y << 8u) | (v.z << 16u) | (v.w << 24u);
}

fn gamutLimit(base: f32, delta: f32) -> f32 {
  if (abs(delta) < 1e-6) { return 1.0; }
  var headroom = -base;
  if (delta > 0.0) { headroom = 255.0 - base; }
  let limit = headroom / delta;
  if (limit <= 0.0) { return 0.0; }
  return min(1.0, limit);
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let i = id.y * params.width + id.x;
  let src = unpack(srcBuf[i]);
  let a = unpack(maskBuf[i]).a;
  if (a == 0.0) {
    destBuf[i] = 0u;
    return;
  }
  if (a >= 250.0) {
    destBuf[i] = pack(vec4f(src.rgb, 255.0));
    return;
  }
  let cx = min(params.gridW - 1u, id.x / params.cell);
  let cy = min(params.gridH - 1u, id.y / params.cell);
  let c = (cy * params.gridW + cx) * 3u;
  let bg = vec3f(gridBuf[c], gridBuf[c + 1u], gridBuf[c + 2u]);
  let d = src.rgb - bg;
  if (dot(d, d) <= params.exact && (params.maskWorked == 0u || a < 220.0)) {
    destBuf[i] = 0u;
    return;
  }
  let t = max(a / 255.0, 0.004);
  let delta = (src.rgb - bg * (1.0 - t)) / t - src.rgb;
  let w = min(gamutLimit(src.r, delta.r), min(gamutLimit(src.g, delta.g), gamutLimit(src.b, delta.b)));
  destBuf[i] = pack(vec4f(src.rgb + w * delta, a));
}
`;

export type MatteScene = Pick<Scene, "exactTol2" | "maskWorked" | "isGraphic">;

const GPU_BUFFER_USAGE = {
  MAP_READ: 0x0001,
  COPY_SRC: 0x0004,
  COPY_DST: 0x0008,
  UNIFORM: 0x0040,
  STORAGE: 0x0080,
} as const;

const STORAGE = GPU_BUFFER_USAGE.STORAGE;
const COPY_DST = GPU_BUFFER_USAGE.COPY_DST;
const COPY_SRC = GPU_BUFFER_USAGE.COPY_SRC;
const MAP_READ = GPU_BUFFER_USAGE.MAP_READ;
const UNIFORM = GPU_BUFFER_USAGE.UNIFORM;

type Session = {
  device: GpuDevice;
  pipeline: { getBindGroupLayout: (i: number) => unknown };
  uniform: GpuBuffer;
  /** Passes using the device now; a broken session is destroyed after the last one. */
  passes: number;
  broken: boolean;
};

let session: Session | null = null;

/** Forget the device, and free it once no pass (a preview beside an export) still uses it;
 *  the next image asks for a fresh one. */
function retire(broken: Session) {
  broken.broken = true;
  if (session === broken) session = null;
  if (!broken.passes) broken.device.destroy?.();
}

let opening: Promise<Session | null> | null = null;

/** One device request at a time: two first passes at once each made a device, and the
 *  first was never retired or destroyed. */
function getSession(): Promise<Session | null> {
  if (session) return Promise.resolve(session);
  return (opening ??= openSession().finally(() => {
    opening = null;
  }));
}

async function openSession() {
  if (session) return session;
  const api = navigatorGpu();
  if (!api) return null;
  let device: GpuDevice | undefined;
  try {
    const adapter = await requestCompatibleAdapter(api);
    if (!adapter) return null;
    device = (await requestCompatibleDevice(adapter)) as GpuDevice;
    const pipeline = device.createComputePipeline({
      layout: "auto",
      compute: { module: device.createShaderModule({ code: MATTE_SHADER }), entryPoint: "main" },
    });
    const uniform = device.createBuffer({ size: 32, usage: UNIFORM | COPY_DST });
    const made: Session = { device, pipeline, uniform, passes: 0, broken: false };
    watchDeviceLoss(device, () => retire(made));
    session = made;
    return made;
  } catch {
    // Synchronous setup failures happen before retire() can own this device.
    device?.destroy?.();
    session = null;
    return null;
  }
}

export async function unblendMatteGpu(
  dest: ImageData,
  source: ImageData,
  scene: MatteScene,
  grid: BackdropGrid,
): Promise<boolean> {
  const width = dest.width;
  const height = dest.height;
  if (width * height < 360_000) return false;
  // Graphics take the CPU path: its colour-to-alpha branch for opaque ink is not mirrored here.
  if (scene.isGraphic) return false;
  const gpuSession = await getSession();
  if (!gpuSession) return false;
  const { device, pipeline, uniform } = gpuSession;
  // Over the binding limit (128 MiB: ~33 MP) the bind group is invalid and the pass reads
  // back zeros after uploading hundreds of MB; the CPU path handles it directly.
  const bytes = width * height * 4;
  if (
    bytes > (device.limits?.maxStorageBufferBindingSize ?? 128 * 1024 * 1024) ||
    bytes > (device.limits?.maxBufferSize ?? 256 * 1024 * 1024)
  )
    return false;
  // Full-resolution buffers live for one pass only; a 12 MP matte holds ~200 MB of them.
  const buffers: GpuBuffer[] = [];
  const buffer = (size: number, usage: number) => {
    const made = device.createBuffer({ size, usage });
    buffers.push(made);
    return made;
  };
  gpuSession.passes += 1;
  try {
    const pixels = width * height;
    const src = buffer(bytes, STORAGE | COPY_DST);
    const mask = buffer(bytes, STORAGE | COPY_DST);
    const destBuf = buffer(bytes, STORAGE | COPY_SRC);
    const read = buffer(bytes, MAP_READ | COPY_DST);
    const gridBuf = buffer(Math.max(16, grid.cells.byteLength), STORAGE | COPY_DST);
    const params = new ArrayBuffer(32);
    new Float32Array(params, 0, 1)[0] = scene.exactTol2;
    const ints = new Uint32Array(params);
    ints[1] = width;
    ints[2] = height;
    ints[3] = grid.gridW;
    ints[4] = grid.gridH;
    ints[5] = grid.cell;
    ints[6] = scene.maskWorked ? 1 : 0;
    device.queue.writeBuffer(uniform, 0, params);
    device.queue.writeBuffer(src, 0, source.data);
    device.queue.writeBuffer(mask, 0, dest.data);
    device.queue.writeBuffer(gridBuf, 0, grid.cells);
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: src } },
        { binding: 1, resource: { buffer: mask } },
        { binding: 2, resource: { buffer: destBuf } },
        { binding: 3, resource: { buffer: uniform } },
        { binding: 4, resource: { buffer: gridBuf } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, group);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(destBuf, 0, read, 0, pixels * 4);
    device.queue.submit([encoder.finish()]);
    await read.mapAsync(MAP_READ);
    try {
      const mapped = new Uint8Array(read.getMappedRange());
      let hits = 0;
      for (let i = 3; i < mapped.length && hits < 32; i += 4) if (mapped[i]! > 16) hits += 1;
      if (hits < 32) return false;
      dest.data.set(mapped);
      return true;
    } finally {
      read.unmap();
    }
  } catch {
    retire(gpuSession);
    return false;
  } finally {
    for (const made of buffers) made.destroy();
    gpuSession.passes -= 1;
    if (gpuSession.broken && !gpuSession.passes) device.destroy?.();
  }
}
