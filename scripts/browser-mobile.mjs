import { test as nodeTest } from "node:test";
import assert from "node:assert/strict";
import { chromium, webkit, devices } from "playwright";
import { bypassCsp, launchChrome, tolerantTest } from "./chrome.mjs";
// An "iPhone: …" (WebKit) test skips if Linux WPE WebKit crashes.
const test = tolerantTest(nodeTest, (name) => name.startsWith("iPhone:"));
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";
const url = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
async function open(t, browserType, device, run) {
  const browser = await (browserType === chromium
    ? launchChrome()
    : browserType.launch({}).then(bypassCsp));
  try {
    const page = await browser.newPage({ ...devices[device] });
    await page.goto(e2eUrl(url));
    await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
    // Playwright's Windows WebKit has no OffscreenCanvas, and Cutout rightly refuses it
    // (browser-unsupported.mjs covers that case). Linux and macOS WebKit have it: there
    // these tests run, so every environment checks WebKit one way or the other.
    if (!(await page.evaluate(() => typeof OffscreenCanvas === "function"))) {
      t.skip("this WebKit build has no OffscreenCanvas; browser-unsupported.mjs covers it");
      return;
    }
    await run(page);
  } finally {
    await browser.close();
  }
}
async function upload(page) {
  const data = await page.evaluate(() => {
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
  await page.getByRole("button", { name: "Choose files", exact: true }).tap();
  await (
    await chooser
  ).setFiles({ name: "phone.png", mimeType: "image/png", buffer: Buffer.from(data, "base64") });
  await page.waitForFunction(
    () =>
      window.__cutoutTest.useWorkspace.getState().items[0]?.status === "done" &&
      !window.__cutoutTest.useWorkspace.getState().previewBusy,
  );
}
for (const [name, browserType, device] of [
  ["iPhone", webkit, "iPhone 13"],
  ["Android", chromium, "Pixel 7"],
]) {
  test(`${name}: touch controls, input sizing, brush and rotated dialogs`, async (t) =>
    open(t, browserType, device, async (page) => {
      await upload(page);
      await page.getByRole("button", { name: "Adjust", exact: true }).tap();
      await page.getByText("Quality & file size", { exact: true }).tap();
      await page.getByLabel("Target file size", { exact: true }).check();
      const input = page.getByRole("spinbutton", { name: "Maximum size (KB)" });
      assert.ok(await input.evaluate((e) => parseFloat(getComputedStyle(e).fontSize) >= 16));
      await input.fill("20");
      await input.press("Tab");
      assert.equal(
        await page.evaluate(() => {
          const s = window.__cutoutTest.useWorkspace.getState();
          return s.settings[s.activeId].targetKB;
        }),
        20,
      );
      await page.getByRole("button", { name: "Close adjust", exact: true }).tap();
      await page.getByRole("button", { name: "Batch (1)", exact: true }).tap();
      // The dialog enters from scale(0.99) and boundingBox() reports the transformed box, so measure it settled.
      const batch = page.getByRole("dialog", { name: "Batch images", exact: true });
      await batch.evaluate((e) =>
        Promise.allSettled(
          e
            .getAnimations({ subtree: true })
            .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime))
            .map((a) => a.finished),
        ),
      );
      const label = await batch.locator(".batch-select").boundingBox();
      assert.ok(
        label.width >= 44 && label.height >= 44,
        `Batch checkbox target ${label.width}x${label.height}`,
      );
      await page.getByLabel("Select phone.png", { exact: true }).check();
      await page.getByRole("button", { name: "Close batch images" }).tap();
      await page.getByRole("button", { name: "Brush", exact: true }).tap();
      await page.getByText("0 strokes · Erase", { exact: true }).waitFor();
      const c = page.getByLabel("Erase brush canvas");
      const box = await c.boundingBox();
      await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
      await page.getByText("1 stroke · Erase", { exact: true }).waitFor();
      assert.equal(
        await c.evaluate(
          (e) => e.getContext("2d").getImageData(e.width / 2, e.height / 2, 1, 1).data[3],
        ),
        0,
      );
      await page.setViewportSize({ width: 844, height: 390 });
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      assert.equal(
        await dialog.evaluate((e) => {
          const r = e.getBoundingClientRect();
          return r.x >= 0 && r.y >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
        }),
        true,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await page.getByRole("button", { name: "Close brush" }).tap();
      await page.goto(e2eUrl(url, "/guide"));
      const footer = page.getByRole("navigation", { name: "Footer", exact: true });
      await footer.scrollIntoViewIfNeeded();
      assert.equal(await footer.isVisible(), true);
      // The router finishes hydrating after load and settles its own URL; leaving early makes WebKit report the next goto as interrupted.
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(750);
      await page.goto(e2eUrl(url));
      await page.getByRole("navigation", { name: "Footer", exact: true }).scrollIntoViewIfNeeded();
      assert.equal(
        await page.getByRole("navigation", { name: "Footer", exact: true }).isVisible(),
        true,
      );
    }));
}

test("iPhone: expired activation gets a fresh tap without encoding again", async (t) =>
  open(t, webkit, "iPhone 13", async (page) => {
    await page.evaluate(() => {
      const activation = navigator.userActivation;
      window.expiredActivation = true;
      window.sharedFiles = [];
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        get: () => (window.expiredActivation ? { isActive: false } : activation),
      });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async ({ files }) => {
          if (!activation.isActive) throw new DOMException("No gesture", "NotAllowedError");
          window.sharedFiles = files.map((f) => ({ name: f.name, type: f.type, size: f.size }));
        },
      });
    });
    await upload(page);
    await page.getByRole("button", { name: "Download PNG", exact: true }).tap();
    await page.getByRole("dialog", { name: "Your image is ready" }).waitFor();
    assert.equal(await page.evaluate(() => window.sharedFiles.length), 0);
    await page.evaluate(() => {
      window.expiredActivation = false;
    });
    await page.getByRole("button", { name: "Share image", exact: true }).tap();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    const files = await page.evaluate(() => window.sharedFiles);
    assert.equal(files.length, 1);
    assert.equal(files[0].type, "image/png");
    assert.ok(files[0].size > 0);
    assert.equal(
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().exporting),
      false,
    );
  }));

test("iPhone: prepared share can download or dismiss without getting stuck", async (t) =>
  open(t, webkit, "iPhone 13", async (page) => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, "userActivation", {
        configurable: true,
        value: { isActive: false },
      });
      Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: async () => {
          throw new DOMException("Blocked", "NotAllowedError");
        },
      });
    });
    await upload(page);
    await page.getByRole("button", { name: "Download PNG", exact: true }).tap();
    await page.getByRole("dialog", { name: "Your image is ready" }).waitFor();
    await page.getByRole("button", { name: "Close your image is ready" }).tap();
    await page.waitForFunction(() => !window.__cutoutTest.useWorkspace.getState().exporting);
    await page.getByRole("button", { name: "Download PNG", exact: true }).tap();
    await page.getByRole("dialog", { name: "Your image is ready" }).waitFor();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download file", exact: true }).tap();
    const file = await pending;
    assert.equal(file.suggestedFilename(), "phone-cutout.png");
    await page.waitForFunction(() => !window.__cutoutTest.useWorkspace.getState().exporting);
  }));
