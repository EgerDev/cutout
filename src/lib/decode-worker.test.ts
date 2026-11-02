import assert from "node:assert/strict";
import { test } from "node:test";
import { registerHooks } from "node:module";

/** Little-endian TIFF with one IFD and a strip pointing past EOF: 138 bytes. */
function tinyTiff(width: number, height: number) {
  const tags = [
    [256, 4, width],
    [257, 4, height],
    [258, 3, 8],
    [259, 3, 1],
    [262, 3, 2],
    [273, 4, 200],
    [277, 3, 4],
    [278, 4, height],
    [279, 4, 16],
  ] as const;
  const buffer = new ArrayBuffer(8 + 2 + tags.length * 12 + 4 + 16);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, tags.length, true);
  tags.forEach(([tag, type, value], i) => {
    const at = 10 + i * 12;
    view.setUint16(at, tag, true);
    view.setUint16(at + 2, type, true);
    view.setUint32(at + 4, 1, true);
    if (type === 3) view.setUint16(at + 8, value, true);
    else view.setUint32(at + 8, value, true);
  });
  return buffer;
}

type Reply = { id: number; error?: string; message?: string };

test("worker resize fallback refuses controlled unavailable/draw/transfer states and releases ownership", async (t) => {
  // Only the preferred resize boundary fails; decode, fallback and message ownership are real.
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (
        specifier === "./bitmap-resize.ts" &&
        context.parentURL?.includes("decode-worker.ts?resize-fault")
      )
        return {
          url: "data:text/javascript,export const resizeBitmap = async () => { throw new Error('preferred resize failed'); };",
          shortCircuit: true,
        };
      return next(specifier, context);
    },
  });
  t.after(() => hook.deregister());
  const keys = ["addEventListener", "postMessage", "createImageBitmap", "OffscreenCanvas"] as const;
  const prior = keys.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  t.after(() =>
    keys.forEach((key, i) => {
      if (prior[i]) Object.defineProperty(globalThis, key, prior[i]!);
      else Reflect.deleteProperty(globalThis, key);
    }),
  );
  for (const fault of ["missing", "context", "draw", "transfer", "post", "healthy"]) {
    await t.test(fault, async () => {
      let onMessage: (event: { data: unknown }) => void;
      let resolve: (value: Reply & { bitmap?: unknown; width?: number; height?: number }) => void;
      let sourceClosed = 0,
        outputClosed = 0,
        draws = 0;
      const canvases: { width: number; height: number }[] = [];
      const source = {
        width: 4000,
        height: 2000,
        close() {
          sourceClosed++;
        },
      };
      const output = {
        width: 1600,
        height: 800,
        close() {
          outputClosed++;
        },
      };
      const define = (key: string, value: unknown) =>
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      define("addEventListener", (_type: string, listener: typeof onMessage) => {
        onMessage = listener;
      });
      define("postMessage", (reply: Reply & { bitmap?: unknown }) => {
        if (fault === "post" && reply.bitmap) throw new Error("transfer message failed");
        resolve(reply);
      });
      define("createImageBitmap", async () => source);
      define(
        "OffscreenCanvas",
        fault === "missing"
          ? undefined
          : class {
              width: number;
              height: number;
              constructor(width: number, height: number) {
                this.width = width;
                this.height = height;
                canvases.push(this);
              }
              getContext() {
                return fault === "context"
                  ? null
                  : {
                      drawImage() {
                        draws++;
                        if (fault === "draw") throw new Error("draw failed");
                      },
                    };
              }
              transferToImageBitmap() {
                if (fault === "transfer") throw new Error("transfer failed");
                return output;
              }
            },
      );
      await import(new URL(`./decode-worker.ts?resize-fault-${fault}`, import.meta.url).href);
      const reply = await new Promise<
        Reply & { bitmap?: unknown; width?: number; height?: number }
      >((done) => {
        resolve = done;
        onMessage({
          data: { id: 1, file: pngHeader(4000, 2000), type: "image/png", maxEdge: 1600 },
        });
      });
      assert.equal(Boolean(reply.error), fault !== "healthy", fault);
      assert.equal(sourceClosed, 1, `${fault}: source released exactly once`);
      assert.ok(
        canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
        `${fault}: backing store released`,
      );
      assert.equal(outputClosed, fault === "post" ? 1 : 0, `${fault}: unsent output released`);
      if (fault === "healthy") {
        assert.equal(reply.bitmap, output);
        assert.deepEqual([reply.width, reply.height], [4000, 2000]);
        assert.equal(draws, 1);
      }
    });
  }
});

test("the decode worker refuses a 16000×16000 TIFF before decoding its pixels", async () => {
  // Drive the real worker module with the globals a dedicated worker has.
  const scope = globalThis as { addEventListener?: unknown; postMessage?: unknown };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const waiting = new Map<number, (reply: Reply) => void>();
  scope.addEventListener = (type: string, listener: typeof onMessage) => {
    if (type === "message") onMessage = listener;
  };
  scope.postMessage = (reply: Reply) => waiting.get(reply.id)?.(reply);
  try {
    await import("./decode-worker.ts");
    assert.ok(onMessage, "the worker listens for messages");
    const ask = (id: number, extra: object) =>
      new Promise<Reply>((resolve) => {
        waiting.set(id, resolve);
        onMessage!({
          data: {
            id,
            file: new Blob([tinyTiff(16000, 16000)], { type: "image/tiff" }),
            type: "image/tiff",
            maxEdge: 1600,
            ...extra,
          },
        });
      });

    const before = process.resourceUsage().maxRSS;
    // CPU time, not wall time: a busy machine must not fail this, a 1 GB decode would.
    const started = process.cpuUsage();
    const reply = await ask(1, { maxPixels: 24_000_000 });
    const cpu = process.cpuUsage(started);
    const ms = (cpu.user + cpu.system) / 1000;
    assert.ok(ms < 100, `burned ${ms} ms of CPU`);
    assert.ok((process.resourceUsage().maxRSS - before) / 1024 < 100, "peak RSS grew over 100 MB");
    assert.equal(reply.error, "memory");
    assert.match(reply.message ?? "", /too large/);

    // A sender that forgets the budget still gets the default one, not none.
    assert.equal((await ask(2, {})).error, "memory");
  } finally {
    delete scope.addEventListener;
    delete scope.postMessage;
  }
});

/** The first 33 bytes of an RGBA PNG: its signature and header, nothing to decode. */
function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return new Blob([bytes], { type: "image/png" });
}

test("the decode worker refuses a PNG declaring far more than the page's budget, undecoded", async () => {
  const scope = globalThis as {
    addEventListener?: unknown;
    postMessage?: unknown;
    createImageBitmap?: unknown;
  };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  const waiting = new Map<number, (reply: Reply) => void>();
  let decodes = 0;
  scope.addEventListener = (type: string, listener: typeof onMessage) => {
    if (type === "message") onMessage = listener;
  };
  scope.postMessage = (reply: Reply) => waiting.get(reply.id)?.(reply);
  scope.createImageBitmap = () => {
    decodes += 1;
    return Promise.reject(new Error("decoded"));
  };
  try {
    // A fresh copy of the module, so it registers its listener with these globals.
    await import(new URL("./decode-worker.ts?declared-size", import.meta.url).href);
    const ask = (id: number, file: Blob, maxPixels: number, maxSide = 16384) =>
      new Promise<Reply>((resolve) => {
        waiting.set(id, resolve);
        onMessage!({ data: { id, file, type: file.type, maxEdge: 1600, maxPixels, maxSide } });
      });
    // The preview of a 16384 x 16384 PNG used to decode all 268 MP here.
    const refused = await ask(1, pngHeader(16384, 16384), 96_000_000);
    assert.equal(refused.error, "memory");
    assert.match(refused.message ?? "", /too large/);
    assert.equal((await ask(2, pngHeader(12000, 12000), 24_000_000)).error, "memory");
    assert.equal(decodes, 0, "nothing was decoded");
    // A desktop 100 MP source and exact phone ceilings still reach the decoder.
    assert.notEqual((await ask(3, pngHeader(10000, 10000), 96_000_000)).error, "memory");
    assert.equal((await ask(4, pngHeader(8064, 6048), 24_000_000)).error, "memory");
    assert.equal(decodes, 1);
    for (const [pixels, side, width, height] of [
      [96_000_000, 16384, 16000, 12000],
      [16_000_000, 4096, 8000, 4000],
      [24_000_000, 8192, 8000, 6000],
      [24_000_000, 16384, 8000, 6000],
    ]) {
      assert.notEqual((await ask(5, pngHeader(width!, height!), pixels!, side!)).error, "memory");
      for (const [w, h] of [
        [2 * side!, 1],
        [1, 2 * side!],
      ]) {
        assert.notEqual((await ask(7, pngHeader(w!, h!), pixels!, side!)).error, "memory");
      }
      const before: number = decodes;
      for (const [w, h] of [
        [width!, height! + 1],
        [2 * side! + 1, 1],
        [1, 2 * side! + 1],
      ]) {
        const reply = await ask(6, pngHeader(w!, h!), pixels!, side!);
        assert.equal(reply.error, "memory");
        assert.match(reply.message ?? "", /too large/);
      }
      assert.equal(decodes, before);
    }
  } finally {
    delete scope.addEventListener;
    delete scope.postMessage;
    delete scope.createImageBitmap;
  }
});

test("TIFF worker checks strict pixels and device sides before decodeImage", async () => {
  const { tiffHeader } = await import("./fixtures/flat-tiff.ts");
  const { default: UTIF } = await import("utif2");
  const native = UTIF.decodeImage;
  let decodes = 0;
  UTIF.decodeImage = () => {
    decodes++;
    throw new Error("counted TIFF pixel decode");
  };
  const scope = globalThis as { addEventListener?: unknown; postMessage?: unknown };
  let onMessage: ((event: { data: unknown }) => void) | undefined;
  let reply: (value: Reply) => void;
  scope.addEventListener = (_type: string, listener: typeof onMessage) => {
    onMessage = listener;
  };
  scope.postMessage = (value: Reply) => reply(value);
  try {
    await import(new URL("./decode-worker.ts?tiff-boundaries", import.meta.url).href);
    for (const [pixels, side] of [
      [96_000_000, 16384],
      [32_000_000, 16384],
      [16_000_000, 4096],
      [24_000_000, 8192],
      [24_000_000, 16384],
    ]) {
      for (const [w, h, refused] of [
        [pixels! / 4000, 4000, false],
        [pixels! / 4000 + 1, 4000, true],
        [2 * side!, 1, false],
        [2 * side! + 1, 1, true],
        [1, 2 * side!, false],
        [1, 2 * side! + 1, true],
      ] as const) {
        const before = decodes;
        const result = await new Promise<Reply>((resolve) => {
          reply = resolve;
          onMessage!({
            data: {
              id: 1,
              file: new Blob([tiffHeader(w, h)], { type: "image/tiff" }),
              type: "image/tiff",
              maxPixels: pixels,
              maxSide: side,
            },
          });
        });
        assert.equal(result.error === "memory", refused);
        assert.equal(decodes - before, refused ? 0 : 1);
      }
    }
  } finally {
    UTIF.decodeImage = native;
    delete scope.addEventListener;
    delete scope.postMessage;
  }
});
