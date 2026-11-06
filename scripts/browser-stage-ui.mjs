// Stage, sheet and layout behaviour, checked in a real page. These replace unit tests that
// matched source text in stage.tsx, styles.css and friends (F-TEST-05): each test here
// guards the same behaviour by what the user sees or what the page does. Runs against a
// dev server or a production build (loaded with ?e2e).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { devices } from "playwright";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";

const url = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const BLUE = "#2f6fdf";

let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function open(t, { width = 1280, height = 800, init, ...options } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, ...options });
  t.after(() => context.close());
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  return page;
}

/** A flat blue graphic with a dark block: takes the fast graphic path, no model download. */
async function upload(page, { count = 1, width = 320, height = 200, wait = true } = {}) {
  const png = await page.evaluate(
    ({ width, height, bg }) => {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const x = c.getContext("2d");
      x.fillStyle = bg;
      x.fillRect(0, 0, width, height);
      x.fillStyle = "#111111";
      x.fillRect(width * 0.3, height * 0.25, width * 0.4, height * 0.5);
      return c.toDataURL().split(",")[1];
    },
    { width, height, bg: BLUE },
  );
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (
    await chooser
  ).setFiles(
    Array.from({ length: count }, (_, i) => ({
      name: count > 1 ? `graphic-${i + 1}.png` : "graphic.png",
      mimeType: "image/png",
      buffer: Buffer.from(png, "base64"),
    })),
  );
  if (wait) await settled(page, count);
}

async function settled(page, count = 1) {
  await page.waitForFunction((n) => {
    const s = window.__cutoutTest.useWorkspace.getState();
    return (
      s.items.length === n &&
      s.items.every((i) => i.status === "done") &&
      !s.previewBusy &&
      Boolean(s.previewBitmap || s.previewUrl)
    );
  }, count);
  // The stage fades and scales in; measure it once that animation has finished.
  await page.locator(".workspace-frame .stage-media.is-ready.is-settled").waitFor();
}

/** Record before a className rewrite: animationend can erase both symptoms afterward. */
async function watchStageEntrance(stage) {
  return stage.evaluateHandle((el) => {
    let classLost = false;
    let animationStarts = 0;
    const recordClasses = (records) => {
      // oldValue retains a transient loss even if the class is restored in the same task.
      if (
        records.length &&
        (!el.classList.contains("is-settled") ||
          records.some((record) => !record.oldValue?.split(/\s+/).includes("is-settled")))
      )
        classLost = true;
    };
    const observer = new MutationObserver(recordClasses);
    observer.observe(el, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    const onStart = (event) => {
      if (event.target === el && event.animationName === "stage-in") animationStarts++;
    };
    el.addEventListener("animationstart", onStart);
    return {
      read() {
        recordClasses(observer.takeRecords());
        return { classLost, animationStarts };
      },
      stop() {
        observer.disconnect();
        el.removeEventListener("animationstart", onStart);
      },
    };
  });
}

async function assertNoStageEntranceReplay(recorder) {
  assert.deepEqual(
    await recorder.evaluate((recording) => recording.read()),
    { classLost: false, animationStarts: 0 },
    "a className rewrite restarted the stage entrance",
  );
}

/** RGBA at fractional points of an element's screenshot. */
async function pixels(page, locator, points) {
  const png = await locator.screenshot({ animations: "disabled" });
  return page.evaluate(
    async ({ b64, points }) => {
      const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      return points.map(([fx, fy]) =>
        Array.from(
          ctx.getImageData(
            Math.round(fx * (bitmap.width - 1)),
            Math.round(fy * (bitmap.height - 1)),
            1,
            1,
          ).data,
        ),
      );
    },
    { b64: png.toString("base64"), points },
  );
}
const isBlue = ([r, g, b]) => b > 170 && r < 110 && g < 160;
const isDark = ([r, g, b]) => r < 60 && g < 60 && b < 60;

const rect = (page, selector) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => el.getBoundingClientRect().toJSON());

async function openSheet(page, name) {
  await page.getByRole("button", { name, exact: true }).click();
  const id = name === "Adjust" ? "#cutout-adjust" : "#cutout-info";
  await page.locator(`${id}[aria-hidden="false"]`).waitFor();
  // Let the slide-in transition finish before measuring.
  await page.waitForTimeout(450);
  return page.locator(id);
}

// The stage.tsx guard this replaces (no GPU paint without result or source content) is
// not reachable from the UI on its own: the stage has no size until the ingest preview
// exists. What the user sees is guarded instead: while the result's decodes are held
// back, the stage keeps showing the cutout rather than a blank GPU layer.
test("the stage keeps showing the photo while the compositor's images decode", async (t) => {
  // Hold every image decode and canvas→bitmap copy for 2.5 s.
  const page = await open(t, {
    init: () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 2500));
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function () {
        await wait();
        return decode.call(this);
      };
      const toBitmap = window.createImageBitmap;
      window.createImageBitmap = async (source, ...rest) => {
        if (source instanceof HTMLCanvasElement || source instanceof OffscreenCanvas) await wait();
        return toBitmap(source, ...rest);
      };
    },
  });
  await upload(page, { wait: false });
  await page.waitForFunction(
    () => window.__cutoutTest.useWorkspace.getState().items[0]?.status === "done",
  );
  const stage = page.locator(".stage-media");
  await stage.and(page.locator(".is-ready")).waitFor();
  const [early] = await pixels(page, stage, [[0.5, 0.5]]);
  assert.ok(isDark(early), `the result shows while decodes are pending: ${early}`);
  await settled(page);
  await page.waitForTimeout(300);
  const [late] = await pixels(page, stage, [[0.5, 0.5]]);
  assert.ok(isDark(late), `the result still shows once the compositor paints: ${late}`);
});

test("dragging the compare wipe updates --wipe and the slider value, nothing else", async (t) => {
  const page = await open(t);
  await upload(page);
  const entrance = await watchStageEntrance(page.locator(".stage-media"));
  await page.getByRole("button", { name: "Compare" }).click();
  const slider = page.getByRole("slider", { name: "Compare original and result" });
  await slider.waitFor();
  await assertNoStageEntranceReplay(entrance);
  const gpuBefore = await slider.getAttribute("data-gpu");
  await slider.evaluate((el) => {
    window.__stageMutations = [];
    new MutationObserver((records) => {
      for (const r of records)
        window.__stageMutations.push(
          r.type === "attributes"
            ? `${r.target === el ? "frame" : r.target.nodeName}@${r.attributeName}`
            : r.type,
        );
    }).observe(el, { attributes: true, childList: true, subtree: true });
  });
  const box = await slider.boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await page.mouse.down();
  for (const f of [0.4, 0.3, 0.25])
    await page.mouse.move(box.x + box.width * f, box.y + box.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const mutations = await page.evaluate(() => [...new Set(window.__stageMutations)]);
  const allowed = new Set([
    "frame@style",
    "frame@aria-valuenow",
    "frame@aria-valuetext",
    "frame@data-dragging",
  ]);
  assert.deepEqual(
    mutations.filter((m) => !allowed.has(m)),
    [],
    "a wipe drag re-rendered the stage",
  );
  const wipe = await slider.evaluate((el) => parseFloat(el.style.getPropertyValue("--wipe")));
  assert.ok(Math.abs(wipe - 25) < 2, `--wipe follows the pointer: ${wipe}`);
  assert.equal(Number(await slider.getAttribute("aria-valuenow")), Math.round(wipe));
  assert.equal(
    await slider.getAttribute("aria-valuetext"),
    `${Math.round(wipe)}% original, ${100 - Math.round(wipe)}% result`,
    "the spoken value says which side is which",
  );
  assert.equal(await slider.getAttribute("data-gpu"), gpuBefore, "the renderer stayed attached");
  await assertNoStageEntranceReplay(entrance);
  await entrance.evaluate((recording) => recording.stop());
  await entrance.dispose();
});

test("the entrance recorder detects a replay even after animationend restores the stage", async (t) => {
  const page = await open(t);
  await upload(page);
  const stage = page.locator(".stage-media");
  const entrance = await watchStageEntrance(stage);
  await page.getByRole("button", { name: "Compare" }).click();
  // Simulate the original bug without modifying product code: React dropped the class,
  // then the old animationend handler added it back. Read only after that recovery.
  await stage.evaluate((el) => {
    const restore = (event) => {
      if (event.target !== el || event.animationName !== "stage-in") return;
      el.removeEventListener("animationend", restore);
      el.classList.add("is-settled");
    };
    el.addEventListener("animationend", restore);
    el.classList.remove("is-settled");
  });
  await stage.and(page.locator(".is-settled")).waitFor();
  // A delayed runner sees healthy snapshots, but the recorder retains the replay.
  assert.equal(await stage.evaluate((el) => el.classList.contains("is-settled")), true);
  assert.equal(await stage.evaluate((el) => el.getAnimations().length), 0);
  await assert.rejects(assertNoStageEntranceReplay(entrance), /restarted the stage entrance/);
  assert.deepEqual(await entrance.evaluate((recording) => recording.read()), {
    classLost: true,
    animationStarts: 1,
  });
  await entrance.evaluate((recording) => recording.stop());
  await entrance.dispose();

  const transient = await watchStageEntrance(stage);
  await stage.evaluate((el) => {
    el.classList.remove("is-settled");
    el.classList.add("is-settled");
  });
  await assert.rejects(assertNoStageEntranceReplay(transient), /restarted the stage entrance/);
  await transient.evaluate((recording) => recording.stop());
  await transient.dispose();
});

test("compare shows the original file on the source side of the wipe", async (t) => {
  const page = await open(t);
  await upload(page);
  await page.getByRole("button", { name: "Compare" }).click();
  const slider = page.getByRole("slider", { name: "Compare original and result" });
  await slider.focus();
  await page.keyboard.press("End");
  const [allSource] = await pixels(page, slider, [[0.05, 0.1]]);
  assert.ok(isBlue(allSource), `wipe at 100%: the original's background shows: ${allSource}`);
  await page.keyboard.press("Home");
  const [allResult] = await pixels(page, slider, [[0.05, 0.1]]);
  assert.ok(!isBlue(allResult), `wipe at 0%: the background is removed: ${allResult}`);
});

test("compare clips at the wipe and the stage uses the GPU compositor", async (t) => {
  const page = await open(t);
  await upload(page, { wait: false });
  // The processing aura was removed; no stage-processing styles or elements ship.
  const aura = await page.evaluate(() => {
    const rules = [];
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules)
          if (rule.cssText?.includes("stage-processing")) rules.push(rule.cssText);
      } catch {
        /* cross-origin sheet */
      }
    }
    return { rules, elements: document.querySelectorAll('[class*="stage-processing"]').length };
  });
  assert.deepEqual(aura, { rules: [], elements: 0 });
  await settled(page);
  const stage = page.locator(".stage-media");
  await page.waitForFunction(() => document.querySelector(".stage-media")?.dataset.gpu);
  assert.match(await stage.getAttribute("data-gpu"), /webgpu|webgl/);
  await page.getByRole("button", { name: "Compare" }).click();
  const slider = page.getByRole("slider", { name: "Compare original and result" });
  await slider.waitFor();
  const [left, right] = await pixels(page, slider, [
    [0.05, 0.1],
    [0.95, 0.1],
  ]);
  assert.ok(isBlue(left), `left of the wipe is the original: ${left}`);
  assert.ok(!isBlue(right), `right of the wipe is the cutout: ${right}`);
  const line = await rect(page, ".stage-wipe-line");
  const frame = await slider.boundingBox();
  assert.ok(
    Math.abs(line.x + line.width / 2 - (frame.x + frame.width / 2)) < 2,
    "wipe line at 50%",
  );
});

for (const [label, width, height] of [
  ["desktop", 1280, 800],
  ["compact", 390, 844],
]) {
  test(`the stage is centred in its slot and fills it on one axis (${label})`, async (t) => {
    const page = await open(t, { width, height });
    await upload(page);
    const { slot, media } = await page.evaluate(() => {
      const slot = document.querySelector(".stage-slot");
      const style = getComputedStyle(slot);
      const r = slot.getBoundingClientRect();
      return {
        slot: {
          x: r.x + parseFloat(style.paddingLeft),
          y: r.y + parseFloat(style.paddingTop),
          width: r.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          height: r.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        },
        media: document.querySelector(".stage-media").getBoundingClientRect().toJSON(),
      };
    });
    assert.ok(
      Math.abs(media.x + media.width / 2 - (slot.x + slot.width / 2)) < 1.5,
      "centred horizontally",
    );
    assert.ok(
      Math.abs(media.y + media.height / 2 - (slot.y + slot.height / 2)) < 1.5,
      "centred vertically",
    );
    assert.ok(media.width <= slot.width + 1 && media.height <= slot.height + 1, "fits the slot");
    assert.ok(
      Math.abs(media.width - slot.width) < 2 || Math.abs(media.height - slot.height) < 2,
      "fills the slot on one axis",
    );
    assert.ok(Math.abs(media.width / media.height - 320 / 200) < 0.02, "keeps the photo's aspect");
  });
}

test("chrome, sheets and the idle screen keep clear of safe-area insets", async (t) => {
  const page = await open(t, { width: 390, height: 844 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", {
    insets: { top: 20, left: 30, right: 40, bottom: 25 },
  });
  const padding = (selector) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const s = getComputedStyle(el);
        return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
      });
  const idle = await padding(".idle-shell");
  assert.ok(idle.left >= 30 && idle.right >= 40, `idle screen: ${JSON.stringify(idle)}`);
  await upload(page);
  const header = await padding(".app-header");
  assert.ok(header.left >= 30 && header.right >= 40, `header: ${JSON.stringify(header)}`);
  const frame = await padding(".workspace-frame");
  assert.deepEqual(frame, { left: 30, right: 40 });
  const south = await (await openSheet(page, "Adjust")).boundingBox();
  assert.ok(
    south.x >= 30 && south.x + south.width <= 390 - 40 + 0.5,
    `south sheet: ${JSON.stringify(south)}`,
  );
  await page.getByRole("button", { name: "Close adjust" }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  const east = await (await openSheet(page, "Adjust")).boundingBox();
  assert.ok(east.x + east.width <= 1280 - 40 + 0.5, `east sheet: ${JSON.stringify(east)}`);
});

test("workspace containers space their children with gap, not margins", async (t) => {
  const page = await open(t);
  await upload(page, { count: 2 });
  const layout = await page.evaluate(() =>
    [".workspace-frame", ".workspace-main", ".workspace-batch"].map((selector) => {
      const el = document.querySelector(selector);
      const children = [...el.children].filter((c) => getComputedStyle(c).display !== "none");
      return {
        selector,
        gap: parseFloat(getComputedStyle(el).rowGap) || parseFloat(getComputedStyle(el).columnGap),
        // Sibling spacing from margins (`> * + *`) shows up as a leading margin on every
        // child but the first, along the main axis.
        margins: children
          .slice(1)
          .filter((c) => {
            const column = getComputedStyle(el).flexDirection.startsWith("column");
            return parseFloat(getComputedStyle(c)[column ? "marginTop" : "marginLeft"]) > 0;
          })
          .map((c) => `${c.tagName}.${c.className}`),
      };
    }),
  );
  for (const { selector, gap, margins } of layout) {
    assert.ok(gap > 0, `${selector} has a gap`);
    assert.deepEqual(margins, [], `${selector} children have no margins`);
  }
  assert.equal(layout[2].gap, 8, ".workspace-batch gap is 0.5rem");
});

// The old source-text test asserted `flex-wrap: wrap` in styles.css, but
// workspace-enhancements.css overrides it: what ships is one scrolling row of 48px
// thumbnails. This guards what ships.
test("batch thumbnails become one scrolling row of 48px buttons when the workspace is narrow", async (t) => {
  const page = await open(t);
  await upload(page, { count: 8 });
  const column = await page
    .locator(".workspace-batch")
    .evaluate((el) => getComputedStyle(el).flexDirection);
  assert.equal(column, "column", "desktop: a vertical strip");
  // No reload: the container query, not a device check, switches the layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const strip = await page.locator(".workspace-batch").evaluate((el) => {
    const buttons = [...el.querySelectorAll("button")].map((b) => b.getBoundingClientRect());
    const style = getComputedStyle(el);
    return {
      direction: style.flexDirection,
      sizes: [...new Set(buttons.map((b) => `${Math.round(b.width)}x${Math.round(b.height)}`))],
      rows: new Set(buttons.map((b) => Math.round(b.top))).size,
      scrolls: style.overflowX === "auto" && el.scrollWidth > el.clientWidth,
      fits: el.getBoundingClientRect().right <= innerWidth + 0.5,
    };
  });
  assert.deepEqual(strip, {
    direction: "row",
    sizes: ["48x48"],
    rows: 1,
    scrolls: true,
    fits: true,
  });
});

test("in a short landscape viewport the sheets stay clear of the toolbar", async (t) => {
  const page = await open(t, { width: 844, height: 390 });
  await upload(page);
  for (const name of ["Adjust", "Info"]) {
    const sheet = await (await openSheet(page, name)).boundingBox();
    const dock = await rect(page, ".workspace-dock");
    assert.ok(sheet.y + sheet.height <= dock.y + 1, `${name} sheet ends above the toolbar`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
});

for (const [label, width, height] of [
  ["east", 1280, 800],
  ["south", 390, 844],
]) {
  test(`open sheets stack above the stage (${label})`, async (t) => {
    const page = await open(t, { width, height });
    await upload(page);
    for (const name of ["Adjust", "Info"]) {
      const sheet = await openSheet(page, name);
      const box = await sheet.boundingBox();
      const onTop = await page.evaluate(
        ({ x, y, id }) => Boolean(document.elementFromPoint(x, y)?.closest(id)),
        {
          x: box.x + box.width / 2,
          y: box.y + Math.min(box.height / 2, 120),
          id: name === "Adjust" ? "#cutout-adjust" : "#cutout-info",
        },
      );
      assert.ok(onTop, `${name} is on top of the stage`);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
    }
  });
}

test("right-to-left layout mirrors sheets while the wipe stays physical", async (t) => {
  const page = await open(t);
  await upload(page);
  const ltr = await (await openSheet(page, "Adjust")).boundingBox();
  assert.ok(
    ltr.x + ltr.width > 1280 - 120,
    `LTR: the sheet sits at the right: ${JSON.stringify(ltr)}`,
  );
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.documentElement.setAttribute("dir", "rtl"));
  await page.waitForTimeout(300);
  const hidden = await page.locator("#cutout-adjust").boundingBox();
  assert.ok(hidden.x + hidden.width <= 1, "RTL: the closed sheet parks off the left edge");
  const rtl = await (await openSheet(page, "Adjust")).boundingBox();
  assert.ok(rtl.x < 120, "RTL: the sheet sits at the left");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Compare" }).click();
  const slider = page.getByRole("slider", { name: "Compare original and result" });
  await slider.focus();
  await page.keyboard.press("Home");
  await page.waitForTimeout(100); // the wipe follows the key at once
  const line = await rect(page, ".stage-wipe-line");
  const frame = await slider.boundingBox();
  assert.ok(
    Math.abs(line.x + line.width / 2 - frame.x) < 2,
    `wipe 0% is the physical left edge: ${JSON.stringify({ line, frame })}`,
  );
});

test("compact, narrow, short-landscape, wide and high-contrast layouts apply", async (t) => {
  const page = await open(t, { width: 1280, height: 800 });
  const style = (selector, prop) =>
    page
      .locator(selector)
      .first()
      .evaluate((el, p) => getComputedStyle(el)[p], prop);
  assert.notEqual(await style(".idle-keys", "display"), "none");
  await page.setViewportSize({ width: 500, height: 844 });
  assert.equal(await style(".idle-keys", "display"), "none", "≤720px hides the keyboard hints");
  assert.equal(await style(".idle-choose", "flexDirection"), "row");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await style(".idle-choose", "flexDirection"), "column", "≤400px stacks the choices");

  const line = () =>
    page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-line").trim(),
    );
  await page.emulateMedia({ contrast: "no-preference" });
  const normal = await line();
  await page.emulateMedia({ contrast: "more" });
  assert.notEqual(await line(), normal, "prefers-contrast: more strengthens lines");
  await page.emulateMedia({ contrast: null });

  await page.setViewportSize({ width: 1280, height: 800 });
  await upload(page);
  assert.equal(await style(".workspace-dock", "position"), "static");
  const regular = parseFloat(await style(".stage-slot", "paddingLeft"));
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(
    parseFloat(await style(".stage-slot", "paddingLeft")),
    36,
    "≥1400px widens the stage margin",
  );
  assert.notEqual(regular, 36);
  await page.setViewportSize({ width: 844, height: 390 });
  assert.equal(
    await style(".workspace-dock", "position"),
    "relative",
    "short landscape lifts the dock",
  );
});

test("opening Adjust or Info does not move the photo or the file name", async (t) => {
  const page = await open(t);
  await upload(page);
  const measure = () =>
    page.evaluate(() => ({
      stage: document.querySelector(".stage-media").getBoundingClientRect().toJSON(),
      name: document.querySelector(".image-summary [title]").getBoundingClientRect().toJSON(),
    }));
  const before = await measure();
  for (const name of ["Adjust", "Info"]) {
    await openSheet(page, name);
    assert.deepEqual(await measure(), before, `${name} shifted the layout`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
});

test("Choose subject fits the photo and offers zoom, undo, redo, show original and Apply", async (t) => {
  const page = await open(t);
  await upload(page);
  await page.getByRole("button", { name: "Subject", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Choose subject" }).waitFor();
  for (const name of [
    "Undo",
    "Redo",
    "Show original",
    "Apply",
    "Zoom out",
    "Fit to view",
    "Zoom in",
  ])
    assert.ok(await dialog.getByRole("button", { name, exact: true }).count(), `${name} button`);
  const canvas = await dialog.getByLabel("Choose subject canvas").boundingBox();
  const view = page.viewportSize();
  assert.ok(canvas.height <= view.height && canvas.width <= view.width, "the photo fits at 100%");
  assert.ok(Math.abs(canvas.width / canvas.height - 320 / 200) < 0.03, "at the photo's aspect");
});

// A lazy() editor would render a Suspense fallback and show its dialog only after its chunk
// arrives; bundled with the workspace, the dialog is in the DOM when the click returns.
test("Brush, Subject, Enhance and Batch open on the click, not after a chunk loads", async (t) => {
  const page = await open(t);
  await upload(page);
  for (const name of ["Brush", "Subject", "Enhance", "Batch (1)"]) {
    const immediate = await page.evaluate(
      (label) =>
        new Promise((resolve) => {
          // Accessible name: the aria-label when there is one, else the visible label.
          const button = [
            ...document.querySelectorAll('[role="toolbar"][aria-label="Editing tools"] button'),
          ].find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === label);
          button.click();
          queueMicrotask(() =>
            queueMicrotask(() => resolve(Boolean(document.querySelector('[role="dialog"]')))),
          );
        }),
      name,
    );
    assert.equal(immediate, true, `${name} waited for code before opening`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
  }
});

test("Adjust and Info sheets stay mounted and slide instead of remounting", async (t) => {
  const page = await open(t);
  await upload(page);
  for (const [name, id] of [
    ["Adjust", "#cutout-adjust"],
    ["Info", "#cutout-info"],
  ]) {
    const sheet = page.locator(id);
    assert.equal(
      await sheet.getAttribute("aria-hidden"),
      "true",
      `${name} is mounted while closed`,
    );
    await sheet.evaluate((el) => (el.__probe = true));
    const closed = await sheet.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        transition: s.transitionProperty,
        events: s.pointerEvents,
        willChange: s.willChange,
      };
    });
    assert.match(closed.transition, /translate/);
    assert.deepEqual([closed.events, closed.willChange], ["none", "auto"]);
    await openSheet(page, name);
    const open_ = await sheet.evaluate((el) => ({
      same: el.__probe === true,
      willChange: getComputedStyle(el).willChange,
    }));
    assert.deepEqual(open_, { same: true, willChange: "translate" }, `${name} was not remounted`);
    await page.keyboard.press("Escape");
    await page.locator(`${id}[aria-hidden="true"]`).waitFor();
    assert.equal(await sheet.evaluate((el) => el.__probe === true), true);
  }
});

test("sheet close controls keep a 44px hit target", async (t) => {
  const page = await open(t);
  await upload(page);
  await openSheet(page, "Adjust");
  const close = await page.getByRole("button", { name: "Close adjust" }).boundingBox();
  assert.ok(
    close.width >= 44 && close.height >= 44,
    `Close adjust: ${close.width}x${close.height}`,
  );
  await page.keyboard.press("Escape");
  await openSheet(page, "Info");
  const done = await page
    .locator("#cutout-info")
    .getByRole("button", { name: "Done" })
    .boundingBox();
  assert.ok(done.width >= 44 && done.height >= 44, `Info Done: ${done.width}x${done.height}`);
});

test("reopening Info or Adjust keeps the metadata already read", async (t) => {
  const page = await open(t);
  await upload(page);
  const kept = await page.evaluate(async () => {
    const store = window.__cutoutTest.useWorkspace;
    store.getState().openInfo();
    while (!store.getState().metadata) await new Promise((r) => setTimeout(r, 20));
    const first = store.getState().metadata;
    store.getState().closeInfo();
    store.getState().openInfo();
    const afterInfo = store.getState().metadata === first;
    store.getState().closeInfo();
    store.getState().openAdjust();
    const afterAdjust = store.getState().metadata === first;
    store.getState().closeAdjust();
    return { afterInfo, afterAdjust };
  });
  assert.deepEqual(kept, { afterInfo: true, afterAdjust: true });
});

test("the live preview ignores export-only fields and debounces real edits", async (t) => {
  const page = await open(t);
  await upload(page);
  const report = await page.evaluate(async () => {
    const store = window.__cutoutTest.useWorkspace;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const busy = [];
    const stop = store.subscribe((s, old) => {
      if (s.previewBusy && !old.previewBusy) busy.push(performance.now());
    });
    const bitmap = store.getState().previewBitmap;
    store.getState().changeEdit({ quality: 0.5 });
    store.getState().changeEdit({ targetKB: 50 });
    store.getState().changeEdit({ stripMetadata: false });
    await sleep(400);
    const ignored = busy.length === 0 && store.getState().previewBitmap === bitmap;
    const edited = performance.now();
    store.getState().changeEdit({ feather: 3 });
    const immediate = store.getState().previewBusy;
    while (store.getState().previewBitmap === bitmap) await sleep(20);
    stop();
    return {
      ignored,
      immediate,
      delay: busy.length ? busy[0] - edited : -1,
      previews: busy.length,
      comparison: "comparisonUrl" in store.getState(),
    };
  });
  assert.equal(report.ignored, true, "quality/targetKB/stripMetadata re-rendered the preview");
  assert.equal(report.immediate, false, "the preview renders after a debounce");
  assert.ok(report.delay >= 100, `debounced: ${report.delay} ms`);
  assert.equal(report.previews, 1, "one composite per edit");
  assert.equal(report.comparison, false, "no separate comparison render");
});

test("the quality report waits for the sheet, never forces an inspect view, and stays mounted", async (t) => {
  const page = await open(t, {
    init: () => {
      window.__idleOptions = [];
      const idle = window.requestIdleCallback;
      // Only the quality probe's callback: other features schedule idle work too.
      window.requestIdleCallback = (fn, options) => {
        if (/quality-live/.test(String(fn))) window.__idleOptions.push(options ?? null);
        return idle(fn, options);
      };
    },
  });
  await upload(page);
  // An extreme contract setting always yields a quality warning.
  const inspect = await page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    s.changeEdit({ choke: 10 });
    return s.inspectMode;
  });
  await settled(page);
  await page.evaluate(() => (window.__idleOptions.length = 0));
  const appeared = page.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        new MutationObserver((_, observer) => {
          if (!document.querySelector(".quality-report")) return;
          observer.disconnect();
          resolve(performance.now() - start);
        }).observe(document.body, { childList: true, subtree: true });
        [...document.querySelectorAll("button")]
          .find((b) => (b.getAttribute("aria-label") ?? b.textContent.trim()) === "Adjust")
          .click();
      }),
  );
  assert.ok((await appeared) >= 250, "the report waits for the sheet's slide-in");
  const options = await page.evaluate(() => window.__idleOptions);
  assert.ok(options.length >= 1 && options.every((o) => !o?.timeout), JSON.stringify(options));
  assert.equal(
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().inspectMode),
    inspect,
  );
  const height = (await page.locator("#cutout-adjust").boundingBox()).height;
  await page.getByRole("button", { name: "Close adjust" }).click();
  await page.locator('#cutout-adjust[aria-hidden="true"]').waitFor();
  assert.equal(
    await page.locator(".quality-report").count(),
    1,
    "issues stay while the sheet is closed",
  );
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  assert.equal(await page.locator(".quality-report").count(), 1);
  assert.equal(
    (await page.locator("#cutout-adjust").boundingBox()).height,
    height,
    "no height jump",
  );
});

test("edited cutouts do not offer the unedited stage file", async (t) => {
  const page = await open(t);
  await upload(page);
  const stage = page.locator(".stage-media");
  const offeredFiles = () =>
    stage.evaluate((el) => {
      const transfer = new DataTransfer();
      el.dispatchEvent(
        new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
      return transfer.files.length;
    });
  assert.equal(await stage.getAttribute("draggable"), "true");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setExportFormat("jpeg"));
  await page.waitForFunction(() => document.querySelector(".stage-media")?.draggable === false);
  assert.equal(await stage.getAttribute("draggable"), "false");
  assert.equal(await offeredFiles(), 0);
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setExportFormat("png"));
  await page.waitForFunction(() => document.querySelector(".stage-media")?.draggable === true);
  await page.evaluate(() =>
    window.__cutoutTest.useWorkspace.getState().setBackground({ type: "color", color: "#ff0000" }),
  );
  await page.waitForFunction(() => document.querySelector(".stage-media")?.draggable === false);
  assert.equal(await stage.getAttribute("draggable"), "false");
  assert.equal(await offeredFiles(), 0);
});

test("dragging the stage out carries the cutout PNG, and dropping it back is ignored", async (t) => {
  const page = await open(t);
  await upload(page);
  const stage = page.locator(".stage-media");
  assert.equal(await stage.getAttribute("draggable"), "true");
  assert.deepEqual(
    await stage.evaluate((el) => [
      ...new Set([...el.querySelectorAll("img")].map((img) => img.getAttribute("draggable"))),
    ]),
    (await stage.locator("img").count()) ? ["false"] : [],
  );
  const result = await stage.evaluate((el) => {
    const transfer = new DataTransfer();
    el.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    const file = transfer.files[0];
    const photos = [...el.querySelectorAll(".stage-photo")].map(
      (p) => getComputedStyle(p).pointerEvents,
    );
    const before = window.__cutoutTest.useWorkspace.getState().items.length;
    document.body.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    const afterOwnDrop = window.__cutoutTest.useWorkspace.getState().items.length;
    el.dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    return {
      types: [...transfer.types],
      file: file && { name: file.name, type: file.type, size: file.size > 0 },
      photos: [...new Set(photos)],
      ignored: afterOwnDrop === before,
    };
  });
  assert.ok(result.types.includes("application/x-cutout-export"), JSON.stringify(result.types));
  assert.deepEqual(result.file, { name: "graphic-cutout.png", type: "image/png", size: true });
  assert.deepEqual(result.photos, ["none"], "photos do not steal the drag");
  assert.equal(result.ignored, true, "dropping the cutout on its own workspace added an item");
  // After dragend a real file drop is accepted again.
  const replacement = page.waitForEvent("dialog").then(async (dialog) => {
    assert.equal(dialog.type(), "confirm");
    assert.match(dialog.message(), /Replace the open images/);
    await dialog.accept();
  });
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(40, 40);
    const x = canvas.getContext("2d");
    x.fillStyle = "#fff";
    x.fillRect(0, 0, 40, 40);
    x.fillStyle = "#000";
    x.fillRect(10, 10, 20, 20);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "dropped.png", { type: "image/png" }));
    document.body.dispatchEvent(
      new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
    document.body.dispatchEvent(
      new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
    );
  });
  await replacement;
  await page.waitForFunction(() =>
    window.__cutoutTest.useWorkspace.getState().items.some((i) => i.name === "dropped.png"),
  );
  await page.getByRole("button", { name: "Compare" }).click();
  assert.equal(await stage.getAttribute("draggable"), "false", "no drag-out while comparing");
});

test("phones never make the stage draggable", async (t) => {
  const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 13"];
  const page = await open(t, {
    ...iphone,
    width: iphone.viewport.width,
    height: iphone.viewport.height,
  });
  await upload(page);
  assert.equal(await page.locator(".stage-media").getAttribute("draggable"), "false");
});

test("the brush samples pen pressure once per stroke", async (t) => {
  const page = await open(t);
  await upload(page, { width: 400, height: 400 });
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  const canvas = page.getByLabel("Erase brush canvas");
  await canvas.waitFor();
  await page.waitForTimeout(300);
  const thickness = await canvas.evaluate(async (el) => {
    const box = el.getBoundingClientRect();
    const at = (fx, fy, type, pressure) =>
      el.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 7,
          pointerType: "pen",
          isPrimary: true,
          button: type === "pointermove" ? -1 : 0,
          buttons: type === "pointerup" ? 0 : 1,
          pressure,
          clientX: box.x + box.width * fx,
          clientY: box.y + box.height * fy,
        }),
      );
    at(0.15, 0.1, "pointerdown", 1);
    for (let f = 0.15; f <= 0.85; f += 0.02) at(f, 0.1, "pointermove", 0.05);
    at(0.85, 0.1, "pointerup", 0);
    await new Promise((r) => setTimeout(r, 300));
    const ctx = el.getContext("2d");
    const column = (fx) => {
      const x = Math.round(el.width * fx);
      const data = ctx.getImageData(x, 0, 1, Math.round(el.height * 0.4)).data;
      let erased = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] < 128) erased += 1;
      return erased;
    };
    return { start: column(0.25), end: column(0.75) };
  });
  assert.ok(thickness.start > 4, `the stroke erased something: ${JSON.stringify(thickness)}`);
  assert.ok(
    Math.abs(thickness.start - thickness.end) <= 2,
    `light pressure mid-stroke thinned it: ${JSON.stringify(thickness)}`,
  );
});

test("export size fields commit on blur, and follow undo", async (t) => {
  const page = await open(t);
  await upload(page);
  await openSheet(page, "Adjust");
  const width = page.locator("#cutout-adjust").getByLabel("Width", { exact: true });
  await width.scrollIntoViewIfNeeded();
  const exportSize = () =>
    page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      const e = s.settings[s.activeId];
      return [e.exportWidth, e.exportHeight];
    });
  const initial = await exportSize();
  const shown = await width.inputValue();
  await width.click();
  await width.fill("");
  await page.keyboard.type("160");
  assert.deepEqual(await exportSize(), initial, "typing does not commit");
  await page.keyboard.press("Tab");
  assert.deepEqual(await exportSize(), [160, 100], "blur commits at the photo's aspect");
  assert.equal(await width.inputValue(), "160");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().undo());
  assert.deepEqual(await exportSize(), initial);
  await page.waitForFunction(
    ([el, value]) => el.value === value,
    [await width.elementHandle(), shown],
  );
});

test("setExportSize keeps an established ratio and otherwise uses the photo's", async (t) => {
  const page = await open(t);
  await upload(page);
  const sizes = await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    const size = () => {
      const s = store.getState();
      const e = s.settings[s.activeId];
      return [e.exportWidth, e.exportHeight];
    };
    const out = {};
    store.getState().setExportSize(160, null);
    out.fromPhoto = size();
    store.getState().setExportSize(null, 50);
    out.keepsRatio = size();
    store.getState().changeEdit({ exportWidth: 200, exportHeight: 200 });
    store.getState().setExportSize(100, null);
    out.keepsSquare = size();
    store.getState().changeEdit({ exportWidth: 300, exportHeight: null });
    store.getState().setExportSize(null, 40);
    out.halfPairUsesPhoto = size();
    store.getState().setExportSize(null, null);
    out.cleared = size();
    return out;
  });
  assert.deepEqual(sizes, {
    fromPhoto: [160, 100],
    keepsRatio: [80, 50],
    keepsSquare: [100, 100],
    halfPairUsesPhoto: [64, 40],
    cleared: [null, null],
  });
});

// These inject setup/first-paint failures on a real mode-locked WebGPU canvas.
// They do not simulate physical device loss.
for (const failure of ["configure", "first-paint"]) {
  for (const fallback of ["webgl2", "2d"]) {
    test(`a WebGPU ${failure} failure mounts a fresh ${fallback} stage canvas`, async (t) => {
      const page = await open(t);
      if (!(await page.evaluate(async () => Boolean(await navigator.gpu?.requestAdapter())))) {
        t.skip("WebGPU is unavailable");
        return;
      }
      await page.evaluate(
        ({ failure, fallback }) => {
          const get = HTMLCanvasElement.prototype.getContext;
          HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
            if (fallback === "2d" && kind === "webgl2" && this.classList.contains("stage-photo"))
              return null;
            return get.call(this, kind, ...args);
          };
          const method = failure === "configure" ? "configure" : "getCurrentTexture";
          const original = GPUCanvasContext.prototype[method];
          GPUCanvasContext.prototype[method] = function (...args) {
            if (this.canvas.classList.contains("stage-photo")) {
              window.__failedStageCanvas = this.canvas;
              throw new DOMException(`controlled ${failure} failure`, "OperationError");
            }
            return original.apply(this, args);
          };
        },
        { failure, fallback },
      );
      await upload(page);
      await page.waitForFunction(
        () => {
          const current = document.querySelector(".stage-media canvas.pointer-events-none");
          return (
            current &&
            current !== window.__failedStageCanvas &&
            current.classList.contains("opacity-100")
          );
        },
        null,
        { timeout: 4000 },
      );
      const state = await page.evaluate((fallback) => {
        const previous = window.__failedStageCanvas;
        const current = document.querySelector(".stage-media canvas.pointer-events-none");
        return {
          locked: previous.getContext("webgl2") === null && previous.getContext("2d") === null,
          detached: !previous.isConnected,
          backend: Boolean(current.getContext(fallback)),
          size: [current.width, current.height],
        };
      }, fallback);
      assert.equal(state.locked, true, "original WebGPU canvas is physically mode-locked");
      assert.equal(state.detached, true);
      assert.equal(state.backend, true);
      assert.ok(state.size[0] > 0 && state.size[1] > 0);
      await page.setViewportSize({ width: 1000, height: 720 });
      await page.evaluate(() => window.__cutoutTest.useWorkspace.setState({ comparing: true }));
      await page.waitForFunction(() =>
        document
          .querySelector(".stage-media canvas.pointer-events-none")
          ?.classList.contains("opacity-100"),
      );
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().reset());
      assert.equal(await page.locator(".stage-media canvas.pointer-events-none").count(), 0);
    });
  }
}

test("unequal compare images use DOM display when atlas packing is unavailable", async (t) => {
  const page = await open(t);
  await upload(page);
  await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 40;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, 64, 40);
    const result = await createImageBitmap(c);
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      // Real drawable inputs, with only scratch packing contexts unavailable.
      if (kind === "2d" && !this.classList.contains("stage-photo")) return null;
      return get.call(this, kind, ...args);
    };
    window.__cutoutTest.useWorkspace.setState({ previewBitmap: result, comparing: true });
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".stage-media canvas.pointer-events-none")
      ?.classList.contains("opacity-0"),
  );
  const [left, right] = await pixels(page, page.locator(".workspace-frame .stage-media"), [
    [0.15, 0.75],
    [0.85, 0.75],
  ]);
  assert.ok(isBlue(left), `DOM original half: ${left}`);
  assert.ok(right[0] > 220 && right[1] < 40 && right[2] < 40, `DOM cutout half: ${right}`);
});
