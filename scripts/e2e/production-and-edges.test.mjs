import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { appCandidates, e2eUrl } from "../app-url.mjs";
import { launchChrome } from "../chrome.mjs";
import { cutoutOrSkip } from "../require-server.mjs";

async function main(t) {
  const appUrl = await cutoutOrSkip(t, appCandidates("http://127.0.0.1:8081/"));
  if (!appUrl) return;

  console.log(`Starting Production Preview and Edge Case E2E Suite against ${appUrl}...`);

  const browser = await launchChrome();
  // Close on failure too; an open browser keeps the test process (and CI) alive.
  t.after(() => browser.close());
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());

  const failedRequests = [];
  page.on("requestfailed", (req) => {
    failedRequests.push(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) {
      failedRequests.push(`${res.status()} ${res.url()}`);
    }
  });

  // -------------------------------------------------------------
  // Test 1: Licenses Route
  // -------------------------------------------------------------
  console.log("\n--- Test 1: Licenses Route ---");
  const licensesUrl = new URL("licenses", appUrl).href;
  console.log(`Navigating to ${licensesUrl}...`);
  const licensesRes = await page.goto(licensesUrl, { waitUntil: "networkidle" });
  assert.equal(licensesRes?.status(), 200, "Licenses route must return 200 OK");

  const title = await page.title();
  console.log("Page title:", title);
  assert.ok(title.includes("licenses") || title.includes("Licenses"), "Title mentions licenses");

  const licenseContent = await page.textContent("main, body");
  assert.ok(licenseContent.includes("Apache License"), "Mentions Apache License");
  assert.ok(
    licenseContent.includes("Earlier versions of Cutout used BG0") &&
      licenseContent.includes("without BG0's source code") &&
      licenseContent.includes("contains no code copied from BG0"),
    "Acknowledges that earlier versions used BG0 and the current engine was written without its source and copies none of it",
  );
  assert.ok(
    licenseContent.includes("LGPL-3.0") || licenseContent.includes("LGPL"),
    "Mentions LGPL for heic-to",
  );
  assert.ok(licenseContent.includes("BiRefNet"), "Mentions BiRefNet");
  console.log("Verified: Upstream and third-party notices intact!");

  // -------------------------------------------------------------
  // Test 2: Main App Idle View & Format Claims
  // -------------------------------------------------------------
  console.log("\n--- Test 2: Main App Idle View & Format Claims ---");
  await page.goto(e2eUrl(appUrl), { waitUntil: "networkidle" });

  const headline = await page.textContent(".idle-headline");
  assert.equal(headline?.trim(), "Remove the background.");

  const allParagraphs = await page.$$eval(".idle-actions p", (els) =>
    els.map((el) => el.textContent || ""),
  );
  console.log("Idle actions paragraphs:", allParagraphs);
  const formatText =
    allParagraphs.find((t) => t.includes("PNG") || t.includes("JPG") || t.includes("DXF")) || "";
  console.log("Advertised format line:", formatText);
  assert.ok(!formatText.includes("DXF"), "Must not advertise DXF");
  assert.ok(!formatText.includes("DWG"), "Must not advertise DWG");
  assert.ok(!formatText.includes("SKP"), "Must not advertise SKP");
  assert.ok(!formatText.includes("PDF"), "Must not advertise PDF");
  assert.ok(formatText.includes("PNG"), "Must include PNG");
  assert.ok(formatText.includes("JPG"), "Must include JPG");
  assert.ok(formatText.includes("WebP"), "Must include WebP");
  assert.ok(formatText.includes("HEIC"), "Must advertise HEIC");

  // -------------------------------------------------------------
  // Test 3: Sample Image Pipeline & WASM Assets
  // -------------------------------------------------------------
  console.log("\n--- Test 3: Sample Image Pipeline & WASM Assets ---");
  let _wasmLoaded = false;
  page.on("response", (res) => {
    if (res.url().includes(".wasm") && res.status() === 200) {
      _wasmLoaded = true;
      console.log("Observed WASM asset load:", res.url().split("/").pop());
    }
  });

  await page.click("text=Try a sample");
  await page.waitForSelector(".stage-media", { timeout: 10000 });
  console.log("Stage media mounted in Focus Workspace!");

  console.log("Waiting for background removal inference to complete...");
  await page.waitForSelector('[role="toolbar"]', { timeout: 45000 });
  console.log("Toolbar appeared! Inference succeeded in production build.");

  await page.waitForFunction(
    () =>
      window.__cutoutTest.useWorkspace
        .getState()
        .items.find((i) => i.id === window.__cutoutTest.useWorkspace.getState().activeId)
        ?.status === "done",
    undefined,
    { timeout: 60000 },
  );
  console.log("Item marked done; workspace dock is live.");

  // -------------------------------------------------------------
  // Test 4: Deep Toolbar & Keyboard Shortcuts
  // -------------------------------------------------------------
  console.log("\n--- Test 4: Deep Toolbar & Keyboard Shortcuts ---");

  // 4a. Compare Toggle & Arrow Key Navigation
  const compareBtn = await page.$('button[aria-label="Compare"], button:has-text("Compare")');
  assert.ok(compareBtn, "Compare button exists");
  await compareBtn.click();
  const slider = await page.$('.stage-media[role="slider"]');
  assert.ok(slider, "Slider role active during compare");
  await slider.press("ArrowLeft");
  let wipeVal = await slider.getAttribute("aria-valuenow");
  console.log("Compare wipe value after ArrowLeft:", wipeVal);
  assert.ok(Number(wipeVal) <= 50, "Wipe responds to arrow keys");
  await compareBtn.click(); // Toggle off

  // 4b. Spacebar Hold Peeking
  console.log("Testing Spacebar hold for original image peek...");
  await page.locator("body").click({ position: { x: 2, y: 100 } });
  await page.keyboard.down(" ");
  await page.waitForTimeout(200);
  const peekingActive = await page.evaluate(() => {
    const stage = document.querySelector(".stage-media");
    return stage?.getAttribute("data-peeking") === "true";
  });
  console.log("Stage data-peeking while space down:", peekingActive);
  assert.equal(peekingActive, true, "Space hold must trigger peeking");

  await page.keyboard.up(" ");
  await page.waitForTimeout(200);
  const peekingReverted = await page.evaluate(() => {
    const stage = document.querySelector(".stage-media");
    return stage?.getAttribute("data-peeking") === "false" || !stage?.hasAttribute("data-peeking");
  });
  console.log("Stage data-peeking after space up:", peekingReverted);
  assert.equal(peekingReverted, true, "Space release must revert peeking");

  // 4c. Mask View via the 'M' inspection cycle
  // 'M' cycles composite → checker → white → black → overlay → mask → edge.
  // The grayscale mask is the fifth stop; data-masking only reflects it.
  console.log("Testing 'M' key inspection cycle reaches mask view...");
  const inspectStates = await page.evaluate(async () => {
    const states = [];
    for (let i = 0; i < 7; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const s = window.__cutoutTest.useWorkspace.getState();
      states.push({
        inspect: s.inspectMode,
        masking: document.querySelector(".stage-media")?.getAttribute("data-masking") ?? null,
      });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    states.push({
      inspect: window.__cutoutTest.useWorkspace.getState().inspectMode,
      masking: document.querySelector(".stage-media")?.getAttribute("data-masking") ?? null,
    });
    return states;
  });
  const maskHit = inspectStates.find((s) => s.inspect === "mask");
  assert.ok(maskHit, "Cycle must pass through mask view");
  assert.equal(maskHit.masking, "true", "Mask view must set stage data-masking");
  console.log("Inspection cycle passes through mask with data-masking:", maskHit.masking);

  await page.keyboard.press("m");
  await page.waitForTimeout(150);
  const maskingOff = await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    const stage = document.querySelector(".stage-media");
    return s.inspectMode !== "mask" && stage?.getAttribute("data-masking") !== "true";
  });
  assert.equal(maskingOff, true, "Moving past mask must leave mask view");

  // 4d. Info Panel ('I' key and 'Escape')
  console.log("Testing 'I' key and Escape for Info Panel...");
  await page.keyboard.press("i");
  await page.waitForSelector("#cutout-info", { timeout: 3000 });
  const infoDims = await page.textContent("#cutout-info");
  assert.ok(infoDims.includes("Image information"), "Info panel has Image information title");
  assert.ok(infoDims.includes("BiRefNet"), "Info panel has BiRefNet model info");
  assert.ok(
    infoDims.includes("File size") || infoDims.includes("Dimensions"),
    "Info panel has size fields",
  );
  console.log("Info panel displayed successfully via 'I' shortcut");

  await page.keyboard.press("Escape");
  await page.waitForSelector('#cutout-info[aria-hidden="true"]', { timeout: 3000 });
  console.log("Info panel closed via Escape shortcut (hidden in place);");

  // 4e. Adjust Panel (Button and Escape)
  console.log("Testing Adjust Panel and Escape...");
  await page.click('button:has-text("Adjust")');
  await page.waitForSelector('aside[data-side="east"]', { timeout: 3000 });
  console.log("Adjust panel opened");

  // Select Black background
  await page.click('button:has-text("Black")');
  await page.waitForTimeout(200);

  // Close with Escape
  await page.keyboard.press("Escape");
  await page.waitForSelector('aside[data-side="east"][aria-hidden="true"]', { timeout: 3000 });
  console.log("Adjust panel closed via Escape (hidden in place);");

  // 4f. Copy Action (Button & Ctrl+C)
  console.log("Testing Copy button flash state...");
  await page.click('button:has-text("Copy")');
  await page.waitForSelector('button:has-text("Copied")', { timeout: 3000 });
  console.log("Copy button flashed 'Copied'!");

  // 4g. Download Action
  console.log("Testing Download action trigger...");
  await page.evaluate(() => {
    delete window.showSaveFilePicker;
  });
  const downloadPromise = page.waitForEvent("download", { timeout: 10000 });
  await page.click('button:has-text("Download")');
  const download = await downloadPromise;
  const suggestedFilename = download.suggestedFilename();
  console.log("Triggered download filename:", suggestedFilename);
  assert.ok(
    suggestedFilename.includes("sample-cutout"),
    "Download filename matches format pattern",
  );

  // -------------------------------------------------------------
  // Test 5: Mobile Responsiveness & Bottom Sheet
  // -------------------------------------------------------------
  console.log("\n--- Test 5: Mobile Viewport Responsiveness ---");
  await page.setViewportSize({ width: 375, height: 667 });
  await page.waitForTimeout(300);

  // Check that toolbar is still present and docked
  const toolbar = await page.$('[role="toolbar"]');
  assert.ok(toolbar, "Toolbar present on mobile");

  // Open Adjust on mobile
  await page.click('button:has-text("Adjust")');
  // On mobile, Adjust opens in bottom sheet with data-side="south"
  const southSheet = await page.waitForSelector('aside[data-side="south"]', { timeout: 3000 });
  assert.ok(southSheet, "Adjust panel docked to bottom sheet on mobile");
  console.log("Mobile bottom sheet verified!");

  // Close sheet with close button
  await page.click('button[aria-label="Close adjust"]');
  await page.waitForSelector('aside[data-side="south"][aria-hidden="true"]', { timeout: 3000 });

  // Restore desktop viewport
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(300);

  // -------------------------------------------------------------
  // Test 6: Corrupted File Error Handling
  // -------------------------------------------------------------
  console.log("\n--- Test 6: Corrupted File Error Handling ---");
  const corruptFilePath = resolve("scratch_corrupt.png");
  writeFileSync(corruptFilePath, Buffer.from("NOT_A_REAL_PNG_FILE_DATA_CORRUPT"));
  try {
    const input = await page.$('input[type="file"]');
    assert.ok(input, "File input exists");
    await input.setInputFiles(corruptFilePath);

    // Should display role="alert" with error message
    console.log("Waiting for error notice alert...");
    await page.waitForSelector('[role="alert"]', { timeout: 10000 });
    const alertMsg = await page.textContent('[role="alert"] p');
    console.log("Error notice message:", alertMsg);
    assert.ok(alertMsg && alertMsg.length > 0, "Alert displays meaningful error message");

    // Click Dismiss button
    console.log("Testing Dismiss button on error notice...");
    await page.click('button[aria-label="Dismiss"]');
    await page.waitForSelector('[role="alert"]', { state: "detached", timeout: 3000 });
    console.log("Error notice dismissed successfully!");
  } finally {
    try {
      unlinkSync(corruptFilePath);
    } catch {
      /* ignore */
    }
  }

  // -------------------------------------------------------------
  // Test 7: Escape preserves images; deliberate clear returns to idle
  // -------------------------------------------------------------
  console.log("\n--- Test 7: Escape preserves the workspace ---");
  const imageCount = await page.evaluate(
    () => window.__cutoutTest.useWorkspace.getState().items.length,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().items.length),
    imageCount,
  );
  await page.getByRole("button", { name: "Cutout — clear workspace", exact: true }).click();
  await page.waitForSelector(".idle-headline", { timeout: 3000 });
  const idleHeadline = await page.textContent(".idle-headline");
  assert.equal(idleHeadline?.trim(), "Remove the background.");
  console.log("Workspace preserved by Escape and cleared after confirmation.");

  // Check no unexpected network failures occurred
  console.log("\nFailed network requests count:", failedRequests.length);
  if (failedRequests.length > 0) {
    console.warn("Recorded network errors:", failedRequests);
  }
  // Filter out any known acceptable aborts or non-fatal
  const fatalErrors = failedRequests.filter(
    (e) => !e.includes("favicon") && !e.includes("chrome-extension"),
  );
  assert.equal(
    fatalErrors.length,
    0,
    `No unexpected HTTP failures: ${JSON.stringify(fatalErrors)}`,
  );

  console.log("\n==============================================");
  console.log("ALL PRODUCTION PREVIEW & EDGE TESTS PASSED! 🎉");
  console.log("==============================================");
}

// A missing server is reported as skipped (failed under CUTOUT_REQUIRE_E2E), not as a pass.
test("production build and edge cases", { timeout: 300_000 }, (t) => main(t));
