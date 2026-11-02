import assert from "node:assert/strict";
import test from "node:test";
import { REMOVAL_MODELS, REMOVAL_MODEL_SHA256 } from "./removal-model-specs.ts";
import { RemovalModelIntegrityError, isRemovalModelIntegrityError, removalModelCache, verifyRemovalModelBytes } from "./removal-model-integrity.ts";

Object.defineProperty(globalThis, "caches", { configurable: true, writable: true, value: undefined });
Object.defineProperty(globalThis, "isSecureContext", { configurable: true, writable: true, value: undefined });

const spec = REMOVAL_MODELS.isnet;
const config = new TextEncoder().encode('{\n  "model_type": "isnet"\n}');

test("every route, both ONNX variants and both fetched JSON files have SHA-256 pins", () => {
  for (const model of Object.keys(REMOVAL_MODELS) as (keyof typeof REMOVAL_MODELS)[]) {
    const files = new Set(["onnx/model.onnx", "onnx/model_fp16.onnx", "config.json", "preprocessor_config.json"]);
    for (const route of Object.values(REMOVAL_MODELS[model].routes)) if (route) files.add(`onnx/${route.onnxFile}`);
    for (const file of files) assert.match(REMOVAL_MODEL_SHA256[model][file], /^[a-f0-9]{64}$/, `${model}/${file}`);
  }
});

test("verified bytes pass unchanged; a one-byte change and a truncated JSON reject with a typed error", async () => {
  const before = config.slice();
  await verifyRemovalModelBytes(spec.modelId, "config.json", spec.revision, config);
  assert.deepEqual(config, before);
  const changed = config.slice();
  changed[changed.length - 2] ^= 1;
  for (const bytes of [changed, config.slice(0, -1)]) {
    await assert.rejects(verifyRemovalModelBytes(spec.modelId, "config.json", spec.revision, bytes), RemovalModelIntegrityError);
  }
});

test("an unpinned file or changed revision cannot silently load", async () => {
  await assert.rejects(verifyRemovalModelBytes(spec.modelId, "new.onnx", spec.revision, config), RemovalModelIntegrityError);
  await assert.rejects(verifyRemovalModelBytes(spec.modelId, "config.json", "main", config), RemovalModelIntegrityError);
  await verifyRemovalModelBytes("other/model", "config.json", "main", config);
});

test("without WebCrypto: an insecure origin skips the pin, any other context fails typed", async (t) => {
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto")!;
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  t.after(() => Object.defineProperty(globalThis, "crypto", cryptoDescriptor));
  t.mock.property(globalThis, "isSecureContext", false);
  await verifyRemovalModelBytes(spec.modelId, "config.json", spec.revision, new Uint8Array([1]));
  globalThis.isSecureContext = true;
  await assert.rejects(verifyRemovalModelBytes(spec.modelId, "config.json", spec.revision, config), RemovalModelIntegrityError);
});

test("a digest that throws is a typed integrity failure", async (t) => {
  t.mock.method(crypto.subtle, "digest", async () => { throw new TypeError("detached"); });
  await assert.rejects(verifyRemovalModelBytes(spec.modelId, "config.json", spec.revision, config), RemovalModelIntegrityError);
});

test("a serialized integrity error is still recognised by its code", () => {
  const serialized = Object.assign(new Error("The model download failed its safety check."), { code: "removal-model-integrity" });
  assert.equal(isRemovalModelIntegrityError(serialized), true);
  assert.equal(isRemovalModelIntegrityError(new Error("other")), false);
});

for (const mode of ["disabled", "absent", "denied"]) {
  test(`verification still runs when Cache Storage is ${mode}`, async (t) => {
    t.mock.property(globalThis, "caches", mode === "absent" ? undefined : {
      async open() { throw new Error("denied"); },
    } as unknown as CacheStorage);
    const cache = removalModelCache({ useBrowserCache: mode !== "disabled" });
    assert.equal(await cache.match("https://mirror/model"), undefined);
    await cache.put("https://mirror/model", new Response(config));
    await assert.rejects(cache.verify(spec.modelId, "config.json", spec.revision, new Uint8Array([1])), RemovalModelIntegrityError);
    await cache.verify(spec.modelId, "config.json", spec.revision, config);
  });
}

test("custom cache preserves mirror keys and verified response bytes", async (t) => {
  const entries = new Map<string, Response>();
  t.mock.property(globalThis, "caches", { async open(name: string) {
    assert.equal(name, "transformers-cache");
    return { match: async (key: string) => entries.get(key), put: async (key: string, value: Response) => { entries.set(key, value); } };
  } } as unknown as CacheStorage);
  const cache = removalModelCache({ useBrowserCache: true });
  const key = `https://mirror.example/models/${spec.modelId}/resolve/${spec.revision}/config.json`;
  const response = new Response(config);
  await cache.verify(spec.modelId, "config.json", spec.revision, config);
  await cache.put(key, response);
  assert.equal(await cache.match(key), response);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), config);
});
