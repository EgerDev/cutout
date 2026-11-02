import assert from "node:assert/strict";
import test from "node:test";
import { maskWith } from "./alpha.ts";

const operations = {
  maskWith: (a: Blob, b: Blob) => maskWith(a, b, 2, 2),
};

for (const [name, run] of Object.entries(operations)) {
  for (const rejected of [0, 1])
    for (const late of [false, true]) {
      test(`${name} closes the ${late ? "late" : "early"} sibling when decode ${rejected} rejects (FINISH-05)`, async (t) => {
        const before = Object.getOwnPropertyDescriptor(globalThis, "createImageBitmap");
        t.after(() => {
          if (before) Object.defineProperty(globalThis, "createImageBitmap", before);
          else Reflect.deleteProperty(globalThis, "createImageBitmap");
        });
        let closes = 0;
        const bitmap = {
          close: () => {
            closes++;
          },
        } as ImageBitmap;
        const deferred = () => {
          let resolve!: (bitmap: ImageBitmap) => void;
          let reject!: (reason: unknown) => void;
          const promise = new Promise<ImageBitmap>((ok, no) => {
            resolve = ok;
            reject = no;
          });
          return { promise, resolve, reject };
        };
        const pair = [deferred(), deferred()];
        let calls = 0;
        Object.defineProperty(globalThis, "createImageBitmap", {
          configurable: true,
          value: () => pair[calls++]!.promise,
        });
        const failure = new Error("controlled decoder rejection");
        const pending = run(new Blob(), new Blob());
        const refused = assert.rejects(pending, (error) => error === failure);
        assert.equal(calls, 2, "both decodes start together");
        if (!late) pair[1 - rejected]!.resolve(bitmap);
        pair[rejected]!.reject(failure);
        await refused;
        if (late) {
          pair[1 - rejected]!.resolve(bitmap);
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(closes, 1);
      });
    }

  test(`${name} keeps successful output and closes both bitmaps (FINISH-05)`, async (t) => {
    const blob = new Blob(["encoded PNG"], { type: "image/png" });
    const descriptors = ["createImageBitmap", "document"].map((key) =>
      Object.getOwnPropertyDescriptor(globalThis, key),
    );
    t.after(() =>
      ["createImageBitmap", "document"].forEach((key, i) => {
        if (descriptors[i]) Object.defineProperty(globalThis, key, descriptors[i]!);
        else Reflect.deleteProperty(globalThis, key);
      }),
    );
    let closes = 0;
    const draws: string[] = [];
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: async () => ({
        width: 2,
        height: 2,
        close: () => {
          closes++;
        },
      }),
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: () => {
          const context = {
            globalCompositeOperation: "source-over",
            drawImage() {
              draws.push(this.globalCompositeOperation);
            },
            getImageData: () => ({
              width: 2,
              height: 2,
              data: new Uint8ClampedArray(16).fill(255),
            }),
            putImageData() {},
          };
          return {
            width: 2,
            height: 2,
            getContext: () => context,
            toBlob: (done: (b: Blob) => void) => done(blob),
          };
        },
      },
    });
    assert.equal(await run(blob, blob), blob);
    assert.equal(closes, 2);
    if (name === "maskWith") assert.deepEqual(draws, ["source-over", "destination-in"]);
  });
}
