import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";
import { finishShare, requestShare, useShareReady } from "../../lib/share-ready.ts";
import { shareFiles } from "../../lib/sharing.ts";

type Element = {
  props: { children?: Element | Element[]; onClick?: () => void | Promise<void> };
  type: unknown;
};
let onDownload: (() => boolean) | undefined;
let changes: unknown[] = [],
  downloads = 0,
  calls = 0;
let effect!: () => () => void, cleanup!: () => void;
const boundary = {
  useShareReady: () => useShareReady.getState().pending,
  useEffect: (fn: typeof effect) => {
    effect = fn;
    cleanup = fn();
  },
  useRef: () => ({ current: false }),
  useState: (value: unknown) => [value, (next: unknown) => changes.push(next)],
  download: () => {
    downloads++;
    return onDownload ? onDownload() : true;
  },
};
Object.assign(globalThis, { launchShareDialog: boundary });
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (!context.parentURL?.endsWith("/share-ready-dialog.tsx")) return next(specifier, context);
    let source: string | null = null;
    if (specifier === "react")
      source = "export const { useEffect, useRef, useState } = globalThis.launchShareDialog;";
    if (specifier === "@/lib/share-ready")
      source = `export * from '${new URL("../../lib/share-ready.ts", import.meta.url).href}'; export const useShareReady = globalThis.launchShareDialog.useShareReady;`;
    if (specifier === "@/lib/files")
      source =
        "export const downloadBlob = globalThis.launchShareDialog.download; export const isSaveAbort = e => e?.name === 'AbortError';";
    if (specifier === "@/components/ui/button") source = "export const Button = 'button';";
    if (specifier === "./editor-dialog") source = "export const EditorDialog = 'dialog';";
    if (source)
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith("/share-ready-dialog.tsx")) return next(url, context);
    return {
      format: "module",
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
        },
      }).outputText,
      shortCircuit: true,
    };
  },
});
const { ShareReadyDialog } = await import("./share-ready-dialog.tsx");
const files = [new File(["real files"], "result.png", { type: "image/png" })];
function buttons(node: Element): Element[] {
  if (!node || typeof node !== "object") return [];
  const children = node.props?.children;
  return [
    ...(node.type === "button" ? [node] : []),
    ...[children].flat().flatMap((child) => buttons(child as Element)),
  ];
}
function render() {
  changes = [];
  return buttons(ShareReadyDialog() as unknown as Element).map((button) => button.props.onClick!);
}
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
test.beforeEach(() => {
  downloads = calls = 0;
  onDownload = undefined;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      canShare: () => true,
      userActivation: { isActive: true },
      share: () => {
        calls++;
        return Promise.resolve();
      },
    },
  });
});
test.after(() => {
  hooks.deregister();
  Reflect.deleteProperty(globalThis, "launchShareDialog");
});

test("captured Share and Download handlers refuse cancelled or replaced requests before rerender", async () => {
  for (const change of ["cancel", "replace"]) {
    const controller = new AbortController(),
      old = requestShare(files, controller.signal);
    const [share, download] = render();
    changes = [];
    let newer: Promise<unknown> | undefined;
    if (change === "cancel") controller.abort();
    else newer = requestShare(files);
    await share();
    download();
    assert.equal(calls, 0);
    assert.equal(downloads, 0);
    assert.deepEqual(changes, []);
    assert.equal(await old, "aborted");
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    if (newer) {
      const pending = useShareReady.getState().pending!;
      finishShare(pending, "aborted");
      await newer;
    }
  }
});
test("dispatched native Share completion/error cannot affect a replacement dialog", async () => {
  for (const outcome of ["success", "error"]) {
    const controller = new AbortController(),
      old = requestShare(files, controller.signal),
      held = deferred();
    navigator.share = () => {
      calls++;
      return held.promise;
    };
    const [share] = render(),
      running = share();
    assert.equal(calls, 1, "native call remains synchronous in the activation handler");
    controller.abort();
    const newer = requestShare(files);
    render();
    changes = [];
    if (outcome === "success") held.resolve();
    else held.reject(new Error("late native failure"));
    await running;
    assert.deepEqual(changes, []);
    assert.equal(await old, "aborted");
    const pending = useShareReady.getState().pending!;
    assert.ok(pending);
    finishShare(pending, "aborted");
    await newer;
    calls = 0;
  }
});
test("ordinary manual dialog Share/Download, error and StrictMode semantics remain", async () => {
  const pending = requestShare(files);
  const [share] = render();
  cleanup();
  cleanup = effect();
  await Promise.resolve();
  assert.ok(useShareReady.getState().pending, "StrictMode cleanup/setup does not abort");
  await share();
  assert.equal(calls, 1);
  assert.equal(await pending, "shared");
  const next = requestShare(files);
  const [, download] = render();
  download();
  assert.equal(downloads, 1);
  assert.equal(await next, "downloaded");
  const failed = requestShare(files);
  const [tryShare] = render();
  navigator.share = async () => {
    throw new Error("unavailable");
  };
  await tryShare();
  assert.ok(changes.includes("Sharing is unavailable. You can download the file instead."));
  cleanup();
  await Promise.resolve();
  assert.equal(await failed, "aborted", "actual unmount still cancels");
});
test("shareFiles cancels pending activation fallback and late NotAllowed fallback without reviving a request", async () => {
  const controller = new AbortController();
  Object.assign(navigator, { userActivation: { isActive: false } });
  const pending = shareFiles(files, controller.signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(useShareReady.getState().pending);
  controller.abort();
  assert.equal(await pending, "aborted");
  assert.equal(useShareReady.getState().pending, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  Object.assign(navigator, { userActivation: { isActive: true } });
  const held = deferred(),
    other = new AbortController();
  navigator.share = () => held.promise;
  const late = shareFiles(files, other.signal);
  other.abort();
  held.reject(Object.assign(new Error("activation expired"), { name: "NotAllowedError" }));
  assert.equal(await late, "aborted");
  assert.equal(useShareReady.getState().pending, null);
});
test("cancellation during activation-module import cannot create a pending request", async () => {
  Object.assign(navigator, { userActivation: { isActive: false } });
  const controller = new AbortController(),
    pending = shareFiles(files, controller.signal);
  controller.abort();
  assert.equal(await pending, "aborted");
  assert.equal(useShareReady.getState().pending, null);
});

test("replacing an older pending share cannot publish an already cancelled launch request", async () => {
  const older = requestShare(files),
    controller = new AbortController();
  const stop = useShareReady.subscribe((next, old) => {
    if (old.pending && !next.pending) controller.abort();
  });
  assert.equal(await requestShare(files, controller.signal), "aborted");
  assert.equal(await older, "aborted");
  assert.equal(useShareReady.getState().pending, null);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  stop();
});

test("a dispatched Download cannot publish an error after its request is replaced", async () => {
  const old = requestShare(files);
  const [, download] = render();
  let newer!: Promise<unknown>;
  onDownload = () => {
    newer = requestShare(files);
    return false;
  };
  changes = [];
  download();
  assert.deepEqual(changes, []);
  assert.equal(downloads, 1);
  assert.equal(await old, "aborted");
  finishShare(useShareReady.getState().pending!, "aborted");
  await newer;
});
