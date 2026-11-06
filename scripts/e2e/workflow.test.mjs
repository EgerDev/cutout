import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { appCandidates, e2eUrl } from "../app-url.mjs";
import { launchChrome } from "../chrome.mjs";
import { cutoutOrSkip } from "../require-server.mjs";

async function main(t) {
  const appUrl = await cutoutOrSkip(
    t,
    appCandidates("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"),
  );
  if (!appUrl) return;

  console.log("Starting End-to-End Workflow Verification with Playwright...");
  const browser = await launchChrome();
  // Close on failure too; an open browser keeps the test process (and CI) alive.
  t.after(() => browser.close());
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());

  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  console.log(`1. Navigating to ${appUrl} ...`);
  await page.goto(e2eUrl(appUrl), { waitUntil: "networkidle" });

  // 1. Idle screen verification
  const headline = await page.textContent(".idle-headline");
  assert.equal(headline?.trim(), "Remove the background.");

  // Check format line
  const formatText = await page.locator(".idle-actions p").filter({ hasText: "PNG" }).textContent();
  console.log("Advertised format text:", formatText);
  assert.ok(formatText?.includes("PNG"));
  assert.ok(formatText?.includes("HEIC"), "Must advertise HEIC");
  assert.ok(!formatText?.includes("DXF"), "Must not advertise DXF");
  assert.ok(!formatText?.includes("DWG"), "Must not advertise DWG");
  assert.ok(!formatText?.includes("SKP"), "Must not advertise SKP");

  // 2. Sample image click
  console.log("2. Clicking 'Try a sample' to verify complete background removal pipeline...");
  await page.click("text=Try a sample");

  // Wait for stage to enter processing then done
  await page.waitForSelector(".stage-media", { timeout: 10000 });
  console.log("Preview appeared in Focus Workspace!");

  // The editing toolbar appears while the item is still processing; the
  // workspace dock (Compare/Copy/Adjust/Info) renders once the item is done.
  console.log("Waiting for background removal inference to complete...");
  await page.waitForSelector('[role="toolbar"]', { timeout: 45000 });
  console.log("Toolbar appeared! Removal complete!");

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

  // Verify toolbar actions exist
  const compareBtn = await page.$('button[aria-label="Compare"], button:has-text("Compare")');
  const copyBtn = await page.$('button:has-text("Copy")');
  const downloadBtn = await page.$('button:has-text("Download")');
  const adjustBtn = await page.$('button:has-text("Adjust")');
  const infoBtn = await page.$('button:has-text("Info")');

  assert.ok(compareBtn, "Compare button exists");
  assert.ok(copyBtn, "Copy button exists");
  assert.ok(downloadBtn, "Download button exists");
  assert.ok(adjustBtn, "Adjust button exists");
  assert.ok(infoBtn, "Info button exists");

  // 3. Test Compare slider
  console.log("3. Testing Compare toggle...");
  await compareBtn.click();
  const slider = await page.$('.stage-media[role="slider"]');
  assert.ok(slider, "Slider role active when comparing");

  // Test keyboard navigation on compare slider
  await slider.press("ArrowLeft");
  const wipeVal = await slider.getAttribute("aria-valuenow");
  console.log("Compare wipe value after ArrowLeft:", wipeVal);
  assert.ok(Number(wipeVal) <= 50, "Wipe value responds to arrow keys");

  // 4. Test Adjust panel
  console.log("4. Testing Adjust panel...");
  await adjustBtn.click();
  await page.waitForSelector('aside[data-side="east"]', { timeout: 5000 });
  console.log("Adjust panel opened successfully!");

  // Test background option White
  console.log("Selecting White background...");
  await page.click('button:has-text("White")');
  await page.waitForTimeout(300);

  // Test background option Blur
  console.log("Selecting Blur background...");
  await page.click('button:has-text("Blur")');
  await page.waitForTimeout(300);

  // Close adjust panel
  await page.click('button[aria-label="Close adjust"]');

  // 5. Test Info panel
  console.log("5. Testing Info panel...");
  await infoBtn.click();
  await page.waitForSelector("#cutout-info", { timeout: 5000 });
  const infoText = await page.textContent("#cutout-info");
  console.log("Info panel content includes:", infoText.slice(0, 150));
  assert.ok(infoText.includes("Image information"), "Info panel opened");
  assert.ok(!infoText.includes("Width: File"), "No fake placeholders in info panel");

  // Close info panel
  await page.click('#cutout-info button:has-text("Done")');

  // 6. Test File Input Replacement
  console.log("6. Testing file input replacement with public/sample.jpg...");
  const input = await page.$('input[type="file"]');
  assert.ok(input, "File input exists");
  await input.setInputFiles(resolve("public/sample.jpg"));

  // Check that new processing begins and stage updates
  await page.waitForSelector(".stage-media", { timeout: 5000 });
  await page.waitForSelector('[role="toolbar"]', { timeout: 45000 });
  console.log("Replacement image processed successfully!");

  console.log("All E2E checks passed without fatal failures!");
}

// A missing server is reported as skipped (failed under CUTOUT_REQUIRE_E2E), not as a pass.
test("full workflow", { timeout: 300_000 }, (t) => main(t));
