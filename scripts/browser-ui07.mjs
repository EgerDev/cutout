// Native UI-07 controls. APP_URL and DEV_URL must identify this task's server.
// WebKit needs a new persistent profile for genuine Blob IndexedDB persistence.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { test as nodeTest } from "node:test";
import { webkit } from "playwright";
import { launchChrome, tolerantTest } from "./chrome.mjs";

// A "… in webkit" test skips if Linux WPE WebKit crashes.
const test = tolerantTest(nodeTest, (name) => name.endsWith(" in webkit"));
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates());
async function poll(page, predicate, arg) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("UI-07 poll timed out");
}
async function fixture(engine, run) {
  let browser, context;
  if (engine === "webkit") {
    assert.ok(process.env.CUTOUT_BROWSER_PROFILE, "provide task-owned profile root");
    const profile = await mkdtemp(join(process.env.CUTOUT_BROWSER_PROFILE, "ui07-"));
    context = await webkit.launchPersistentContext(profile, { headless: true });
  } else {
    browser = await launchChrome({ bypassCSP: false });
    context = await browser.newContext({ bypassCSP: false, acceptDownloads: true });
  }
  const errors = [];
  let page;
  try {
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
      window.guardListeners = new Set();
      const add = window.addEventListener,
        remove = window.removeEventListener;
      window.addEventListener = function (type, fn, ...rest) {
        if (type === "beforeunload") window.guardListeners.add(fn);
        return add.call(this, type, fn, ...rest);
      };
      window.removeEventListener = function (type, fn, ...rest) {
        if (type === "beforeunload") window.guardListeners.delete(fn);
        return remove.call(this, type, fn, ...rest);
      };
    });
    await page.goto(e2eUrl(appUrl), { waitUntil: "domcontentloaded" });
    await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace));
    await page.evaluate(() => {
      window.idleGuardCount = window.guardListeners.size;
    });
    await run(page, context);
    assert.deepEqual(errors, []);
  } catch (error) {
    let diagnosticTimer;
    const state = await Promise.race([
      page
        ?.evaluate(() => {
          const state = window.__cutoutTest?.useWorkspace.getState();
          return {
            phase: state?.phase,
            activeId: state?.activeId,
            progress: state?.progress,
            errorMessage: state?.errorMessage,
            items: state?.items.map(({ id, status, error, width, height }) => ({
              id,
              status,
              error,
              width,
              height,
            })),
            toolbars: document.querySelectorAll('[role="toolbar"][aria-label="Image actions"]')
              .length,
          };
        })
        .catch((failure) => ({ unavailable: String(failure) })),
      new Promise((resolve) => {
        diagnosticTimer = setTimeout(
          () => resolve({ unavailable: "diagnostic read timed out" }),
          1000,
        );
      }),
    ]).finally(() => clearTimeout(diagnosticTimer));
    // Preserve the original exception: a later diagnostic closure is not evidence
    // that the failed operation was a WebKit crash.
    console.error(`UI-07 ${engine} failure state: ${JSON.stringify({ state, errors })}`);
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
  }
}
async function graphic(page, count = 1) {
  const accepted = await page.evaluate(async (count) => {
    const c = document.createElement("canvas");
    c.width = c.height = 48;
    const x = c.getContext("2d");
    x.fillStyle = "white";
    x.fillRect(0, 0, 48, 48);
    x.fillStyle = "black";
    x.fillRect(12, 12, 24, 24);
    const blob = await new Promise((resolve) => c.toBlob(resolve));
    const receipt = await window.__cutoutTest.useWorkspace
      .getState()
      .receiveFiles(
        Array.from(
          { length: count },
          (_, i) => new File([blob], `graphic-${i}.png`, { type: "image/png" }),
        ),
      );
    return receipt?.items.length ?? 0;
  }, count);
  assert.equal(accepted, count, "UI-07 graphic ingestion must accept every fixture image");
  await poll(
    page,
    (count) => {
      const state = window.__cutoutTest.useWorkspace.getState();
      const failed = state.items.find((item) => item.status === "error");
      if (failed) throw new Error(`UI-07 graphic processing failed: ${failed.error}`);
      return state.items.length === count && state.items.every((item) => item.status === "done");
    },
    count,
  );
  await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
}
async function guard(page, expected, reason) {
  assert.equal(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
    expected,
    reason,
  );
  assert.equal(
    await page.evaluate(() => window.guardListeners.size - window.idleGuardCount),
    expected ? 1 : 0,
    "only one guard while dirty, none while idle/saved",
  );
}
async function dialog(page) {
  await page
    .locator(".header-label-full")
    .filter({ hasText: /^(Save|Saved) workspace$/ })
    .click();
  return page.getByRole("dialog", { name: "Saved workspace" });
}
async function closeDialog(page) {
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
}
async function save(page, pause = true) {
  const d = await dialog(page);
  await d.getByRole("button", { name: /Enable local autosave|Save now/, exact: true }).click();
  await d.getByText("Saved on this device.", { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("cutout-workspace", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        const stored = await new Promise((resolve, reject) => {
          const r = db.transaction("sessions").objectStore("sessions").get("current");
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        return (
          stored.items.every((i) => i.source instanceof Blob && i.result instanceof Blob) &&
          (await stored.items[0].source.arrayBuffer()).byteLength > 0 &&
          (await stored.items[0].result.arrayBuffer()).byteLength > 0
        );
      } finally {
        db.close();
      }
    }),
    "the native database stores recoverable real source and result Blob bytes",
  );
  if (pause) await d.getByRole("button", { name: "Pause autosave" }).click();
  await closeDialog(page);
  await guard(page, false, "real local save covers the current result/settings");
}
async function workspaceBytes(page) {
  return page.evaluate(async () => {
    const state = window.__cutoutTest.useWorkspace.getState();
    const hash = async (blob) => {
      if (!blob) return null;
      const bytes = await blob.arrayBuffer();
      return {
        size: bytes.byteLength,
        hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join(""),
      };
    };
    return Promise.all(
      state.items.map(async (item) => ({
        name: item.source.name,
        type: item.source.type,
        source: await hash(item.source),
        result: await hash(item.resultBlob),
        background: await hash(state.settings[item.id].backgroundBlob),
      })),
    );
  });
}

async function clear(page) {
  const d = await dialog(page);
  page.once("dialog", (confirmation) => confirmation.accept());
  await d
    .getByRole("button", { name: /Delete saved workspace|Clear local workspace data/ })
    .click();
  await d.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
  await closeDialog(page);
  // Native file backing must survive collection of the deleted saved snapshot too.
  await page.requestGC();
}
async function edit(page, patch) {
  await page.evaluate(
    (patch) => window.__cutoutTest.useWorkspace.getState().changeEdit(patch),
    patch,
  );
}
async function exportFile(page, kind) {
  const download = page.waitForEvent("download");
  if (kind === "download")
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadActive());
  else {
    await page.getByRole("button", { name: /^Batch/ }).click();
    await page
      .getByRole("dialog", { name: "Batch images" })
      .getByRole("button", {
        name: kind === "ZIP" ? "Download all ZIP" : "Sprite sheet + JSON",
        exact: true,
      })
      .click();
  }
  const file = await download;
  assert.equal(await file.failure(), null);
  if (kind !== "download") await closeDialog(page);
  await guard(page, false, `${kind} actual export marks its results saved`);
}

test("UI-07 setup reports refused ingestion without waiting for an absent toolbar", async () =>
  fixture("chromium", async (page) => {
    await page.evaluate(() => {
      window.__cutoutTest.useWorkspace.setState({
        receiveFiles: async () => {
          // Keep the store empty through several polling turns: [].every(done) is true.
          await new Promise((resolve) => setTimeout(resolve, 150));
          return null;
        },
      });
    });
    await assert.rejects(graphic(page), /graphic ingestion must accept every fixture image/);
  }));

test("UI-07 setup reports a failed image before waiting for its toolbar", async () =>
  fixture("chromium", async (page) => {
    await page.evaluate(() => {
      const store = window.__cutoutTest.useWorkspace;
      const receiveFiles = store.getState().receiveFiles;
      store.setState({
        receiveFiles: async (files) => {
          const receipt = await receiveFiles(files);
          // Stop real work first so it cannot overwrite the terminal fixture error.
          store.getState().cancelProcessing();
          store.setState({
            items: store.getState().items.map((item) => ({
              ...item,
              status: "error",
              error: "fixture decoder failed",
            })),
          });
          return receipt;
        },
      });
    });
    await assert.rejects(graphic(page), /graphic processing failed: fixture decoder failed/);
  }));

for (const engine of ["chromium", "webkit"]) {
  test(`UI-07 local save/resume/delete/resave and edit/undo in ${engine}`, async () =>
    fixture(engine, async (page) => {
      await guard(page, false);
      await graphic(page);
      const bytes = await workspaceBytes(page);
      await guard(page, true);
      await save(page);
      await page.reload();
      await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace));
      await page.evaluate(() => {
        window.idleGuardCount = window.guardListeners.size;
      });
      const d = await dialog(page);
      await d.getByRole("button", { name: "Resume saved workspace" }).click();
      await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
      await guard(page, false, "resume covers actual recovered Blobs");
      await edit(page, { feather: 2 });
      await guard(page, true);
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
      await guard(page, false, "undo returns to saved settings identity");
      await clear(page);
      assert.deepEqual(await workspaceBytes(page), bytes, "delete retains byte-exact open data");
      await guard(page, true, "native success removes the only saved copy");
      await save(page);
      await clear(page);
      await guard(page, true, "a repeated save/delete has the same contract");
    }));

  for (const mutation of ["delete", "autosave"])
    test(`UI-07 resumed disk-backed data survives ${mutation} in ${engine}`, async () =>
      fixture(engine, async (page) => {
        await graphic(page, 2);
        // PNG trailing bytes keep the pixels unchanged while forcing native IDB file backing.
        await page.evaluate(() => {
          const store = window.__cutoutTest.useWorkspace;
          const state = store.getState();
          const padding = new Uint8Array(2_000_000);
          padding.fill(173);
          const background = new Blob([state.items[0].source, padding], { type: "image/png" });
          store.setState({
            items: state.items.map((item) => ({
              ...item,
              source: new File([item.source, padding], item.source.name, {
                type: item.source.type,
              }),
              resultBlob: new Blob([item.resultBlob, padding], { type: item.resultBlob.type }),
            })),
            settings: Object.fromEntries(
              state.items.map((item) => [
                item.id,
                {
                  ...state.settings[item.id],
                  backgroundBlob: background,
                },
              ]),
            ),
          });
        });
        const bytes = await workspaceBytes(page);
        assert.ok(
          bytes.every((item) => item.source.size > 2_000_000 && item.result.size > 2_000_000),
        );
        await save(page);
        await page.reload();
        await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace));
        await page.evaluate(() => {
          window.idleGuardCount = window.guardListeners.size;
        });
        const d = await dialog(page);
        await d.getByRole("button", { name: "Resume saved workspace" }).click();
        await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
        // Do not read the restored Blobs before mutation: that can warm their native backing.
        if (mutation === "delete") await clear(page);
        else {
          await save(page, false);
          const savedDialog = await dialog(page);
          await edit(page, { feather: 2 });
          await savedDialog.getByText("Unsaved changes…", { exact: true }).waitFor();
          await savedDialog.getByText("Saved on this device.", { exact: true }).waitFor();
          await closeDialog(page);
          await page.requestGC();
        }
        assert.deepEqual(await workspaceBytes(page), bytes, `${mutation} retains exact bytes`);
        await save(page);
      }));

  test(`UI-07 one blocked native delete invalidates on Guide only after success in ${engine}`, async () =>
    fixture(engine, async (page) => {
      await graphic(page);
      await save(page);
      await page.evaluate(async () => {
        window.foreignDb = await new Promise((resolve, reject) => {
          const r = indexedDB.open("cutout-workspace", 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        const native = IDBFactory.prototype.deleteDatabase;
        window.deletes = [];
        IDBFactory.prototype.deleteDatabase = function (...args) {
          window.deletes.push("request");
          const r = native.apply(this, args);
          r.addEventListener("success", () => window.deletes.push("success"));
          r.addEventListener("blocked", () => window.deletes.push("blocked"));
          return r;
        };
      });
      const d = await dialog(page);
      for (let i = 0; i < 4; i++) {
        page.once("dialog", (confirmation) => confirmation.accept());
        const button = d.getByRole("button", { name: "Delete saved workspace" });
        await button.click();
        await d.getByText(/Could not delete/).waitFor();
        await poll(
          page,
          () =>
            !document.querySelector('[role="dialog"] button[disabled]') ||
            [...document.querySelectorAll('[role="dialog"] button')].some(
              (b) => b.textContent === "Delete saved workspace" && !b.disabled,
            ),
        );
        assert.equal(await button.isEnabled(), true);
        await guard(page, false, "blocked retries retain the stored copy");
      }
      assert.deepEqual(await page.evaluate(() => window.deletes), ["request", "blocked"]);
      await closeDialog(page);
      await page.getByRole("link", { name: "Guide", exact: true }).first().click();
      await page.waitForURL(/\/guide$/);
      await page.evaluate(() => window.foreignDb.close());
      await poll(page, () => window.deletes.includes("success"));
      await guard(page, true, "eventual native success re-arms the permanent guard on Guide");
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);
      let prompted = false;
      const handler = (d) => {
        prompted = d.type() === "beforeunload";
        void d.dismiss();
      };
      page.on("dialog", handler);
      await page.reload({ timeout: 2000 }).catch(() => {});
      page.off("dialog", handler);
      assert.equal(prompted, true, "native reload is guarded on Guide");
      await page.getByRole("link", { name: "Back to Cutout" }).click();
      await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
      await guard(page, true, "route remount retains exactly one guard");
      await save(page);
      await guard(page, false, "resaving after late success restores local provenance");
    }));

  test(`UI-07 eventual deletion error and unstarted/failed exports retain the guard contract in ${engine}`, async () =>
    fixture(engine, async (page) => {
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadActive());
      await graphic(page);
      await guard(page, true, "an unstarted export saved nothing");
      await page.evaluate(async () => {
        window.showSaveFilePicker = () =>
          Promise.reject(new DOMException("cancelled", "AbortError"));
        await window.__cutoutTest.useWorkspace.getState().downloadActive();
        delete window.showSaveFilePicker;
      });
      await guard(page, true, "a cancelled picker saved nothing");
      await page.evaluate(async () => {
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = () => {
          throw new Error("controlled download failure");
        };
        try {
          await window.__cutoutTest.useWorkspace.getState().downloadActive();
        } finally {
          HTMLAnchorElement.prototype.click = click;
        }
      });
      await guard(page, true, "a failed download saved nothing");
      await save(page);
      // Controlled native-request error, while the real stored Blob copy stays intact.
      // Real storage-device errors cannot be reliably induced by a browser test.
      await page.evaluate(() => {
        window.nativeDelete = IDBFactory.prototype.deleteDatabase;
        IDBFactory.prototype.deleteDatabase = () => {
          const r = (window.failedDelete = {});
          queueMicrotask(() => r.onblocked?.());
          return r;
        };
      });
      const d = await dialog(page);
      page.once("dialog", (confirmation) => confirmation.accept());
      await d.getByRole("button", { name: "Delete saved workspace" }).click();
      await d.getByText(/Could not delete/).waitFor();
      await guard(page, false);
      await page.evaluate(() => {
        window.failedDelete.error = new DOMException("controlled failure", "UnknownError");
        window.failedDelete.onerror();
        IDBFactory.prototype.deleteDatabase = window.nativeDelete;
      });
      await guard(page, false, "eventual error preserves the still-stored local copy");
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), "1");
      await closeDialog(page);
      await clear(page);
      await guard(page, true, "a later native success still invalidates");
    }));

  for (const kind of ["download", "ZIP", "sheet"]) {
    test(`UI-07 external ${kind} survives local deletion and stale exported settings do not in ${engine}`, async () =>
      fixture(engine, async (page) => {
        await graphic(page);
        await exportFile(page, kind);
        await save(page);
        await clear(page);
        await guard(page, false, "deletion preserves independent external provenance");
        await edit(page, { feather: 3 });
        await guard(page, true);
        await save(page);
        await clear(page);
        await guard(page, true, "older external settings cannot cover a locally saved edit");
        await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
        await guard(page, false, "undo to exported settings remains externally saved");
      }));
  }

  test(`UI-07 mixed batch keeps locally-only work guarded in ${engine}`, async () =>
    fixture(engine, async (page) => {
      await graphic(page, 2);
      // Actual active-item store export covers one item, not its locally saved sibling.
      const file = page.waitForEvent("download");
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadActive());
      await file;
      await guard(page, true);
      await save(page);
      await clear(page);
      await guard(page, true, "one remaining locally-only item still needs a copy");
      await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        s.removeItem(s.items.find((i) => i.id !== s.activeId).id);
      });
      await guard(page, false, "only the externally saved item remains");
    }));
}
