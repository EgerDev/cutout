import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { WorkspaceState } from "../../lib/workspace-types.ts";
import { deleteSavedWorkspace } from "../../lib/editor/session.ts";
import { defaults } from "../../lib/editor/model.ts";
import {
  localWorkspaceGeneration,
  onLocalWorkspaceDeleted,
} from "../../lib/editor/session-events.ts";

// Exercise the real hook/subscription and native-request handler. Only React's effect
// scheduling and the store boundary are replaced; no guard logic is copied here.
let state = { items: [], settings: {}, saved: false } as unknown as WorkspaceState;
const subscriptions = new Set<(next: WorkspaceState, old: WorkspaceState) => void>();
const store = {
  getState: () => state,
  subscribe: (listener: (next: WorkspaceState, old: WorkspaceState) => void) => {
    subscriptions.add(listener);
    return () => subscriptions.delete(listener);
  },
};
const boundary = globalThis as unknown as { ui07Store: typeof store };
boundary.ui07Store = store;
registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.includes("use-unsaved-guard.ts")) return next(specifier, context);
    const source =
      specifier === "react"
        ? "export const useEffect = fn => fn();"
        : specifier === "@/lib/workspace-store"
          ? "export const useWorkspace = globalThis.ui07Store;"
          : null;
    if (source)
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    if (specifier === "@/lib/editor/session-events")
      return {
        url: new URL("../../lib/editor/session-events.ts", import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { useUnsavedGuard, markSaved } = await import("./use-unsaved-guard.ts");
function set(next: Partial<WorkspaceState>) {
  const old = state;
  state = { ...state, ...next };
  for (const listener of subscriptions) listener(state, old);
}
function result(settings: unknown = { ...defaults }) {
  const blob = new Blob(["result"]);
  set({
    items: [{ id: "a", resultBlob: blob, status: "done" }] as WorkspaceState["items"],
    settings: { a: settings } as WorkspaceState["settings"],
    activeId: "a",
    saved: false,
  });
  return { blob, settings };
}

test("saved provenance follows authoritative deletion, async lifetime and the existing warning scope", async (t) => {
  const target = new EventTarget();
  const prior = Object.fromEntries(
    ["window", "indexedDB", "localStorage"].map((key) => [
      key,
      Object.getOwnPropertyDescriptor(globalThis, key),
    ]),
  );
  const define = (key: string, value: unknown) =>
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  define("window", target);
  const storage = new Map<string, string>();
  define("localStorage", {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  t.after(() => {
    for (const [key, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    Reflect.deleteProperty(globalThis, "ui07Store");
  });
  const warns = () => {
    const event = new Event("beforeunload", { cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  useUnsavedGuard();
  useUnsavedGuard();
  assert.equal(subscriptions.size, 1, "route remounts do not duplicate the permanent observer");
  let requests = 0;
  let request: {
    onblocked?: () => void;
    onsuccess?: () => void;
    onerror?: () => void;
    error?: Error;
  };
  define("indexedDB", {
    deleteDatabase() {
      requests++;
      request = {};
      return request;
    },
  });
  async function begin() {
    const operation = deleteSavedWorkspace();
    const observed = operation.catch((e: Error) => e);
    await new Promise((resolve) => setImmediate(resolve));
    return { operation, observed };
  }
  await t.test(
    "blocked and eventual error preserve local marks; observer cleanup works",
    async () => {
      const { blob, settings } = result();
      markSaved(blob, settings, localWorkspaceGeneration());
      assert.equal(warns(), false);
      let notifications = 0;
      const remove = onLocalWorkspaceDeleted(() => notifications++);
      const generation = localWorkspaceGeneration();
      const { observed } = await begin();
      request.onblocked?.();
      assert.match(String(await observed), /Close other Cutout tabs/);
      for (let i = 0; i < 8; i++) await assert.rejects(deleteSavedWorkspace(), /Close other/);
      assert.equal(requests, 1);
      assert.equal(warns(), false);
      request.error = new Error("native error");
      request.onerror?.();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(localWorkspaceGeneration(), generation);
      assert.equal(warns(), false);
      assert.equal(notifications, 0);
      remove();
      remove();
      const { operation } = await begin();
      request.onsuccess?.();
      await operation;
      assert.equal(warns(), true, "successful native completion invalidates immediately");
      assert.equal(notifications, 0, "unsubscribed observers stay removed");
    },
  );
  await t.test(
    "late success rejects stale save/resume marks, and a new save restores them",
    async () => {
      const { blob, settings } = result();
      const old = localWorkspaceGeneration();
      markSaved(blob, settings, old);
      const { observed } = await begin();
      request.onblocked?.();
      await observed;
      request.onsuccess?.();
      assert.equal(warns(), true, "the request outlives its rejected caller");
      markSaved(blob, settings, old);
      assert.equal(warns(), true, "late async marking cannot resurrect a deleted save");
      await new Promise((resolve) => setImmediate(resolve));
      markSaved(blob, settings, localWorkspaceGeneration());
      assert.equal(warns(), false);
    },
  );
  await t.test(
    "external and local settings stay independent across edits, undo and repeated deletes",
    async () => {
      const { blob, settings } = result();
      markSaved(blob, settings);
      const edited = { ...defaults, feather: 3 };
      set({ settings: { a: edited } as WorkspaceState["settings"] });
      markSaved(blob, edited, localWorkspaceGeneration());
      const { operation } = await begin();
      request.onsuccess?.();
      await operation;
      assert.equal(warns(), true);
      set({ settings: { a: settings } as WorkspaceState["settings"] });
      assert.equal(warns(), false, "older external settings remain saved on undo");
      markSaved(blob, settings, localWorkspaceGeneration());
      const again = await begin();
      request.onsuccess?.();
      await again.operation;
      assert.equal(warns(), false, "a local save cannot overwrite the independent export");
    },
  );
  await t.test(
    "the saved flash is not export provenance; unfinished items remain outside the warning scope",
    async () => {
      result();
      set({ saved: true });
      assert.equal(warns(), true, "a UI flash cannot certify a result was exported");
      const { operation } = await begin();
      request.onsuccess?.();
      await operation;
      assert.equal(warns(), true);
      const { blob } = result();
      set({ items: [{ id: "a", resultBlob: blob, status: "working" }] as WorkspaceState["items"] });
      assert.equal(warns(), false);
      set({ items: [{ id: "a", resultBlob: null, status: "done" }] as WorkspaceState["items"] });
      assert.equal(warns(), false);
      set({ errorMessage: "unrelated error", saved: false });
      assert.equal(warns(), false);
    },
  );
  await t.test("deleting in another tab invalidates local marks and stale async saves", () => {
    const { blob, settings } = result();
    const before = localWorkspaceGeneration();
    markSaved(blob, settings, before);
    assert.equal(warns(), false);
    const event = new Event("storage");
    Object.defineProperties(event, {
      key: { value: "cutout:workspace-deleted" },
      newValue: { value: "other-tab" },
    });
    storage.set("cutout:workspace-deleted", "other-tab");
    target.dispatchEvent(event);
    assert.equal(warns(), true);
    assert.equal(localWorkspaceGeneration(), before + 1);
    markSaved(blob, settings, before);
    assert.equal(warns(), true);
    markSaved(blob, settings);
    target.dispatchEvent(event);
    assert.equal(warns(), false, "downloaded results survive local data deletion");
  });
});
