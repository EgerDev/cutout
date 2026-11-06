import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { mkdir, writeFile } from "node:fs/promises";

let browser, page;
const app = verifiedAppUrl;
const base = process.env.MODULE_URL ?? app;
beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.addInitScript(() => {
    window.rejections = [];
    window.failedDecoderCalls = 0;
    window.addEventListener("unhandledrejection", (event) =>
      window.rejections.push(String(event.reason)),
    );
  });
  await page.route("**/src/lib/editor/palette.ts*", (route) => {
    if (new URL(route.request().url()).searchParams.has("actual")) return route.continue();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
      import { paletteOf as actualPalette } from '${base}/src/lib/editor/palette.ts?actual=1';
      export async function paletteOf(...args) {
        if (window.failPalette) { window.failedDecoderCalls++; await createImageBitmap(new Blob(['invalid'], { type: 'image/png' })); }
        return actualPalette(...args);
      }
    `,
    });
  });
  await page.route("**/src/lib/editor/quality-live.ts*", (route) => {
    if (new URL(route.request().url()).searchParams.has("actual")) return route.continue();
    return route.fulfill({
      contentType: "application/javascript",
      body: `
      import { inspectEditedQuality as actualQuality, inspectCheckAreas as actualAreas } from '${base}/src/lib/editor/quality-live.ts?actual=1';
      export async function inspectEditedQuality(...args) {
        if (window.cancelQuality) throw new DOMException('Internal scan aborted', 'AbortError');
        if (window.pauseBatch && args[1].name === 'advanced-1.png') await new Promise(resolve => { window.releaseBatch = resolve; });
        if (window.failQuality || (window.failBatch && args[1].name === 'advanced-1.png')) { window.failedDecoderCalls++; await createImageBitmap(new Blob(['invalid'], { type: 'image/png' })); }
        return actualQuality(...args);
      }
      export async function inspectCheckAreas(...args) {
        if (window.cancelAreas) throw new DOMException('Internal scan aborted', 'AbortError');
        if (window.failAreas) { window.failedDecoderCalls++; await createImageBitmap(new Blob(['invalid'], { type: 'image/png' })); }
        return actualAreas(...args);
      }
    `,
    });
  });
  await page.goto(app);
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
});

test("quality-filtered ZIP waits for an unfinished batch check", async () => {
  // Given two ready images and a paused quality scan of the first.
  await upload(2);
  await page.evaluate(() => {
    window.pauseBatch = true;
  });
  await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
  await page.waitForFunction(() => typeof window.releaseBatch === "function");
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  // When filtering out quality warnings is enabled before the scan finishes.
  await page.getByLabel("Skip images with quality warnings in ZIP", { exact: true }).check();
  // Then neither filtered ZIP action can emit unchecked files.
  assert.equal(
    await page.getByRole("button", { name: "Download all ZIP", exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Selected ZIP", exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => {
    window.pauseBatch = false;
    window.releaseBatch();
  });
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".batch-name")].every((node) =>
      node.textContent.includes("Ready"),
    ),
  );
  assert.equal(
    await page.getByRole("button", { name: "Download all ZIP", exact: true }).isDisabled(),
    false,
  );
});
afterEach(async () => {
  await browser?.close();
});
async function upload(count = 1) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = "#000";
    ctx.fillRect(24, 24, 48, 48);
    return canvas.toDataURL().split(",")[1];
  });
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles(
      Array.from({ length: count }, (_, index) => ({
        name: `advanced-${index + 1}.png`,
        mimeType: "image/png",
        buffer: Buffer.from(png, "base64"),
      })),
    );
  await page.waitForFunction(
    (count) =>
      window.__cutoutTest?.useWorkspace.getState().items.filter((item) => item.status === "done")
        .length === count,
    count,
  );
}
async function assertHandled(button) {
  await page.waitForFunction(() => window.failedDecoderCalls > 0);
  await page.waitForFunction(
    () => window.rejections.length > 0 || document.querySelector('[role="alert"]'),
  );
  assert.deepEqual(await page.evaluate(() => window.rejections), []);
  await page.getByRole("button", { name: button, exact: true }).waitFor();
  if (["Retry colours", "Retry quality check", "Retry area check"].includes(button)) {
    const alerts = (await page.getByRole("alert").allTextContents()).join(" ");
    assert.doesNotMatch(
      alerts,
      /source image could not be decoded|InvalidStateError|createImageBitmap/,
    );
    assert.match(alerts, /This image is damaged or in a format this browser can’t read\./);
  }
}

async function captureError(name, retry) {
  if (process.env.CAPTURE_ASYNC_ERRORS !== "1") return;
  const directory = ".omo/evidence/continuation/async-recovery";
  await mkdir(directory, { recursive: true });
  const checks = [];
  for (const width of [375, 1280])
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      const button = page.getByRole("button", { name: retry, exact: true });
      await button.scrollIntoViewIfNeeded();
      await page.evaluate(async () => {
        await Promise.allSettled(
          document
            .getAnimations()
            .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
            .map((animation) => animation.finished),
        );
      });
      const bounds = await button.boundingBox();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      checks.push({ width, theme, bounds, overflow });
      await page.screenshot({ path: `${directory}/${name}-${theme}-${width}.png`, fullPage: true });
    }
  await writeFile(`${directory}/${name}.json`, JSON.stringify(checks, null, 2));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

test("palette decoder failure is visible and Retry colours recovers without reopening Adjust", async () => {
  // Given a ready image and a real decoder rejection at the palette seam.
  await upload();
  await page.evaluate(() => {
    window.failPalette = true;
  });
  // When Adjust requests the colours.
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByText("Colours", { exact: true }).click();
  // Then the error is handled and retry returns the real palette.
  await assertHandled("Retry colours");
  await captureError("palette", "Retry colours");
  await page.evaluate(() => {
    window.failPalette = false;
  });
  await page.getByRole("button", { name: "Retry colours", exact: true }).click();
  await page.getByLabel("Replace #000000", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry colours", exact: true }).count(), 0);
});

test("quality decoder failure is visible and retry restores a fresh quality report", async () => {
  // Given a ready image and a real decoder rejection while checking its output.
  await upload();
  await page.evaluate(() => {
    window.failQuality = true;
  });
  // When Adjust requests export quality.
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  // Then it exposes a retry instead of an unhandled rejection.
  await assertHandled("Retry quality check");
  assert.match(await page.getByRole("alert").textContent(), /^Could not check export quality\. /);
  await captureError("quality", "Retry quality check");
  await page.evaluate(() => {
    window.failQuality = false;
    // A busy renderer may not provide an idle deadline after a viewport change.
    // Deliver only callbacks with a deadline, preserving the cancellation contract.
    window.requestIdleCallback = (callback, options) =>
      options?.timeout
        ? setTimeout(() => callback({ didTimeout: true, timeRemaining: () => 0 }), options.timeout)
        : 0;
    window.cancelIdleCallback = (id) => clearTimeout(id);
    const s = window.__cutoutTest?.useWorkspace.getState();
    s.changeEdit({ exportWidth: 400, exportHeight: 400 });
  });
  await page.getByRole("button", { name: "Retry quality check", exact: true }).click();
  await page.getByLabel("Export quality", { exact: true }).scrollIntoViewIfNeeded();
  await page
    .getByLabel("Export quality", { exact: true })
    .getByText(/larger than the source/)
    .waitFor({ timeout: 5000 });
  assert.equal(
    await page.getByRole("button", { name: "Retry quality check", exact: true }).count(),
    0,
  );
});

test("subject decoder failure exits Preparing and retry makes piece tools ready", async () => {
  // Given a ready image and a targeted failure of the subject editor's real bitmap decode.
  await upload();
  await page.evaluate(() => {
    const original = window.createImageBitmap.bind(window);
    window.subjectTarget = window.__cutoutTest?.useWorkspace.getState().items[0].resultBlob;
    window.failSubject = true;
    window.createImageBitmap = (...args) => {
      if (window.failSubject && String(new Error().stack).includes("subject-editor")) {
        window.failedDecoderCalls++;
        return original(new Blob(["invalid"], { type: "image/png" }));
      }
      return original(...args);
    };
  });
  // When Choose subject prepares the plate.
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  // Then preparation fails visibly and an explicit retry becomes ready.
  await assertHandled("Retry subject preview");
  await captureError("subject", "Retry subject preview");
  await page.evaluate(() => {
    window.failSubject = false;
  });
  await page.getByRole("button", { name: "Retry subject preview", exact: true }).click();
  await page.getByText(/The cutout is one piece/).waitFor();
  assert.equal(await page.getByText("Preparing…", { exact: true }).count(), 0);
});

test("batch quality failures isolate one image and retry checks the rest of the batch", async () => {
  // Given two ready images and a decoder failure only for the first.
  await upload(2);
  await page.evaluate(() => {
    window.failBatch = true;
  });
  // When Batch scans quality.
  await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
  // Then a failed check is not labelled Ready and the second image still finishes.
  await assertHandled("Retry batch quality checks");
  await captureError("batch", "Retry batch quality checks");
  const first = page.getByRole("button", { name: /^advanced-1\.png/ });
  const second = page.getByRole("button", { name: /^advanced-2\.png/ });
  // Each row settles after the retry control appears; wait for it rather than read once.
  await first.filter({ hasText: /Quality check unavailable/ }).waitFor();
  await second.filter({ hasText: /Ready/ }).waitFor();
  await page.evaluate(() => {
    window.failBatch = false;
  });
  await page.getByRole("button", { name: "Retry batch quality checks", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".batch-name")].every((node) =>
      node.textContent.includes("Ready"),
    ),
  );
});

test("check area failure clears false clean status and retries the overlay", async () => {
  // Given a ready image and a real decoder rejection at the check-area seam.
  await upload();
  await page.evaluate(() => {
    window.failAreas = true;
  });
  // When areas to check are enabled.
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByText("Removal", { exact: true }).click();
  await page.getByLabel("Show areas to check (specks, holes, soft edges)", { exact: true }).check();
  // Then failure is visible instead of Nothing to check, with an accessible retry.
  await assertHandled("Retry area check");
  assert.match(await page.getByRole("alert").textContent(), /^Could not check areas\. /);
  assert.equal(await page.getByText("Nothing to check", { exact: true }).count(), 0);
  await page.keyboard.press("Escape");
  await captureError("areas", "Retry area check");
  await page.evaluate(() => {
    window.failAreas = false;
  });
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Retry area check", exact: true }).click();
  await page.getByText("Nothing to check", { exact: true }).waitFor();
});

for (const kind of ["quality", "areas"]) {
  test(`F4: cancelled ${kind} check shows bare Stopped copy and keeps Retry`, async () => {
    await upload();
    await page.evaluate((kind) => {
      window[kind === "quality" ? "cancelQuality" : "cancelAreas"] = true;
    }, kind);
    await page.getByRole("button", { name: "Adjust", exact: true }).click();
    if (kind === "areas") {
      await page.getByText("Removal", { exact: true }).click();
      await page
        .getByLabel("Show areas to check (specks, holes, soft edges)", { exact: true })
        .check();
    }
    const alert = page.getByRole("alert");
    await alert.waitFor();
    assert.equal((await alert.textContent()).trim(), "Stopped.");
    assert.equal(await page.getByText("Nothing to check", { exact: true }).count(), 0);
    const retry = kind === "quality" ? "Retry quality check" : "Retry area check";
    await page.getByRole("button", { name: retry, exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.rejections), []);
  });
}

test("batch framing changes restart quality checks before filtered ZIP can proceed", async () => {
  // Given completed quality checks and warning-based ZIP filtering.
  await upload(2);
  await page.getByRole("button", { name: "Batch (2)", exact: true }).click();
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".batch-name")].every((node) =>
      node.textContent.includes("Ready"),
    ),
  );
  await page.getByLabel("Skip images with quality warnings in ZIP", { exact: true }).check();
  await page.evaluate(() => {
    window.pauseBatch = true;
    window.releaseBatch = null;
  });
  // When the selected images receive a new framing preset, without changing their blobs.
  await page.getByLabel("Batch preset", { exact: true }).selectOption("profile");
  await page.getByRole("button", { name: "Apply preset", exact: true }).click();
  // Then fresh checks run and filtered exports remain guarded until they finish.
  await page.waitForFunction(() => typeof window.releaseBatch === "function", undefined, {
    timeout: 3000,
  });
  assert.equal(
    await page.getByRole("button", { name: "Download all ZIP", exact: true }).isDisabled(),
    true,
  );
  await page.evaluate(() => {
    window.pauseBatch = false;
    window.releaseBatch();
  });
  await page.waitForFunction(
    () =>
      ![...document.querySelectorAll(".batch-name")].some((node) =>
        node.textContent.includes("Checking quality"),
      ),
  );
  assert.equal(
    await page.getByRole("button", { name: "Download all ZIP", exact: true }).isDisabled(),
    false,
  );
});
