import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
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

  const browser = await launchChrome();
  // Close on failure too; an open browser keeps the test process (and CI) alive.
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(e2eUrl(appUrl), { waitUntil: "networkidle" });

  const buffer = readFileSync(resolve("public/sample.jpg"));
  const dataTransfer = await page.evaluateHandle((bytes) => {
    const dt = new DataTransfer();
    const file = new File([new Uint8Array(bytes)], "dragged-sample.jpg", { type: "image/jpeg" });
    dt.items.add(file);
    return dt;
  }, Array.from(buffer));

  console.log("Simulating dragenter at center (640, 360) with empty types (OS first-event)...");
  const emptyTransfer = await page.evaluateHandle(() => {
    const dt = new DataTransfer();
    return dt;
  });
  await page.dispatchEvent("body", "dragenter", {
    dataTransfer: emptyTransfer,
    clientX: 640,
    clientY: 360,
  });
  await page.waitForTimeout(200);
  assert.ok(
    await page.$(".drop-veil.is-open"),
    "Drop veil opened on first dragenter even with empty types",
  );

  const veilHandle = await page.$(".drop-veil");
  await page.dispatchEvent("body", "dragleave", {
    dataTransfer: emptyTransfer,
    clientX: 640,
    clientY: 360,
    relatedTarget: veilHandle,
  });
  await page.waitForTimeout(80);
  assert.ok(await page.$(".drop-veil.is-open"), "Drop veil stayed open after retarget dragleave");

  console.log("Simulating dragenter at center (640, 360)...");
  await page.dispatchEvent("body", "dragenter", { dataTransfer, clientX: 640, clientY: 360 });
  await page.waitForTimeout(200);

  const dropVeil = await page.$(".drop-veil.is-open");
  assert.ok(dropVeil, "Drop veil opened on dragenter");

  const dropCard = await page.$(".drop-card");
  assert.ok(dropCard, "Drop card is rendered");

  // Verify drop card text
  const cardTitle = await page.textContent(".drop-card-title");
  const cardCopy = await page.textContent(".drop-card-copy");
  console.log("Drop card title:", cardTitle);
  console.log("Drop card copy:", cardCopy);
  assert.equal(cardTitle?.trim(), "Release to remove");
  assert.equal(cardCopy?.trim(), "Up to 15 · stays on this device");

  // Verify centering via bounding rect
  const cardBox = await dropCard.boundingBox();
  const viewport = page.viewportSize();
  console.log("Card box:", cardBox, "Viewport:", viewport);
  assert.ok(cardBox, "Card bounding box exists");
  assert.ok(viewport, "Viewport size exists");

  // The center of the card should be approximately the center of the viewport
  const cardCenterX = cardBox.x + cardBox.width / 2;
  const cardCenterY = cardBox.y + cardBox.height / 2;
  const viewportCenterX = viewport.width / 2;
  const viewportCenterY = viewport.height / 2;

  console.log(
    `Card center: (${cardCenterX}, ${cardCenterY}), Viewport center: (${viewportCenterX}, ${viewportCenterY})`,
  );
  assert.ok(Math.abs(cardCenterX - viewportCenterX) < 10, "Card is horizontally centered");
  assert.ok(Math.abs(cardCenterY - viewportCenterY) < 20, "Card is vertically centered");

  // Simulating drop
  console.log("Simulating drop event...");
  await page.dispatchEvent("body", "drop", { dataTransfer });

  // Verify stage media appears
  await page.waitForSelector(".stage-media", { timeout: 10000 });
  console.log("Stage media appeared after drop!");

  await page.waitForSelector('[role="toolbar"]', { timeout: 45000 });
  console.log("Background removal succeeded from drag and drop!");

  console.log("Drag & Drop test completed successfully!");
}

// A missing server is reported as skipped (failed under CUTOUT_REQUIRE_E2E), not as a pass.
test("drag and drop into the workspace", { timeout: 300_000 }, (t) => main(t));
