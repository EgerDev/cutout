import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { defaults } from "./editor/model.ts";
import type { SavedSession } from "./editor/session.ts";
import type { WorkspaceState } from "./workspace-types.ts";
import { runtime } from "./workspace-runtime.ts";

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.includes("workspace-lifecycle.ts")) {
      const stubs: Record<string, string> = {
        "./workspace-queue": "export const runQueue = async () => {};",
        "./workspace-ingest": "export const hydratePreview = async () => {};",
        "./editor/canvas": "export const clearSourceBitmapCache = () => {};",
      };
      const stub = stubs[specifier];
      if (stub)
        return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
      if (specifier.startsWith("./") && !specifier.endsWith(".ts"))
        return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { resumeWorkspace } = await import("./workspace-lifecycle.ts");
test.after(() => hooks.deregister());
const jpeg = readFileSync(new URL("./fixtures/gps.jpg", import.meta.url));

for (const action of ["reset", "new upload", "upload validation"] as const) {
  test(`a pending saved-workspace restore cannot overwrite a newer ${action}`, async () => {
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slice = File.prototype.slice;
    File.prototype.slice = function (...args) {
      const part = slice.apply(this, args);
      if (this.name === "saved.jpg") {
        const read = part.arrayBuffer.bind(part);
        part.arrayBuffer = async () => {
          entered();
          await held;
          return read();
        };
      }
      return part;
    };
    const snapshot: SavedSession = {
      version: 2,
      savedAt: Date.now(),
      activeIndex: 0,
      items: [
        {
          name: "saved.jpg",
          source: new Blob([jpeg], { type: "image/jpeg" }),
          result: new Blob([jpeg]),
          width: 96,
          height: 96,
          settings: { ...defaults, strokes: [], hints: [], recolors: [] },
        },
      ],
    };
    let resets = 0;
    let state = {
      items: [],
      settings: {},
      phase: "idle",
      activeId: null,
      reset: () => {
        resets++;
        runtime.job++;
      },
    } as unknown as WorkspaceState;
    const store = {
      getState: () => state,
      setState: (
        patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>),
      ) => {
        state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      },
    };
    try {
      const pending = resumeWorkspace(snapshot, store);
      await reading;
      if (action === "upload validation") runtime.drop++;
      else runtime.job++;
      const newerItems =
        action === "new upload" ? [{ id: "new-upload", source: new File([jpeg], "new.jpg") }] : [];
      store.setState({
        items: newerItems as WorkspaceState["items"],
        phase: action === "reset" ? "idle" : "processing",
      });
      release();
      await assert.rejects(pending, /workspace changed while restoring/i);
      assert.equal(state.items, newerItems);
      assert.equal(resets, 0, "a stale restore must not reset the newer workspace");
    } finally {
      release();
      File.prototype.slice = slice;
    }
  });
}

for (const mutation of ["delete", "replace", "clear"] as const) {
  test(`open restored bytes survive ${mutation} invalidating native database backing`, async (t) => {
    const { deleteSavedWorkspace, saveSession, snapshotSession } =
      await import("./editor/session.ts");
    const { hasUnsavedWork, markSaved } = await import("./workspace-saved.ts");
    let available = true;
    const databaseFiles = new WeakSet<File>();
    const reads = new Map<Blob, number>();
    const slice = File.prototype.slice;
    const read = File.prototype.arrayBuffer;
    File.prototype.slice = function (...args) {
      if (this.name === "saved.jpg" || this.name === "background") databaseFiles.add(this);
      return slice.apply(this, args);
    };
    File.prototype.arrayBuffer = function () {
      if (databaseFiles.has(this)) reads.set(this, (reads.get(this) ?? 0) + 1);
      return !available && databaseFiles.has(this)
        ? Promise.reject(new DOMException("Missing database backing", "NotFoundError"))
        : read.call(this);
    };
    class StoredBlob extends Blob {
      override arrayBuffer() {
        reads.set(this, (reads.get(this) ?? 0) + 1);
        return available
          ? super.arrayBuffer()
          : Promise.reject(new DOMException("Missing database backing", "NotFoundError"));
      }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        length: 0,
        getItem: () => null,
        setItem() {},
        removeItem() {},
      },
    });
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        deleteDatabase() {
          const request = { onsuccess: () => {} };
          queueMicrotask(() => {
            available = false;
            request.onsuccess();
          });
          return request;
        },
        open() {
          const request = {
            onsuccess: () => {},
            result: {
              close() {},
              transaction() {
                const tx = { oncomplete: () => {}, objectStore: () => ({ put() {}, delete() {} }) };
                queueMicrotask(() => {
                  available = false;
                  tx.oncomplete();
                });
                return tx;
              },
            },
          };
          queueMicrotask(() => request.onsuccess());
          return request;
        },
      },
    });
    t.after(() => {
      File.prototype.slice = slice;
      File.prototype.arrayBuffer = read;
      for (const [key, descriptor] of [
        ["indexedDB", previous],
        ["localStorage", previousStorage],
      ] as const)
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    });
    const background = new StoredBlob([jpeg], { type: "image/jpeg" });
    const snapshot: SavedSession = {
      version: 2,
      savedAt: 0,
      activeIndex: 0,
      items: [
        {
          name: "saved.jpg",
          source: new Blob([jpeg], { type: "image/jpeg" }),
          result: new StoredBlob([jpeg], { type: "image/jpeg" }),
          width: 96,
          height: 96,
          settings: {
            ...defaults,
            strokes: [],
            hints: [],
            recolors: [],
            backgroundBlob: background,
          },
        },
      ],
    };
    let state = {
      items: [],
      settings: {},
      past: [],
      future: [],
      reset() {
        runtime.job++;
      },
    } as unknown as WorkspaceState;
    const store = {
      getState: () => state,
      setState: (
        patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>),
      ) => {
        state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      },
    };
    await resumeWorkspace(snapshot, store);
    const item = state.items[0]!;
    markSaved(item.resultBlob!, state.settings[item.id]);
    assert.equal(hasUnsavedWork(state), false);
    assert.equal(reads.size, 0, "resume never copies full restored Blobs into RAM");
    const originalSettings = state.settings;
    state = {
      ...state,
      settings: { ...state.settings, [item.id]: { ...state.settings[item.id]!, feather: 2 } },
      past: [{ settings: originalSettings, key: "feather", time: 0 }],
    };
    assert.equal(hasUnsavedWork(state), true);
    if (mutation === "delete") await deleteSavedWorkspace();
    else await saveSession(mutation === "clear" ? null : snapshotSession(state));
    assert.deepEqual(
      new Uint8Array(await state.items[0]!.source.arrayBuffer()),
      new Uint8Array(jpeg),
    );
    assert.deepEqual(
      new Uint8Array(await state.items[0]!.resultBlob!.arrayBuffer()),
      new Uint8Array(jpeg),
    );
    assert.deepEqual(
      new Uint8Array(await state.settings[item.id]!.backgroundBlob!.arrayBuffer()),
      new Uint8Array(jpeg),
    );
    assert.equal(hasUnsavedWork(state), true, "detachment does not save a new edit");
    assert.deepEqual(
      [...reads.values()],
      [1, 1, 1],
      "source, result and shared historical background copied once",
    );
    state = { ...state, settings: state.past[0]!.settings };
    assert.equal(hasUnsavedWork(state), false, "undo retains independent saved provenance");
    URL.revokeObjectURL(state.items[0]!.sourceUrl);
    URL.revokeObjectURL(state.items[0]!.resultUrl!);
    URL.revokeObjectURL(state.settings[item.id]!.backgroundImageUrl!);
  });
}
