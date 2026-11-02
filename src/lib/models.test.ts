import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { MODEL_NOTICES } from "./model-notices.ts";
import { MODELS, MODEL_PREPARE_TIMEOUT_MS, formatMB, type ModelId } from "./models.ts";

const HOOKS = `
export async function resolve(specifier, context, next) {
  const parent = context.parentURL ?? "";
  // Each test imports models.ts under its own ?case= tag so its lazy backend
  // imports resolve to fresh stub modules — a cached module would skip the delay.
  const tag = /[?&]case=([^&#]+)/.exec(parent)?.[1];
  const suffix = tag ? "?case=" + tag : "";
  if (parent.includes("/src/lib/models.ts") && specifier.endsWith("/removal-client.ts"))
    return { url: "cutout-test:prepare-birefnet" + suffix, shortCircuit: true };
  if (parent.includes("/src/lib/models.ts") && specifier.endsWith("/enhance.ts"))
    return { url: "cutout-test:prepare-enhance" + suffix, shortCircuit: true };
  if (parent.includes("/src/lib/models.ts") && specifier.endsWith("/editor/depth.ts"))
    return { url: "cutout-test:prepare-depth" + suffix, shortCircuit: true };
  return next(specifier, context);
}
export async function load(url, context, next) {
  // A top-level await makes the import promise itself hang in flight — the same
  // observable shape as a slow module fetch for the importer.
  const held = (ms, source) => ({
    format: "module",
    shortCircuit: true,
    source: "await new Promise((resolve) => setTimeout(resolve, " + ms + "));\\n" + source,
  });
  const base = url.split("?")[0];
  if (base === "cutout-test:prepare-birefnet")
    return held(
      200,
      "export async function warmupRemoval(onProgress, options){ globalThis.__prepareCalls.push({ id: 'birefnet', options }); onProgress?.(0.5); }",
    );
  if (base === "cutout-test:prepare-enhance")
    return held(
      15,
      "export async function prepareUpscaler(scale, onProgress, options){ globalThis.__prepareCalls.push({ id: scale === 2 ? 'swin2sr-x2' : 'swin2sr-x4', scale, options }); onProgress?.(1); }",
    );
  if (base === "cutout-test:prepare-depth")
    return held(
      200,
      "export async function prepareDepth(onProgress, options){ globalThis.__prepareCalls.push({ id: 'depth', options }); onProgress?.(1); }",
    );
  return next(url, context);
}
`;
register("data:text/javascript," + encodeURIComponent(HOOKS), import.meta.url);

type ModelsModule = typeof import("./models.ts");
const loadModels = async (caseTag: string) =>
  (await import(`./models.ts?case=${caseTag}`)) as ModelsModule;

test("formatMB and the default prepare deadline are stable", () => {
  assert.equal(formatMB(12_000_000), "12 MB");
  assert.equal(formatMB(1_500_000_000), "1.50 GB");
  assert.equal(MODEL_PREPARE_TIMEOUT_MS, 120_000);
});

test("MODELS groups cover every model notice", () => {
  const groups = new Set(MODELS.map((model) => model.id));
  for (const notice of MODEL_NOTICES) assert.ok(groups.has(notice.group), notice.id);
});

test("prepareModel rejects a pre-aborted wait before calling a backend", async () => {
  const { prepareModel } = await import("./models.ts");
  const calls: unknown[] = [];
  (globalThis as { __prepareCalls?: unknown }).__prepareCalls = calls;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareModel("depth", undefined, { signal: controller.signal }), {
    name: "AbortError",
  });
  assert.deepEqual(calls, []);
});

test("prepareModel checks abort after a lazy backend import", async () => {
  const { prepareModel } = await import("./models.ts");
  const calls: unknown[] = [];
  (globalThis as { __prepareCalls?: unknown }).__prepareCalls = calls;
  const controller = new AbortController();
  const pending = prepareModel("swin2sr-x2", (fraction) => {
    assert.notEqual(fraction, 1, "cancelled prepare must not report final progress");
  }, { signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(calls, []);
});

test("prepareModel forwards signal and a remaining budget to each backend", async () => {
  const { prepareModel } = await loadModels("forwards");
  const calls: Array<{ id: string; options?: { timeoutMs?: number } }> = [];
  (globalThis as { __prepareCalls?: unknown }).__prepareCalls = calls;
  const controller = new AbortController();
  const ids: ModelId[] = ["birefnet", "swin2sr-x2", "swin2sr-x4", "depth"];
  const progress: Partial<Record<ModelId, number>> = {};
  for (const id of ids) {
    await prepareModel(id, (fraction) => {
      progress[id] = fraction;
    }, { signal: controller.signal, timeoutMs: 1_000 });
  }
  assert.deepEqual(
    calls.map((call) => call.id),
    ["birefnet", "swin2sr-x2", "swin2sr-x4", "depth"],
  );
  // The backend receives the budget the import left: never more than the
  // original, visibly less wherever the import actually consumed time.
  const byId = new Map(calls.map((call) => [call.id, call.options?.timeoutMs]));
  for (const forwarded of byId.values()) {
    assert.equal(typeof forwarded, "number");
    assert.ok(forwarded! > 0 && forwarded! <= 1_000, `budget out of range (${forwarded})`);
  }
  assert.ok(byId.get("birefnet")! < 900, `held import left no deduction (${byId.get("birefnet")})`);
  assert.ok(byId.get("depth")! < 900, `held import left no deduction (${byId.get("depth")})`);
  assert.ok(
    byId.get("swin2sr-x2")! < 1_000,
    `held import left no deduction (${byId.get("swin2sr-x2")})`,
  );
  assert.equal(progress.birefnet, 1);
  assert.equal(progress.depth, 1);
});

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("prepareModel cancel covers a held lazy import; a late import starts no backend", async () => {
  const { prepareModel } = await loadModels("held-cancel");
  const calls: unknown[] = [];
  (globalThis as { __prepareCalls?: unknown }).__prepareCalls = calls;
  const progress: number[] = [];
  const controller = new AbortController();
  const started = Date.now();
  const pending = prepareModel("depth", (fraction) => progress.push(fraction), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
  // The depth import resolves ~200ms in; the cancelled wait must not ride along.
  assert.ok(
    Date.now() - started < 150,
    `cancelled wait outlived the held import (${Date.now() - started}ms)`,
  );
  await tick(260);
  assert.deepEqual(calls, [], "late import completion started a backend");
  assert.deepEqual(progress, [], "stale progress reported after cancellation");
});

test("prepareModel timeout covers a held lazy import", async () => {
  const { prepareModel } = await loadModels("held-timeout");
  const calls: unknown[] = [];
  (globalThis as { __prepareCalls?: unknown }).__prepareCalls = calls;
  const progress: number[] = [];
  const started = Date.now();
  await assert.rejects(
    prepareModel("birefnet", (fraction) => progress.push(fraction), { timeoutMs: 40 }),
    { name: "TimeoutError" },
  );
  assert.ok(Date.now() - started < 150, "the held import escaped the deadline");
  await tick(230);
  assert.deepEqual(calls, [], "backend ran after the deadline expired");
  assert.deepEqual(progress, [], "stale progress reported after timeout");
});
