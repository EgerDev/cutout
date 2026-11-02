// npm run dev must be running at APP_URL (the suite replaces src/lib/removal-client.ts's
// removeBackgroundAuto through the dev server's module route, so it cannot run against a
// production build). Stopping background removal from the interface: one image stops from its
// progress capsule and retries in place; a batch stops from its status line, keeps finished
// cutouts and resumes the rest; and a removal that ignores the stop cannot overwrite the result
// of the Retry that followed it. The store's own rules are covered in src/lib/workspace-cancel.
import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

/**
 * A removeBackgroundAuto that follows window.__cut.plan, one entry per call: "resolve",
 * "hang" (until its signal aborts) or "late" (ignores the abort and resolves when
 * window.__cut.release() runs, after a stray progress tick). Each call records whether its
 * signal was aborted; each result blob is kept so tests can tell whose result an image shows.
 */
const STUB = `
export async function removeBackgroundAuto(source, options = {}) {
  const cut = (globalThis.__cut ??= { calls: [], plan: [], releases: [], results: [] });
  const call = { name: source.name, aborted: false };
  cut.calls.push(call);
  const step = cut.plan.shift() ?? "resolve";
  const signal = options.signal;
  signal?.addEventListener("abort", () => { call.aborted = true; }, { once: true });
  options.onProgress?.({ stage: "cutting", progress: 0.4, message: "Finding subject" });
  const result = async () => {
    const bitmap = await createImageBitmap(source);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    cut.results.push({ call: cut.calls.indexOf(call), blob });
    return { blob, width: bitmap.width, height: bitmap.height, provider: "wasm", method: "auto" };
  };
  if (step === "resolve") return result();
  return new Promise((resolve, reject) => {
    if (step === "hang")
      signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")), { once: true });
    if (step === "late")
      cut.releases.push(() => {
        options.onProgress?.({ stage: "cutting", progress: 0.9, message: "Cleaning edges" });
        resolve(result());
      });
  });
}
globalThis.__cut ??= { calls: [], plan: [], releases: [], results: [] };
globalThis.__cut.release = () => { for (const release of globalThis.__cut.releases.splice(0)) release(); };
`;

async function open(plan) {
  const browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.route("**/src/lib/removal-client.ts*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("actual")) return route.continue();
    url.searchParams.set("actual", "1");
    return route.fulfill({
      contentType: "application/javascript",
      body: `export * from ${JSON.stringify(url.href)};\n${STUB}`,
    });
  });
  await page.addInitScript((value) => {
    globalThis.__cut = { calls: [], plan: value, releases: [], results: [] };
  }, plan);
  await page.goto(e2eUrl(appUrl));
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  return { page, close: () => browser.close() };
}

async function upload(page, count) {
  const files = await Promise.all(
    Array.from({ length: count }, async (_, index) => ({
      name: `photo-${index + 1}.png`,
      mimeType: "image/png",
      buffer: await sharp({
        create: {
          width: 96,
          height: 72,
          channels: 3,
          background: { r: 40 + index * 60, g: 90, b: 140 },
        },
      })
        .png()
        .toBuffer(),
    })),
  );
  await page.locator('input[type="file"][aria-label="Choose files"]').setInputFiles(files);
}

const calls = (page) => page.evaluate(() => globalThis.__cut.calls.map((call) => ({ ...call })));
const items = (page) =>
  page.evaluate(() =>
    window.__cutoutTest.useWorkspace
      .getState()
      .items.map(({ name, status, cancelled }) => ({ name, status, cancelled })),
  );
/** A Stop, Retry or Resume that has just replaced another ignores presses for a moment. */
const armed = (page, name) =>
  page
    .getByRole("button", { name, exact: true })
    .and(page.locator(":not([aria-disabled])"))
    .waitFor();
const summary = (page) => page.locator(".image-summary [role=status]").textContent();

test("Stop in the capsule ends one image's removal; the same button retries it", async () => {
  const { page, close } = await open(["hang", "resolve"]);
  try {
    await upload(page, 1);
    await armed(page, "Stop removing the background");
    // The keyboard path: focus stays on the button as Stop turns into Retry.
    await page.getByRole("button", { name: "Stop removing the background", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("status", { name: "Stopped", exact: true }).waitFor();
    assert.equal(await summary(page), "Stopped");
    assert.equal(await page.getByRole("alert").count(), 0, "a stop is not an error");
    assert.deepEqual(await items(page), [
      { name: "photo-1.png", status: "error", cancelled: true },
    ]);
    assert.deepEqual(await calls(page), [{ name: "photo-1.png", aborted: true }]);
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      "Retry",
      "focus stays on the button",
    );
    // A second press straight after (a double-click or Enter twice) does not undo the stop.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(150);
    assert.equal((await calls(page)).length, 1);
    await armed(page, "Retry");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Download PNG", exact: true }).waitFor();
    assert.equal(await summary(page), "Ready");
    assert.deepEqual(await items(page), [
      { name: "photo-1.png", status: "done", cancelled: undefined },
    ]);
    assert.equal(await page.locator(".status-capsule").count(), 0);
  } finally {
    await close();
  }
});

test("a batch stops from its status line, keeps finished cutouts, and Resume finishes the rest", async () => {
  const { page, close } = await open(["resolve", "hang"]);
  try {
    await upload(page, 3);
    await page.waitForFunction(() => globalThis.__cut.calls.length === 2);
    // The finished first image stays in view while the second is cut.
    await page.getByRole("button", { name: "Download PNG", exact: true }).waitFor();
    const kept = await page.evaluate(() => {
      window.keptBlob = window.__cutoutTest.useWorkspace.getState().items[0].resultBlob;
      return Boolean(window.keptBlob);
    });
    assert.ok(kept);
    assert.equal(await page.locator(".status-capsule").count(), 0);
    await armed(page, "Stop removing backgrounds");
    await page.getByRole("button", { name: "Stop removing backgrounds", exact: true }).click();
    await armed(page, "Resume 2 stopped images");
    assert.equal(await summary(page), "1/3 · 1 ready · 2 stopped");
    assert.deepEqual(await items(page), [
      { name: "photo-1.png", status: "done", cancelled: undefined },
      { name: "photo-2.png", status: "error", cancelled: true },
      { name: "photo-3.png", status: "error", cancelled: true },
    ]);
    assert.deepEqual(await calls(page), [
      { name: "photo-1.png", aborted: false },
      { name: "photo-2.png", aborted: true },
    ]);
    assert.ok(
      await page.evaluate(
        () => window.__cutoutTest.useWorkspace.getState().items[0].resultBlob === window.keptBlob,
      ),
      "the finished cutout is untouched",
    );
    await page.getByRole("button", { name: "Download PNG", exact: true }).waitFor();
    assert.equal(await page.getByRole("alert").count(), 0);
    for (const name of ["photo-2.png", "photo-3.png"])
      await page.getByRole("button", { name: `${name} · Stopped`, exact: true }).waitFor();
    // The batch list says the same and keeps each image's own Retry.
    await page.getByRole("button", { name: "Batch (3)", exact: true }).click();
    const batch = page.getByRole("dialog", { name: "Batch images", exact: true });
    assert.equal(await batch.getByText("Stopped", { exact: true }).count(), 2);
    assert.equal(
      await batch.getByRole("button", { name: "Retry photo-3.png", exact: true }).isEnabled(),
      true,
    );
    await page.keyboard.press("Escape");
    await batch.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Resume 2 stopped images", exact: true }).click();
    await page.waitForFunction(() =>
      window.__cutoutTest.useWorkspace.getState().items.every((item) => item.status === "done"),
    );
    assert.equal(await summary(page), "1/3 · 3 ready");
    assert.equal((await calls(page)).length, 4);
    assert.equal(await page.locator(".summary-action").count(), 0);
  } finally {
    await close();
  }
});

test("Retry right after Stop waits for a removal that ignored the stop, and keeps its own result", async () => {
  const { page, close } = await open(["late", "resolve"]);
  try {
    await upload(page, 1);
    await armed(page, "Stop removing the background");
    await page.getByRole("button", { name: "Stop removing the background", exact: true }).click();
    await armed(page, "Retry");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    // The first removal is still running, so the retry waits its turn.
    await page.getByRole("status", { name: "Queued", exact: true }).waitFor();
    assert.equal(await summary(page), "Queued");
    assert.equal((await calls(page)).length, 1);
    await page.evaluate(() => globalThis.__cut.release());
    await page.getByRole("button", { name: "Download PNG", exact: true }).waitFor();
    const result = await page.evaluate(() => {
      const shown = window.__cutoutTest.useWorkspace.getState().items[0].resultBlob;
      return globalThis.__cut.results.map((entry) => ({
        call: entry.call,
        shown: entry.blob === shown,
      }));
    });
    assert.deepEqual(
      result.sort((a, b) => a.call - b.call),
      [
        { call: 0, shown: false },
        { call: 1, shown: true },
      ],
      "the image shows the retry's cutout, not the stopped one",
    );
    assert.deepEqual(await calls(page), [
      { name: "photo-1.png", aborted: true },
      { name: "photo-1.png", aborted: false },
    ]);
    assert.equal(await summary(page), "Ready");
  } finally {
    await close();
  }
});

test("the progress bar eases to each value, and steps under reduced motion", async () => {
  const { page, close } = await open(["hang"]);
  try {
    await upload(page, 1);
    const fill = page.getByRole("progressbar").locator("div");
    await fill.waitFor();
    const duration = () => fill.evaluate((node) => getComputedStyle(node).transitionDuration);
    assert.notEqual(await duration(), "0s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await duration(), "0s");
  } finally {
    await close();
  }
});
