import assert from "node:assert/strict";
import { test } from "node:test";
import { editorActions, editorDefaults, type Get, type Set } from "./state.ts";
import * as model from "./model.ts";
const { boundFuture, defaults, recordHistory, shareBackgrounds } = model;

test("jumpBack undoes several steps at once and leaves them redo-able in order", () => {
  let state: Record<string, unknown> = {
    ...editorDefaults,
    items: [{ id: "a" }],
    activeId: "a",
    settings: { a: defaults },
    reportError: () => undefined,
  };
  const get = (() => state) as unknown as Get;
  const set: Set = (partial) => {
    state = { ...state, ...(typeof partial === "function" ? partial(state as never) : partial) };
  };
  const actions = editorActions(get, set);
  Object.assign(state, actions);
  actions.changeEdit({ feather: 2 }, "feather");
  actions.changeEdit({ choke: 3 }, "choke");
  actions.changeEdit({ scale: 120 }, "scale");
  const s = () => (state.settings as Record<string, typeof defaults>).a!;
  assert.equal((state.past as unknown[]).length, 3);
  actions.jumpBack(2);
  assert.deepEqual([s().feather, s().choke, s().scale], [2, 0, 100]);
  assert.equal((state.past as unknown[]).length, 1);
  assert.equal((state.future as unknown[]).length, 2);
  actions.redo();
  assert.deepEqual([s().feather, s().choke, s().scale], [2, 3, 100]);
  actions.redo();
  assert.equal(s().scale, 120);
  assert.equal((state.future as unknown[]).length, 0);
});

const MB = 1_000_000;
const big = (mb: number) => new Blob([new Uint8Array(mb * MB)]);

test("one settings map over the byte budget still keeps its newest undo and redo step", () => {
  // Three images, each with its own 25 MB background: one map is 75 MB on its own.
  const map = {
    a: { ...defaults, backgroundBlob: big(25) },
    b: { ...defaults, backgroundBlob: big(25) },
    c: { ...defaults, backgroundBlob: big(25) },
  };
  assert.equal(recordHistory([], map, "a:feather", 0).length, 1);
  assert.equal(boundFuture([map, map]).length, 1);

  let state: Record<string, unknown> = {
    ...editorDefaults,
    items: [{ id: "a" }, { id: "b" }, { id: "c" }],
    activeId: "a",
    settings: map,
    reportError: () => undefined,
  };
  const get = (() => state) as unknown as Get;
  const set: Set = (partial) => {
    state = { ...state, ...(typeof partial === "function" ? partial(state as never) : partial) };
  };
  const actions = editorActions(get, set);
  Object.assign(state, actions);
  const feather = () => (state.settings as Record<string, typeof defaults>).a!.feather;
  actions.changeEdit({ feather: 4 }, "feather");
  assert.ok((state.past as unknown[]).length >= 1, "the edit can be undone");
  actions.undo();
  assert.equal(feather(), 0);
  assert.ok((state.future as unknown[]).length >= 1, "the undo can be redone");
  actions.redo();
  assert.equal(feather(), 4);
});

test("resume shares one background between the items that shared it before the save", async () => {
  const shared = big(1);
  // A store may hand back one copy per item (WebKit's IndexedDB does): equal bytes, new Blobs.
  const copies = Array.from({ length: 6 }, () => new Blob([new Uint8Array(MB)]));
  const other = new Blob([new Uint8Array(MB).fill(7)]);
  let converted = 0;
  const convert = async (blob: Blob) => {
    converted += 1;
    return new File([blob], "background", { type: blob.type });
  };
  for (const saved of [Array(6).fill(shared), copies]) {
    converted = 0;
    const out = await shareBackgrounds([...saved, null, other], convert);
    assert.equal(new Set(out.slice(0, 6)).size, 1, "six items, one background Blob");
    assert.equal(out[6], null);
    assert.notEqual(out[7], out[0], "a different background stays its own");
    assert.equal(converted, 2, "each distinct background is converted once");
  }
  const failing = await shareBackgrounds([shared, shared], () => Promise.reject(new Error("x")));
  assert.deepEqual(failing, [null, null], "a background that cannot be restored is left out");
});
