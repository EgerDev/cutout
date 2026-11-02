import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";
import { defaults } from "./model.ts";
import { editorDefaults } from "./state.ts";
import { closePreview, liveBitmap, retainPreview } from "./resources.ts";
import type { WorkspaceState } from "../workspace-types.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/preview.ts") && specifier === "./render.ts")
      return {
        url: "data:text/javascript,export async function renderCanvas(){return {width:32,height:24}}",
        shortCircuit: true,
      };
    if (context.parentURL?.endsWith("/preview.ts") && specifier === "./canvas.ts")
      return {
        url: "data:text/javascript,export const MATTE_PREVIEW_MAX=1600;export async function encodeCanvas(){return new Blob()}",
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { installEditorPreview } = await import("./preview.ts");
test.after(() => hooks.deregister());

class Bitmap {
  width = 32;
  height = 24;
  closes = 0;
  close() {
    this.closes++;
    this.width = this.height = 0;
  }
}
const asBitmap = (b: Bitmap) => b as unknown as ImageBitmap;
function environment(t: TestContext) {
  const created: Bitmap[] = [],
    urls: string[] = [],
    revoked: string[] = [];
  const stub = (key: string, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() =>
      descriptor
        ? Object.defineProperty(globalThis, key, descriptor)
        : Reflect.deleteProperty(globalThis, key),
    );
  };
  stub("ImageBitmap", Bitmap);
  stub("createImageBitmap", async () => {
    const bitmap = new Bitmap();
    created.push(bitmap);
    return bitmap;
  });
  t.mock.method(URL, "createObjectURL", () => {
    const url = `blob:preview-${urls.length}`;
    urls.push(url);
    return url;
  });
  t.mock.method(URL, "revokeObjectURL", (url: string) => revoked.push(url));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const item = (id: string) => ({ id, source: new File([], id), resultBlob: new Blob([id]) });
  let state = {
    ...editorDefaults,
    items: [item("a"), item("b")],
    activeId: "a",
  } as unknown as WorkspaceState;
  const listeners = new Set<(s: WorkspaceState, old: WorkspaceState) => void>();
  const store = {
    getState: () => state,
    setState(patch: Partial<WorkspaceState>) {
      const old = state;
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state, old);
    },
    subscribe(fn: (s: WorkspaceState, old: WorkspaceState) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  installEditorPreview(store);
  const render = async () => {
    t.mock.timers.tick(120);
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  const start = async () => {
    store.setState({ settings: { a: { ...defaults, feather: 1 } } });
    await render();
  };
  const assertClosed = () => {
    assert.ok(created.length > 0);
    assert.deepEqual(
      created.map((b) => b.closes),
      created.map(() => 1),
    );
    assert.deepEqual([...revoked].sort(), [...urls].sort());
  };
  return { store, created, urls, revoked, render, start, assertClosed };
}

test("retired previews close once after the last painter releases, without a timer", (t) => {
  environment(t);
  const b = new Bitmap(),
    bitmap = asBitmap(b);
  const first = retainPreview(bitmap),
    second = retainPreview(bitmap);
  closePreview(bitmap);
  closePreview(bitmap);
  assert.equal(b.closes, 0);
  first();
  first();
  assert.equal(b.closes, 0);
  second();
  second();
  assert.equal(b.closes, 1);
  closePreview(bitmap);
  retainPreview(bitmap)();
  assert.equal(b.closes, 1);
  assert.equal(liveBitmap(bitmap), null);
  assert.equal(liveBitmap(null), null);
  const canvas = { width: 0, height: 0 };
  assert.equal(liveBitmap(canvas), canvas);
});

for (const action of ["switch", "remove", "retry", "clear", "replace"])
  test(`editor preview ${action} retires the old bitmap until painter cleanup`, async (t) => {
    const e = environment(t);
    await e.start();
    const bitmap = e.store.getState().previewBitmap!;
    const release = retainPreview(bitmap);
    const s = e.store.getState();
    e.store.setState(
      action === "switch"
        ? { activeId: "b" }
        : action === "retry"
          ? { items: s.items.map((i) => ({ ...i, resultBlob: null })) }
          : { items: [], activeId: null, ...(action === "replace" ? editorDefaults : {}) },
    );
    assert.equal(e.store.getState().previewBitmap, null);
    assert.equal(bitmap.width, 32);
    release();
    assert.equal(bitmap.width, 0);
    // Cancel the next item's pending preview as clearAll does.
    e.store.setState({ items: [], activeId: null });
    await e.render();
    e.assertClosed();
  });

test("edits and mask toggles release every published bitmap and URL exactly once", async (t) => {
  const e = environment(t);
  await e.start();
  const old = e.store.getState().previewBitmap!;
  const release = retainPreview(old);
  e.store.setState({ settings: { a: { ...defaults, feather: 2 } } });
  await e.render();
  assert.notEqual(e.store.getState().previewBitmap, old);
  assert.equal(old.width, 32);
  release();
  assert.equal(old.width, 0);
  e.store.setState({ inspectMode: "mask" });
  await e.render();
  assert.equal(e.store.getState().previewBitmap, null);
  assert.equal(e.urls.length, 1);
  e.store.setState({ inspectMode: "composite" });
  await e.render();
  e.store.setState({ items: [], activeId: null });
  e.assertClosed();
});

test("an aborted bitmap decode closes its unpublished candidate and cannot overwrite the next item", async (t) => {
  const e = environment(t);
  let finish!: (bitmap: ImageBitmap) => void;
  t.mock.method(
    globalThis,
    "createImageBitmap",
    () =>
      new Promise<ImageBitmap>((resolve) => {
        finish = resolve;
      }),
  );
  e.store.setState({ settings: { a: { ...defaults, feather: 1 } } });
  await e.render();
  e.store.setState({ items: [], activeId: null });
  const candidate = new Bitmap();
  finish(asBitmap(candidate));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.equal(candidate.closes, 1);
  assert.equal(e.store.getState().previewBitmap, null);
  assert.equal(e.store.getState().previewBusy, false);
});
