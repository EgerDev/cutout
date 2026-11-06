import assert from "node:assert/strict";
import { test } from "node:test";
import { editedMatte, pngSize } from "./canvas.ts";
import { encodeExport, passthrough, unedited } from "./export.ts";
import { defaults } from "./model.ts";

const pngHeader = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 1, 64, 0, 0, 0, 200,
]);

test("pngSize reads IHDR without decoding pixels", async () => {
  const blob = new Blob([pngHeader], { type: "image/png" });
  assert.deepEqual(await pngSize(blob), { width: 320, height: 200 });
  assert.equal(await pngSize(new Blob([new Uint8Array([0xff, 0xd8, 0xff])])), null);
  assert.equal(await pngSize(new Blob([new Uint8Array(8)])), null);
});

test("encodeExport PNG passthrough returns the same blob sized from IHDR", async () => {
  const result = new Blob([pngHeader], { type: "image/png" });
  const encoded = await encodeExport({
    result,
    source: new File([result], "cutout.png", { type: "image/png" }),
    settings: defaults,
  });
  assert.equal(encoded.blob, result);
  assert.equal(encoded.width, 320);
  assert.equal(encoded.height, 200);
  assert.equal(encoded.quality, null);
  assert.equal(encoded.metTarget, true);
});

test("editedMatte skips a full-res bounds scan when tight is false", async () => {
  const result = new Blob([pngHeader], { type: "image/png" });
  const matte = await editedMatte(
    result,
    new File([result], "cutout.png", { type: "image/png" }),
    defaults,
    { tight: false },
  );
  assert.equal(matte.blob, result);
  assert.deepEqual(matte.bounds, { x: 0, y: 0, width: 320, height: 200 });
  assert.equal(matte.empty, false);
  assert.equal(matte.width, 320);
  assert.equal(matte.height, 200);
});

test("the final allowed downscale still searches quality, with bounded work and aborts (S3-C-PLATFORM-14)", async (t) => {
  const { registerHooks } = await import("node:module");
  const calls: { width: number; quality: number | undefined }[] = [];
  const canvases: { width: number; height: number }[] = [];
  const abort = new AbortController();
  let abortOnFinal = false;
  const makeCanvas = () => {
    const canvas = {
      width: 1024,
      height: 1024,
      getContext: () => ({ drawImage() {} }),
      toBlob(done: (blob: Blob) => void, mime: string, quality?: number) {
        calls.push({ width: canvas.width, quality });
        const size = canvas.width > 330 ? 1001 : quality! <= 0.4 ? 900 : 1600;
        if (abortOnFinal && canvas.width <= 330 && quality === 0.15) abort.abort();
        done(new Blob([new Uint8Array(size)], { type: mime }));
      },
    };
    canvases.push(canvas);
    return canvas;
  };
  const globals = globalThis as typeof globalThis & { exportTestCanvas?: typeof makeCanvas };
  globals.exportTestCanvas = makeCanvas;
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: makeCanvas },
  });
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "./render.ts" && context.parentURL?.includes("?target-search"))
        return {
          shortCircuit: true,
          url: "data:text/javascript,export async function renderCanvas(){return globalThis.exportTestCanvas()}",
        };
      return next(specifier, context);
    },
  });
  t.after(() => {
    hook.deregister();
    delete globals.exportTestCanvas;
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
  });
  const { encodeExport: encode } = await import(String("./export.ts?target-search"));
  const input = {
    result: new Blob(),
    source: new File([], "test.png"),
    settings: { ...defaults, exportFormat: "jpeg" as const, targetKB: 1 },
  };
  const result = await encode(input);
  assert.equal(result.metTarget, true);
  assert.equal(result.width, 328, "exactly seven resizes");
  assert.ok(result.quality! > 0.15 && result.quality! <= 0.4);
  assert.equal(result.blob.size, 900);
  assert.equal(calls.length, 22, "eight full/low candidates and six bisections");
  assert.ok(canvases.every((canvas) => canvas.width === 0 && canvas.height === 0));
  calls.length = 0;
  const ordinary = await encode({ ...input, settings: { ...input.settings, targetKB: null } });
  assert.equal(ordinary.width, 1024);
  assert.equal(ordinary.quality, 0.92);
  assert.equal(calls.length, 1, "no search without a target");
  calls.length = 0;
  abortOnFinal = true;
  await assert.rejects(encode(input, abort.signal), { name: "AbortError" });
  assert.equal(calls.length, 16, "abort after final low-quality encode stops the bisection");
});

test("unedited distinguishes visual edits from export encoding choices", () => {
  assert.equal(unedited(defaults), true);
  assert.equal(unedited({ ...defaults, exportFormat: "jpeg", targetKB: 50 }), true);
  for (const patch of [
    { background: { type: "color" as const, color: "#ff0000" } },
    { shadow: true },
    { feather: 1 },
    { choke: 1 },
    { preset: "trim" as const },
    { strokes: [{ mode: "erase" as const, size: 10, points: [{ x: 0.5, y: 0.5 }] }] },
    { hints: [{ kind: "remove" as const, size: 0.1, points: [{ x: 0.5, y: 0.5 }] }] },
    { recolors: [{ from: "#ff0000", to: "#00ff00" }] },
    { decontaminate: "auto" as const },
    { scale: 90 },
    { rotate: 90 },
    { flipX: true },
    { matchBackground: true },
    { exportWidth: 64 },
    { exportHeight: 32 },
  ])
    assert.equal(unedited({ ...defaults, ...patch }), false, JSON.stringify(patch));
});

test("passthrough requires unedited PNG settings without a size target", () => {
  assert.equal(passthrough(defaults), true);
  assert.equal(passthrough({ ...defaults, exportFormat: "jpeg" }), false);
  assert.equal(passthrough({ ...defaults, targetKB: 50 }), false);
  assert.equal(passthrough({ ...defaults, shadow: true }), false);
});
