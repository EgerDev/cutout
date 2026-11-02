import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(/\/$/, "");
import assert from "node:assert/strict";
import test from "node:test";
import { launchChrome } from "./chrome.mjs";

for (const action of ["reset", "replace", "cancel"]) {
  test(`releases enhancement controllers when the user chooses ${action}`, async () => {
    const browser = await launchChrome();
    try {
      const page = await browser.newPage();
      await page.goto(verifiedAppUrl);
      await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
      // Given a real workspace item and enhancement before its first async boundary.
      const report = await page.evaluate(async (action) => {
        const loaded = performance.getEntriesByType("resource").find((entry) => new URL(entry.name).pathname === "/src/lib/workspace-runtime.ts");
        const { runtime } = await import(loaded?.name ?? "/src/lib/workspace-runtime.ts");
        const canvas = document.createElement("canvas");
        canvas.width = 128; canvas.height = 64;
        const ctx = canvas.getContext("2d");
        ctx.fillRect(32, 16, 64, 32);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const file = new File([blob], "enhance.png", { type: "image/png" });
        const store = window.__cutoutTest?.useWorkspace;
        store.getState().receiveFiles([file]);
        // Wait for successful actual image removal via store subscription.
        await new Promise((resolve) => {
          if (store.getState().items[0]?.status === "done") return resolve();
          const unsubscribe = store.subscribe((s) => { if (s.items[0]?.status === "done") { unsubscribe(); resolve(); } });
        });
        const id = store.getState().activeId;
        const pending = store.getState().enhanceActive();
        const controller = runtime.itemAborts.get(id);
        // When work is reset, replaced, or explicitly cancelled.
        if (action === "reset") store.getState().reset();
        else if (action === "replace") store.getState().receiveFiles([file]);
        else store.getState().cancelEnhance();
        await pending;
        // Then the old controller is aborted and no longer retained.
        return { aborted: controller.signal.aborted, retained: [...runtime.itemAborts.values()].includes(controller), enhancing: store.getState().enhancing };
      }, action);
      assert.equal(report.aborted, true, "The discarded enhancement signal stayed live");
      assert.equal(report.retained, false, "The discarded enhancement controller stayed cached");
      assert.equal(report.enhancing, null);
    } finally { await browser.close(); }
  });
}
