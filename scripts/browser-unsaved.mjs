// npm run dev or a production preview must be running at APP_URL.
// A reload must not silently throw away a cutout that was never saved.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

/** Reloads and reports whether the page asked to stay (the dialog is dismissed, so it stays). */
async function reloadAsks(page) {
  let asked = false;
  const onDialog = (dialog) => {
    if (dialog.type() === "beforeunload") asked = true;
    void dialog.dismiss();
  };
  page.on("dialog", onDialog);
  await page.reload({ timeout: 3000 }).catch(() => {});
  page.off("dialog", onDialog);
  return asked;
}

/** A page showing a finished sample cutout that has not been saved. */
async function sampleCutout() {
  const page = await browser.newPage({ acceptDownloads: true });
  page.setDefaultTimeout(15000);
  // Headless Chrome has no save dialog: the picker aborts as if the user cancelled.
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Try a sample" }).click();
  await page.getByRole("toolbar", { name: "Image actions" }).waitFor({ timeout: 240_000 });
  return page;
}

/**
 * A page (with the store exposed) showing a finished cutout of a flat graphic that has
 * not been saved: the colour-key path, so no model download.
 */
async function graphicCutout(context) {
  const page = context ? await context.newPage() : await browser.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(e2eUrl(appUrl), { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 96;
    const x = c.getContext("2d");
    x.fillStyle = "white";
    x.fillRect(0, 0, 96, 96);
    x.fillStyle = "black";
    x.fillRect(24, 24, 48, 48);
    return c.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  const input = await chooser;
  await input.setFiles({
    name: "graphic.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await page.getByRole("toolbar", { name: "Image actions" }).waitFor({ timeout: 60_000 });
  return page;
}

for (const method of ["picker", "paste", "drop"]) {
  test(`${method} asks before replacing unsaved cutouts and respects Cancel`, async () => {
    const page = await graphicCutout();
    try {
      const original = await page.evaluate(
        () => window.__cutoutTest.useWorkspace.getState().activeId,
      );
      const bytes = await page.evaluate(async () =>
        Array.from(
          new Uint8Array(
            await window.__cutoutTest.useWorkspace.getState().items[0].source.arrayBuffer(),
          ),
        ),
      );
      const replace = async () => {
        if (method === "picker") {
          await page
            .locator('input[type="file"]')
            .first()
            .setInputFiles({
              name: "replacement.png",
              mimeType: "image/png",
              buffer: Buffer.from(bytes),
            });
        } else {
          await page.evaluate(
            ({ method, bytes }) => {
              const transfer = new DataTransfer();
              transfer.items.add(
                new File([Uint8Array.from(bytes)], "replacement.png", { type: "image/png" }),
              );
              const event =
                method === "paste"
                  ? new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true })
                  : new DragEvent("drop", { dataTransfer: transfer, bubbles: true });
              document.body.dispatchEvent(event);
            },
            { method, bytes },
          );
        }
      };
      for (const accept of [false, true]) {
        const decision = page.waitForEvent("dialog").then(async (dialog) => {
          assert.equal(dialog.type(), "confirm");
          assert.match(dialog.message(), /Unsaved cutouts and edits will be lost/);
          await (accept ? dialog.accept() : dialog.dismiss());
        });
        await replace();
        await decision;
        if (!accept) {
          assert.equal(
            await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().activeId),
            original,
          );
        } else {
          await page.waitForFunction((id) => {
            const state = window.__cutoutTest.useWorkspace.getState();
            return state.activeId !== id && state.items[0]?.status === "done";
          }, original);
        }
      }
    } finally {
      await page.close();
    }
  });
}

test("deletion in another tab re-arms the warning and pauses that tab's autosave", async () => {
  const context = await browser.newContext();
  const page = await graphicCutout(context);
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
    const other = await page.context().newPage();
    await other.goto(e2eUrl(appUrl));
    await other.getByRole("button", { name: "Saved workspace", exact: true }).click();
    // Hold a real autosave open request behind deletion, including a delayed upgrade.
    await page.evaluate(() => {
      const open = indexedDB.open.bind(indexedDB);
      indexedDB.open = (...args) => {
        if (window.delayedOpenSettled) return open(...args);
        const proxy = {};
        window.releaseStaleSave = () => {
          const request = open(...args);
          for (const key of ["result", "error", "transaction"])
            Object.defineProperty(proxy, key, { get: () => request[key] });
          request.onupgradeneeded = (event) => proxy.onupgradeneeded?.(event);
          for (const type of ["success", "error"])
            request["on" + type] = (event) => {
              window.delayedOpenSettled = true;
              proxy["on" + type]?.(event);
            };
        };
        return proxy;
      };
      window.__cutoutTest.useWorkspace.getState().changeEdit({ feather: 4 });
    });
    await page.waitForFunction(() => typeof window.releaseStaleSave === "function");
    other.once("dialog", (confirm) => void confirm.accept());
    await other.getByRole("button", { name: "Delete saved workspace" }).click();
    await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    await dialog.getByRole("button", { name: "Enable local autosave" }).waitFor();
    await page.evaluate(() => window.releaseStaleSave());
    await page.waitForFunction(() => window.delayedOpenSettled);
    await page.keyboard.press("Escape");
    await edit(page, { feather: 5 });
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);
    assert.equal(
      await page.evaluate(async () =>
        (await indexedDB.databases()).some((db) => db.name === "cutout-workspace"),
      ),
      false,
    );
    assert.equal(await reloadAsks(page), true);
    await page.getByRole("button", { name: "Save workspace", exact: true }).click();
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

test("deletion during resume cannot turn autosave back on", async () => {
  const context = await browser.newContext();
  const page = await graphicCutout(context);
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
    const other = await context.newPage();
    await other.goto(e2eUrl(appUrl));
    await other.getByRole("button", { name: "Saved workspace", exact: true }).click();
    await page.evaluate(() => {
      window.__cutoutTest.useWorkspace.getState().reset();
      const slice = File.prototype.slice;
      let hold = true;
      File.prototype.slice = function (...args) {
        const blob = slice.apply(this, args);
        if (hold) {
          hold = false;
          const read = blob.arrayBuffer.bind(blob);
          blob.arrayBuffer = () =>
            new Promise((resolve) => {
              window.releaseResume = () => read().then(resolve);
            });
        }
        return blob;
      };
    });
    await dialog.getByRole("button", { name: "Resume saved workspace" }).click();
    await page.waitForFunction(() => typeof window.releaseResume === "function");
    other.once("dialog", (confirm) => void confirm.accept());
    await other.getByRole("button", { name: "Delete saved workspace" }).click();
    await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    await page.evaluate(() => window.releaseResume());
    await page.waitForFunction(
      () => window.__cutoutTest.useWorkspace.getState().items.length === 1,
    );
    await dialog
      .getByRole("button", { name: "Enable local autosave" })
      .waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await edit(page, { feather: 7 });
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);
    assert.equal(
      await page.evaluate(async () =>
        (await indexedDB.databases()).some((db) => db.name === "cutout-workspace"),
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("reset cancels a pending autosave without reporting a storage error", async () => {
  const page = await graphicCutout();
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
    await page.evaluate(() => {
      const state = window.__cutoutTest.useWorkspace.getState();
      state.changeEdit({ feather: 6 });
      state.reset();
    });
    await page.waitForTimeout(850);
    assert.equal(await dialog.getByText(/Not saved/).count(), 0);
    assert.equal(
      await page.evaluate(() => localStorage.getItem("cutout.saved")),
      "1",
      "reset leaves the previous saved copy available",
    );
  } finally {
    await page.close();
  }
});

test("resume synchronizes a delayed deletion notification before using its saved copy", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key === "cutout:workspace-deleted") event.stopImmediatePropagation();
      },
      true,
    );
  });
  const page = await graphicCutout(context);
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().reset());
    const other = await context.newPage();
    await other.goto(e2eUrl(appUrl));
    await other.getByRole("button", { name: "Saved workspace", exact: true }).click();
    other.once("dialog", (confirm) => void confirm.accept());
    await other.getByRole("button", { name: "Delete saved workspace" }).click();
    await other.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    // The first tab has not received its storage notification and still renders Resume.
    await dialog.getByRole("button", { name: "Resume saved workspace" }).click();
    await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    await page.waitForTimeout(850);
    assert.equal(
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().items.length),
      0,
    );
    assert.equal(await dialog.getByRole("button", { name: "Pause autosave" }).count(), 0);
    assert.equal(
      await page.evaluate(async () =>
        (await indexedDB.databases()).some((db) => db.name === "cutout-workspace"),
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

test("a pending autosave synchronizes deletion before treating a save as a fresh request", async () => {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key === "cutout:workspace-deleted") event.stopImmediatePropagation();
      },
      true,
    );
  });
  const page = await graphicCutout(context);
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
    const other = await context.newPage();
    await other.goto(e2eUrl(appUrl));
    await other.getByRole("button", { name: "Saved workspace", exact: true }).click();
    other.once("dialog", (confirm) => void confirm.accept());
    await other.getByRole("button", { name: "Delete saved workspace" }).click();
    await other.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    await edit(page, { feather: 7 });
    await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
    await page.waitForTimeout(850);
    assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);
    assert.equal(
      await page.evaluate(async () =>
        (await indexedDB.databases()).some((db) => db.name === "cutout-workspace"),
      ),
      false,
    );
  } finally {
    await context.close();
  }
});

/** Changes the active image's settings, as a slider would. */
function edit(page, patch) {
  return page.evaluate(
    (patch) => window.__cutoutTest.useWorkspace.getState().changeEdit(patch, Object.keys(patch)[0]),
    patch,
  );
}

/** Runs a Batch images export and waits for its file. */
async function batchExport(page, button) {
  await page.getByRole("button", { name: /^Batch/ }).click();
  const dialog = page.getByRole("dialog", { name: "Batch images" });
  const download = page.waitForEvent("download", { timeout: 60_000 });
  await dialog.getByRole("button", { name: button, exact: true }).click();
  const file = (await download).suggestedFilename();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "detached" });
  return file;
}

test("reload warns after an unsaved cutout and not after it was downloaded", async () => {
  const page = await sampleCutout();
  try {
    assert.equal(await reloadAsks(page), true, "an unsaved cutout should ask before reload");
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 1);

    const download = page.waitForEvent("download");
    await page.keyboard.press("ControlOrMeta+s");
    await download;
    assert.equal(await reloadAsks(page), false, "a downloaded cutout should reload freely");
  } finally {
    await page.close();
  }
});

test("a ZIP export counts as saving every image in it", async () => {
  const page = await sampleCutout();
  try {
    assert.equal(await batchExport(page, "Download all ZIP"), "cutout-images.zip");
    assert.equal(await reloadAsks(page), false, "a cutout exported in a ZIP should reload freely");
  } finally {
    await page.close();
  }
});

test("a sprite sheet export counts as saving its frames", async () => {
  const page = await sampleCutout();
  try {
    assert.equal(await batchExport(page, "Sprite sheet + JSON"), "sprites.zip");
    assert.equal(
      await reloadAsks(page),
      false,
      "a cutout exported as sprites should reload freely",
    );
  } finally {
    await page.close();
  }
});

test("local autosave counts as saved once it has written the current state", async () => {
  const page = await sampleCutout();
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    const dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    assert.equal(await reloadAsks(page), false, "an autosaved cutout should reload freely");
  } finally {
    await page.close();
  }
});

test("a resumed workspace counts as saved until it is edited", async () => {
  const page = await sampleCutout();
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    let dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Autosave is session state: after this reload it is off, so only the resume can mark it saved.
    assert.equal(await reloadAsks(page), false);
    // The header button reads "Saved workspace" once a copy exists.
    await page.getByRole("button", { name: "Saved workspace" }).click();
    dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Resume saved workspace" }).click();
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor({ timeout: 60_000 });
    assert.equal(await reloadAsks(page), false, "a just-resumed workspace should reload freely");
  } finally {
    await page.close();
  }
});

test("the header Guide link keeps the unsaved-work prompt while the work stays in memory", async () => {
  const page = await graphicCutout();
  try {
    await page.getByRole("link", { name: "Guide", exact: true }).first().click();
    await page.waitForURL(/\/guide$/);
    await page.getByRole("heading", { name: "Guide", exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().items.length),
      1,
      "the cutout is still in memory on the Guide",
    );
    // Headless Chrome shows no prompt for page.close(); a reload runs the same listener.
    assert.equal(await reloadAsks(page), true, "leaving the Guide should ask first");
  } finally {
    await page.close();
  }
});

test("autosave stays on across the Guide and keeps an edit made just before leaving", async () => {
  const page = await graphicCutout();
  try {
    await page.getByRole("button", { name: "Save workspace" }).click();
    let dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.").waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // Leaving well inside autosave's 600 ms pause: the pending save must still be written.
    await edit(page, { feather: 4 });
    await page.getByRole("link", { name: "Guide", exact: true }).first().click();
    await page.waitForURL(/\/guide$/);
    await page.getByRole("link", { name: "Back to Cutout" }).click();
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
    await page.getByRole("button", { name: "Saved workspace" }).click();
    dialog = page.getByRole("dialog", { name: "Saved workspace" });
    await dialog.getByRole("button", { name: "Pause autosave" }).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Enable local autosave" }).count(), 0);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    // A later edit is saved too: autosave is still on, not just shown as on.
    await edit(page, { choke: 3 });
    await page.getByRole("button", { name: "Saved workspace" }).click();
    await dialog.getByText("Saved on this device.").waitFor();
    // Both edits come back from the saved copy. (The studio link dropped `?e2e`: load it again.)
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await page.goto(e2eUrl(appUrl), { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Saved workspace" }).click();
    await dialog.getByRole("button", { name: "Resume saved workspace" }).click();
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
    const restored = await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      const edits = s.settings[s.activeId];
      return { feather: edits?.feather, choke: edits?.choke };
    });
    assert.deepEqual(restored, { feather: 4, choke: 3 });
  } finally {
    await page.close();
  }
});

test("the idle page reloads without asking", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Choose files", exact: true }).click({ trial: true });
    assert.equal(await reloadAsks(page), false);
  } finally {
    await page.close();
  }
});
