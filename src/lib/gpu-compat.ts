export type GpuApi = {
  requestAdapter: (options?: { powerPreference?: "high-performance" | "low-power" }) => Promise<GpuAdapter | null>;
};

export type GpuAdapter = {
  requestDevice: (desc?: { requiredLimits?: Record<string, number> }) => Promise<unknown>;
  limits?: { maxStorageBufferBindingSize?: number };
  features?: { has: (feature: string) => boolean };
};

export type GpuDevice = {
  addEventListener?: (type: string, listener: (event: { error?: { message?: string } }) => void) => void;
  lost?: Promise<{ reason?: string }>;
  destroy?: () => void;
};

const PREFS: Array<"high-performance" | "low-power" | undefined> = ["high-performance", "low-power", undefined];

/** Try discrete GPU, then integrated, then whatever the browser offers. */
export async function requestCompatibleAdapter(api: GpuApi | undefined) {
  if (!api) return null;
  for (const preference of PREFS) {
    try {
      const adapter = await api.requestAdapter(preference ? { powerPreference: preference } : undefined);
      if (adapter) return adapter;
    } catch {
      /* next preference */
    }
  }
  return null;
}

/**
 * Whether BiRefNet's fp16 WebGPU route can run. Without `shader-f16` transformers refuses the fp16
 * weights ("does not support fp16"); it checks the browser's default adapter, which ORT then runs on,
 * not the preferred one `requestCompatibleAdapter` returns. The original ran primary WASM there.
 */
export async function hasFp16Adapter(api: GpuApi | undefined) {
  try {
    return (await api?.requestAdapter())?.features?.has("shader-f16") === true;
  } catch {
    return false;
  }
}

export async function requestCompatibleDevice(adapter: GpuAdapter) {
  const maxStorage = adapter.limits?.maxStorageBufferBindingSize;
  const want = 128 * 1024 * 1024;
  const requiredLimits =
    typeof maxStorage === "number" && maxStorage >= want ? { maxStorageBufferBindingSize: want } : undefined;
  try {
    return await adapter.requestDevice(requiredLimits ? { requiredLimits } : undefined);
  } catch {
    return adapter.requestDevice();
  }
}

export function watchDeviceLoss(device: GpuDevice, onLost: () => void) {
  device.addEventListener?.("uncapturederror", () => onLost());
  void device.lost?.then(() => onLost());
}

export function navigatorGpu() {
  return (navigator as Navigator & { gpu?: GpuApi }).gpu;
}
