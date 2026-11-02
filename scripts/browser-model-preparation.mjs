// npm run dev must be running at APP_URL (the suite replaces src/lib/models.ts's prepareModel
// through the dev server's module route, so it cannot run against a production build).
// The Models panel's own lifecycle: Cancel and closing the panel end only its waits, a
// timeout offers Retry that starts a fresh wait, Download all keeps going past a failure
// and stops when cancelled, and a late completion never reaches a reopened panel. A wait
// that ends early after saving files to the real Cache API still offers Retry (which keeps
// those files) beside Clear. The loader's sharing, deadlines and disposal are covered in
// src/lib (idle-model, models).
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

/**
 * A prepareModel that follows a per-model plan set on window.__prep.plan before the click:
 * "resolve", "fail", "timeout", "hang" (until its signal aborts) or "manual" (until
 * window.__prep.release() runs, which first sends a stray progress tick). "partial-fail" and
 * "partial-timeout" first save the model's config to the real Cache API, as a download that
 * stops after its first file does. An array is consumed one entry per call. Each call
 * records whether its signal was aborted.
 */
const STUB = `
const REPO = {
  birefnet: "studioludens/birefnet-lite-512",
  "swin2sr-x2": "Xenova/swin2SR-lightweight-x2-64",
  "swin2sr-x4": "Xenova/swin2SR-compressed-sr-x4-48",
  depth: "onnx-community/depth-anything-v2-small",
};
export async function prepareModel(id, onProgress, options = {}) {
  const prep = (globalThis.__prep ??= { calls: [], plan: {}, releases: [] });
  const call = { id, aborted: false };
  prep.calls.push(call);
  const signal = options.signal;
  let step = prep.plan[id] ?? prep.plan["*"] ?? "resolve";
  if (Array.isArray(step)) step = step.length > 1 ? step.shift() : step[0];
  const aborted = () => signal?.reason ?? new DOMException("The operation was aborted.", "AbortError");
  if (step.startsWith("partial-")) {
    const cache = await caches.open("transformers-cache");
    await cache.put(
      "https://huggingface.co/" + REPO[id] + "/resolve/main/config.json",
      new Response('{"model_type":"test"}', { headers: { "content-type": "application/json" } }),
    );
    onProgress?.(0.25);
    step = step.slice("partial-".length);
  }
  if (step === "resolve") { onProgress?.(1); return; }
  if (step === "fail") throw new Error("Failed to fetch");
  if (step === "timeout") throw new DOMException("Preparing took too long.", "TimeoutError");
  return new Promise((resolve, reject) => {
    signal?.addEventListener("abort", () => { call.aborted = true; reject(aborted()); }, { once: true });
    if (step === "manual") prep.releases.push(() => { onProgress?.(0.5); resolve(); });
  });
}
globalThis.__prep ??= { calls: [], plan: {}, releases: [] };
globalThis.__prep.release = () => { for (const release of globalThis.__prep.releases.splice(0)) release(); };
`;

async function openPanel(plan) {
  const browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.route("**/src/lib/models.ts*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("actual")) return route.continue();
    url.searchParams.set("actual", "1");
    return route.fulfill({
      contentType: "application/javascript",
      body: `export * from ${JSON.stringify(url.href)};\n${STUB}`,
    });
  });
  await page.addInitScript((value) => {
    globalThis.__prep = { calls: [], plan: value, releases: [] };
  }, plan);
  await page.goto(e2eUrl(appUrl));
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  await openModels(page);
  return { page, close: () => browser.close() };
}

const openModels = (page) =>
  page.getByRole("button", { name: "On-device models · download ahead", exact: true }).click();
const calls = (page) => page.evaluate(() => globalThis.__prep.calls.map((c) => ({ ...c })));
const note = (page, text) => page.getByRole("status").getByText(text, { exact: true }).waitFor();
const enabled = (page, name) =>
  page.getByRole("button", { name, exact: true }).and(page.locator(":enabled")).waitFor();
const row = (page, label) => page.locator("li", { hasText: label });
const buttons = (page, label) => row(page, label).getByRole("button").allTextContents();
/** Files of one model in the real Cache API, read through the panel's own accounting. */
const cachedFiles = (page, id) =>
  page.evaluate(async (id) => {
    const { listModelCache } = await import("/src/lib/models.ts?actual=1");
    return (await listModelCache()).find((entry) => entry.id === id).files;
  }, id);

test("Cancel ends the panel's wait, says the model may still finish, and offers Download again", async () => {
  const { page, close } = await openPanel({ birefnet: "hang" });
  try {
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    await page.locator("li", { hasText: "BiRefNet lite" }).getByText("Starting…").waitFor();
    await page.getByRole("button", { name: "Cancel BiRefNet lite", exact: true }).click();
    await note(page, "Stopped waiting. The model may finish preparing in the background.");
    assert.deepEqual(await calls(page), [{ id: "birefnet", aborted: true }]);
    await enabled(page, "Download BiRefNet lite");
  } finally {
    await close();
  }
});

test("a timed-out wait offers Retry, and Retry starts a fresh wait", async () => {
  const { page, close } = await openPanel({ birefnet: ["timeout", "resolve"] });
  try {
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    await note(page, "That took too long. Try again.");
    assert.doesNotMatch(await page.getByRole("dialog").innerText(), /couldn’t process this image/);
    await page.getByRole("button", { name: "Retry BiRefNet lite", exact: true }).click();
    await enabled(page, "Download BiRefNet lite");
    assert.equal(await page.getByRole("status").count(), 0, "a successful retry clears the note");
    assert.deepEqual(await calls(page), [
      { id: "birefnet", aborted: false },
      { id: "birefnet", aborted: false },
    ]);
  } finally {
    await close();
  }
});

test("Download all keeps going past a failure, reports it, and Retry targets that model", async () => {
  const { page, close } = await openPanel({ "swin2sr-x4": ["fail", "resolve"], "*": "resolve" });
  try {
    await page.getByRole("button", { name: "Download all now", exact: true }).click();
    await note(page, "Some models couldn’t be prepared. Try again.");
    assert.deepEqual(
      (await calls(page)).map((c) => c.id),
      ["birefnet", "swin2sr-x2", "swin2sr-x4", "depth"],
      "every model is tried, in order, after one fails",
    );
    await enabled(page, "Download Depth Anything V2 small");
    await page.getByRole("button", { name: "Retry Swin2SR ×4", exact: true }).click();
    await enabled(page, "Download Swin2SR ×4");
    assert.equal(await page.getByRole("status").count(), 0);
  } finally {
    await close();
  }
});

test("cancelling Download all ends the current wait and starts no further model", async () => {
  const { page, close } = await openPanel({ "swin2sr-x2": "hang", "*": "resolve" });
  try {
    await page.getByRole("button", { name: "Download all now", exact: true }).click();
    await page.waitForFunction(() => globalThis.__prep.calls.length === 2);
    await page.getByRole("button", { name: "Cancel download all", exact: true }).click();
    await note(page, "Stopped waiting. Models that finished stay on this device.");
    await page.waitForTimeout(300);
    assert.deepEqual(await calls(page), [
      { id: "birefnet", aborted: false },
      { id: "swin2sr-x2", aborted: true },
    ]);
    await enabled(page, "Download all now");
  } finally {
    await close();
  }
});

test("a stray tick from a cancelled wait cannot move the same row's new wait", async () => {
  const { page, close } = await openPanel({ birefnet: ["manual", "hang"] });
  try {
    const row = page.locator("li", { hasText: "BiRefNet lite" });
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    await row.getByText("Starting…").waitFor();
    await page.getByRole("button", { name: "Cancel BiRefNet lite", exact: true }).click();
    await note(page, "Stopped waiting. The model may finish preparing in the background.");
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    await row.getByText("Starting…").waitFor();
    // The first wait now reports 50% and resolves: neither may reach the second wait.
    await page.evaluate(() => globalThis.__prep.release());
    await page.waitForTimeout(300);
    assert.equal(await row.locator(".models-size").textContent(), "0%");
    assert.equal(await row.getByText("Starting…").count(), 1);
    await enabled(page, "Cancel BiRefNet lite");
    assert.deepEqual(await calls(page), [
      { id: "birefnet", aborted: true },
      { id: "birefnet", aborted: false },
    ]);
  } finally {
    await close();
  }
});

test("closing the panel ends its wait; a reopened panel ignores the late completion", async () => {
  const { page, close } = await openPanel({ birefnet: "manual" });
  try {
    await page.getByRole("button", { name: "Download BiRefNet lite", exact: true }).click();
    await page.locator("li", { hasText: "BiRefNet lite" }).getByText("Starting…").waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    assert.deepEqual(await calls(page), [{ id: "birefnet", aborted: true }]);
    await openModels(page);
    const row = page.locator("li", { hasText: "BiRefNet lite" });
    await enabled(page, "Download BiRefNet lite");
    await page.evaluate(() => globalThis.__prep.release());
    await page.waitForTimeout(300);
    assert.equal(await row.locator(".models-size").textContent(), "about 90–192 MB");
    assert.equal(await row.getByText("Starting…").count(), 0);
    assert.equal(await page.getByRole("status").count(), 0);
  } finally {
    await close();
  }
});

test("a timed-out wait that saved a file offers Retry above Clear; Retry keeps the file", async () => {
  const { page, close } = await openPanel({ depth: ["partial-timeout", "resolve"] });
  try {
    const depth = "Depth Anything V2 small";
    await page.getByRole("button", { name: `Download ${depth}`, exact: true }).click();
    await note(page, "That took too long. Try again.");
    await row(page, depth).getByText("Took too long", { exact: true }).waitFor();
    assert.deepEqual(await buttons(page, depth), ["Retry", "Clear"]);
    assert.equal(await row(page, depth).locator(".models-size").textContent(), "under 1 MB");
    await page.getByRole("button", { name: `Retry ${depth}`, exact: true }).click();
    await row(page, depth)
      .getByText("Depth-aware blur · on this device", { exact: true })
      .waitFor();
    assert.deepEqual(await buttons(page, depth), ["Clear"]);
    assert.equal(await cachedFiles(page, "depth"), 1, "Retry reused the saved file");
    assert.equal(await page.getByRole("status").count(), 0);
    assert.deepEqual(await calls(page), [
      { id: "depth", aborted: false },
      { id: "depth", aborted: false },
    ]);
  } finally {
    await close();
  }
});

test("a failed wait that saved a file can still be cleared, which leaves Download", async () => {
  const { page, close } = await openPanel({ "swin2sr-x2": ["partial-fail"] });
  try {
    const x2 = "Swin2SR ×2";
    await page.getByRole("button", { name: `Download ${x2}`, exact: true }).click();
    await row(page, x2).getByText("Didn’t finish", { exact: true }).waitFor();
    assert.deepEqual(await buttons(page, x2), ["Retry", "Clear"]);
    await page.getByRole("button", { name: `Clear ${x2}`, exact: true }).click();
    await note(page, "Removed 1 currently cached file. Active downloads can save files again.");
    await enabled(page, `Download ${x2}`);
    assert.deepEqual(await buttons(page, x2), ["Download"]);
    assert.equal(await cachedFiles(page, "swin2sr-x2"), 0);
  } finally {
    await close();
  }
});

test("Download all reports a model that stopped after saving a file; its Retry finishes it", async () => {
  const { page, close } = await openPanel({
    "swin2sr-x4": ["partial-fail", "resolve"],
    "*": "resolve",
  });
  try {
    const x4 = "Swin2SR ×4";
    await page.getByRole("button", { name: "Download all now", exact: true }).click();
    await note(page, "Some models couldn’t be prepared. Try again.");
    assert.deepEqual(await buttons(page, x4), ["Retry", "Clear"]);
    await enabled(page, `Retry ${x4}`);
    await page.getByRole("button", { name: `Retry ${x4}`, exact: true }).click();
    await row(page, x4)
      .getByText(/ · on this device$/)
      .waitFor();
    assert.deepEqual(await buttons(page, x4), ["Clear"]);
    assert.equal(await cachedFiles(page, "swin2sr-x4"), 1);
    assert.equal(await page.getByRole("status").count(), 0);
    assert.deepEqual(
      (await calls(page)).map((call) => call.id),
      ["birefnet", "swin2sr-x2", "swin2sr-x4", "depth", "swin2sr-x4"],
    );
  } finally {
    await close();
  }
});
