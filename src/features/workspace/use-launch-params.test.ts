import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { registerHooks } from "node:module";
import test from "node:test";
import type { LaunchPlan } from "../../lib/url-api.ts";
import type { WorkspaceState, QueueItem, IngestReceipt } from "../../lib/workspace-types.ts";
import { runtime } from "../../lib/workspace-runtime.ts";
import {
  backgroundPatch,
  defaults,
  presetPatch,
  type EditSettings,
} from "../../lib/editor/model.ts";

const listeners = new Set<(next: WorkspaceState, old: WorkspaceState) => void>();
let state: WorkspaceState;
let fetchSource: () => Promise<File>;
const store = {
  getState: () => state,
  subscribe: (listener: (next: WorkspaceState, old: WorkspaceState) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
Object.assign(globalThis, { launchTestStore: store, launchTestFetch: () => fetchSource() });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.includes("use-launch-params.ts")) return next(specifier, context);
    const source =
      specifier === "@/lib/workspace-store"
        ? "export const useWorkspace = globalThis.launchTestStore;"
        : specifier === "@/lib/url-api"
          ? "export const fetchLaunchSource = (...args) => globalThis.launchTestFetch(...args);"
          : null;
    if (source)
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    if (["@/lib/workspace-runtime", "@/lib/editor/model", "@/lib/errors"].includes(specifier))
      return {
        url: new URL(`${specifier.replace("@/", "../../")}.ts`, import.meta.url).href,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    // Export the private real runner for behavioral tests, including at the immutable base.
    if (url.endsWith("/use-launch-params.ts"))
      return { ...result, source: `${result.source}\nexport { runLaunch };` };
    return result;
  },
});
const { runLaunch } = (await import("./use-launch-params.ts")) as unknown as {
  runLaunch: (plan: LaunchPlan, signal?: AbortSignal) => Promise<void>;
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function set(patch: Partial<WorkspaceState>) {
  const old = state;
  state = { ...state, ...patch };
  for (const listener of [...listeners]) listener(state, old);
}
const file = () => new File(["source"], "linked.png", { type: "image/png" });
const item = (id: string, source = file(), status: QueueItem["status"] = "working") =>
  ({
    id,
    source,
    status,
    resultBlob: status === "done" ? new Blob(["result"]) : null,
  }) as QueueItem;
const plan = (src: string | null = "https://images.example/linked.png"): LaunchPlan => ({
  src,
  preset: "amazon",
  background: { type: "blur" },
  format: "jpeg",
  download: true,
  name: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  listeners.clear();
  runtime.job = runtime.drop = 0;
  const calls: string[] = [];
  const patch = (key: string, change: Partial<EditSettings>) => {
    calls.push(key);
    set({
      settings: {
        ...state.settings,
        [state.activeId!]: { ...(state.settings[state.activeId!] ?? defaults), ...change },
      },
    });
  };
  state = {
    items: [],
    activeId: null,
    settings: {},
    errorMessage: null,
    phase: "idle",
    setPreset: (preset: Parameters<WorkspaceState["setPreset"]>[0]) =>
      patch("preset", presetPatch(preset)),
    setBackground: (background: Parameters<WorkspaceState["setBackground"]>[0]) =>
      patch("background", backgroundPatch(state.settings[state.activeId!] ?? defaults, background)),
    setExportFormat: (exportFormat: Parameters<WorkspaceState["setExportFormat"]>[0]) =>
      patch("format", { exportFormat }),
    downloadActive: async () => {
      calls.push(`download:${state.activeId}`);
    },
    reportError: (errorMessage: string) => set({ errorMessage }),
    receiveFiles: async ([source]: File[]) => {
      const drop = ++runtime.drop,
        job = ++runtime.job;
      const target = item("linked", source);
      set({
        items: [target],
        activeId: target.id,
        settings: { linked: defaults },
        phase: "processing",
      });
      return { job, drop, items: [target] };
    },
  } as unknown as WorkspaceState;
  fetchSource = async () => file();
  return calls;
}
const finish = () =>
  set({
    items: state.items.map((entry) => ({
      ...entry,
      status: "done",
      resultBlob: new Blob(["result"]),
    })),
  });

test.beforeEach((t) => {
  if (!("mock" in t)) return;
  Object.assign(globalThis, { window: globalThis });
  t.mock.timers.enable({ apis: ["setTimeout"] });
});

test("linked target owns launch effects through processing; replacement, selection and edits win", async (t) => {
  for (const change of ["drop", "reset", "remove", "select", "source", "id", "edit", "abort"])
    await t.test(change, async () => {
      const calls = setup(),
        controller = new AbortController();
      const running = runLaunch(plan(), controller.signal);
      await flush();
      assert.equal(state.activeId, "linked");
      if (change === "drop") {
        runtime.drop++;
        runtime.job++;
        set({ items: [item("own", file(), "done")], activeId: "own" });
      }
      if (change === "reset" || change === "remove") {
        if (change === "reset") runtime.job++;
        set({ items: [], activeId: null });
      }
      if (change === "select")
        set({ items: [...state.items, item("own", file(), "done")], activeId: "own" });
      if (change === "source") set({ items: [item("linked", file(), "done")] });
      if (change === "id")
        set({ items: [item("new-id", state.items[0]!.source, "done")], activeId: "new-id" });
      if (change === "edit") set({ settings: { linked: { ...defaults, customColor: "#123456" } } });
      if (change === "abort") controller.abort();
      finish();
      await flush();
      assert.deepEqual(calls, [], change);
      assert.equal(listeners.size, 0, "cancelled targets release their subscription");
      await running;
    });
});

test("slow linked target completes once beyond 120 seconds without an engine watchdog", async (t) => {
  const calls = setup();
  const running = runLaunch(plan(), new AbortController().signal);
  await flush();
  t.mock.timers.tick(120_001);
  await flush();
  assert.deepEqual(calls, []);
  finish();
  await flush();
  await running;
  assert.deepEqual(calls, ["preset", "background", "format", "download:linked"]);
  finish();
  assert.equal(calls.length, 4);
  assert.equal(listeners.size, 0);
});

test("new ingest preparation never applies launch to a previous done item and rejected/empty ingest settles", async (t) => {
  for (const outcome of ["accepted", "empty", "rejected"])
    await t.test(outcome, async () => {
      const calls = setup(),
        pending = deferred<IngestReceipt | null>();
      set({ items: [item("old", file(), "done")], activeId: "old", settings: { old: defaults } });
      const receive = state.receiveFiles;
      state.receiveFiles = () => {
        runtime.drop++;
        set({ phase: "processing" });
        return pending.promise;
      };
      const controller = new AbortController(),
        running = runLaunch(plan(), controller.signal);
      await flush();
      assert.deepEqual(calls, [], "old result is not the new target");
      if (outcome === "accepted") {
        runtime.drop--;
        const receipt = await receive([file()]);
        pending.resolve(receipt);
        await flush();
        finish();
      } else if (outcome === "empty") pending.resolve(null);
      else pending.reject(new Error("ingest refused"));
      await flush();
      if (outcome === "accepted")
        assert.deepEqual(calls, ["preset", "background", "format", "download:linked"]);
      else assert.deepEqual(calls, []);
      controller.abort();
      await flush();
      await running;
      assert.equal(listeners.size, 0);
    });
});

test("fetch failure publication belongs to latest job/drop, selection, settings and hook lifetime", async (t) => {
  for (const change of ["none", "drop", "reset", "select", "edit", "abort"])
    await t.test(change, async () => {
      setup();
      const pending = deferred<File>(),
        controller = new AbortController();
      fetchSource = () => pending.promise;
      const running = runLaunch(plan(), controller.signal);
      await flush();
      if (change === "drop") {
        runtime.drop++;
        set({ phase: "processing" });
      }
      if (change === "reset") {
        runtime.job++;
        set({ phase: "idle" });
      }
      if (change === "select") set({ items: [item("own")], activeId: "own" });
      if (change === "edit") set({ settings: { none: { ...defaults } } });
      if (change === "abort") controller.abort();
      pending.reject(new Error("fetch failed"));
      await flush();
      await running;
      assert.equal(
        state.errorMessage,
        change === "none" || change === "edit"
          ? "Couldn’t load the linked image. Check the link and your connection. Choose a file from your device to continue."
          : null,
      );
      assert.equal(listeners.size, 0);
    });
});

test("F2: a non-Error launch failure uses the linked-image fallback and a next step", async () => {
  setup();
  fetchSource = async () => {
    throw "internal launch failure";
  };
  await runLaunch(plan());
  assert.equal(
    state.errorMessage,
    "Couldn’t load the linked image. Choose a file from your device to continue.",
  );
  assert.equal(listeners.size, 0);
});

test("no-src plans keep the current or first next item; errors and retry never auto-download", async (t) => {
  for (const mode of ["done", "working", "next", "error"])
    await t.test(mode, async () => {
      const calls = setup();
      if (mode !== "next")
        set({
          items: [item("current", file(), mode === "done" ? "done" : "working")],
          activeId: "current",
          settings: { current: defaults },
        });
      const controller = new AbortController(),
        running = runLaunch(plan(null), controller.signal);
      await flush();
      if (mode === "next") await state.receiveFiles([file()]);
      if (mode === "error") {
        set({ items: state.items.map((entry) => ({ ...entry, status: "error" })) });
        await flush();
      }
      finish();
      await flush();
      if (mode === "error") assert.deepEqual(calls, []);
      else
        assert.deepEqual(calls, [
          "preset",
          "background",
          "format",
          `download:${mode === "next" ? "linked" : "current"}`,
        ]);
      controller.abort();
      await running;
      assert.equal(listeners.size, 0);
    });
});

test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, "launchTestStore");
  Reflect.deleteProperty(globalThis, "launchTestFetch");
});

test("a selected source or settings identity change invalidates both fetch success and failure", async (t) => {
  for (const change of ["source", "settings", "selection", "result"])
    for (const outcome of ["success", "failure"])
      await t.test(`${change}-${outcome}`, async () => {
        const calls = setup();
        set({ items: [item("old", file(), "done")], activeId: "old", settings: { old: defaults } });
        const pending = deferred<File>(),
          controller = new AbortController();
        fetchSource = () => pending.promise;
        const running = runLaunch(plan(), controller.signal);
        await flush();
        if (change === "source") set({ items: [item("old", file(), "done")] });
        if (change === "settings") set({ settings: { old: { ...defaults } } });
        if (change === "result")
          set({ items: state.items.map((i) => ({ ...i, resultBlob: new Blob(["replaced"]) })) });
        if (change === "selection")
          set({ items: [...state.items, item("other", file(), "done")], activeId: "other" });
        if (outcome === "success") pending.resolve(file());
        else pending.reject(new Error("obsolete fetch"));
        await flush();
        await running;
        assert.deepEqual(calls, []);
        assert.equal(state.errorMessage, null);
        assert.equal(listeners.size, 0);
      });
});

test("away and back before ingest receipt cannot restore launch ownership", async () => {
  const calls = setup(),
    held = deferred<IngestReceipt | null>();
  const receive = state.receiveFiles;
  state.receiveFiles = async (files, signal) => {
    const receipt = await receive(files, signal);
    await held.promise;
    return receipt;
  };
  const running = runLaunch(plan());
  await flush();
  const linked = state.items[0]!;
  set({
    items: [linked, item("other", file(), "done")],
    settings: { ...state.settings, other: defaults },
  });
  set({ activeId: "other" });
  set({ activeId: linked.id });
  finish();
  held.resolve(null);
  await running;
  assert.deepEqual(calls, []);
  assert.equal(listeners.size, 0);
});
test("terminal publication stays observed until effect continuation", async () => {
  const calls = setup(),
    controller = new AbortController();
  const running = runLaunch(plan(), controller.signal);
  await flush();
  const linked = state.items[0]!;
  set({
    items: [linked, item("other", file(), "done")],
    settings: { ...state.settings, other: defaults },
  });
  finish();
  set({ activeId: "other" });
  set({ activeId: linked.id });
  await running;
  assert.deepEqual(calls, []);
  assert.equal(listeners.size, 0);
});

test("launch observes nested settings/selection/result changes during its own preset publication", async (t) => {
  for (const order of ["before", "after"])
    for (const change of ["edit", "selection", "result"])
      await t.test(`${order}-${change}`, async () => {
        const calls = setup();
        let fired = false;
        const nested = () => {
          if (fired || calls[0] !== "preset") return;
          fired = true;
          const original = state;
          if (change === "selection") {
            set({ activeId: "other" });
            set({ activeId: original.activeId });
          }
          if (change === "result") {
            set({ items: original.items.map((i) => ({ ...i, resultBlob: new Blob(["new"]) })) });
            set({ items: original.items });
          }
          if (change === "edit") {
            set({ settings: { linked: { ...state.settings.linked!, customColor: "#123456" } } });
            set({ settings: original.settings });
          }
        };
        if (order === "before") listeners.add(nested);
        const running = runLaunch(plan());
        await flush();
        if (order === "after") listeners.add(nested);
        finish();
        await running;
        assert.deepEqual(calls, ["preset"]);
        listeners.delete(nested);
        assert.equal(listeners.size, 0);
      });
});
test("done launch retains observer and abort ownership until download completes", async () => {
  setup();
  const held = deferred<void>(),
    controller = new AbortController();
  let ownership: Parameters<WorkspaceState["downloadActive"]>[1];
  state.downloadActive = async (_format, launch) => {
    ownership = launch;
    await held.promise;
  };
  const running = runLaunch(plan(), controller.signal);
  await flush();
  finish();
  await flush();
  assert.equal(listeners.size, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  assert.equal(ownership?.isCurrent(), true);
  controller.abort();
  assert.equal(ownership?.signal.aborted, true);
  assert.equal(ownership?.isCurrent(), false);
  held.resolve();
  await running;
  assert.equal(listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("healthy current settings-only plans accept their own no-op/transparent transitions and release listeners", async () => {
  const calls = setup(),
    controller = new AbortController();
  set({
    items: [item("current", file(), "done")],
    activeId: "current",
    settings: { current: { ...defaults, exportFormat: "jpeg" } },
  });
  await runLaunch(
    {
      ...plan(null),
      preset: null,
      format: null,
      background: { type: "transparent" },
      download: false,
    },
    controller.signal,
  );
  assert.deepEqual(calls, ["background"]);
  assert.equal(state.settings.current!.exportFormat, "png");
  assert.equal(listeners.size, 0);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});
