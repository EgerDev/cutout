import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { defaultExportCaps } from "./formats.ts";

test("a failed capability import resolves conservatively for shared waiters and can retry (FINISH-03)", async (t) => {
  let imports = 0;
  const failure = new TypeError("Failed to fetch dynamically imported module");
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === "./still-encode.ts" && context.parentURL?.includes("/composite.ts")) {
        if (++imports === 1) throw failure;
      }
      return next(specifier, context);
    },
  });
  t.after(() => hook.deregister());
  const before = Object.getOwnPropertyDescriptor(globalThis, "document");
  t.after(() => {
    if (before) Object.defineProperty(globalThis, "document", before);
    else Reflect.deleteProperty(globalThis, "document");
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => ({ toDataURL: (mime: string) => `data:${mime};base64,AA==` }),
    },
  });
  const { prepareExportCaps, exportCaps } = await import("./composite.ts");
  const first = prepareExportCaps();
  assert.equal(prepareExportCaps(), first, "concurrent callers share the attempt");
  const settled = await Promise.allSettled([first, first.then((caps) => caps)]);
  assert.deepEqual(
    settled,
    [
      { status: "fulfilled", value: defaultExportCaps },
      { status: "fulfilled", value: defaultExportCaps },
    ],
    "the hook's catch-free .then caller must not inherit an unhandled rejection",
  );
  assert.equal(imports, 1);
  assert.deepEqual(exportCaps(), defaultExportCaps);
  const retry = prepareExportCaps();
  assert.notEqual(retry, first);
  assert.deepEqual(await retry, { webp: true, avif: true, heic: true });
  assert.equal(imports, 2);
  assert.equal(prepareExportCaps(), retry, "successful state stays cached");
});
