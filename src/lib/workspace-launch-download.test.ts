import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { runtime } from "./workspace-runtime.ts";
import { defaults } from "./editor/model.ts";
import type { WorkspaceState, LaunchDownload } from "./workspace-types.ts";
import { writeToSaveHandle } from "./files.ts";
import { hasUnsavedWork } from "./workspace-saved.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const blob = new Blob(["encoded"], { type: "image/jpeg" });
const encoded = { blob, metTarget: true };
let encode: (input?: unknown, signal?: AbortSignal) => Promise<typeof encoded>;
let strip: () => Promise<Blob>;
let picker: Promise<
  Parameters<typeof writeToSaveHandle>[0] extends Promise<infer T> ? T : never
> | null;
let share: () => Promise<string>;
let mobile = false,
  downloads = 0,
  picks = 0;
Object.assign(globalThis, {
  launchDownloads: {
    encode: (input?: unknown, signal?: AbortSignal) => encode(input, signal),
    strip: () => strip(),
    picker: () => {
      picks++;
      return picker;
    },
    client: () => ({ saveViaShare: mobile }),
    share: () => share(),
    download: () => {
      downloads++;
      return true;
    },
    writeToSaveHandle,
  },
});
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/workspace-downloads.ts")) return next(specifier, context);
    let source: string | null = null;
    if (specifier === "./editor/export")
      source =
        "export const encodeExport = (input, signal) => globalThis.launchDownloads.encode(input, signal);";
    if (specifier === "./device")
      source = "export const readClient = () => globalThis.launchDownloads.client();";
    if (specifier === "./clipboard") source = "export const copyPngOrShare = () => {};";
    if (specifier === "./metadata-client")
      source =
        "export const stripExportMetadata = () => globalThis.launchDownloads.strip(); export const cleanedFilename = () => ''; export const downscaleNotice = () => {}; export const stripOriginalMetadata = () => {};";
    if (specifier === "./files")
      source = `
      export const beginSavePicker = () => globalThis.launchDownloads.picker();
      export const canShareFiles = () => true;
      export const shareBlob = () => globalThis.launchDownloads.share();
      export const downloadBlob = () => globalThis.launchDownloads.download();
      export const resultFilename = (name) => name;
      export const isSaveAbort = (e) => e?.name === 'AbortError';
      export const writeToSaveHandle = (...args) => globalThis.launchDownloads.writeToSaveHandle(...args);`;
    if (source)
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return next(`${specifier}.ts`, context);
  },
});
const { downloadActions } = await import("./workspace-downloads.ts");
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
function setup() {
  runtime.job = 1;
  runtime.runAbort = new AbortController();
  encode = async () => encoded;
  strip = async () => blob;
  picker = null;
  share = async () => "unsupported";
  mobile = false;
  downloads = picks = 0;
  let state = {
    items: [
      {
        id: "a",
        source: new File(["source"], "a.png"),
        resultBlob: blob,
        name: "a.png",
        status: "done",
      },
    ],
    activeId: "a",
    settings: { a: { ...defaults } },
    exporting: false,
    saved: false,
    errorMessage: null,
  } as unknown as WorkspaceState;
  const set = (
    patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>),
  ) => {
    state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  };
  const actions = downloadActions(() => state, set);
  const controller = new AbortController();
  let owned = true;
  const launch: LaunchDownload = { signal: controller.signal, isCurrent: () => owned };
  return {
    get: () => state,
    set,
    actions,
    controller,
    launch,
    invalidate: () => {
      owned = false;
      controller.abort();
    },
  };
}
test.beforeEach((t) => {
  if (!("mock" in t)) return;
  Object.assign(globalThis, { window: globalThis });
  t.mock.timers.enable({ apis: ["setTimeout"] });
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, "launchDownloads");
});

test("a manual export saves its captured result and settings when selection changes", async () => {
  const w = setup();
  const original = w.get().items[0]!;
  // Distinct results prevent provenance from an earlier test being relevant.
  const result = new Blob(["first cutout"]);
  const other = { ...original, id: "b", resultBlob: new Blob(["second cutout"]) };
  const firstSettings = w.get().settings.a!;
  w.set({
    items: [{ ...original, resultBlob: result }, other],
    settings: { a: firstSettings, b: { ...defaults } },
  });
  const pending = deferred<typeof encoded>();
  encode = () => pending.promise;
  const exporting = w.actions.downloadActive("png");
  await flush();
  w.set({ activeId: "b" });
  pending.resolve(encoded);
  await exporting;
  assert.equal(w.get().saved, false, "the current image cannot show the first image's save flash");
  assert.equal(hasUnsavedWork(w.get()), true, "the second image is still unsaved");
  w.set({ items: w.get().items.filter((item) => item.id === "a"), activeId: "a" });
  assert.equal(hasUnsavedWork(w.get()), false, "the exported image is saved");
  w.set({ settings: { a: { ...firstSettings, feather: 9 } } });
  assert.equal(hasUnsavedWork(w.get()), true, "later edits are unsaved");
});

test("an edit made during a manual export keeps its warning after that export finishes", async () => {
  const w = setup();
  w.set({ items: w.get().items.map((item) => ({ ...item, resultBlob: new Blob(["cutout"]) })) });
  const pending = deferred<typeof encoded>();
  encode = () => pending.promise;
  const exporting = w.actions.downloadActive("png");
  await flush();
  w.set({ settings: { a: { ...defaults, feather: 6 } } });
  pending.resolve(encoded);
  await exporting;
  assert.equal(hasUnsavedWork(w.get()), true);
  assert.equal(w.get().saved, false);
});

for (const change of ["selection", "source", "settings", "result", "unmount", "away-back", "job"]) {
  test(`launch pending encoding refuses ${change} without stale errors or saved publication`, async () => {
    const w = setup(),
      pending = deferred<typeof encoded>();
    encode = () => pending.promise;
    const running = w.actions.downloadActive("jpeg", w.launch);
    await flush();
    assert.equal(w.get().exporting, true);
    if (change === "selection") w.set({ activeId: "other" });
    if (change === "source" || change === "result")
      w.set({
        items: w.get().items.map((i) => ({
          ...i,
          ...(change === "source"
            ? { source: new File([i.source], "same-id.png") }
            : { resultBlob: new Blob([i.resultBlob!]) }),
        })),
      });
    if (change === "settings") w.set({ settings: { a: { ...defaults } } });
    if (change === "unmount" || change === "away-back") {
      w.invalidate();
      await running;
    }
    if (change === "job") {
      runtime.job++;
      w.set({ exporting: false });
    }
    pending.resolve(encoded);
    await running;
    assert.equal(downloads, 0);
    assert.equal(w.get().saved, false);
    assert.equal(w.get().errorMessage, null);
    assert.equal(w.get().exporting, false);
    assert.equal(runtime.runAbort!.signal.aborted, false, "launch never aborts shared model work");
  });
}
for (const stage of ["encode", "metadata", "picker", "createWritable", "write", "close", "share"]) {
  for (const fails of [false, true])
    test(`cancelled ${stage} ${fails ? "error" : "completion"} cannot save or fall back`, async () => {
      const w = setup(),
        pending = deferred<any>(),
        trace: string[] = [];
      if (stage === "encode") encode = () => pending.promise;
      if (stage === "metadata") {
        w.set({ settings: { a: { ...defaults, stripMetadata: true } } });
        strip = () => pending.promise;
      }
      if (stage === "share") {
        mobile = true;
        share = () => pending.promise;
      }
      const writable = {
        write: async () => {
          trace.push("write");
          if (stage === "write") await pending.promise;
        },
        close: async () => {
          trace.push("close");
          if (stage === "close") await pending.promise;
        },
        abort: async () => {
          trace.push("abort");
        },
      };
      const handle = {
        createWritable: async () => {
          trace.push("create");
          return stage === "createWritable" ? pending.promise : writable;
        },
      };
      if (stage === "picker") picker = pending.promise;
      if (["createWritable", "write", "close"].includes(stage)) picker = Promise.resolve(handle);
      const running = w.actions.downloadActive("jpeg", w.launch);
      await flush();
      w.invalidate();
      await running;
      assert.equal(
        w.get().exporting,
        false,
        "cancel releases action without waiting for native promise",
      );
      w.set({ errorMessage: "newer error" });
      if (fails) pending.reject(new Error("late native failure"));
      else
        pending.resolve(
          stage === "encode"
            ? encoded
            : stage === "metadata"
              ? blob
              : stage === "picker"
                ? handle
                : stage === "createWritable"
                  ? writable
                  : "shared",
        );
      await flush();
      assert.equal(downloads, 0);
      assert.equal(w.get().saved, false);
      assert.equal(w.get().errorMessage, "newer error");
      if (stage === "picker") assert.deepEqual(trace, []);
      if (stage === "createWritable" && !fails) assert.deepEqual(trace, ["create", "abort"]);
      if (stage === "write") assert.deepEqual(trace, ["create", "write", "abort"]);
      // A close/share already dispatched before cancellation cannot be recalled.
      if (stage === "close" && !fails) assert.deepEqual(trace, ["create", "write", "close"]);
    });
}
test("cancelled old action cannot clear a newer action's exporting state", async () => {
  const w = setup(),
    first = deferred<typeof encoded>(),
    second = deferred<typeof encoded>();
  encode = () => first.promise;
  const old = w.actions.downloadActive("jpeg", w.launch);
  await flush();
  runtime.job++;
  w.set({ exporting: false });
  encode = () => second.promise;
  const newer = w.actions.downloadActive("jpeg");
  w.invalidate();
  await old;
  assert.equal(w.get().exporting, true);
  first.resolve(encoded);
  await flush();
  assert.equal(w.get().exporting, true);
  second.resolve(encoded);
  await newer;
  assert.equal(w.get().exporting, false);
  assert.equal(w.get().saved, true);
  assert.equal(downloads, 1);
});
test("manual and healthy owned actions export once, including ordinary share/picker fallbacks", async () => {
  for (const owned of [false, true])
    for (const via of ["download", "picker", "picker-fallback", "share", "share-fallback"]) {
      const w = setup(),
        trace: string[] = [];
      if (via.startsWith("picker"))
        picker =
          via === "picker-fallback"
            ? Promise.reject(new Error("unavailable"))
            : Promise.resolve({
                createWritable: async () => ({
                  write: async () => {
                    trace.push("write");
                  },
                  close: async () => {
                    trace.push("close");
                  },
                }),
              });
      if (via.startsWith("share")) {
        mobile = true;
        share = async () => (via === "share" ? "shared" : "unsupported");
      }
      await w.actions.downloadActive("jpeg", owned ? w.launch : undefined);
      assert.equal(w.get().saved, true, `${owned}/${via}`);
      assert.equal(w.get().exporting, false);
      assert.equal(w.get().errorMessage, null);
      assert.equal(downloads, ["picker", "share"].includes(via) ? 0 : 1);
      if (via === "picker") assert.deepEqual(trace, ["write", "close"]);
    }
});
test("current export errors still publish, and cancelled ownership cannot start a picker", async () => {
  const w = setup();
  encode = async () => {
    throw new Error("encode failed");
  };
  await w.actions.downloadActive("jpeg", w.launch);
  assert.ok(w.get().errorMessage);
  assert.equal(w.get().saved, false);
  w.invalidate();
  await w.actions.downloadActive("jpeg", w.launch);
  assert.equal(picks, 1);
});

async function withoutAny<T>(run: () => Promise<T>) {
  const prior = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  Object.defineProperty(AbortSignal, "any", { configurable: true, value: undefined });
  try {
    return await run();
  } finally {
    if (prior) Object.defineProperty(AbortSignal, "any", prior);
    else Reflect.deleteProperty(AbortSignal, "any");
  }
}
function trackAbort(signal: AbortSignal) {
  const remaining = new Set<object>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  Object.defineProperty(signal, "addEventListener", {
    configurable: true,
    value: (
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | AddEventListenerOptions,
    ) => {
      if (type === "abort") remaining.add(fn);
      return add(type, fn, opts);
    },
  });
  Object.defineProperty(signal, "removeEventListener", {
    configurable: true,
    value: (
      type: string,
      fn: EventListenerOrEventListenerObject,
      opts?: boolean | EventListenerOptions,
    ) => {
      remaining.delete(fn);
      return remove(type, fn, opts);
    },
  });
  return {
    remaining,
    restore() {
      Reflect.deleteProperty(signal, "addEventListener");
      Reflect.deleteProperty(signal, "removeEventListener");
    },
  };
}

test("owned export works when AbortSignal.any is absent, including default manual", async () => {
  await withoutAny(async () => {
    const owned = setup();
    await owned.actions.downloadActive("jpeg", owned.launch);
    assert.equal(downloads, 1);
    assert.equal(owned.get().saved, true);
    assert.equal(owned.get().errorMessage, null);
    assert.equal(owned.get().exporting, false);
    assert.equal(runtime.runAbort!.signal.aborted, false);
    const manual = setup();
    await manual.actions.downloadActive("jpeg");
    assert.equal(downloads, 1);
    assert.equal(manual.get().saved, true);
    assert.equal(manual.get().errorMessage, null);
  });
});

test("a lone launch signal still exports when AbortSignal.any is absent", async () => {
  await withoutAny(async () => {
    const w = setup();
    runtime.runAbort = null;
    await w.actions.downloadActive("jpeg", w.launch);
    assert.equal(downloads, 1);
    assert.equal(w.get().saved, true);
    assert.equal(w.get().errorMessage, null);
  });
});

for (const source of ["launch", "shared"] as const) {
  test(`${source} pre-abort cancels owned export without AbortSignal.any`, async () => {
    await withoutAny(async () => {
      const w = setup();
      const reason = new Error(`${source} already gone`);
      if (source === "launch") w.controller.abort(reason);
      else runtime.runAbort!.abort(reason);
      await w.actions.downloadActive("jpeg", w.launch);
      assert.equal(downloads, 0);
      assert.equal(w.get().saved, false);
      assert.equal(w.get().exporting, false);
      assert.equal(w.get().errorMessage, null);
      assert.equal(runtime.runAbort!.signal.aborted, source === "shared");
      assert.equal(w.controller.signal.aborted, source === "launch");
    });
  });
  test(`${source} live abort keeps its reason and first-abort without AbortSignal.any`, async () => {
    await withoutAny(async () => {
      const w = setup(),
        pending = deferred<typeof encoded>();
      let received: AbortSignal | undefined;
      encode = (_input, signal) => {
        received = signal;
        return pending.promise;
      };
      const first = new Error(`${source} first`);
      const second = new Error(`${source} second`);
      const running = w.actions.downloadActive("jpeg", w.launch);
      await flush();
      assert.equal(w.get().exporting, true);
      if (source === "launch") {
        w.controller.abort(first);
        runtime.runAbort!.abort(second);
      } else {
        runtime.runAbort!.abort(first);
        w.controller.abort(second);
      }
      await running;
      assert.equal(downloads, 0);
      assert.equal(w.get().saved, false);
      assert.equal(w.get().errorMessage, null);
      assert.equal(w.get().exporting, false);
      assert.equal(received?.aborted, true);
      assert.equal(received?.reason, first);
      pending.resolve(encoded);
      await flush();
      assert.equal(downloads, 0);
      assert.equal(w.get().saved, false);
    });
  });
}

for (const exit of ["success", "error", "cancel"] as const)
  test(`${exit} removes abort listeners when AbortSignal.any is absent`, async () => {
    await withoutAny(async () => {
      const w = setup(),
        pending = deferred<typeof encoded>();
      const launch = trackAbort(w.launch.signal),
        shared = trackAbort(runtime.runAbort!.signal);
      try {
        if (exit === "error")
          encode = async () => {
            throw new Error("encode failed");
          };
        else encode = () => pending.promise;
        const running = w.actions.downloadActive("jpeg", w.launch);
        await flush();
        if (exit === "cancel") {
          w.invalidate();
          await running;
          pending.resolve(encoded);
        } else if (exit === "success") {
          pending.resolve(encoded);
          await running;
        } else await running;
        await flush();
        assert.equal(launch.remaining.size, 0);
        assert.equal(shared.remaining.size, 0);
        if (exit === "success") {
          assert.equal(downloads, 1);
          assert.equal(w.get().saved, true);
        } else {
          assert.equal(downloads, 0);
          assert.equal(w.get().saved, false);
        }
      } finally {
        launch.restore();
        shared.restore();
      }
    });
  });

for (const stage of ["encode", "picker", "share"] as const)
  test(`held ${stage} cancel still gates save when AbortSignal.any is absent`, async () => {
    await withoutAny(async () => {
      const w = setup(),
        pending = deferred<any>(),
        trace: string[] = [];
      if (stage === "encode") encode = () => pending.promise;
      if (stage === "share") {
        mobile = true;
        share = () => pending.promise;
      }
      if (stage === "picker") picker = pending.promise;
      const running = w.actions.downloadActive("jpeg", w.launch);
      await flush();
      w.invalidate();
      await running;
      assert.equal(w.get().exporting, false);
      pending.resolve(
        stage === "encode"
          ? encoded
          : stage === "share"
            ? "shared"
            : {
                createWritable: async () => {
                  trace.push("create");
                  return {
                    write: async () => {
                      trace.push("write");
                    },
                    close: async () => {
                      trace.push("close");
                    },
                    abort: async () => {
                      trace.push("abort");
                    },
                  };
                },
              },
      );
      await flush();
      assert.equal(downloads, 0);
      assert.equal(w.get().saved, false);
      assert.equal(w.get().errorMessage, null);
      if (stage === "picker") assert.deepEqual(trace, []);
    });
  });

test("cancelled old action cannot clear a newer action when AbortSignal.any is absent", async () => {
  await withoutAny(async () => {
    const w = setup(),
      first = deferred<typeof encoded>(),
      second = deferred<typeof encoded>();
    encode = () => first.promise;
    const old = w.actions.downloadActive("jpeg", w.launch);
    await flush();
    runtime.job++;
    w.set({ exporting: false });
    encode = () => second.promise;
    const newer = w.actions.downloadActive("jpeg");
    w.invalidate();
    await old;
    assert.equal(w.get().exporting, true);
    first.resolve(encoded);
    await flush();
    assert.equal(w.get().exporting, true);
    second.resolve(encoded);
    await newer;
    assert.equal(w.get().exporting, false);
    assert.equal(w.get().saved, true);
    assert.equal(downloads, 1);
  });
});
