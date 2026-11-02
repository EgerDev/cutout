import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { launchFirefox } from "./firefox.mjs";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

/**
 * The enforced Content-Security-Policy must not break the product: every page, a
 * sample removal, a HEIC decode (heic-to's blob: worker), enhance ×2 and depth-aware
 * blur run with zero `securitypolicyviolation` events, in Chromium and Firefox.
 * Needs a production build (dev sends no CSP): `npm run build && npm start`, then
 * APP_URL=http://127.0.0.1:<port>/ node --test scripts/browser-csp.mjs
 * First run downloads every model from Hugging Face (several hundred MB per browser).
 * Stages run on fresh pages in one shared context: page.close() releases the renderer's
 * model sessions while the context keeps the model caches, so nothing re-downloads.
 */
const url = await requireCutout(appCandidates("http://127.0.0.1:8081/"));
const at = (path) => new URL(path, url).href;
const MODEL_WAIT = 15 * 60_000;

for (const [name, launch] of [
  ["Chromium", () => launchChrome({ bypassCSP: false })],
  ["Firefox", () => launchFirefox()],
]) {
  test(
    `${name}: pages and every model feature run without a CSP violation`,
    { timeout: 60 * 60_000 },
    async (t) => {
      const policy = (await fetch(url)).headers.get("content-security-policy");
      assert.match(
        policy ?? "",
        /script-src 'self' 'wasm-unsafe-eval' 'sha256-/,
        `${url} must be a production build`,
      );

      const browser = await launch();
      try {
        const violations = [];
        const errors = [];
        const unexpectedDialogs = [];
        // A fresh context has empty caches, so each model family's first load must be a
        // real .onnx response — count them instead of trusting a settled state alone.
        const fetched = { removal: 0, enhance: 0 };
        const record = (source) => (message) => {
          const text = message.text();
          if (/\[csp-violation\]|Content[- ]Security[- ]Policy/i.test(text))
            violations.push(`${source}: ${text}`);
        };
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        // Bound event/locator waits. Evaluate still awaits returned promises without
        // this deadline, so Enhance below is scheduled before a bounded state wait.
        context.setDefaultTimeout(MODEL_WAIT);
        await context.addInitScript(() =>
          document.addEventListener("securitypolicyviolation", (e) =>
            console.warn("[csp-violation]", e.violatedDirective, e.blockedURI, e.sample),
          ),
        );

        /** A wired page: page-scope CSP listener, worker-scope listeners, model counters. */
        const freshPage = async () => {
          const page = await context.newPage();
          page.on("console", record("page"));
          page.on("pageerror", (error) => errors.push(error.message));
          // Worker violations fire in the worker's own scope, which init scripts never reach.
          page.on("worker", (worker) => {
            worker.on("console", record(`worker ${worker.url()}`));
            worker
              .evaluate(() =>
                self.addEventListener("securitypolicyviolation", (e) =>
                  console.warn("[csp-violation]", e.violatedDirective, e.blockedURI, e.sample),
                ),
              )
              .catch(() => {});
          });
          page.on("response", (response) => {
            const { pathname } = new URL(response.url());
            if (/(?:birefnet|isnet)[^?]*\.onnx$/i.test(pathname)) fetched.removal += 1;
            else if (/swin2sr[^?]*\.onnx$/i.test(pathname)) fetched.enhance += 1;
          });
          return page;
        };
        /** The active item is `name`, decoded and cut out. */
        const done = (page, name) =>
          page.waitForFunction(
            (n) => {
              const s = window.__cutoutTest.useWorkspace.getState();
              if (s.errorMessage) throw new Error(s.errorMessage);
              const item = s.items.find((i) => i.id === s.activeId);
              if (item?.status === "error") throw new Error(item.error);
              return item?.name === n && item.status === "done" && item.width > 0;
            },
            name,
            { timeout: MODEL_WAIT, polling: 500 },
          );
        /** What the store recorded for the stage's active item (provider/device evidence). */
        const readProviders = (page) =>
          page.evaluate(() => {
            const s = window.__cutoutTest.useWorkspace.getState();
            const item = s.items.find((i) => i.id === s.activeId);
            return {
              name: item?.name ?? null,
              provider: item?.provider ?? null,
              enhanced: item?.enhanced ?? null,
            };
          });
        /** Stage B/C pages start empty: any dialog here is unexpected and fails the test. */
        const watchDialogs = (page) =>
          page.on("dialog", (dialog) => {
            unexpectedDialogs.push(`${dialog.type()}: ${dialog.message()}`);
            dialog.dismiss().catch(() => {});
          });
        const providerMap = {};

        // Stage A: enforcement probe, every page, a real removal, the HEIC decode.
        let page = await freshPage();

        // The listener works: an unhashed inline script is reported.
        await page.goto(at("/guide"), { waitUntil: "load" });
        await page.evaluate(() => {
          const script = document.createElement("script");
          script.textContent = "window.cspProbe = 1";
          document.head.append(script);
        });
        await assert.doesNotReject(
          waitFor(() => violations.length > 0),
          "violations are detected",
        );
        assert.equal(
          await page.evaluate(() => window.cspProbe),
          undefined,
          "the policy is enforced",
        );
        violations.length = 0;

        for (const path of [
          "/",
          "/guide",
          "/library",
          "/licenses",
          "/privacy",
          "/terms",
          "/nope",
        ]) {
          await page.goto(at(path), { waitUntil: "load" });
          await page.locator("h1").first().waitFor();
          await page.waitForTimeout(500);
        }
        assert.equal(await page.title(), "Page not found · Cutout");

        await page.goto(at("/?e2e"), { waitUntil: "load" });
        await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
        assert.ok(await page.evaluate(() => crossOriginIsolated), "cross-origin isolated");

        await page.getByText("Try a sample").click();
        await done(page, "sample.jpg");

        // Opening a file replaces the sample; Chromium and Firefox decode HEIC with heic-to.
        const heic = await readFile(new URL("./fixtures/sample.heic", import.meta.url));
        const replacement = page.waitForEvent("dialog", { timeout: 30_000 }).then(async (dialog) => {
          assert.equal(dialog.type(), "confirm");
          assert.match(dialog.message(), /Replace the open images/);
          await dialog.accept();
        });
        await page
          .locator('input[type="file"][aria-label="Choose files"]')
          .setInputFiles({ name: "sample.heic", mimeType: "image/heic", buffer: heic });
        await replacement;
        await done(page, "sample.heic");
        assert.ok(fetched.removal > 0, "no BiRefNet/ISNet .onnx response was seen");
        providerMap.A = await readProviders(page);
        await page.close();

        // CSP coverage needs real model execution, not a large inference workload.
        // Keep the HEIC decode/removal above, then use an owned 32px control so both
        // x2 runs stay within Swin2SR's minimum 64px tile and do not exhaust a dev Mac.
        // Stage B: a fresh page (stage A's sessions released) with an empty workspace,
        // so opening the control asks nothing — a dialog here would be unexpected.
        page = await freshPage();
        watchDialogs(page);
        await page.goto(at("/?e2e"), { waitUntil: "load" });
        await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
        const control = await page.evaluate(() => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 32;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, 32, 32);
          ctx.fillStyle = "#273b51";
          ctx.fillRect(8, 8, 16, 16);
          return canvas.toDataURL("image/png").split(",")[1];
        });
        await page.getByLabel("Choose files", { exact: true }).setInputFiles({
          name: "csp-control.png",
          mimeType: "image/png",
          buffer: Buffer.from(control, "base64"),
        });
        await done(page, "csp-control.png");

        // Enhancing is set synchronously, so each wait starts while the run is in flight.
        // The evaluate must not return enhanceActive's promise: page.evaluate would await
        // the whole run with no deadline of its own, outside MODEL_WAIT.
        for (let round = 0; round < 2; round++) {
          await page.evaluate(() => {
            void window.__cutoutTest.useWorkspace.getState().enhanceActive({ scale: 2 });
          });
          await page.waitForFunction(
            () => {
              const s = window.__cutoutTest.useWorkspace.getState();
              if (s.errorMessage) throw new Error(s.errorMessage);
              const item = s.items.find((i) => i.id === s.activeId);
              return !s.enhancing && item.enhanced && item.status === "done";
            },
            null,
            { timeout: MODEL_WAIT, polling: 500 },
          );
        }
        assert.ok(fetched.enhance > 0, "no Swin2SR .onnx response was seen");
        providerMap.B = await readProviders(page);
        await page.close();

        // Stage C: another fresh page; depth-aware blur loads Depth Anything and renders.
        page = await freshPage();
        watchDialogs(page);
        await page.goto(at("/?e2e"), { waitUntil: "load" });
        await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
        await page.getByLabel("Choose files", { exact: true }).setInputFiles({
          name: "csp-control.png",
          mimeType: "image/png",
          buffer: Buffer.from(control, "base64"),
        });
        await done(page, "csp-control.png");

        const depthModel = page.waitForResponse((r) => /depth-anything.*\.onnx/.test(r.url()), {
          timeout: MODEL_WAIT,
        });
        await page.evaluate(() =>
          window.__cutoutTest.useWorkspace
            .getState()
            .changeEdit({ background: { type: "blur" }, blurDepth: true }),
        );
        await depthModel;
        await page.waitForFunction(
          () => !window.__cutoutTest.useWorkspace.getState().previewBusy,
          null,
          {
            timeout: MODEL_WAIT,
            polling: 500,
          },
        );

        assert.equal(await page.getByLabel("Describe what to find").count(), 0);
        providerMap.C = await readProviders(page);
        await page.close();

        t.diagnostic(JSON.stringify({ browser: name, ...providerMap, fetched }));
        assert.deepEqual(unexpectedDialogs, [], "no unexpected dialogs");
        assert.deepEqual(errors, [], "no uncaught page errors");
        assert.deepEqual(violations, [], "no Content-Security-Policy violations");
      } finally {
        await browser.close();
      }
    },
  );
}

async function waitFor(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
