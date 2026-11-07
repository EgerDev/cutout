// E05-G-02: a failed model download recovers through the main notice’s item-bound Retry.
import assert from "node:assert/strict";
import test from "node:test";
import { appCandidates, e2eUrl } from "../app-url.mjs";
import { launchChrome } from "../chrome.mjs";
import { cutoutOrSkip } from "../require-server.mjs";

// Hugging Face and its file CDNs. A deployment with VITE_MODEL_HOST would need its host here.
const MODEL_HOSTS = /^https:\/\/([\w-]+\.)*(huggingface\.co|hf\.co)\//;

test(
  "a failed model download recovers through the main Retry notice",
  { timeout: 300_000 },
  async (t) => {
    const appUrl = await cutoutOrSkip(
      t,
      appCandidates("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"),
    );
    if (!appUrl) return;
    const browser = await launchChrome();
    t.after(() => browser.close());
    const context = await browser.newContext();
    const page = await context.newPage();

    let blocked = 0;
    const block = (route) => {
      blocked += 1;
      return route.abort("internetdisconnected");
    };
    await page.route(MODEL_HOSTS, block);
    await page.goto(e2eUrl(appUrl));
    await page.getByText("Try a sample").click();

    const alert = page.getByRole("alert");
    await alert.waitFor({ timeout: 60_000 });
    assert.ok(blocked > 0, "the model request never reached the network");
    assert.match(await alert.innerText(), /connection|couldn’t start|network|offline/i);
    const failed = await page.evaluate(() =>
      window.__cutoutTest.useWorkspace.getState().items.map((i) => [i.status, i.retryable]),
    );
    assert.deepEqual(failed, [["error", true]]);
    const target = await page.evaluate(() => {
      const state = window.__cutoutTest.useWorkspace.getState();
      window.failedModelItem = state.items[0];
      return { id: state.items[0].id, name: state.items[0].name, activeId: state.activeId };
    });
    assert.equal(target.activeId, target.id);
    assert.equal(await alert.getByRole("button").count(), 2);
    await page.unroute(MODEL_HOSTS, block);
    await alert.getByRole("button", { name: "Retry", exact: true }).click();
    await page.waitForFunction(
      (id) =>
        window.__cutoutTest.useWorkspace.getState().items.find((item) => item.id === id)?.status ===
        "done",
      target.id,
      { timeout: 180_000 },
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const state = window.__cutoutTest.useWorkspace.getState();
        const item = state.items[0];
        return {
          ids: state.items.map((entry) => entry.id),
          activeId: state.activeId,
          sourcePreserved: item.source === window.failedModelItem.source,
          hasResult: item.resultBlob?.size > 0 && item.width > 0 && item.height > 0,
          errorMessage: state.errorMessage,
        };
      }),
      {
        ids: [target.id],
        activeId: target.id,
        sourcePreserved: true,
        hasResult: true,
        errorMessage: null,
      },
    );
    await page.getByRole("toolbar", { name: "Image actions", exact: true }).waitFor();
  },
);
