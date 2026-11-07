import assert from "node:assert/strict";
import test from "node:test";

/** A device a whole pass runs on: it records every buffer's destroy() calls; mapAsync may fail. */
function passDevice(mapFails: boolean) {
  const buffers: { size: number; destroyed: number }[] = [];
  let destroyed = 0;
  const device = {
    limits: { maxStorageBufferBindingSize: 1 << 30, maxBufferSize: 1 << 30 },
    lost: new Promise(() => {}),
    addEventListener() {},
    destroy() {
      destroyed += 1;
    },
    createShaderModule: () => ({}),
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer({ size }: { size: number }) {
      const made = { size, destroyed: 0 };
      buffers.push(made);
      return {
        destroy() {
          made.destroyed += 1;
        },
        async mapAsync() {
          if (mapFails) throw new Error("controlled readback failure");
        },
        getMappedRange: () => new Uint8Array(size).fill(255).buffer,
        unmap() {},
      };
    },
    createBindGroup: () => ({}),
    createCommandEncoder: () => ({
      beginComputePass: () => ({
        setPipeline() {},
        setBindGroup() {},
        dispatchWorkgroups() {},
        end() {},
      }),
      copyBufferToBuffer() {},
      finish: () => ({}),
    }),
    queue: { writeBuffer() {}, submit() {} },
  };
  return { device, buffers, destroyed: () => destroyed };
}

test("unblendMatteGpu destroys every full-resolution buffer after the pass, whether it succeeds or fails", async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  t.after(() => Object.defineProperty(globalThis, "navigator", before));
  const width = 600,
    height = 600;
  for (const mapFails of [false, true]) {
    const { device, buffers, destroyed } = passDevice(mapFails);
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } },
    });
    const { unblendMatteGpu } = await import(`./gpu-matte.ts?pass=${mapFails ? "fails" : "ok"}`);
    const image = () =>
      ({ width, height, data: new Uint8ClampedArray(width * height * 4) }) as ImageData;
    const scene = { isGraphic: false, exactTol2: 1, maskWorked: true };
    const grid = { cells: new Float32Array(3), gridW: 1, gridH: 1, cell: 600 };
    assert.equal(await unblendMatteGpu(image(), image(), scene, grid), !mapFails);
    // The session's 32-byte uniform outlives the pass; the five per-pass buffers do not.
    const [uniform, ...pass] = buffers;
    assert.equal(uniform?.size, 32);
    assert.equal(pass.length, 5);
    assert.deepEqual(
      pass.map((made) => made.destroyed),
      [1, 1, 1, 1, 1],
      `mapFails=${mapFails}`,
    );
    assert.equal(uniform?.destroyed, 0);
    // A failed pass retires the device once its last pass is done; a good one keeps it.
    assert.equal(destroyed(), mapFails ? 1 : 0);
  }
});

import { buildBackdropGrid, processCutout, unblendSpill } from "./defringe.ts";
import { MATTE_SHADER } from "./gpu-matte.ts";

function studioScene(width = 200, height = 140) {
  const src = new Uint8ClampedArray(width * height * 4);
  const dst = new Uint8ClampedArray(width * height * 4);
  const rows = [40, 70, 100];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const inSubject = x >= 60 && x <= 130 && y >= 30 && y <= 110;
      const onWhisker = rows.includes(y) && x > 130 && x < 175;
      // a white shirt patch inside the subject: same colour as the backdrop, alpha 240
      const shirt = inSubject && x >= 90 && x <= 120 && y >= 70 && y <= 100;
      const bg = [244 + ((x + y) % 3), 245 + ((x * 7 + y) % 3), 246 + ((x + y * 5) % 3)];
      const fur = [
        148 + (((x * 13 + y * 7) % 23) - 11),
        104 + (((x * 5 + y * 3) % 19) - 9),
        62 + (((x * 3 + y * 11) % 17) - 8),
      ];
      const colour = inSubject
        ? shirt
          ? bg
          : fur
        : onWhisker
          ? bg.map((v, k) => Math.round(fur[k]! * 0.35 + v * 0.65))
          : bg;
      src[i] = colour[0]!;
      src[i + 1] = colour[1]!;
      src[i + 2] = colour[2]!;
      src[i + 3] = 255;
      dst[i] = colour[0]!;
      dst[i + 1] = colour[1]!;
      dst[i + 2] = colour[2]!;
      dst[i + 3] = shirt ? 240 : inSubject ? 255 : 0;
    }
  }
  return { src, dst, width, height };
}

test("CPU unblendSpill keeps a white shirt and faint whiskers on a studio backdrop", () => {
  const { src, dst, width, height } = studioScene();
  // finishCutoutData runs processCutout with skipUnblend, then either path on the result.
  const scene = processCutout(dst, src, width, height, {
    refine: true,
    jpeg: false,
    skipUnblend: true,
  });
  assert.equal(scene.hasBlankField, true);
  assert.equal(scene.isGraphic, false);
  const grid = buildBackdropGrid(dst, src, width, height, scene.field);

  const gpu = new Uint8ClampedArray(dst);
  unblendSpill(gpu, src, width, height, grid, scene);

  // The white shirt survives, faint whiskers keep colour; MATTE_SHADER mirrors these gates.
  let shirtZeroed = 0;
  let crushed = 0;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (x >= 90 && x <= 120 && y >= 70 && y <= 100 && gpu[i + 3] === 0) shirtZeroed += 1;
      const a = gpu[i + 3]!;
      if (a > 0 && a < 200 && 0.2126 * gpu[i]! + 0.7152 * gpu[i + 1]! + 0.0722 * gpu[i + 2]! < 40)
        crushed += 1;
    }
  assert.ok(
    shirtZeroed < 961 * 0.5,
    `a white shirt on a white backdrop is not punched out, zeroed ${shirtZeroed}/961`,
  );
  assert.equal(crushed, 0, "faint recovered edges keep their hue");
});

test("matte shader carries the CPU path's constants and gates", () => {
  for (const needle of [
    "a >= 250.0",
    "a < 220.0",
    "params.maskWorked == 0u",
    "max(a / 255.0, 0.004)",
    "gamutLimit(src.r, delta.r)",
    "gridBuf[c]",
  ]) {
    assert.ok(MATTE_SHADER.includes(needle), `shader carries ${needle}`);
  }
});

test("failed synchronous GPU setup destroys only the failed device and permits a shared retry (FINISH-04)", async (t) => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "navigator")!;
  t.after(() => Object.defineProperty(globalThis, "navigator", before));
  for (const stage of ["shader", "pipeline", "uniform", "watch"] as const) {
    let requests = 0;
    const destroyed = [0, 0];
    let fail = true;
    const device = (index: number) => ({
      limits: { maxStorageBufferBindingSize: 0 },
      createShaderModule() {
        if (fail && stage === "shader") throw new Error("controlled synchronous setup failure");
        return {};
      },
      createComputePipeline() {
        if (fail && stage === "pipeline") throw new Error("controlled synchronous setup failure");
        return {};
      },
      createBuffer() {
        if (fail && stage === "uniform") throw new Error("controlled synchronous setup failure");
        return {};
      },
      addEventListener() {
        if (fail && stage === "watch") throw new Error("controlled synchronous setup failure");
      },
      destroy() {
        destroyed[index]! += 1;
      },
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        gpu: { requestAdapter: async () => ({ requestDevice: async () => device(requests++) }) },
      },
    });
    const { unblendMatteGpu } = await import(`./gpu-matte.ts?setup=${stage}`);
    const data = { width: 600, height: 600 } as ImageData;
    const scene = { isGraphic: false, exactTol2: 1, maskWorked: true };
    const grid = { cells: new Float32Array(3), gridW: 1, gridH: 1, cell: 600 };
    assert.deepEqual(
      await Promise.all([
        unblendMatteGpu(data, data, scene, grid),
        unblendMatteGpu(data, data, scene, grid),
      ]),
      [false, false],
    );
    assert.equal(requests, 1);
    assert.deepEqual(destroyed, [1, 0], `${stage}: destroy the unregistered device`);
    fail = false;
    // Binding-limit fallback lets us observe successful session lifetime without a GPU pass.
    assert.equal(await unblendMatteGpu(data, data, scene, grid), false);
    assert.equal(await unblendMatteGpu(data, data, scene, grid), false);
    assert.equal(requests, 2, "a successful session is shared by later passes");
    assert.deepEqual(destroyed, [1, 0]);
  }
});
