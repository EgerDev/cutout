import assert from "node:assert/strict";
import test from "node:test";
import { defaults } from "./model.ts";
import type { WorkspaceState } from "../workspace-types.ts";
import {
  REMOVAL_FAILURE_KEY,
  REMOVAL_RUNTIME_FINGERPRINT,
  clearRemovalFailureRecords,
  readGpuFailure,
  rememberGpuFailure,
} from "../removal-provider.ts";
import {
  deleteSavedWorkspace,
  forgetLocalData,
  sessionInputsChanged,
  sessionSchema,
  snapshotSession,
  saveSession,
  shouldOpenStore,
} from "./session.ts";
import { localWorkspaceGeneration } from "./session-events.ts";

test("oversized saved workspaces are refused before parsing their items", () => {
  let reads = 0;
  const item = {
    get name() {
      reads += 1;
      return "image.png";
    },
  };
  const parsed = sessionSchema.safeParse({
    version: 2,
    savedAt: 1,
    activeIndex: 0,
    items: Array(16).fill(item),
  });
  assert.equal(parsed.success, false);
  assert.equal(reads, 0, "the 15-image budget must be checked before visiting untrusted items");
});

test("version 1 workspaces load with new editor defaults", () => {
  const source = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
  const parsed = sessionSchema.parse({
    version: 1,
    savedAt: 1,
    activeIndex: 0,
    items: [
      {
        name: "a.png",
        source,
        result: null,
        width: 10,
        height: 10,
        settings: {
          exportFormat: "png",
          exportWidth: null,
          exportHeight: null,
          background: { type: "transparent" },
          customColor: "#f4f3ef",
          backgroundImageUrl: null,
          backgroundBlob: null,
          stripMetadata: false,
          feather: 0,
          choke: 0,
          strokes: [],
          preset: "original",
          padding: 10,
          positionX: 50,
          positionY: 50,
          shadow: false,
          shadowOpacity: 25,
          shadowSoftness: 15,
          shadowDistance: 2,
          quality: 92,
          targetKB: null,
        },
      },
    ],
  });
  assert.equal(parsed.items[0]?.settings.scale, 100);
  assert.equal(parsed.items[0]?.settings.hints.length, 0);
  assert.equal(parsed.items[0]?.settings.decontaminate, "off");
  assert.equal(parsed.items[0]?.settings.shadowKind, "contact");
});

test("the workspace database is only opened when something was saved or is being saved", () => {
  assert.equal(shouldOpenStore({ hasSaveFlag: false, autosave: false }), false);
  assert.equal(shouldOpenStore({ hasSaveFlag: true, autosave: false }), true);
  assert.equal(shouldOpenStore({ hasSaveFlag: false, autosave: true }), true);
});

test("deleting local data removes workspace settings and retains the deletion fence", () => {
  const entries = new Map([
    ["cutout.saved", "1"],
    ["cutout.enhance.tileMs", '{"2":40}'],
    ["bg0:webgpu-failure:abc123", "Mozilla/5.0"],
    ["bg0:webgpu-failure:def456", "Mozilla/5.0"],
    ["theme", "dark"],
    ["cutout:workspace-deleted", "receipt"],
  ]);
  const storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
  };
  forgetLocalData(storage);
  assert.deepEqual([...entries.keys()], ["theme", "cutout:workspace-deleted"]);
});

test("autosave ignores queue progress and previews, but not saved content", () => {
  const source = new Blob(["a"]);
  const settings = { a: {} } as never;
  const item = { id: "a", name: "a.png", source, resultBlob: null, width: 10, height: 10 };
  const old = { items: [item], settings, activeId: "a" } as never;
  const progress = {
    items: [{ ...item, status: "working", preview: {} }],
    settings,
    activeId: "a",
  };
  assert.equal(sessionInputsChanged(progress as never, old), false);
  const result = { ...progress, items: [{ ...item, resultBlob: new Blob(["b"]) }] };
  assert.equal(sessionInputsChanged(result as never, old), true);
  assert.equal(sessionInputsChanged({ ...progress, settings: { a: {} } } as never, old), true);
  assert.equal(sessionInputsChanged({ ...progress, activeId: null } as never, old), true);
  assert.equal(sessionInputsChanged({ ...progress, items: [] } as never, old), true);
});

function keyStorage(entries: Map<string, string>) {
  return {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

// Q8 (design r9): the owned failure record is Cutout's own key, so forgetLocalData
// sweeps it by exact name; the legacy record was written by bg0 and holds the UA.
test("forgetLocalData removes cutout:removal-webgpu-failure:v1 and the legacy prefix, by exact name", () => {
  assert.equal(REMOVAL_FAILURE_KEY, "cutout:removal-webgpu-failure:v1");
  const entries = new Map([
    ["cutout:removal-webgpu-failure:v1", '{"version":1}'],
    ["bg0:webgpu-failure:4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7", "Mozilla/5.0"],
    ["cutout:removal-webgpu-failure:v2", "kept: not a key Cutout writes"],
    ["theme", "dark"],
  ]);
  forgetLocalData(keyStorage(entries));
  assert.deepEqual([...entries.keys()], ["cutout:removal-webgpu-failure:v2", "theme"]);
});

// A page with fake localStorage/indexedDB globals, restored afterwards.
function fakePage(t: { after(fn: () => void): void }, entries: Map<string, string>) {
  const storage = keyStorage(entries);
  // A store that never holds a record: reading through it shows only the in-process flag.
  const flagOnly = keyStorage(new Map());
  const globals = globalThis as Record<string, unknown>;
  const saved = {
    localStorage: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
    indexedDB: Object.getOwnPropertyDescriptor(globalThis, "indexedDB"),
  };
  const define = (name: string, value: unknown) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globals[name];
    }
    clearRemovalFailureRecords(flagOnly);
  });
  clearRemovalFailureRecords(flagOnly);
  define("localStorage", storage);
  define("indexedDB", {
    deleteDatabase() {
      const request: { onsuccess?: () => void } = {};
      queueMicrotask(() => request.onsuccess?.());
      return request;
    },
  });
  return { storage, flagOnly };
}

// Q7/Q8 (design r9, F6): Delete saved workspace removes the owned record and the legacy note.
test("deleteSavedWorkspace removes the owned and legacy failure records and the save flag", async (t) => {
  const entries = new Map([
    ["cutout.saved", "1"],
    ["bg0:webgpu-failure:abc123", "Mozilla/5.0"],
    ["theme", "dark"],
  ]);
  const { storage } = fakePage(t, entries);
  // A gpu-mask record an earlier version persisted (E10-S-01: no longer written, still read and cleared).
  entries.set(REMOVAL_FAILURE_KEY, JSON.stringify({ version: 1, fingerprint: REMOVAL_RUNTIME_FINGERPRINT, kind: "gpu-mask" }));
  assert.equal(readGpuFailure(storage), true);

  await deleteSavedWorkspace();

  assert.deepEqual([...entries.keys()], ["theme", "cutout:workspace-deleted"]);
  assert.match(entries.get("cutout:workspace-deleted")!, /^[0-9a-f-]{36}$/);
  assert.equal(readGpuFailure(storage), false);
});

// Q7 (design r9, F6): it also resets this page's in-process flag. Needs the flag from
// removal-provider (S1 commit 1); until then the precondition below fails.
test("deleteSavedWorkspace resets the page's in-process GPU failure flag", async (t) => {
  const { storage, flagOnly } = fakePage(t, new Map());
  assert.equal(rememberGpuFailure("gpu-mask", storage), false, "a gpu-mask failure is not persisted (E10-S-01)");
  assert.equal(readGpuFailure(flagOnly), true, "precondition: the in-process flag is set");

  await deleteSavedWorkspace();

  assert.equal(readGpuFailure(flagOnly), false, "the in-process flag was reset");
});

function heldDelete(
  t: { after(fn: () => void): void },
  entries: Map<string, string>,
) {
  fakePage(t, entries);
  const request: {
    onblocked?: () => void;
    onsuccess?: () => void;
    onerror?: () => void;
    error?: Error;
  } = {};
  let requests = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      deleteDatabase() {
        requests += 1;
        // A later native delete queues behind the outstanding one and gets no events.
        if (requests > 1) return {};
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    },
  });
  t.after(() => {
    request.error ??= new Error("test cleanup");
    request.onerror?.();
  });
  return {
    request,
    nativeDeletes: () => requests,
    settle: (status: "success" | "error", error?: Error) => {
      if (status === "error") {
        request.error = error ?? new Error("Local storage is unavailable.");
        request.onerror?.();
      } else request.onsuccess?.();
      return Promise.resolve();
    },
  };
}

async function settles(
  operation: Promise<unknown>,
  ms = 50,
): Promise<string> {
  return Promise.race([
    operation.then(
      () => "resolved",
      (e: Error) => e.message,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), ms)),
  ]);
}

test("blocked deletion rejects promptly and preserves the saved-data flag", async (t) => {
  const entries = new Map([["cutout.saved", "1"]]);
  const held = heldDelete(t, entries);
  const outcome = await settles(deleteSavedWorkspace());
  assert.match(outcome, /Close other Cutout tabs/);
  assert.equal(entries.get("cutout.saved"), "1");
  assert.equal(held.nativeDeletes(), 1);
});

test("a second delete while the native request is still blocked fails immediately without another native request", async (t) => {
  const entries = new Map([["cutout.saved", "1"]]);
  const held = heldDelete(t, entries);
  assert.match(await settles(deleteSavedWorkspace()), /Close other Cutout tabs/);
  const retry = await settles(deleteSavedWorkspace());
  assert.match(retry, /Close other Cutout tabs/);
  assert.notEqual(retry, "still pending");
  assert.equal(held.nativeDeletes(), 1);
  assert.equal(entries.get("cutout.saved"), "1");
});

test("when a blocked native delete later succeeds, the saved flag is cleared and a later delete can run", async (t) => {
  const entries = new Map([["cutout.saved", "1"]]);
  const held = heldDelete(t, entries);
  assert.match(await settles(deleteSavedWorkspace()), /Close other Cutout tabs/);
  await held.settle("success");
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(entries.has("cutout.saved"), false);
  let later = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      deleteDatabase() {
        later += 1;
        const next: { onsuccess?: () => void } = {};
        queueMicrotask(() => next.onsuccess?.());
        return next;
      },
    },
  });
  await deleteSavedWorkspace();
  assert.equal(later, 1);
});

test("when a blocked native delete later fails, the saved flag remains and a later delete can run", async (t) => {
  const entries = new Map([["cutout.saved", "1"]]);
  const held = heldDelete(t, entries);
  assert.match(await settles(deleteSavedWorkspace()), /Close other Cutout tabs/);
  await held.settle("error");
  await Promise.resolve();
  assert.equal(entries.get("cutout.saved"), "1");
  let later = 0;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      deleteDatabase() {
        later += 1;
        const next: { onsuccess?: () => void } = {};
        queueMicrotask(() => next.onsuccess?.());
        return next;
      },
    },
  });
  await deleteSavedWorkspace();
  assert.equal(later, 1);
  assert.equal(entries.has("cutout.saved"), false);
});

test("saving rejects promptly while a blocked delete is still outstanding", async (t) => {
  const entries = new Map([["cutout.saved", "1"]]);
  heldDelete(t, entries);
  assert.match(await settles(deleteSavedWorkspace()), /Close other Cutout tabs/);
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        return {};
      },
    },
  });
  const save = await settles(saveSession(null));
  assert.match(save, /Close other Cutout tabs/);
  assert.notEqual(save, "still pending");
  assert.equal(entries.get("cutout.saved"), "1");
});

test("an open that succeeds after reporting blocked closes its unused connection", async (t) => {
  fakePage(t, new Map());
  let closed = 0;
  const request: { onblocked?: () => void; onsuccess?: () => void; result: unknown } = {
    result: { close: () => closed++ },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        queueMicrotask(() => request.onblocked?.());
        return request;
      },
    },
  });
  await assert.rejects(saveSession(null), /Close other Cutout tabs/);
  request.onsuccess?.();
  assert.equal(closed, 1);
});

test("a save queued before deletion is fenced, while an explicit save after deletion succeeds", async (t) => {
  fakePage(t, new Map());
  const generation = localWorkspaceGeneration();
  const deletion: { onsuccess?: () => void } = {};
  let writes = 0,
    closed = 0;
  const opening: { onsuccess?: () => void; result: unknown } = {
    result: {
      close() {
        closed++;
      },
      transaction() {
        writes++;
        const transaction = { objectStore: () => ({ delete() {} }), oncomplete: () => {} };
        queueMicrotask(() => transaction.oncomplete());
        return transaction;
      },
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { deleteDatabase: () => deletion, open: () => opening },
  });
  const removing = deleteSavedWorkspace();
  await new Promise((resolve) => setImmediate(resolve));
  const saving = saveSession(null);
  const rejected = assert.rejects(saving, /saved workspace was deleted/);
  await new Promise((resolve) => setImmediate(resolve));
  // Native opens wait behind deletion. The old snapshot must not recreate the database.
  deletion.onsuccess?.();
  await removing;
  opening.onsuccess?.();
  await rejected;
  assert.equal(writes, 0);
  assert.equal(closed, 1);
  const fresh = saveSession(null);
  await new Promise((resolve) => setImmediate(resolve));
  opening.onsuccess?.();
  assert.equal(await fresh, generation + 1);
  assert.equal(writes, 1);
});

test("a delayed storage notification cannot let a stale save recreate the database during upgrade", async (t) => {
  const entries = new Map<string, string>();
  const { storage } = fakePage(t, entries);
  let aborted = 0,
    stores = 0;
  const opening: { onupgradeneeded?: () => void; result: unknown; transaction: unknown } = {
    result: {
      createObjectStore() {
        stores++;
      },
    },
    transaction: {
      abort() {
        aborted++;
      },
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open: () => opening },
  });
  const saving = saveSession(null);
  const rejected = assert.rejects(saving, /saved workspace was deleted/);
  await new Promise((resolve) => setImmediate(resolve));
  // Another tab committed deletion; deliberately do not dispatch a storage event here.
  storage.setItem("cutout:workspace-deleted", "another-tab-deletion");
  opening.onupgradeneeded?.();
  await rejected;
  assert.equal(aborted, 1);
  assert.equal(stores, 0);
  assert.equal(entries.has("cutout.saved"), false);
});

function workspaceWithBackground(background: Blob): WorkspaceState {
  const source = new File(["source"], "image.png", { type: "image/png" });
  return {
    activeId: "0",
    items: Array.from({ length: 15 }, (_, i) => ({
      id: String(i),
      name: source.name,
      source,
      resultBlob: null,
      width: 10,
      height: 10,
    })),
    settings: Object.fromEntries(
      Array.from({ length: 15 }, (_, i) => [
        String(i),
        {
          ...defaults,
          backgroundBlob: background,
        },
      ]),
    ),
  } as WorkspaceState;
}

test("saving counts shared background, source and result Blobs only once", () => {
  const background = new Blob([new Uint8Array(17_000_000)]);
  const state = workspaceWithBackground(background);
  state.items = state.items.map((item) => ({ ...item, resultBlob: background }));
  assert.equal(snapshotSession(state).items.length, 15);
});

test("saving still refuses more than 250 MB of distinct Blobs", () => {
  const state = workspaceWithBackground(new Blob());
  state.items = state.items.map((item) => ({
    ...item,
    resultBlob: new Blob([new Uint8Array(17_000_000)]),
  }));
  assert.throws(() => snapshotSession(state), /exceeds 250 MB/);
});

test("snapshot retains queued source dimensions above 20000 without changing pixels", () => {
  const state = workspaceWithBackground(new Blob());
  state.items[0] = { ...state.items[0]!, width: 30000, height: 100 };
  const snapshot = snapshotSession(state);
  assert.equal(snapshot.items[0]?.width, 30000);
  assert.equal(snapshot.items[0]?.source, state.items[0]?.source);
});

test("invalid editor state has a plain save failure rather than validator JSON", () => {
  const state = workspaceWithBackground(new Blob());
  state.settings = {
    ...state.settings,
    "0": {
      ...defaults,
      recolors: Array.from({ length: 25 }, () => ({ from: "#112233", to: null })),
    },
  };
  assert.throws(
    () => snapshotSession(state),
    (error) =>
      error instanceof Error &&
      /adjustments.*cannot be saved/.test(error.message) &&
      !error.message.includes("too_big"),
  );
  assert.equal(state.settings["0"].recolors.length, 25, "invalid edits are not silently discarded");
});
