import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import type { WorkspaceState } from "./workspace-types.ts";
import { runtime } from "./workspace-runtime.ts";
import { editorDefaults } from "./editor/state.ts";
import { planIngest } from "./files.ts";
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (
      context.parentURL?.includes("workspace-ingest.ts") &&
      ["./workspace-queue.ts", "./editor/canvas.ts"].includes(specifier)
    )
      return {
        url: `data:text/javascript,${encodeURIComponent("export const runQueue = async () => {}; export const clearSourceBitmapCache = () => {};")}`,
        shortCircuit: true,
      };
    return next(specifier, context);
  },
});
const { ingestFiles } = await import("./workspace-ingest.ts");
const jpeg = readFileSync(new URL("./fixtures/gps.jpg", import.meta.url));
function workspace() {
  let state = {
    ...editorDefaults,
    items: [],
    activeId: null,
    phase: "idle",
    removalMode: "auto",
  } as unknown as WorkspaceState;
  return {
    get: () => state,
    set: (patch: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>)) => {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    },
  };
}
test("ingest receipt identifies published converted source and returns null for empty/refused/superseded work", async () => {
  const { get, set } = workspace();
  const input = new File([jpeg], "photo.jpg", { type: "image/pjpeg" });
  const receipt = await ingestFiles([input], get, set);
  assert.ok(receipt);
  assert.equal(receipt.job, runtime.job);
  assert.equal(receipt.drop, runtime.drop);
  assert.equal(receipt.items[0]!.id, get().activeId);
  assert.equal(receipt.items[0]!.source, get().items[0]!.source);
  assert.notEqual(receipt.items[0]!.source, input, "signature retyping changes File identity");
  assert.equal(receipt.items[0]!.source.type, "image/jpeg");
  assert.equal(await ingestFiles([], get, set), null);
  assert.equal(
    await ingestFiles([new File(["invalid"], "bad.png", { type: "image/png" })], get, set),
    null,
  );
  const first = ingestFiles([input], get, set);
  const second = ingestFiles([new File([jpeg], "latest.jpg", { type: "image/jpeg" })], get, set);
  assert.equal(await first, null);
  const latest = await second;
  assert.ok(latest);
  assert.equal(latest.items[0]!.source.name, "latest.jpg");
  const stale = ingestFiles([input], get, set);
  runtime.job++;
  assert.equal(await stale, null);
  for (const entry of get().items) URL.revokeObjectURL(entry.sourceUrl);
});
test.after(() => hooks.deregister());

test("F3: rasterization failures use classified copy, with the ingest plan as fallback", async () => {
  for (const reason of [
    new DOMException("The source image could not be decoded.", "InvalidStateError"),
    "internal rasterizer failure",
  ]) {
    class FailedFile extends File {
      slice(start?: number, end?: number, contentType?: string) {
        const blob = super.slice(start, end, contentType);
        blob.arrayBuffer = async () => {
          throw reason;
        };
        return blob;
      }
    }
    const files = Array.from(
      { length: 16 },
      (_, index) => new FailedFile(["invalid"], `drawing-${index}.svg`, { type: "image/svg+xml" }),
    );
    const { get, set } = workspace();
    assert.equal(await ingestFiles(files, get, set), null);
    assert.equal(
      get().errorMessage,
      reason instanceof Error
        ? "This image is damaged or in a format this browser can’t read."
        : planIngest(files).errorMessage,
    );
    assert.equal(get().phase, "idle");
    assert.deepEqual(get().items, []);
  }
});

test("a cancelled linked ingest cannot publish after held source validation", async () => {
  const { get, set } = workspace();
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  class HeldFile extends File {
    slice(start?: number, end?: number, contentType?: string) {
      const blob = super.slice(start, end, contentType);
      const arrayBuffer = blob.arrayBuffer.bind(blob);
      blob.arrayBuffer = async () => {
        await held;
        return arrayBuffer();
      };
      return blob;
    }
  }
  const input = new HeldFile([jpeg], "linked.jpg", { type: "image/jpeg" });
  const old = new File([jpeg], "user.jpg", { type: "image/jpeg" });
  set({
    items: [{ id: "user", source: old }] as WorkspaceState["items"],
    activeId: "user",
    phase: "result",
  });
  const running = ingestFiles([input], get, set, controller.signal);
  controller.abort();
  release();
  assert.equal(await running, null);
  assert.equal(get().items[0]!.source, old);
  assert.equal(get().activeId, "user");
  assert.equal(get().phase, "result");
});
