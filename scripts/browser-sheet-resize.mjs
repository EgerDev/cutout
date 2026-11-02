import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(/\/$/, "");
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchChrome } from "./chrome.mjs";

for (const reducedMotion of ["no-preference", "reduce"]) {
  for (const direction of ["ltr", "rtl"]) {
    test(`closed editor sheets stay inside the page after resize (${direction}, ${reducedMotion})`, async () => {
      const browser = await launchChrome();
      try {
        const page = await browser.newPage({
          viewport: { width: 1280, height: 900 },
          reducedMotion,
        });
        await page.goto(verifiedAppUrl);
        const bytes = await page.evaluate((direction) => {
          document.documentElement.dir = direction;
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 96;
          const context = canvas.getContext("2d");
          context.fillStyle = "#30556d";
          context.fillRect(24, 24, 48, 48);
          return canvas.toDataURL().split(",")[1];
        }, direction);
        const chooser = page.waitForEvent("filechooser");
        await page.getByRole("button", { name: "Choose files", exact: true }).click();
        await (
          await chooser
        ).setFiles({
          name: "resize.png",
          mimeType: "image/png",
          buffer: Buffer.from(bytes, "base64"),
        });
        await page.waitForFunction(
          () => window.__cutoutTest?.useWorkspace?.getState().items[0]?.status === "done",
        );
        for (const width of [375, 1280, 720, 721, 375, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await page.waitForFunction(
            (width) =>
              document.querySelector("#cutout-adjust")?.dataset.side ===
              (width <= 720 ? "south" : "east"),
            width,
          );
          await page.waitForTimeout(400);
          const closed = await page.evaluate(() => {
            const width = document.documentElement.scrollWidth;
            window.scrollTo({ left: 10000, behavior: "instant" });
            const right = window.scrollX;
            window.scrollTo({ left: -10000, behavior: "instant" });
            const left = window.scrollX;
            window.scrollTo({ left: 0, behavior: "instant" });
            return { width, viewport: innerWidth, right, left };
          });
          assert.ok(closed.width <= closed.viewport, JSON.stringify(closed));
          assert.equal(closed.right, 0);
          assert.equal(closed.left, 0);
          await page.getByRole("button", { name: "Adjust", exact: true }).click();
          await page.getByRole("button", { name: "Close adjust", exact: true }).click();
          await page.waitForTimeout(250);
          assert.equal(await page.locator("#cutout-adjust").getAttribute("aria-hidden"), "true");
          assert.equal(
            await page.evaluate(() => window.__cutoutTest?.useWorkspace.getState().items[0].status),
            "done",
          );
        }
      } finally {
        await browser.close();
      }
    });
  }
}
