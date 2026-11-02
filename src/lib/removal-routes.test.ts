import assert from "node:assert/strict";
import test from "node:test";
import { selectRemovalRoute } from "./removal-provider.ts";

const GPU = { model: "birefnet", provider: "webgpu" } as const;
const GPU32 = { ...GPU, dtype: "fp32" } as const;
const CPU = { model: "birefnet", provider: "wasm" } as const;
const SMALL = { model: "isnet", provider: "wasm" } as const;

// Explicit browser-context rows keep unnamed desktop routes fixed when the table evolves.
const contexts = [
  ["desktop WebGPU f16", 8, true, true, false, GPU],
  ["desktop no GPU", 8, false, false, true, CPU],
  ["desktop GPU without f16", 8, true, false, false, GPU32],
  ["iPhone WebGPU f16, unknown memory", undefined, true, true, false, GPU],
  ["iPhone no GPU, unknown memory", undefined, false, false, true, CPU],
  ["iPad WebGPU f16, unknown memory", undefined, true, true, false, GPU],
  ["iPad no GPU, unknown memory", undefined, false, false, true, CPU],
  ["Android 4 GB WebGPU f16", 4, true, true, false, GPU],
  ["Android 4 GB GPU without f16", 4, true, false, false, GPU32],
  ["Android 4 GB no GPU", 4, false, false, true, SMALL],
  ["Android 4 GB failed GPU", 4, true, true, true, CPU],
  ["Android 8 GB WebGPU f16", 8, true, true, false, GPU],
  ["Android 8 GB no GPU", 8, false, false, true, CPU],
  ["Firefox desktop, no usable adapter", undefined, false, false, true, CPU],
  ["Firefox desktop, usable no-f16 adapter", undefined, true, false, false, GPU32],
  ["desktop 4 GB WebGPU f16", 4, true, true, false, GPU],
  ["desktop 4 GB no GPU", 4, false, false, true, SMALL],
] as const;

for (const [context, memory, compatibleGpu, fp16, gpuFailed, primary] of contexts) {
  test(`C20 routing: ${context}`, () => {
    assert.deepEqual(selectRemovalRoute({
      ...(memory === undefined ? {} : { deviceMemory: memory }), compatibleGpu, fp16, gpuFailed,
    }), { primary });
  });
}
