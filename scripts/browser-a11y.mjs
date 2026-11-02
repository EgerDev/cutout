// F-TEST-07: axe-core over the states people actually see. Serious and critical
// violations fail the suite. Also: forced colours keep every state mark visible (read from
// rendered pixels), and focus moves on when the control holding it disappears.
// Runs against a dev server or a production build (?e2e).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import sharp from "sharp";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";

const url = await requireCutout(appCandidates("http://127.0.0.1:8081/", "http://127.0.0.1:8080/"));
const axeSource = readFileSync(
  createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
  "utf8",
);

let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function open(t, width = 1280, height = 800, media = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...media });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  return page;
}

/**
 * Fade-ins make axe read half-transparent text as low contrast; let them finish.
 * Looping animations (spinners) never finish, so only finite ones are awaited.
 */
const settle = (page) =>
  page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})),
    ),
  );

async function audit(page, state) {
  await settle(page);
  // Evaluated, not injected as a <script>: the page's CSP would (rightly) block that.
  if (!(await page.evaluate(() => typeof window.axe === "object"))) await page.evaluate(axeSource);
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target.join(" ")).slice(0, 5),
      }));
  });
  assert.deepEqual(violations, [], `${state}: ${JSON.stringify(violations, null, 2)}`);
}

async function cutout(page) {
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 320;
    c.height = 200;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, 320, 200);
    x.fillStyle = "#111111";
    x.fillRect(96, 50, 128, 100);
    return c.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (
    await chooser
  ).setFiles({ name: "graphic.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await page.waitForFunction(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return s.items[0]?.status === "done" && !s.previewBusy;
  });
  await page.locator('[role="toolbar"]').first().waitFor();
}

async function sheet(page, name, id) {
  await page.getByRole("button", { name, exact: true }).click();
  await page.locator(`${id}[aria-hidden="false"]`).waitFor();
}

for (const [label, width, height] of [
  ["desktop", 1280, 800],
  ["390 px", 390, 844],
]) {
  test(`idle screen (${label})`, async (t) => {
    const page = await open(t, width, height);
    await audit(page, `idle ${label}`);
  });

  test(`workspace after a cutout, Adjust and Info (${label})`, async (t) => {
    const page = await open(t, width, height);
    await cutout(page);
    await audit(page, `after cutout ${label}`);
    await sheet(page, "Adjust", "#cutout-adjust");
    await audit(page, `Adjust ${label}`);
    await page.keyboard.press("Escape");
    await sheet(page, "Info", "#cutout-info");
    await audit(page, `Info ${label}`);
  });
}

test("keyboard shortcut help", async (t) => {
  const page = await open(t);
  await cutout(page);
  await page.locator("body").click({ position: { x: 2, y: 200 } });
  await page.keyboard.press("?");
  await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
  await audit(page, "shortcut help");
});

/** A store action, as the interface would call it. */
const call =
  (page, action, ...args) =>
  () =>
    page.evaluate(([a, v]) => window.__cutoutTest.useWorkspace.getState()[a](...v), [action, args]);
/** The image back in the queue's working or failed state, as the engine leaves it. */
const queue = (page, item, top) =>
  page.evaluate(
    ([item, top]) => {
      const ws = window.__cutoutTest.useWorkspace;
      const { items, activeId } = ws.getState();
      ws.setState({ ...top, items: items.map((i) => (i.id === activeId ? { ...i, ...item } : i)) });
    },
    [item, top],
  );
const working = (page, progress = 0.4) =>
  queue(
    page,
    { status: "working" },
    {
      phase: "processing",
      progress: { stage: "cutting", progress, message: "Finding subject" },
    },
  );
const MESSAGE =
  "The local remover couldn’t start on this device. Check your connection and try again.";
const failed = (page) =>
  queue(
    page,
    { status: "error", error: MESSAGE, retryable: true },
    { phase: "error", errorMessage: MESSAGE },
  );

/**
 * Pixels that change clearly (a channel by 48 or more) when a control goes from one state to
 * another, outside its own text: a pressed, checked or active mark must be more than a
 * heavier label.
 */
async function markPixels(page, locator, setA, setB) {
  const shot = async (clip) => {
    await settle(page);
    const text = await locator.evaluate((el, c) => {
      const out = [];
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const range = document.createRange();
        range.selectNodeContents(n);
        for (const r of range.getClientRects())
          out.push({ x: r.x - c.x - 2, y: r.y - c.y - 2, w: r.width + 4, h: r.height + 4 });
      }
      return out;
    }, clip);
    const png = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    return { text, ...(await sharp(png).raw().toBuffer({ resolveWithObject: true })) };
  };
  await setA();
  await settle(page);
  const box = await locator.boundingBox();
  const clip = {
    x: Math.max(0, Math.floor(box.x) - 6),
    y: Math.max(0, Math.floor(box.y) - 6),
    width: Math.ceil(box.width) + 12,
    height: Math.ceil(box.height) + 12,
  };
  const a = await shot(clip);
  await setB();
  const b = await shot(clip);
  const moved = await locator.boundingBox();
  await setA();
  // A control that moves would count its own displacement as a mark.
  assert.ok(
    Math.abs(moved.x - box.x) < 0.5 && Math.abs(moved.y - box.y) < 0.5,
    "the control stays put",
  );
  const skip = [...a.text, ...b.text];
  let count = 0;
  for (let y = 0; y < a.info.height; y++)
    for (let x = 0; x < a.info.width; x++) {
      if (skip.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h)) continue;
      const i = (y * a.info.width + x) * a.info.channels;
      const d = Math.max(
        Math.abs(a.data[i] - b.data[i]),
        Math.abs(a.data[i + 1] - b.data[i + 1]),
        Math.abs(a.data[i + 2] - b.data[i + 2]),
      );
      if (d >= 48) count++;
    }
  return count;
}

test(
  "forced colours keep pressed, checked and active marks and progress visible",
  { timeout: 60_000 },
  async (t) => {
    const [transparent, white] = [{ type: "transparent" }, { type: "color", color: "#ffffff" }];
    // Set the palette before loading: switching a just-retried page left Chromium's
    // finite transition promises pending. Each palette keeps normal motion.
    for (const colorScheme of ["dark", "light"]) {
      const page = await open(t, 1280, 800, { forcedColors: "active", colorScheme });
      await cutout(page);
      const background = (value) => async () => {
        await call(page, "setBackground", value)();
        await page.waitForFunction(() => !window.__cutoutTest.useWorkspace.getState().previewBusy);
      };
      const marks = {};
      const compare = page.getByRole("toolbar", { name: "Image actions" }).getByRole("button", {
        name: "Compare",
        exact: true,
      });
      const off = call(page, "setComparing", false);
      marks.compare = await markPixels(page, compare, off, call(page, "setComparing", true));
      await sheet(page, "Adjust", "#cutout-adjust");
      const none = page.locator("#cutout-adjust button.swatch").filter({ hasText: /^None$/ });
      marks.swatch = await markPixels(page, none, background(transparent), background(white));
      // On white: JPG over a transparent background adds a note that moves the picker.
      await background(white)();
      const png = page.getByRole("radio", { name: "PNG", exact: true });
      const [toPng, toJpg] = ["png", "jpeg"].map((f) => call(page, "setExportFormat", f));
      marks.format = await markPixels(page, png, toPng, toJpg);
      await background(transparent)();
      await page.keyboard.press("Escape");
      const track = page.locator(".status-track");
      marks.progress = await markPixels(
        page,
        track,
        () => working(page, 0.2),
        () => working(page, 0.8),
      );
      await page
        .getByRole("button", { name: "Stop removing the background", exact: true })
        .and(page.locator(":not([aria-disabled])"))
        .click();
      await page
        .getByRole("button", { name: "Retry", exact: true })
        .and(page.locator(":not([aria-disabled])"))
        .click();
      await page.waitForFunction(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return s.items[0]?.status === "done" && !s.previewBusy;
      });
      for (const [mark, count] of Object.entries(marks))
        assert.ok(
          count >= 24,
          `${colorScheme} forced colours: ${mark} changed ${count} px beyond its text`,
        );
      await page.context().close();
    }
  },
);

test(
  "focus moves on when Retry or Dismiss removes it; the batch toggle keeps its name",
  { timeout: 60_000 },
  async (t) => {
    const page = await open(t);
    await cutout(page);
    const focused = (test) => page.waitForFunction(test, undefined, { timeout: 5000 });
    const armed = (name) =>
      page.getByRole("button", { name, exact: true }).and(page.locator(":not([aria-disabled])"));

    await page.getByRole("button", { name: "Batch (1)", exact: true }).click();
    const skip = page.getByRole("button", { name: "Skip ZIP for graphic.png", exact: true });
    assert.equal(await skip.getAttribute("aria-pressed"), "false");
    await skip.click();
    assert.equal(await skip.getAttribute("aria-pressed"), "true", "pressed, under the same name");
    await skip.click();
    await page.keyboard.press("Escape");

    // Stop turns into Retry in place; when the retried cutout is ready, focus goes to Download.
    await working(page);
    await armed("Stop removing the background").focus();
    await page.keyboard.press("Enter");
    await armed("Retry").waitFor();
    await page.keyboard.press("Enter");
    await focused(() => document.activeElement?.classList.contains("download-main"));

    // The notice's Retry: the same, through the running capsule.
    await failed(page);
    await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).focus();
    await page.keyboard.press("Enter");
    await focused(() => document.activeElement?.classList.contains("download-main"));

    // Dismiss leaves nothing to act on: focus stays in the workspace, on its heading.
    await failed(page);
    await page.getByRole("alert").getByRole("button", { name: "Dismiss", exact: true }).focus();
    await page.keyboard.press("Enter");
    await focused(() => document.activeElement?.id === "workspace-heading");
  },
);
