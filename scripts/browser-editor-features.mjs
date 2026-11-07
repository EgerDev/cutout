import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";
import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
let browser, page;
const url = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const moduleBase = (process.env.MODULE_URL ?? url).replace(/\/$/, "");
beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.addInitScript((base) => {
    delete window.showSaveFilePicker;
    window.editorModuleBase = base;
  }, moduleBase);
  await page.route("**/src/lib/removal-client.ts*", (route) => {
    if (new URL(route.request().url()).searchParams.has("actual")) return route.continue();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
      export * from '${moduleBase}/src/lib/removal-client.ts?actual=1';
      import { refineCropsAuto as actual } from '${moduleBase}/src/lib/removal-client.ts?actual=1';
      export function refineCropsAuto(...args) {
        if (window.failRecut) throw new Error("Could not load birefnet on wasm: Failed to fetch");
        return actual(...args);
      }
    `,
    });
  });
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
});
afterEach(async () => {
  await browser?.close();
});
async function upload(count = 1) {
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
  await (
    await chooser
  ).setFiles(
    Array.from({ length: count }, () => ({
      name: "graphic.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })),
  );
  await page.waitForFunction(
    (n) =>
      window.__cutoutTest.useWorkspace.getState().items.filter((i) => i.status === "done")
        .length === n,
    count,
  );
  await page.waitForFunction(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return !s.previewBusy && (s.previewBitmap || s.previewUrl);
  });
}
async function edits() {
  return page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return s.settings[s.activeId];
  });
}

test("per-image edits, grouped undo/redo and atomic batch application", async () => {
  await upload(2);
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.setFeather(1);
    s.setFeather(2);
    s.setPreset("product");
    s.setBackground({ type: "color", color: "#123456" });
  });
  assert.equal((await edits()).background.color, "#123456");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  assert.equal((await edits()).background.color, "#ffffff");
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  assert.equal((await edits()).background.color, "#123456");
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.selectItem(s.items[1].id);
  });
  assert.equal((await edits()).feather, 0);
  assert.equal((await edits()).preset, "original");
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.selectItem(s.items[0].id);
    s.selectAll();
    s.applySelected();
    s.selectItem(s.items[1].id);
  });
  assert.equal((await edits()).feather, 2);
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
  assert.equal((await edits()).feather, 0);
});

test("brush gestures erase, restore, cancel, and undo without losing original pixels", async () => {
  await upload();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
  // Measure the canvas before every click: the dialog can scroll (a button click nudges it)
  // and a box measured once sent the restore stroke 2.5% below the erased spot.
  const surface = page.locator(".brush-surface canvas:not(.brush-ghost)");
  const center = async () => {
    const b = await surface.boundingBox();
    assert.ok(b);
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  await page.mouse.click(...(await center()));
  await page.getByText("1 stroke · Erase", { exact: true }).waitFor();
  const alpha = () =>
    surface.evaluate((c) =>
      Array.from(c.getContext("2d").getImageData(c.width / 2, c.height / 2, 1, 1).data),
    );
  assert.equal((await alpha())[3], 0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.mouse.click(...(await center()));
  await page.getByText("2 strokes · Restore", { exact: true }).waitFor();
  assert.ok((await alpha())[3] > 250);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByText("1 stroke · Restore", { exact: true }).waitFor();
  assert.equal((await alpha())[3], 0);
  {
    const b = await surface.boundingBox();
    assert.ok(b);
    await page.mouse.move(b.x + 10, b.y + 10);
  }
  await page.mouse.down();
  await surface.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  assert.equal((await edits()).strokes.length, 0, "strokes stay in the dialog until Apply");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await edits()).strokes.length, 1);
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByText("1 stroke · Erase", { exact: true }).waitFor();
  await page.mouse.click(...(await center()));
  await page.getByText("2 strokes · Erase", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await edits()).strokes.length, 1, "cancel discards the session");
});

test("a soft brush fades out to its rim and the size reads in image pixels", async () => {
  await upload();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
  await page.getByLabel("Brush size").fill("1000");
  await page.getByText("29 px", { exact: true }).waitFor();
  await page.getByLabel("Edge softness").fill("100");
  await page.getByText("Soft 100%", { exact: true }).waitFor();
  // Shortcuts still work with a slider focused (it used to swallow them as a text field).
  await page.keyboard.press("r");
  assert.equal(
    await page.getByRole("button", { name: "Restore", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  await page.keyboard.press("e");
  assert.equal(
    await page.getByRole("button", { name: "Erase", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  const surface = page.locator(".brush-surface canvas:not(.brush-ghost)");
  const b = await surface.boundingBox();
  assert.ok(b);
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.getByText("1 stroke · Erase", { exact: true }).waitFor();
  const at = (dx) =>
    surface.evaluate(
      (c, dx) =>
        c
          .getContext("2d")
          .getImageData(Math.floor(c.width / 2) + dx, Math.floor(c.height / 2), 1, 1).data[3],
      dx,
    );
  assert.ok((await at(0)) < 30, "full strength in the middle");
  const mid = await at(9);
  assert.ok(mid > 60 && mid < 250, `partly erased towards the rim, got ${mid}`);
  assert.ok((await at(20)) > 250, "untouched past the rim");
  assert.equal((await edits()).strokes.length, 0);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await edits()).strokes[0].hardness, 0);
});

test("editor zoom keeps the pointed spot still, and Space-drag pans instead of painting", async () => {
  await upload();
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
  const surface = page.locator(".brush-surface canvas:not(.brush-ghost)");
  const b = await surface.boundingBox();
  assert.ok(b);
  const x = b.x + b.width * 0.7,
    y = b.y + b.height * 0.3;
  const under = async () => {
    const r = await surface.boundingBox();
    return [(x - r.x) / r.width, (y - r.y) / r.height];
  };
  const before = await under();
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -400);
  await page.keyboard.up("Control");
  await page.waitForFunction(
    () => Number(document.querySelector(".zoom-value")?.textContent?.replace("%", "")) > 150,
  );
  const after = await under();
  assert.ok(
    Math.abs(after[0] - before[0]) < 0.02 && Math.abs(after[1] - before[1]) < 0.02,
    `spot moved from ${before} to ${after}`,
  );
  const viewport = page.locator(".stage-viewport");
  const scroll = () => viewport.evaluate((v) => [v.scrollLeft, v.scrollTop]);
  const start = await scroll();
  await page.keyboard.down("Space");
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 60, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Space");
  const end = await scroll();
  assert.ok(end[0] < start[0] - 40 && end[1] < start[1] - 30, `panned from ${start} to ${end}`);
  await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Fit to view" }).click();
  await page
    .getByRole("button", { name: "Fit to view" })
    .getByText("100%", { exact: true })
    .waitFor();
});

test("ZIP uses selected format, unique safe names and excludes removed images", async () => {
  await upload(2);
  await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download all ZIP" }).click();
  const file = await download;
  assert.equal(file.suggestedFilename(), "cutout-images.zip");
  const archive = unzipSync(new Uint8Array(await readFile(await file.path())));
  assert.deepEqual(Object.keys(archive), ["graphic-cutout.png", "graphic-cutout-2.png"]);
  for (const bytes of Object.values(archive))
    assert.deepEqual(Array.from(bytes.slice(0, 4)), [137, 80, 78, 71]);
  await page.getByRole("button", { name: "Remove graphic.png", exact: true }).last().click();
  assert.equal(
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().items.length),
    1,
  );
});

test("presets, shadows and file-size targeting share exact export geometry", async () => {
  await upload();
  const report = await page.evaluate(async () => {
    const { encodeExport } = await import(`${window.editorModuleBase}/src/lib/editor/export.ts`);
    const s = window.__cutoutTest.useWorkspace.getState();
    s.setPreset("product");
    s.changeEdit({ shadow: true, exportFormat: "jpeg", targetKB: 10 });
    const state = window.__cutoutTest.useWorkspace.getState(),
      item = state.items[0],
      settings = state.settings[item.id];
    const result = await encodeExport({ result: item.resultBlob, source: item.source, settings });
    const bitmap = await createImageBitmap(result.blob);
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return {
      size: result.blob.size,
      width: result.width,
      height: result.height,
      met: result.metTarget,
      pixel: Array.from(ctx.getImageData(0, 0, 1, 1).data),
    };
  });
  assert.ok(report.size <= 10000);
  assert.equal(report.width, report.height);
  assert.ok(report.met);
  assert.ok(report.pixel[0] > 245);
});

test("optional saved workspace restores originals, results and edits after reload and can be deleted", async () => {
  await upload(2);
  await page.evaluate(() => {
    window.__cutoutTest.useWorkspace.getState().setPreset("profile");
  });
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.getByRole("button", { name: "Enable local autosave" }).click();
  await page.getByText("Saved on this device.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.getByRole("button", { name: "Resume saved workspace" }).click();
  await page.getByRole("button", { name: "Batch (2)" }).waitFor();
  assert.equal((await edits()).preset, "profile");
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.getByRole("button", { name: "Delete saved workspace" }).click();
  await page.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  assert.equal(await page.getByRole("button", { name: "Resume saved workspace" }).count(), 0);
});

test("reset cancels preview publication and removed in-flight items cannot return", async () => {
  await upload(2);
  const state = await page.evaluate(async () => {
    const s = window.__cutoutTest.useWorkspace.getState();
    const first = s.items[0].id,
      second = s.items[1].id;
    s.setPreset("product");
    s.changeEdit({ feather: 12, shadow: true });
    s.selectItem(second);
    s.removeItem(first);
    s.reset();
    await new Promise((r) => setTimeout(r, 600));
    const after = window.__cutoutTest.useWorkspace.getState();
    return {
      count: after.items.length,
      preview: after.previewBitmap ?? after.previewUrl,
      busy: after.previewBusy,
      phase: after.phase,
    };
  });
  assert.deepEqual(state, { count: 0, preview: null, busy: false, phase: "idle" });
});

test("transparent empty images never produce a phantom shadow and Original PNG retains resolution", async () => {
  const result = await page.evaluate(async () => {
    const { encodeExport } = await import(`${window.editorModuleBase}/src/lib/editor/export.ts`);
    const { defaults } = await import(`${window.editorModuleBase}/src/lib/editor/model.ts`);
    const c = document.createElement("canvas");
    c.width = 4200;
    c.height = 40;
    const blob = await new Promise((r) => c.toBlob(r));
    const source = new File([blob], "wide.png", { type: "image/png" });
    const original = await encodeExport({ result: blob, source, settings: defaults });
    const shadow = await encodeExport({
      result: blob,
      source,
      settings: { ...defaults, shadow: true, exportWidth: 128, exportHeight: 128 },
    });
    const b = await createImageBitmap(shadow.blob);
    const view = document.createElement("canvas");
    view.width = view.height = 128;
    const ctx = view.getContext("2d");
    ctx.drawImage(b, 0, 0);
    b.close();
    const rgba = ctx.getImageData(0, 0, 128, 128).data;
    let maxAlpha = 0;
    for (let i = 3; i < rgba.length; i += 4) maxAlpha = Math.max(maxAlpha, rgba[i]);
    return {
      width: original.width,
      height: original.height,
      same: original.blob === blob,
      maxAlpha,
    };
  });
  assert.deepEqual(result, { width: 4200, height: 40, same: true, maxAlpha: 0 });
});

test("archive cancellation rejects without emitting a partial archive", async () => {
  await upload();
  const name = await page.evaluate(async () => {
    const { createArchive } = await import(`${window.editorModuleBase}/src/lib/editor/archive.ts`);
    const s = window.__cutoutTest.useWorkspace.getState(),
      item = s.items[0];
    const controller = new AbortController();
    try {
      await createArchive(
        [
          {
            name: item.name,
            result: item.resultBlob,
            source: item.source,
            settings: s.settings[item.id],
          },
        ],
        "png",
        controller.signal,
        () => controller.abort(),
      );
      return "unexpected";
    } catch (e) {
      return e.name;
    }
  });
  assert.equal(name, "AbortError");
});

test("local save failures are visible and a queued deletion wins over an earlier write", async () => {
  await upload();
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.evaluate(() => {
    window.originalIdbOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = () => {
      throw new DOMException("Storage quota exceeded", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "Enable local autosave" }).click();
  await page.getByText(/Not saved\. Browser storage may be full or unavailable/).waitFor();
  const cleared = await page.evaluate(async () => {
    indexedDB.open = window.originalIdbOpen;
    const { saveSession, loadSession, snapshotSession } = await import(
      `${window.editorModuleBase}/src/lib/editor/session.ts`
    );
    const pending = saveSession(snapshotSession(window.__cutoutTest.useWorkspace.getState()));
    const deletion = saveSession(null);
    await Promise.all([pending, deletion]);
    return (await loadSession()) === null;
  });
  assert.equal(cleared, true);
});

test("download keeps its captured image and background while active selection changes", async () => {
  await upload(2);
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.setBackground({ type: "color", color: "#ff0000" });
  });
  const downloaded = page.waitForEvent("download");
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    void s.downloadActive("png");
    s.selectItem(s.items[1].id);
    s.setBackground({ type: "color", color: "#0000ff" });
  });
  const file = await downloaded;
  const base64 = (await readFile(await file.path())).toString("base64");
  const pixel = await page.evaluate(async (encoded) => {
    const blob = await fetch(`data:image/png;base64,${encoded}`).then((r) => r.blob());
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return Array.from(ctx.getImageData(0, 0, 1, 1).data);
  }, base64);
  assert.deepEqual(pixel, [255, 0, 0, 255]);
});

test("selected ZIP uses JPG for every included image", async () => {
  await upload(2);
  await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.setExportFormat("jpeg");
    s.toggleSelected(s.items[1].id);
  });
  await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Selected ZIP", exact: true }).click();
  const file = await downloaded;
  const entries = unzipSync(new Uint8Array(await readFile(await file.path())));
  assert.equal(Object.keys(entries).length, 1);
  assert.ok(Object.keys(entries)[0].endsWith(".jpg"));
  assert.deepEqual(Array.from(Object.values(entries)[0].slice(0, 2)), [255, 216]);
});

test("removing a working image advances the queue and repeated retry remains serial", async () => {
  await upload();
  const removed = await page.evaluate(async () => {
    const s = window.__cutoutTest.useWorkspace.getState(),
      source = s.items[0].source;
    s.receiveFiles([source, source, source]);
    // Ingest first checks each file's bytes for SVG (Stream A2), so the new items can arrive a tick later.
    while (window.__cutoutTest.useWorkspace.getState().items.length !== 3)
      await new Promise((r) => setTimeout(r, 5));
    const current = window.__cutoutTest.useWorkspace.getState(),
      id = current.items[0].id;
    current.removeItem(id);
    return id;
  });
  await page.waitForFunction(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return s.items.length === 2 && s.items.every((i) => i.status === "done");
  });
  assert.equal(
    await page.evaluate(
      (id) => window.__cutoutTest.useWorkspace.getState().items.some((i) => i.id === id),
      removed,
    ),
    false,
  );
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace,
      id = store.getState().items[0].id;
    window.maxWorking = 0;
    window.stopQueueObservation = store.subscribe((s) => {
      window.maxWorking = Math.max(
        window.maxWorking,
        s.items.filter((i) => i.status === "working").length,
      );
    });
    store.setState((s) => ({
      items: s.items.map((i) =>
        i.id === id ? { ...i, status: "error", retryable: true, error: "Retry test" } : i,
      ),
    }));
    store.getState().retryItem(id);
    store.getState().retryItem(id);
  });
  await page.waitForFunction(() =>
    window.__cutoutTest.useWorkspace.getState().items.every((i) => i.status === "done"),
  );
  const max = await page.evaluate(() => {
    window.stopQueueObservation();
    return window.maxWorking;
  });
  assert.equal(max, 1);
});

test("non-square background images use centered cover in preview and export", async () => {
  const pixels = await page.evaluate(async () => {
    const { renderCanvas } = await import(`${window.editorModuleBase}/src/lib/editor/render.ts`);
    const { encodeExport } = await import(`${window.editorModuleBase}/src/lib/editor/export.ts`);
    const { defaults } = await import(`${window.editorModuleBase}/src/lib/editor/model.ts`);
    const c = document.createElement("canvas");
    c.width = 120;
    c.height = 40;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 40, 40);
    ctx.fillStyle = "#00ff00";
    ctx.fillRect(40, 0, 40, 40);
    ctx.fillStyle = "#0000ff";
    ctx.fillRect(80, 0, 40, 40);
    const backgroundBlob = await new Promise((r) => c.toBlob(r));
    c.width = c.height = 40;
    const result = await new Promise((r) => c.toBlob(r));
    const input = {
      result,
      source: new File([result], "empty.png", { type: "image/png" }),
      settings: { ...defaults, background: { type: "image", url: "" }, backgroundBlob },
    };
    const preview = await renderCanvas(input, { maxSide: 1200 });
    const previewPixels = Array.from(preview.getContext("2d").getImageData(1, 20, 1, 1).data);
    const encoded = await encodeExport(input);
    const bitmap = await createImageBitmap(encoded.blob);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { preview: previewPixels, export: Array.from(ctx.getImageData(1, 20, 1, 1).data) };
  });
  assert.deepEqual(pixels, { preview: [0, 255, 0, 255], export: [0, 255, 0, 255] });
});

test("closing each editor dialog returns keyboard focus to its opening control", async () => {
  const save = page.getByRole("button", { name: "Save workspace", exact: true });
  await page.waitForFunction(() =>
    [...document.querySelectorAll("button")].some(
      (b) => b.textContent.startsWith("Save workspace") && !b.disabled,
    ),
  );
  await save.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Saved workspace" }).waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.startsWith("Save workspace"),
  );
  await upload();
  for (const name of ["Brush", "Batch (1)"]) {
    const trigger = page.getByRole("button", { name, exact: true });
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction((label) => {
      const el = document.activeElement;
      return el?.getAttribute("aria-label") === label || el?.textContent?.startsWith(label);
    }, name);
  }
});

test("file-size target supports incremental typing, invalid drafts and undo", async () => {
  await upload();
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByText("Quality & file size", { exact: true }).click();
  await page.getByLabel("Target file size", { exact: true }).check();
  const input = page.getByRole("spinbutton", { name: "Maximum size (KB)" });
  await input.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("20");
  assert.equal(await input.inputValue(), "20");
  assert.equal((await edits()).targetKB, 500);
  await input.press("Enter");
  assert.equal((await edits()).targetKB, 20);
  await input.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type("2");
  assert.equal(await input.inputValue(), "2");
  assert.equal((await edits()).targetKB, 20);
  await page.keyboard.press("Tab");
  assert.equal(await input.inputValue(), "20");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Maximum size (KB)"]')?.value === "500",
  );
  assert.equal((await edits()).targetKB, 500);
});

test("mouse-opened editor dialogs restore focus after Escape and close buttons", async () => {
  const check = async (name, closeName) => {
    const trigger = page.getByRole("button", { name, exact: true });
    for (const method of ["Escape", "button"]) {
      await trigger.click();
      await page.getByRole("dialog").waitFor();
      if (method === "Escape") await page.keyboard.press("Escape");
      else await page.getByRole("button", { name: closeName, exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      await page.waitForFunction(
        (label) => {
          const el = document.activeElement;
          return el?.getAttribute("aria-label") === label || el?.textContent?.startsWith(label);
        },
        name,
        { timeout: 3000 },
      );
    }
  };
  await check("Save workspace", "Close saved workspace");
  await upload();
  await check("Brush", "Close brush");
  await check("Subject", "Close choose subject");
  await check("Batch (1)", "Close batch images");
});

test("inspection, subject marks, transform and batch framing stay per-image", async () => {
  await upload(2);
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  await page.getByRole("heading", { name: "Choose subject" }).waitFor();
  await page.getByRole("button", { name: "Close choose subject" }).click();
  const report = await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.cycleInspectMode();
    s.changeEdit({
      scale: 125,
      rotate: 10,
      flipX: true,
      decontaminate: "auto",
      matchBackground: true,
    });
    s.changeEdit({ hints: [{ kind: "keep", size: 0.08, points: [{ x: 0.4, y: 0.4 }] }] });
    s.selectAll();
    s.matchFraming();
    const next = window.__cutoutTest.useWorkspace.getState();
    const first = next.settings[next.items[0].id],
      second = next.settings[next.items[1].id];
    return {
      inspect: next.inspectMode,
      firstScale: first.scale,
      secondScale: second.scale,
      secondHints: second.hints.length,
      firstHints: first.hints.length,
    };
  });
  assert.equal(report.inspect, "checker");
  assert.equal(report.firstScale, 125);
  assert.equal(report.secondScale, 125);
  assert.equal(report.firstHints, 1);
  assert.equal(report.secondHints, 0);
});

test("choose subject picks pieces in a draft with its own undo, then applies or cancels", async () => {
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 96;
    const x = c.getContext("2d");
    x.fillStyle = "white";
    x.fillRect(0, 0, 160, 96);
    x.fillStyle = "black";
    x.fillRect(16, 24, 48, 48);
    x.fillRect(96, 24, 48, 48);
    return c.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (
    await chooser
  ).setFiles([{ name: "two.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") }]);
  await page.waitForFunction(
    () => window.__cutoutTest.useWorkspace.getState().items[0]?.status === "done",
  );
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  await page.getByText("2 of 2 pieces kept", { exact: true }).waitFor();
  const surface = page.locator(".brush-surface canvas");
  const at = async (fx, fy) => {
    const b = await surface.boundingBox();
    assert.ok(b);
    return [b.x + b.width * fx, b.y + b.height * fy];
  };
  const alpha = (fx, fy) =>
    surface.evaluate(
      (c, [fx, fy]) =>
        c.getContext("2d").getImageData(Math.floor(c.width * fx), Math.floor(c.height * fy), 1, 1)
          .data[3],
      [fx, fy],
    );
  const right = [0.75, 0.5];
  await page.mouse.click(...(await at(...right)));
  await page.getByText("1 of 2 pieces kept · 1 removed", { exact: true }).waitFor();
  await page.mouse.move(...(await at(0.5, 0.05)));
  assert.ok((await alpha(...right)) < 100, "removed piece is faded, not gone");
  assert.ok((await alpha(...right)) > 0);
  assert.equal((await edits()).hints.length, 0, "nothing reaches the workspace before Apply");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await page.getByText("2 of 2 pieces kept", { exact: true }).waitFor();
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await page.getByText("1 of 2 pieces kept · 1 removed", { exact: true }).waitFor();
  await page.mouse.click(...(await at(...right)));
  await page.getByText("2 of 2 pieces kept", { exact: true }).waitFor();
  await page.mouse.click(...(await at(...right)));
  await page.getByText("1 of 2 pieces kept · 1 removed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await edits()).hints.length, 1);
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  await page.getByText("1 of 2 pieces kept · 1 removed", { exact: true }).waitFor();
  await page.mouse.click(...(await at(0.25, 0.5)));
  await page.getByText("0 of 2 pieces kept · 2 removed", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal((await edits()).hints.length, 1, "cancel discards the draft");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
  assert.equal((await edits()).hints.length, 0);
});

test("choose subject guide opens, and Escape closes the guide without closing the dialog", async () => {
  await upload();
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  const heading = page.getByRole("heading", { name: "How Choose subject works" });
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await heading.waitFor();
  await page.keyboard.press("Escape");
  await heading.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("heading", { name: "Choose subject" }).isVisible(), true);
  await page.getByRole("button", { name: "Guide", exact: true }).click();
  await heading.waitFor();
  await page.getByRole("button", { name: "Close guide" }).click();
  await heading.waitFor({ state: "hidden" });
  assert.equal(await page.getByRole("heading", { name: "Choose subject" }).isVisible(), true);
});

test("a file dropped under an open editor is swallowed, and its edits land on the image it opened on", async () => {
  await upload(2);
  const ids = await page.evaluate(() =>
    window.__cutoutTest.useWorkspace.getState().items.map((i) => i.id),
  );
  const select = (id) =>
    page.evaluate((id) => window.__cutoutTest.useWorkspace.getState().selectItem(id), id);
  await select(ids[0]);
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
  const surface = page.locator(".brush-surface canvas:not(.brush-ghost)");
  {
    const b = await surface.boundingBox();
    assert.ok(b);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  }
  await page.getByText("1 stroke · Erase", { exact: true }).waitFor();
  // A file dragged in from the desktop and dropped while the dialog is open.
  const drag = await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" }),
    );
    const fire = (type) => {
      const e = new DragEvent(type, {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
        clientX: 200,
        clientY: 200,
      });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    };
    const out = { enter: fire("dragenter"), over: fire("dragover") };
    out.dragging = window.__cutoutTest.useWorkspace.getState().dragging;
    out.drop = fire("drop");
    return out;
  });
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return {
      ids: s.items.map((i) => i.id),
      dragging: s.dragging,
      open: Boolean(document.querySelector('[role="dialog"][data-state="open"]')),
    };
  });
  assert.deepEqual(after.ids, ids, "a drop under a dialog must not replace the workspace");
  assert.equal(drag.dragging, false, "no drop overlay over a dialog");
  assert.equal(after.dragging, false);
  assert.equal(drag.over, true, "dragover is still taken, so the browser does not open the file");
  assert.equal(drag.drop, true, "the drop is swallowed, not left to the browser");
  assert.equal(after.open, true);
  // Even if the active image changes under the dialog, Apply writes to the image it opened on.
  await select(ids[1]);
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const strokes = await page.evaluate((ids) => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return ids.map((id) => s.settings[id]?.strokes.length ?? 0);
  }, ids);
  assert.deepEqual(strokes, [1, 0], "brush strokes belong to the image the dialog opened on");
  // Choose subject: a draft started on one image never lands on another.
  await select(ids[1]);
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  const subject = page.locator(".brush-surface canvas");
  await page.getByText(/^The cutout is one piece/).waitFor();
  {
    const b = await subject.boundingBox();
    assert.ok(b);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  }
  await page
    .getByText("The only piece is removed. Click it to bring it back.", { exact: true })
    .waitFor();
  // Another image becomes active: the draft belonged to the first one, so the dialog starts
  // over on this one with nothing to apply.
  await select(ids[0]);
  await page.getByText(/^The cutout is one piece/).waitFor();
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled(), true);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  const hints = await page.evaluate((ids) => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return ids.map((id) => s.settings[id]?.hints.length ?? 0);
  }, ids);
  assert.deepEqual(hints, [0, 0], "subject marks never move to another image");
});

test("a background shared by a batch is still one image after the saved workspace is resumed", async () => {
  await upload(6);
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = "#c03";
    x.fillRect(0, 0, 64, 64);
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const s = window.__cutoutTest.useWorkspace;
    s.getState().setBackgroundImage(new File([blob], "bg.png", { type: "image/png" }));
    while (!s.getState().settings[s.getState().activeId]?.backgroundBlob)
      await new Promise((r) => setTimeout(r, 20));
    s.getState().selectAll();
    s.getState().applySelected();
  });
  const distinct = () =>
    page.evaluate(() => {
      const b = Object.values(window.__cutoutTest.useWorkspace.getState().settings).map(
        (s) => s.backgroundBlob,
      );
      return b.every((x) => x instanceof Blob && x.size > 0) ? new Set(b).size : -1;
    });
  assert.equal(await distinct(), 1);
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.getByRole("button", { name: "Enable local autosave" }).click();
  await page.getByText("Saved on this device.", { exact: true }).waitFor();
  await page.reload();
  await page.getByRole("button", { name: /^Saved? workspace$/ }).click();
  await page.getByRole("button", { name: "Resume saved workspace" }).click();
  await page.getByRole("button", { name: "Batch (6)" }).waitFor();
  assert.equal(await distinct(), 1, "six items, one background Blob after resume");
  await page.evaluate(() =>
    window.__cutoutTest.useWorkspace.getState().changeEdit({ feather: 3 }, "feather"),
  );
  assert.equal(
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().past.length),
    1,
    "the edit can be undone",
  );
  await page.evaluate(async () =>
    (await import(window.editorModuleBase + "/src/lib/editor/session.ts")).deleteSavedWorkspace(),
  );
});

test("background picks keep the latest choice and discard stale success", async () => {
  await upload(2);
  // Hold the real file's header read so completion order is deterministic.
  const report = await page.evaluate(async () => {
    const store = window.__cutoutTest.useWorkspace;
    const state = store.getState(),
      a = state.activeId,
      b = state.items[1].id;
    const source = state.items[0].source;
    const makeHeld = (name) => {
      const file = new File([source], name, { type: "image/png" });
      let finish,
        held = false;
      const slice = file.slice.bind(file);
      file.slice = (...args) => {
        if (held) return slice(...args);
        held = true;
        return {
          arrayBuffer: () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        };
      };
      return {
        file,
        finish: async () => {
          finish(await source.slice(0, 512).arrayBuffer());
        },
      };
    };
    const old = makeHeld("old.png");
    state.setBackgroundImage(old.file);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const newest = new File([source], "new.png", { type: "image/png" });
    state.setBackgroundImage(newest);
    while (store.getState().settings[a].backgroundBlob?.name !== "new.png")
      await new Promise((resolve) => setTimeout(resolve, 0));
    await old.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const name = store.getState().settings[a].backgroundBlob.name;
    const stale = makeHeld("stale.png");
    state.setBackgroundImage(stale.file);
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.selectItem(b);
    state.selectItem(a);
    await stale.finish();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { name, afterNavigation: store.getState().settings[a].backgroundBlob.name };
  });
  assert.deepEqual(report, { name: "new.png", afterNavigation: "new.png" });
});

test("active deletion clears Info immediately", async () => {
  await upload(2);
  const result = await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace,
      state = store.getState();
    const metadata = { sentinel: "old image" };
    store.setState({ metadata, inspecting: true });
    state.removeItem(state.activeId);
    return {
      metadata: store.getState().metadata,
      inspecting: store.getState().inspecting,
      count: store.getState().items.length,
    };
  });
  assert.deepEqual(result, { metadata: null, inspecting: false, count: 1 });
});

test("an old Info request cannot update a changed source with the same item id", async () => {
  await page.route(/\/src\/lib\/metadata-client(?:\.ts)?(?:\?.*)?$/, (route) => {
    if (new URL(route.request().url()).searchParams.has("actual")) return route.continue();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
    export * from '/src/lib/metadata-client.ts?actual';
    export function inspectImageMetadata(source) { return new Promise((resolve,reject) => { window.infoRequests ??= []; window.infoRequests.push({resolve,reject,source}); }); }
  `,
    });
  });
  await page.reload();
  await upload(2);
  const result = await page.evaluate(async () => {
    const store = window.__cutoutTest.useWorkspace;
    store.setState({ metadata: null });
    store.getState().openInfo();
    const request = window.infoRequests.at(-1);
    const id = store.getState().activeId;
    // Enhance replaces the source under this id. Keep this request held across that change.
    store.setState({
      items: store
        .getState()
        .items.map((item) =>
          item.id === id
            ? { ...item, source: new File([item.source], "enhanced.png", { type: "image/png" }) }
            : item,
        ),
      metadata: null,
    });
    request.resolve({ sentinel: "old source" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    return store.getState().metadata;
  });
  assert.equal(result, null);
});
test("reset discards the previous job progress", async () => {
  await upload();
  const result = await page.evaluate(async () => {
    const store = window.__cutoutTest.useWorkspace;
    store.setState({ progress: { stage: "loading", progress: 0.95, message: "Previous job" } });
    store.getState().reset();
    return store.getState().progress;
  });
  assert.deepEqual(result, { stage: "loading", progress: 0, message: "" });
});

test("queue claim clears stale progress before any callback for the next item", async () => {
  await upload(2);
  const progress = await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    store.setState({ progress: { stage: "loading", progress: 0.95, message: "Previous job" } });
    store.getState().reprocessItem(store.getState().items[1].id);
    return store.getState().progress;
  });
  assert.deepEqual(progress, { stage: "loading", progress: 0, message: "" });
});

test("colour controls refuse a twenty-fifth rule without dropping existing edits", async () => {
  await upload();
  await page.evaluate(() => {
    window.EyeDropper = class {
      async open() {
        return { sRGBHex: "#abcdef" };
      }
    };
    window.__cutoutTest.useWorkspace.getState().changeEdit({
      recolors: Array.from({ length: 24 }, (_, i) => ({
        from: "#" + (i + 1).toString(16).padStart(6, "0"),
        to: null,
      })),
    });
  });
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByText("Colours", { exact: true }).click();
  await page.getByRole("button", { name: "Pick a colour to key" }).click();
  await page.getByRole("button", { name: "Remove #abcdef", exact: true }).click();
  assert.equal((await edits()).recolors.length, 24);
  await page.getByText(/Up to 24 colour changes/).waitFor();
});

test("subject drag paints only new picks and restores old fix boxes without trails", async () => {
  await upload();
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 96;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#123456";
    ctx.fillRect(16, 24, 48, 48);
    ctx.fillRect(96, 24, 48, 48);
    const blob = await new Promise((resolve) => c.toBlob(resolve));
    window.__cutoutTest.useWorkspace.getState().replaceResult(blob);
  });
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  await page.getByText("2 of 2 pieces kept", { exact: true }).waitFor();
  const surface = page.locator(".brush-surface canvas");
  const picked = await surface.evaluate((c) => {
    const ctx = c.getContext("2d"),
      box = c.getBoundingClientRect();
    const fire = (type, x, y) =>
      c.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 77,
          button: 0,
          clientX: box.left + box.width * x,
          clientY: box.top + box.height * y,
        }),
      );
    fire("pointerdown", 0.25, 0.5);
    const first = Array.from(ctx.getImageData(40, 48, 1, 1).data);
    const put = ctx.putImageData.bind(ctx),
      writes = [];
    ctx.putImageData = (...args) => {
      writes.push(args[0].width);
      return put(...args);
    };
    fire("pointermove", 0.75, 0.5);
    const after = Array.from(ctx.getImageData(40, 48, 1, 1).data);
    const second = Array.from(ctx.getImageData(120, 48, 1, 1).data);
    ctx.putImageData = put;
    fire("pointercancel", 0.75, 0.5);
    return { first, after, second, writes };
  });
  assert.deepEqual(picked.after, picked.first, "earlier picks retain their exact tint");
  assert.deepEqual(picked.second, picked.first, "new piece has the same tint");
  assert.equal(picked.writes.length, 1, "only the new piece is painted");
  assert.ok(picked.writes[0] < 160, "no full preview copy");
  await page.getByRole("button", { name: "Fix area", exact: true }).click();
  const fixed = await surface.evaluate((c) => {
    const ctx = c.getContext("2d"),
      box = c.getBoundingClientRect();
    const read = () => Array.from(ctx.getImageData(0, 0, c.width, c.height).data);
    const base = read();
    const fire = (type, x, y) =>
      c.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          pointerId: 78,
          button: 0,
          clientX: box.left + box.width * x,
          clientY: box.top + box.height * y,
        }),
      );
    fire("pointerdown", 0.2, 0.2);
    const put = ctx.putImageData.bind(ctx),
      writes = [];
    ctx.putImageData = (...args) => {
      writes.push(args.length);
      return put(...args);
    };
    fire("pointermove", 0.9, 0.8);
    fire("pointermove", 0.55, 0.6);
    fire("pointermove", 0.05, 0.05);
    const actual = read();
    ctx.putImageData = put;
    fire("pointercancel", 0.05, 0.05);
    const restored = read();
    fire("pointerdown", 0.2, 0.2);
    fire("pointermove", 0.05, 0.05);
    const expected = read();
    fire("pointercancel", 0.05, 0.05);
    return {
      same: actual.every((v, i) => v === expected[i]),
      restored: restored.every((v, i) => v === base[i]),
      writes,
    };
  });
  assert.equal(fixed.same, true, "shrinking and reversing a box leaves only the final outline");
  assert.equal(fixed.restored, true, "cancel restores the complete draft");
  assert.deepEqual(fixed.writes, [7, 7, 7], "moves restore only dirty rectangles");
});

test("F1: preview decoder failure shows classified copy and clears busy state", async () => {
  await upload();
  await page.evaluate(() => {
    window.createImageBitmap = async () => {
      throw new DOMException("The source image could not be decoded.", "InvalidStateError");
    };
    window.__cutoutTest.useWorkspace.getState().setFeather(1);
  });
  const alert = page.getByRole("alert");
  await alert.waitFor();
  assert.match(
    await alert.textContent(),
    /This image is damaged or in a format this browser can’t read\./,
  );
  assert.doesNotMatch(await alert.textContent(), /InvalidStateError|could not be decoded/);
  assert.equal(
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().previewBusy),
    false,
  );
});

test("E05-G-03: subject re-cut shows classified copy instead of loader text", async () => {
  await upload();
  await page.evaluate(() => {
    window.failRecut = true;
  });
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  await page.getByText(/The cutout is one piece/).waitFor();
  await page.getByRole("button", { name: "Fix area", exact: true }).click();
  const surface = page.getByLabel("Choose subject canvas", { exact: true });
  const box = await surface.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 5 });
  await page.mouse.up();
  const message =
    "The local remover couldn’t start on this device. Check your connection and try again.";
  await page.getByRole("dialog").getByText(message, { exact: true }).waitFor();
  assert.doesNotMatch(
    await page.getByRole("dialog").innerText(),
    /Could not load birefnet|Failed to fetch/,
  );
});

test("E09-S-02: reduced motion keeps the ready stage visible without animation", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 568 });
  await upload();
  const stage = page.locator(".stage-media.is-ready");
  await stage.waitFor();
  const style = await stage.evaluate((el) => {
    const css = getComputedStyle(el);
    return { animation: css.animationName, opacity: css.opacity, willChange: css.willChange };
  });
  assert.deepEqual(style, { animation: "none", opacity: "1", willChange: "auto" });
});

test("E04-04: WebGPU and CPU mattes have identical alpha and at most one RGB level of difference", async (t) => {
  const available = await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter()));
  if (!available) return t.skip("WebGPU is unavailable on this host");
  const results = await page.evaluate(async () => {
    const { unblendSpill, buildBackdropGrid } = await import("/src/lib/defringe.ts");
    const { unblendMatteGpu } = await import("/src/lib/gpu-matte.ts");
    const width = 1024,
      height = 512;
    const source = new ImageData(width, height);
    const base = new ImageData(width, height);
    let seed = 99;
    const random = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) / 0xffffffff;
    };
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const distance = Math.hypot(x - width / 2, y - height / 2);
        const inside = distance < 180;
        const f = 228 + ((x >> 4) & 3) - 2 + Math.floor(random() * 14) - 7;
        const rgb = inside ? [200 - distance / 4, 90 + (x & 15), 60] : [f, f - 4, f - 8];
        source.data.set([...rgb, 255], i);
        base.data.set(
          [
            ...rgb,
            inside ? Math.round(255 * (1 - Math.max(0, Math.min(1, (distance - 170) / 20)))) : 0,
          ],
          i,
        );
      }
    const results = [];
    for (const maskWorked of [true, false]) {
      const scene = {
        field: { r: 226, g: 222, b: 218 },
        jpeg: false,
        isGraphic: false,
        hasBlankField: true,
        maskWorked,
        exactTol2: 81,
        nearTol2: 784,
      };
      const grid = buildBackdropGrid(base.data, source.data, width, height, scene.field);
      const cpu = new ImageData(new Uint8ClampedArray(base.data), width, height);
      const gpu = new ImageData(new Uint8ClampedArray(base.data), width, height);
      unblendSpill(cpu.data, source.data, width, height, grid, scene);
      const gpuOk = await unblendMatteGpu(gpu, source, scene, grid);
      let alphaFlips = 0,
        maxDelta = 0;
      for (let i = 0; i < cpu.data.length; i++) {
        const delta = Math.abs(cpu.data[i] - gpu.data[i]);
        if (i % 4 === 3 && delta) alphaFlips++;
        maxDelta = Math.max(maxDelta, delta);
      }
      results.push({ gpuOk, maskWorked, alphaFlips, maxDelta });
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.gpuOk, true, JSON.stringify(result));
    assert.equal(result.alphaFlips, 0, JSON.stringify(result));
    assert.ok(result.maxDelta <= 1, JSON.stringify(result));
  }
});
