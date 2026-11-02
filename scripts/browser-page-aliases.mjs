// Focused production route/CSP coverage; no models or bypassCSP contexts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync } from "node:fs";
import { resolve, sep } from "node:path";
import { webkit } from "playwright";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const publicFiles = readdirSync(resolve(process.env.CUTOUT_PUBLIC_DIR || ".output/public"), {
  recursive: true,
}).map((file) => file.replaceAll(sep, "/"));
const emittedHtml = publicFiles.filter((file) => /(^|\/)index\.html(?:\.(?:gz|br))?$/.test(file));
assert.equal(emittedHtml.length, 18, "six public HTML pages and both compressed encodings");
const base = await requireCutout(appCandidates("http://127.0.0.1:8081/"));
for (const [name, launch] of [
  ["Chromium", () => launchChrome({ bypassCSP: false })],
  ["WebKit", () => webkit.launch()],
]) {
  test(`${name}: HTML aliases reach interactive canonical pages under enforced CSP`, async () => {
    const browser = await launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const violations = [];
      const errors = [];
      page.on("console", (message) => {
        if (/\[csp-violation\]|Content[- ]Security[- ]Policy/i.test(message.text()))
          violations.push(message.text());
      });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() =>
        document.addEventListener("securitypolicyviolation", (event) =>
          console.warn("[csp-violation]", event.violatedDirective, event.blockedURI),
        ),
      );
      const query = "?q=hello%20world&q=again&e2e";
      for (const route of ["/", "/guide", "/library", "/licenses", "/privacy", "/terms"]) {
        const index = route === "/" ? "index.html" : `${route.slice(1)}/index.html`;
        const aliases = [
          ...(route === "/" ? ["/index.html"] : [`${route}.html`, `${route}/index.html`]),
          ...emittedHtml
            .filter((file) => file === `${index}.br` || file === `${index}.gz`)
            .map((file) => `/${file}`),
        ].flatMap((path) => [path, `${path}/`]);
        aliases.push(route === "/" ? "//" : `${route}//`);
        for (const alias of aliases) {
          const response = await page.goto(new URL(base).origin + alias + query, {
            waitUntil: "networkidle",
          });
          assert.equal(response.status(), 200, alias);
          assert.equal(new URL(page.url()).pathname, route, alias);
          assert.equal(new URL(page.url()).search, query, alias);
          assert.equal(new URL(page.url()).origin, new URL(base).origin);
          await page.locator("h1").first().waitFor({ state: "visible" });
          assert.ok(!(await page.locator("h1").first().textContent()).includes("Page not found"));
          const canonical = await page.evaluate(() =>
            document.querySelector('link[rel="canonical"]')?.getAttribute("href"),
          );
          if (canonical) assert.equal(new URL(canonical).pathname, route);
          const rendered = await page.evaluate(() => ({
            isolated: crossOriginIsolated,
            styled: getComputedStyle(document.body).fontFamily,
          }));
          assert.ok(rendered.isolated, alias);
          assert.match(rendered.styled, /system-ui/i, alias);
        }
      }
      for (const path of [
        "/",
        "/guide",
        "/guide/",
        "/unknown.html.gz",
        "/guide///",
        "/guide/index.html.br//",
        "///",
      ]) {
        const response = await page.goto(new URL(base).origin + path + "?e2e", {
          waitUntil: "networkidle",
        });
        assert.equal(
          response.status(),
          path === "/" || path === "/guide" || path === "/guide/" ? 200 : 404,
          path,
        );
        assert.match(
          await page.evaluate(() => getComputedStyle(document.body).fontFamily),
          /system-ui/i,
          path,
        );
      }
      // Launch parameters reach the existing consent flow only after canonicalization.
      let external = 0;
      await page.route(/^https?:\/\//, (request) => {
        if (new URL(request.request().url()).origin !== new URL(base).origin) {
          external++;
          return request.abort();
        }
        return request.continue();
      });
      const launchQuery =
        "?src=https%3A%2F%2Fimages.example%2Fcat.jpg&src=second&name=a+b&download=1&e2e";
      await page.goto(new URL(base).origin + "/index.html.br/" + launchQuery, {
        waitUntil: "networkidle",
      });
      const dialog = page.getByRole("dialog", { name: "Load an image from images.example?" });
      await dialog.waitFor();
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(new URL(page.url()).search, "");
      assert.equal(external, 0, "no external image/model fetch before approval");
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await dialog.waitFor({ state: "detached" });
      assert.equal(external, 0);
      assert.deepEqual(violations, [], "no policy violations during alias rendering/hydration");
      assert.deepEqual(errors, [], "no hydration/runtime errors");
      await page.goto(new URL("/index.html?e2e", base).href, { waitUntil: "networkidle" });
      // A real client interaction after hydration proves the scripts ran.
      await page.getByRole("link", { name: "Guide", exact: true }).first().click();
      await page
        .locator("h1")
        .filter({ hasText: /guide|how|background/i })
        .first()
        .waitFor();
      assert.equal(new URL(page.url()).pathname, "/guide");
      assert.deepEqual(violations, []);
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "window.aliasCspProbe = true";
        document.head.append(script);
      });
      // Node-side polling does not require unsafe-eval inside the page.
      for (let i = 0; i < 30 && violations.length === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(violations.length > 0, "the negative CSP control was detected");
      assert.equal(
        await page.evaluate(() => window.aliasCspProbe),
        undefined,
        "inline script blocked",
      );
    } finally {
      await browser.close();
    }
  });
}
