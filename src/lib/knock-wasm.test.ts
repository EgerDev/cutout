import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { classifyGraphic, knockPaper, sampleBorder, stripPaper } from "./graphics.ts";

// Vite turns "./key-simd.wasm?url" into the asset's URL. Here it becomes the committed file's
// URL and fetch reads it, so the tests below run the real knockPaperWasm on the real binary.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.endsWith(".wasm?url")) return nextResolve(specifier, context);
    const url = new URL(specifier.slice(0, -"?url".length), context.parentURL).href;
    return {
      url: `data:text/javascript,export default ${JSON.stringify(url)};`,
      shortCircuit: true,
    };
  },
});
let failSimd = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (!url.startsWith("file:")) return realFetch(input, init);
  if (failSimd && url.endsWith("/key-simd.wasm")) return new Response("not wasm");
  return new Response(readFileSync(new URL(url)));
}) as typeof fetch;

/** Analytic anti-aliased wordmark (disc, ring, bar) in `ink` on a uniform `field`. */
function logo(width: number, height: number, field: number[], ink: number[]) {
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.3;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy += 1) {
        for (let sx = 0; sx < 4; sx += 1) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          const r = Math.hypot(px - cx, py - cy);
          const ring = r < radius * 0.5 || (r > radius * 0.75 && r < radius);
          const bar = Math.abs(py - cy) < radius * 0.08 && Math.abs(px - cx) < radius * 1.2;
          if (ring || bar) hits += 1;
        }
      }
      const i = (y * width + x) * 4;
      for (let k = 0; k < 3; k += 1)
        data[i + k] = Math.round(ink[k]! * (hits / 16) + field[k]! * (1 - hits / 16));
      data[i + 3] = 255;
    }
  }
  return data;
}

async function knockModule(simd: boolean) {
  failSimd = !simd;
  // A query gives a fresh module instance, so each one loads its own wasm.
  const module = (await import(
    `./knock-wasm.ts?${simd ? "simd" : "no-simd"}`
  )) as typeof import("./knock-wasm.ts");
  await module.ensureKnockWasm();
  return module;
}

/** cutoutGraphic's pixel path: the wasm key, then stripPaper. */
function cut(
  knock: typeof import("./knock-wasm.ts"),
  source: Uint8ClampedArray,
  width: number,
  height: number,
) {
  const data = new Uint8ClampedArray(source);
  const field = sampleBorder(data, width, height);
  knock.knockPaperWasm(data, width, height, field);
  stripPaper(data, width, height, field, { jpeg: false });
  return data;
}

test("a white logo on #121212 at an unaligned size keeps a clear background (C31)", async () => {
  const knock = await knockModule(true);
  const field = [18, 18, 18];
  const width = 101;
  const height = 101;
  const source = logo(width, height, field, [255, 255, 255]);
  assert.equal(classifyGraphic(source, width, height), "logo");
  const out = cut(knock, source, width, height);
  let fieldPixels = 0;
  let visible = 0;
  for (let i = 0; i < source.length; i += 4) {
    if (source[i] !== field[0] || source[i + 1] !== field[1] || source[i + 2] !== field[2])
      continue;
    fieldPixels += 1;
    if (out[i + 3] !== 0) visible += 1;
  }
  assert.ok(fieldPixels > 5000);
  assert.equal(visible, 0, `${visible} of ${fieldPixels} background pixels kept alpha`);
  assert.equal(out[(50 * width + 50) * 4 + 3], 255);
});

test("the wasm key never changes the cut, with or without SIMD (C31)", async () => {
  const cases = [
    { field: [18, 18, 18], ink: [255, 255, 255] },
    { field: [15, 15, 15], ink: [255, 255, 255] },
    { field: [255, 255, 255], ink: [90, 90, 90] },
    { field: [242, 242, 242], ink: [0, 0, 0] },
  ];
  const sizes = [
    [100, 100],
    [101, 101],
    [333, 111],
  ] as const;
  const changed: string[] = [];
  for (const simd of [true, false]) {
    const knock = await knockModule(simd);
    for (const { field, ink } of cases) {
      for (const [width, height] of sizes) {
        const source = logo(width, height, field, ink);
        const expected = new Uint8ClampedArray(source);
        stripPaper(expected, width, height, sampleBorder(expected, width, height), { jpeg: false });
        const out = cut(knock, source, width, height);
        let differ = 0;
        for (let i = 0; i < out.length; i += 4)
          if (out.subarray(i, i + 4).some((v, k) => v !== expected[i + k])) differ += 1;
        const label = `${simd ? "SIMD" : "no SIMD"} #${field[0]} ${width}x${height}`;
        if (differ) changed.push(`${label}: ${differ} px`);
      }
    }
  }
  assert.deepEqual(changed, []);
});

test("SIMD color-key zeros the page and keeps the mark", async () => {
  const bytes = readFileSync(new URL("./key-simd.wasm", import.meta.url));
  const result = await WebAssembly.instantiate(bytes);
  const memory = result.instance.exports.memory as WebAssembly.Memory;
  const key4 = result.instance.exports.key4 as (n: number, r: number, g: number, b: number) => void;
  const width = 16;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    const mark = x >= 6 && x < 10 && y >= 6 && y < 10;
    data[i] = mark ? 4 : 255;
    data[i + 1] = mark ? 4 : 255;
    data[i + 2] = mark ? 4 : 255;
    data[i + 3] = 255;
  }
  new Uint8Array(memory.buffer).set(data);
  key4(data.length, 255, 255, 255);
  const out = new Uint8Array(memory.buffer, 0, data.length);
  assert.equal(out[3], 0);
  assert.ok(out[((8 * width + 8) * 4) + 3]! > 200);
});

test("JS knock still keeps the mark", () => {
  const width = 24;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const x = (i / 4) % width;
    const y = Math.floor(i / 4 / width);
    const mark = x >= 8 && x < 16 && y >= 8 && y < 16;
    data[i] = mark ? 8 : 255;
    data[i + 1] = mark ? 8 : 255;
    data[i + 2] = mark ? 8 : 255;
    data[i + 3] = 255;
  }
  assert.equal(classifyGraphic(data, width, height), "logo");
  knockPaper(data, width, height);
  assert.equal(data[3], 0);
  assert.ok(data[((12 * width + 12) * 4) + 3]! > 200);
});
