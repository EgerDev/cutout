// Local storage hygiene (F-PRIV-04): a visit that never saves leaves no database, Delete
// removes the database and workspace settings (including the owned GPU failure record and the
// legacy bg0 note) and resets the page's in-process GPU failure flag, and resuming keeps
// autosave as the user set it. npm run dev or a production server must be running at APP_URL;
// the in-process flag row needs the dev server (it imports /src/lib/removal-provider.ts).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webkit } from "playwright";
import { after, before, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

const databases = (page) =>
  page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name));

async function openWorkspace(context) {
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(new URL("/?e2e", appUrl).href, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Save workspace" }).waitFor();
  return page;
}

async function openDialog(page, label) {
  await page.getByRole("button", { name: label }).click();
  return page.getByRole("dialog");
}

test("save, resume and delete touch storage only as far as the user asked", async (t) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await openWorkspace(context);
    await page.waitForLoadState("networkidle");
    assert.equal((await databases(page)).includes("cutout-workspace"), false);

    const png = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = "black";
      ctx.fillRect(24, 24, 48, 48);
      return canvas.toDataURL().split(",")[1];
    });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "graphic.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    });
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
    let dialog = await openDialog(page, "Save workspace");
    await dialog.getByRole("button", { name: "Enable local autosave" }).click();
    await dialog.getByText("Saved on this device.").waitFor();
    await dialog.getByRole("button", { name: "Pause autosave" }).click();
    assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), "1");

    // A fresh page: the saved copy is found, and resuming leaves autosave off.
    await page.evaluate(() => {
      localStorage.setItem("cutout.enhance.tileMs", '{"2":40}');
      localStorage.setItem("bg0:webgpu-failure:test", navigator.userAgent);
      // The owned record (Q8): a colon key the Delete sweep must also remove.
      localStorage.setItem(
        "cutout:removal-webgpu-failure:v1",
        JSON.stringify({ version: 1, fingerprint: "seed", kind: "gpu-mask" }),
      );
    });
    const second = await openWorkspace(context);
    dialog = await openDialog(second, "Saved workspace");
    await dialog.getByRole("button", { name: "Resume saved workspace" }).click();
    await second.waitForFunction(
      () => window.__cutoutTest.useWorkspace.getState().items.length === 1,
    );
    dialog = await openDialog(second, "Saved workspace");
    await dialog.getByText("Workspace restored. Autosave is off.").waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Enable local autosave" }).count(), 1);

    await page.close();
    // Q7: besides the stored keys, Delete resets the page's in-process failure flag. The
    // dev server serves the same module instance the app uses; a production build does not.
    const flagRow = await second.evaluate(async () => {
      try {
        const provider = await import("/src/lib/removal-provider.ts");
        provider.rememberGpuFailure("gpu-mask");
        return provider.readGpuFailure() === true ? "armed" : "flag not set";
      } catch {
        return "no source modules";
      }
    });
    if (flagRow !== "armed") {
      assert.equal(flagRow, "no source modules", flagRow);
      if (process.env.CUTOUT_REQUIRE_E2E) assert.fail("flag row needs the dev server");
      t.diagnostic("Delete flag row skipped: this server does not serve /src modules.");
    }
    second.once("dialog", (confirmation) => confirmation.accept());
    await dialog.getByRole("button", { name: "Delete saved workspace" }).click();
    await dialog.getByText("Saved workspace deleted. Autosave is off.").waitFor();
    assert.equal((await databases(second)).includes("cutout-workspace"), false);
    const keys = await second.evaluate(() => Object.keys(localStorage));
    assert.deepEqual(
      keys.filter(
        (key) =>
          key.startsWith("cutout.") ||
          key === "cutout:removal-webgpu-failure:v1" ||
          key.startsWith("bg0:webgpu-failure:"),
      ),
      [],
    );
    if (flagRow === "armed") {
      assert.equal(
        await second.evaluate(async () =>
          (await import("/src/lib/removal-provider.ts")).readGpuFailure(),
        ),
        false,
        "Delete saved workspace resets the page's in-process GPU failure flag",
      );
    }
  } finally {
    await context.close();
  }
});

test("failed autosave shows plain copy, marks the header unsaved and retains the old saved copy", async () => {
  const context = await browser.newContext({viewport:{width:1280,height:800}});
  try {
    const page = await openWorkspace(context);
    await page.waitForFunction(()=>Boolean(window.__cutoutTest?.useWorkspace));
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width=canvas.height=32;
      const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,32,32);ctx.fillStyle='black';ctx.fillRect(8,8,16,16);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve));
      const file=new File([blob],'a.png',{type:'image/png'});
      window.__cutoutTest.useWorkspace.getState().receiveFiles([file]);
    });
    await page.waitForFunction(()=>window.__cutoutTest.useWorkspace.getState().items.some(item=>item.status==='done'));
    const dialog = await openDialog(page,'Save workspace');
    await dialog.getByRole('button',{name:'Enable local autosave'}).click();
    await dialog.getByText('Saved on this device.',{exact:true}).waitFor();
    await page.evaluate(()=>{
      const store=window.__cutoutTest.useWorkspace, state=store.getState();
      state.changeEdit({recolors:Array.from({length:25},()=>({from:'#112233',to:null}))});
    });
    await dialog.getByText(/Not saved/).waitFor();
    const text=await dialog.innerText();
    assert.ok(!/too_big|maximum|"path"|Zod/.test(text),text);
    assert.equal(await page.locator('.header-label-full').filter({hasText:/^Save workspace$/}).count(),1);
    assert.equal(await dialog.getByRole('button',{name:'Delete saved workspace'}).count(),1,'last successful save remains available');
    assert.equal(await page.evaluate(()=>{
      const s=window.__cutoutTest.useWorkspace.getState();return s.settings[s.activeId].recolors.length;
    }),25,'failed saves preserve edits');
  } finally { await context.close(); }
});


async function poll(page, fn, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await page.evaluate(fn)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error("poll timeout");
}

async function holdForeignWorkspace(page) {
  const wrapped = await page.evaluate(async () => {
    window.foreignDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open("cutout-workspace", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("sessions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    localStorage.setItem("cutout.saved", "1");
    window.nativeEvents = [];
    let n = 0;
    // WebKit may replace the IDBFactory instance; wrap the prototype so page calls are counted.
    const nativeDelete = IDBFactory.prototype.deleteDatabase;
    IDBFactory.prototype.deleteDatabase = function (...args) {
      const id = ++n;
      window.nativeEvents.push("request" + id);
      const request = nativeDelete.apply(this, args);
      for (const event of ["blocked", "success", "error"])
        request.addEventListener(event, () => window.nativeEvents.push(event + id));
      return request;
    };
    return IDBFactory.prototype.deleteDatabase !== nativeDelete;
  });
  assert.equal(wrapped, true, "native deleteDatabase wrap must stick");
}

async function addGraphic(page) {
  await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace));
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = "black";
    ctx.fillRect(8, 8, 16, 16);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    window.__cutoutTest.useWorkspace.getState().receiveFiles([
      new File([blob], "graphic.png", { type: "image/png" }),
    ]);
  });
  await poll(page, () => {
    const state = window.__cutoutTest.useWorkspace.getState();
    return state.items.length >= 1 && Boolean(state.settings[state.items[0].id]);
  });
}

async function retryContext(engine) {
  if (engine !== "webkit") {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      bypassCSP: false,
    });
    return { context, close: () => context.close() };
  }
  // Ephemeral WebKit contexts cannot store Blob/File values in IndexedDB.
  // Persistent profile workflow matches review-p2-editor-low webkit-resume.mjs.
  const profile = await mkdtemp(
    join(process.env.CUTOUT_BROWSER_PROFILE || tmpdir(), "cutout-webkit-retry-"),
  );
  try {
    const context = await webkit.launchPersistentContext(profile, {
      headless: true,
      viewport: { width: 1280, height: 800 },
    });
    return {
      context,
      close: async () => {
        try {
          await context.close();
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}

for (const engine of ['chromium','webkit']) {
  test(`blocked storage deletion settles in ${engine}`, async () => {
    const ownBrowser = engine === 'webkit' ? await webkit.launch() : null;
    const context = await (ownBrowser ?? browser).newContext({viewport:{width:1280,height:800}});
    try {
      const page = await openWorkspace(context);
      const dialog = await openDialog(page,'Save workspace');
      await dialog.getByText('Local autosave is off.',{exact:true}).waitFor();
      await page.evaluate(async () => {
        window.foreignDb = await new Promise((resolve,reject) => {
          const request=indexedDB.open('cutout-workspace',1);
          request.onupgradeneeded=()=>request.result.createObjectStore('sessions');
          request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
        });
        localStorage.setItem('cutout.saved','1');
      });
      await dialog.getByRole('button',{name:'Clear local workspace data'}).click();
      await dialog.getByText(/Could not delete the saved workspace/).waitFor({timeout:2000});
      assert.equal(await dialog.getByRole('button',{name:'Clear local workspace data'}).isEnabled(),true);
      assert.equal(await page.evaluate(()=>localStorage.getItem('cutout.saved')),'1');
      await page.evaluate(()=>window.foreignDb.close());
    } finally { await context.close(); await ownBrowser?.close(); }
  });

  test(`blocked storage deletion retry settles in ${engine}`, async () => {
    const launched = await retryContext(engine);
    try {
      const page = await openWorkspace(launched.context);
      await addGraphic(page);
      const dialog = await openDialog(page, "Save workspace");
      await dialog.getByText("Local autosave is off.", { exact: true }).waitFor();
      await holdForeignWorkspace(page);
      const clear = dialog.getByRole("button", { name: "Clear local workspace data" });
      await clear.click();
      await dialog.getByText(/Could not delete the saved workspace/).waitFor({ timeout: 2000 });
      assert.equal(await clear.isEnabled(), true);
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), "1");

      await clear.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      assert.equal(
        await clear.isEnabled(),
        true,
        "Retry must settle promptly while a foreign holder still blocks the earlier native delete request",
      );
      assert.match(await dialog.getByRole("status").innerText(), /Could not delete the saved workspace/);
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), "1");
      const duringHold = JSON.parse(await page.evaluate(() => JSON.stringify(window.nativeEvents)));
      assert.equal(duringHold.filter((event) => event.startsWith("request")).length, 1);
      assert.ok(duringHold.includes("blocked1"));
      assert.equal(await dialog.getByRole("button", { name: "Enable local autosave" }).isEnabled(), true);

      await page.evaluate(() => window.foreignDb.close());
      await poll(page, () => window.nativeEvents.includes("success1"), 5000);

      await clear.click();
      await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);

      await dialog.getByRole("button", { name: "Enable local autosave" }).click();
      await dialog.getByText("Saved on this device.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), "1");
      assert.equal(
        await page.evaluate(async () => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("cutout-workspace", 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const value = await new Promise((resolve, reject) => {
            const get = db.transaction("sessions").objectStore("sessions").get("current");
            get.onsuccess = () => resolve(get.result);
            get.onerror = () => reject(get.error);
          });
          db.close();
          return value?.items?.[0]?.source instanceof Blob;
        }),
        true,
        "subsequent save must store a real image Blob",
      );

      page.once("dialog", (confirmation) => confirmation.accept());
      await dialog.getByRole("button", { name: "Delete saved workspace" }).click();
      await dialog.getByText("Saved workspace deleted. Autosave is off.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem("cutout.saved")), null);
    } finally {
      await launched.close();
    }
  });
}
