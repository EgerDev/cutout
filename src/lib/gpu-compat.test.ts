import assert from "node:assert/strict";
import test from "node:test";
import { hasFp16Adapter, requestCompatibleAdapter, requestCompatibleDevice } from "./gpu-compat.ts";

test("adapter waterfall uses high-performance then low-power then default", async () => {
  const seen: Array<string | undefined> = [];
  const api = {
    requestAdapter: async (options?: { powerPreference?: string }) => {
      seen.push(options?.powerPreference);
      return null;
    },
  };
  const adapter = await requestCompatibleAdapter(api);
  assert.equal(adapter, null);
  assert.deepEqual(seen, ["high-performance", "low-power", undefined]);
});

test("adapter stops at the first success", async () => {
  const seen: string[] = [];
  const api = {
    requestAdapter: async (options?: { powerPreference?: string }) => {
      seen.push(options?.powerPreference ?? "default");
      if (options?.powerPreference === "low-power") return { requestDevice: async () => ({}) };
      return null;
    },
  };
  const adapter = await requestCompatibleAdapter(api);
  assert.ok(adapter);
  assert.deepEqual(seen, ["high-performance", "low-power"]);
});

test("hasFp16Adapter is true only when the default adapter reports shader-f16", async () => {
  assert.equal(await hasFp16Adapter(undefined), false);
  assert.equal(
    await hasFp16Adapter({
      requestAdapter: async () => ({ requestDevice: async () => ({}), features: { has: () => false } }),
    }),
    false,
  );
  assert.equal(
    await hasFp16Adapter({
      requestAdapter: async () => ({
        requestDevice: async () => ({}),
        features: { has: (feature) => feature === "shader-f16" },
      }),
    }),
    true,
  );
  assert.equal(
    await hasFp16Adapter({
      requestAdapter: async () => {
        throw new Error("adapter probe failed");
      },
    }),
    false,
  );
});

test("device request falls back if storage limits are rejected", async () => {
  let attempts = 0;
  const adapter = {
    limits: { maxStorageBufferBindingSize: 256 * 1024 * 1024 },
    requestDevice: async (desc?: { requiredLimits?: Record<string, number> }) => {
      attempts += 1;
      if (desc?.requiredLimits) throw new Error("limits");
      return { ok: true };
    },
  };
  const device = await requestCompatibleDevice(adapter);
  assert.equal(attempts, 2);
  assert.deepEqual(device, { ok: true });
});
