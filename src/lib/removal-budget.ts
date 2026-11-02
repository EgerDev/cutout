import type { RemovalMode } from "./editor/model.ts";
import type { RemovalDtype } from "./removal-provider.ts";

export function refinementBudget(
  provider: "webgpu" | "wasm",
  deviceMemory: number | undefined,
  globalInferenceMs: number,
  sourcePixels: number,
  mode: RemovalMode = "auto",
  dtype?: RemovalDtype,
) {
  if (mode === "quick") return 0;
  if (typeof deviceMemory === "number" && deviceMemory <= 3) return 0;
  if (mode !== "maximum") {
    if (globalInferenceMs > 12_000) return 0;
    if (sourcePixels > 16_000_000) return 0;
  } else if (sourcePixels > 24_000_000) return 0;
  // The new fp32 GPU route keeps the crop budget of the WASM route it replaces.
  const gpuBudget = provider === "webgpu" && dtype !== "fp32";
  if (mode === "maximum") return gpuBudget ? 4 : 2;
  return gpuBudget ? 2 : 1;
}
