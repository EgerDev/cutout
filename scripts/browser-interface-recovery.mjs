import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
// Requires npm run dev (or APP_URL pointing at a production preview).
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchChrome } from "./chrome.mjs";

async function workspace(run, width = 1280) {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.goto(verifiedAppUrl);
    await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d");
      context.fillStyle = "white";
      context.fillRect(0, 0, 96, 96);
      context.fillStyle = "black";
      context.fillRect(24, 24, 48, 48);
      return canvas.toDataURL().split(",")[1];
    });
    await page
      .locator("input[type=file]")
      .first()
      .setInputFiles({
        name: "product.png",
        mimeType: "image/png",
        buffer: Buffer.from(base64, "base64"),
      });
    await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
    await run(page);
  } finally {
    await browser.close();
  }
}

test("Escape preserves a ready workspace when no panel is open", async () =>
  workspace(async (page) => {
    // Given a completed image, When Escape is pressed, Then the result remains downloadable.
    await page.locator("body").click({ position: { x: 2, y: 100 } });
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 1);
  }));

test("pasting an image preserves the workspace while an editor dialog owns focus", async () =>
  workspace(async (page) => {
    // Given an open editor, When an image is pasted, Then its underlying image is retained.
    await page.getByRole("button", { name: "Brush", exact: true }).click();
    await page.getByRole("dialog", { name: "Brush" }).waitFor();
    const original = await page.evaluate(
      () => window.__cutoutTest?.useWorkspace.getState().activeId,
    );
    await page.evaluate(() => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(
        new File([new Uint8Array([1, 2, 3])], "pasted.png", { type: "image/png" }),
      );
      document.activeElement.dispatchEvent(
        new ClipboardEvent("paste", { bubbles: true, clipboardData }),
      );
    });
    assert.equal(
      await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().activeId),
      original,
    );
  }));

for (const width of [320, 640, 720])
  test(`all image actions fit inside a ${width}px viewport`, async () =>
    workspace(async (page) => {
      // Given a narrow workbench, When image actions render, Then every action is reachable.
      // Measure after the entry animation; otherwise the slide-in frame reads as out-of-bounds.
      await page
        .getByRole("toolbar", { name: "Image actions" })
        .evaluate((el) =>
          Promise.allSettled(el.getAnimations({ subtree: true }).map((a) => a.finished)),
        );
      const outside = await page
        .getByRole("toolbar", { name: "Image actions" })
        .locator("button")
        .evaluateAll((buttons) =>
          buttons
            .filter((button) => {
              const r = button.getBoundingClientRect();
              return r.x < 0 || r.right > innerWidth || r.bottom > innerHeight;
            })
            .map((button) => button.getAttribute("aria-label")),
        );
      assert.deepEqual(outside, []);
    }, width));

test("cancelling logo clear preserves the completed image", async () =>
  workspace(async (page) => {
    // Given a completed image, When clearing is cancelled, Then the result remains.
    let confirmation = false;
    page.on("dialog", async (dialog) => {
      confirmation = true;
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: /^Cutout —/ }).click();
    assert.equal(confirmation, true);
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 1);
  }));

test("named Batch retry recovers the failed image while preserving the selected ready image", async () =>
  workspace(async (page) => {
    // UI-06: a global message has no item identity; Batch owns the named retry.
    const readyId = await page.evaluate(() => {
      const state = window.__cutoutTest?.useWorkspace.getState();
      const ready = state.items[0];
      window.readyBeforeRetry = ready;
      window.readySettingsBeforeRetry = state.settings[ready.id];
      window.retriedImages = [];
      const retryItem = state.retryItem;
      window.__cutoutTest?.useWorkspace.setState({
        items: [
          ready,
          {
            ...ready,
            id: "failed-image",
            name: "failed.png",
            status: "error",
            resultBlob: null,
            resultUrl: null,
            error: "Temporary error. Try again.",
            retryable: true,
          },
        ],
        selectedIds: [ready.id],
        errorMessage: "Temporary error. Try again.",
        retryItem: (id) => {
          window.retriedImages.push(id);
          retryItem(id);
        },
      });
      return ready.id;
    });
    await page.getByRole("button", { name: "failed.png · Failed", exact: true }).click();
    await page.getByRole("button", { name: "product.png · Ready", exact: true }).click();
    const alert = page.getByRole("alert");
    assert.equal(await alert.getByRole("button").count(), 1);
    await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
    await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
    const batch = page.getByRole("dialog", { name: "Batch images", exact: true });
    await batch.getByRole("button", { name: "Retry failed.png", exact: true }).click();
    await page.waitForFunction(
      () =>
        window.__cutoutTest.useWorkspace.getState().items.find((item) => item.id === "failed-image")
          ?.status === "done",
    );
    assert.deepEqual(
      await page.evaluate(() => {
        const state = window.__cutoutTest.useWorkspace.getState();
        const ready = window.readyBeforeRetry;
        const recovered = state.items.find((item) => item.id === "failed-image");
        return {
          retried: window.retriedImages,
          ids: state.items.map((item) => item.id),
          activeId: state.activeId,
          selectedIds: state.selectedIds,
          readyPreserved:
            state.items[0] === ready &&
            state.settings[ready.id] === window.readySettingsBeforeRetry,
          recoveredSourcePreserved: recovered.source === ready.source,
          hasResult: recovered.resultBlob?.size > 0,
          errorMessage: state.errorMessage,
        };
      }),
      {
        retried: ["failed-image"],
        ids: [readyId, "failed-image"],
        activeId: readyId,
        selectedIds: [readyId],
        readyPreserved: true,
        recoveredSourcePreserved: true,
        hasResult: true,
        errorMessage: null,
      },
    );
    await batch.getByRole("button", { name: "Close batch images", exact: true }).click();
    await page.getByRole("toolbar", { name: "Image actions", exact: true }).waitFor();
  }));

test("cancelling batch removal retains the image and its edits", async () =>
  workspace(async (page) => {
    // Given a batch image, When removal is cancelled, Then its result is retained.
    await page.getByRole("button", { name: "Batch (1)", exact: true }).click();
    await page.getByRole("dialog", { name: "Batch images" }).waitFor();
    let confirmation = false;
    page.on("dialog", async (dialog) => {
      confirmation = true;
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Remove product.png", exact: true }).click();
    assert.equal(confirmation, true);
    assert.equal(
      await page.getByRole("button", { name: "Remove product.png", exact: true }).count(),
      1,
    );
  }));

test("cancelling saved workspace deletion retains its saved copy", async () =>
  workspace(async (page) => {
    // Given a saved copy, When deletion is cancelled, Then it can still be resumed later.
    await page.getByRole("button", { name: "Save workspace", exact: true }).click();
    await page.getByRole("button", { name: "Enable local autosave", exact: true }).click();
    await page.getByRole("button", { name: "Delete saved workspace", exact: true }).waitFor();
    let confirmation = false;
    page.on("dialog", async (dialog) => {
      confirmation = true;
      await dialog.dismiss();
    });
    await page.getByRole("button", { name: "Delete saved workspace", exact: true }).click();
    assert.equal(confirmation, true);
    assert.equal(
      await page.getByRole("button", { name: "Delete saved workspace", exact: true }).count(),
      1,
    );
  }));

test("processing at zero reports zero accessible progress", async () =>
  workspace(async (page) => {
    // Given an image starting processing, When its progress is zero, Then zero is exposed.
    await page.evaluate(() => {
      const state = window.__cutoutTest?.useWorkspace.getState();
      window.__cutoutTest?.useWorkspace.setState({
        items: state.items.map((item) => ({ ...item, status: "working" })),
        progress: { message: "Preparing image", progress: 0 },
      });
    });
    const bar = page.getByRole("progressbar");
    await bar.waitFor();
    assert.equal(await bar.getAttribute("aria-valuenow"), "0");
  }));

test("failed model downloads never announce offline readiness", async () => {
  // Given failed model hosts, When download-all finishes, Then recovery replaces success.
  const browser = await launchChrome();
  try {
    const context = await browser.newContext();
    await context.route(/huggingface\.co|cdn\.jsdelivr\.net/, (route) => route.abort());
    const page = await context.newPage();
    await page.goto(verifiedAppUrl);
    await page
      .getByRole("button", { name: "On-device models · download ahead", exact: true })
      .click();
    await page.getByRole("button", { name: "Download all now", exact: true }).click();
    await page.waitForFunction(
      () => {
        const dialog = document.querySelector('[role="dialog"]');
        return (
          dialog?.querySelector('[role="status"]') &&
          [...dialog.querySelectorAll("button")].every((button) => !button.disabled)
        );
      },
      undefined,
      { timeout: 60000 },
    );
    const message = await page.getByRole("dialog").getByRole("status").innerText();
    assert.doesNotMatch(message, /all models are on this device|now works offline/i);
    assert.match(message, /try again|retry/i);
  } finally {
    await browser.close();
  }
});

test("metadata filtering keeps a visible label after entering a query", async () =>
  workspace(async (page) => {
    // Given image metadata, When its filter contains a query, Then the field stays named.
    await page.getByRole("button", { name: "Info", exact: true }).click();
    const filter = page.getByRole("textbox", { name: "Filter metadata", exact: true });
    await filter.fill("width");
    const label = page.locator('label[for="metadata-filter"]');
    assert.equal(await label.isVisible(), true);
  }));
