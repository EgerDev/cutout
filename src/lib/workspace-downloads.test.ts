import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { CutoutError, messageFor } from "./errors.ts";
import { hasUnsavedWork } from "./workspace-saved.ts";
import type { WorkspaceState } from "./workspace-types.ts";
import { defaults } from "./editor/model.ts";

// Keep real downloadActions control flow; replace browser effects and rendering only.
test("download/copy/share preserve safe export refusals without saved state (p1-pixels follow-up)", async (t) => {
  const item = {
    id: "one",
    name: "test.png",
    source: new File([], "test.png"),
    resultBlob: new Blob(),
  };
  let state = {
    items: [item],
    activeId: item.id,
    exporting: false,
    copying: false,
    saved: false,
    copied: false,
    errorMessage: null as string | null,
  };
  let encodeError: unknown;
  let downloads = 0,
    shares = 0,
    copies = 0;
  let saveViaShare = false;
  const settings: WorkspaceState["settings"][string] = {
    ...defaults,
    exportFormat: "heic",
    stripMetadata: false,
    background: { type: "transparent" },
  };
  const runtime = { job: 1, runAbort: new AbortController() };
  const globals = globalThis as typeof globalThis & { downloadTest?: unknown };
  globals.downloadTest = {
    runtime,
    settings,
    encode: async () => {
      if (encodeError) throw encodeError;
      return { blob: new Blob(["healthy"]), metTarget: true };
    },
    client: () => ({ saveViaShare }),
    download: () => {
      downloads++;
      return true;
    },
    share: async () => {
      shares++;
      return "shared";
    },
    copy: async (source: Promise<Blob>) => {
      try {
        await source;
        copies++;
        return "copied";
      } catch {
        return "failed";
      }
    },
  };
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { clearTimeout() {}, setTimeout: () => 1 },
  });
  const stubs: Record<string, string> = {
    "./workspace-runtime": "export const runtime = globalThis.downloadTest.runtime",
    "./clipboard": "export const copyPngOrShare = globalThis.downloadTest.copy",
    "./editor/export": "export const encodeExport = globalThis.downloadTest.encode",
    "./editor/state": "export const activeSettings = () => globalThis.downloadTest.settings",
    "./device": "export const readClient = globalThis.downloadTest.client",
    "./files":
      "export const beginSavePicker=()=>null,canShareFiles=()=>true,downloadBlob=globalThis.downloadTest.download,shareBlob=globalThis.downloadTest.share,resultFilename=()=> 'test.heic',isSaveAbort=e=>e?.name==='AbortError',writeToSaveHandle=async()=>{}",
    "./metadata-client":
      "export const stripExportMetadata=async b=>b,stripOriginalMetadata=async b=>b,cleanedFilename=()=>'',downscaleNotice=async()=>null",
  };
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL?.includes("/workspace-downloads.ts?")) {
        if (stubs[specifier])
          return {
            shortCircuit: true,
            url: `data:text/javascript,${encodeURIComponent(stubs[specifier]!)}`,
          };
        return next(specifier + ".ts", context);
      }
      return next(specifier, context);
    },
  });
  t.after(() => {
    hook.deregister();
    delete globals.downloadTest;
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const { downloadActions } = await import(String("./workspace-downloads.ts?refusal"));
  const actions = downloadActions(
    () => state,
    (partial: Partial<typeof state>) => {
      state = { ...state, ...partial };
    },
  );
  const specific = "This browser wrote a broken HEIC file. Choose PNG.";
  for (const error of [
    new CutoutError("export", specific, false),
    new CutoutError(
      "export",
      "This browser cannot preserve transparency in AVIF. Choose PNG.",
      false,
    ),
    new Error("private encoder internals"),
  ]) {
    encodeError = error;
    for (const viaShare of [false, true]) {
      saveViaShare = viaShare;
      await actions.downloadActive("heic");
      assert.equal(
        state.errorMessage,
        error instanceof CutoutError ? error.message : messageFor("export"),
      );
      assert.equal(state.exporting, false);
    }
    await actions.copyActive();
    assert.equal(
      state.errorMessage,
      error instanceof CutoutError ? error.message : messageFor("copy"),
    );
    assert.equal(state.copying, false);
    assert.equal(state.saved, false);
    assert.equal(state.copied, false);
  }
  assert.deepEqual([downloads, shares, copies], [0, 0, 0]);
  const unsaved = () =>
    hasUnsavedWork({
      items: [{ ...item, status: "done" }] as WorkspaceState["items"],
      settings: { one: settings } as WorkspaceState["settings"],
    });
  assert.equal(unsaved(), true);
  await actions.downloadOriginal();
  assert.equal(downloads, 1);
  assert.equal(state.saved, false);
  assert.equal(unsaved(), true, "saving the original does not save the cutout");
  downloads = 0;
  runtime.runAbort.abort();
  state.errorMessage = null;
  await actions.downloadActive("heic");
  assert.equal(state.errorMessage, null, "aborted runs do not replace error state");
  runtime.runAbort = new AbortController();
  encodeError = null;
  saveViaShare = false;
  await actions.downloadActive("heic");
  assert.equal(downloads, 1);
  assert.equal(state.saved, true);
  assert.equal(state.errorMessage, null);
  saveViaShare = true;
  await actions.downloadActive("heic");
  assert.equal(shares, 1);
  await actions.copyActive();
  assert.equal(copies, 1);
  assert.equal(state.copied, true);
});
