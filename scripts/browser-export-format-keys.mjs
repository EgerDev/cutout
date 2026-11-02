// npm run dev must be running at APP_URL (the suite replaces src/lib/composite.ts's export
// capability probe through the dev server's module route, so it cannot run against a
// production build). The Export format radio group always has exactly one Tab stop: on the
// chosen format, or, when a restored or linked format (HEIC, AVIF) can't be encoded here, on
// the first offered one, without changing the setting until the user picks a format; and
// on the chosen format again once the probe finds its encoder.
import assert from "node:assert/strict";
import { test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));

/** The probe answers with window.__caps.initial, then whatever window.__caps.resolve(caps) sends. */
const STUB = `
const state = (globalThis.__caps ??= { initial: { webp: true, avif: false, heic: false } });
let pending = null;
export function exportCaps() { return state.current ?? state.initial; }
export function prepareExportCaps() {
  pending ??= new Promise((resolve) => {
    state.resolve = (caps) => { state.current = caps; resolve(caps); };
  });
  return pending;
}
`;

async function open(format) {
  const browser = await launchChrome();
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000);
  await page.route("**/src/lib/composite.ts*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("actual")) return route.continue();
    url.searchParams.set("actual", "1");
    return route.fulfill({
      contentType: "application/javascript",
      body: `export * from ${JSON.stringify(url.href)};\n${STUB}`,
    });
  });
  await page.goto(e2eUrl(appUrl));
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
  // One finished 8 px image, then the format a saved session or a launch link would set.
  await page.evaluate(async (format) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    canvas.getContext("2d").fillRect(2, 2, 4, 4);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    const file = new File([blob], "owned.png", { type: "image/png" });
    const { defaults } = await import("/src/lib/editor/model.ts");
    const store = window.__cutoutTest.useWorkspace;
    store.setState({
      items: [
        {
          id: "owned",
          name: file.name,
          source: file,
          sourceUrl: URL.createObjectURL(file),
          preview: null,
          resultBlob: blob,
          resultUrl: URL.createObjectURL(blob),
          width: 8,
          height: 8,
          status: "done",
        },
      ],
      activeId: "owned",
      phase: "result",
      settings: { owned: defaults },
      errorMessage: null,
    });
    store.getState().setExportFormat(format);
  }, format);
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await group(page).waitFor();
  // The sheet stays inert while it slides in.
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[role="radiogroup"][aria-label="Export format"]')
        ?.closest("[inert]"),
  );
  return { page, close: () => browser.close() };
}

const group = (page) => page.getByRole("radiogroup", { name: "Export format", exact: true });
const radios = (page) =>
  group(page)
    .getByRole("radio")
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        label: node.textContent,
        tabIndex: node.tabIndex,
        checked: node.getAttribute("aria-checked") === "true",
      })),
    );
const setting = (page) =>
  page.evaluate(() => window.__cutoutTest.useWorkspace.getState().settings.owned.exportFormat);
const focused = (page) =>
  page.evaluate(() => ({
    role: document.activeElement?.getAttribute("role"),
    label: document.activeElement?.textContent,
  }));

/** Tab from the last control before the group that takes focus, as a keyboard user arrives. */
async function tabInto(page) {
  await page.evaluate(() => {
    const target = document.querySelector('[role="radiogroup"][aria-label="Export format"]');
    const before = [
      ...document.querySelectorAll("a[href], button, input, select, summary, [tabindex]"),
    ]
      .filter(
        (node) =>
          node.tabIndex >= 0 &&
          !target.contains(node) &&
          target.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING,
      )
      .reverse();
    // Controls in a closed disclosure still report boxes but cannot take focus.
    if (!before.some((node) => (node.focus(), document.activeElement === node)))
      throw new Error("nothing before the group takes focus");
  });
  await page.keyboard.press("Tab");
  return focused(page);
}

test("an unavailable saved format keeps the setting; the first offered format takes the Tab stop", async () => {
  const { page, close } = await open("heic");
  try {
    assert.deepEqual(await radios(page), [
      { label: "PNG", tabIndex: 0, checked: false },
      { label: "WebP", tabIndex: -1, checked: false },
      { label: "JPG", tabIndex: -1, checked: false },
      { label: "BMP", tabIndex: -1, checked: false },
    ]);
    assert.deepEqual(await tabInto(page), { role: "radio", label: "PNG" });
    assert.equal(await setting(page), "heic", "entering the group changes nothing");
    await page.keyboard.press("ArrowRight");
    assert.deepEqual(await focused(page), { role: "radio", label: "WebP" });
    assert.equal(await setting(page), "webp");
    assert.deepEqual(
      (await radios(page)).filter((radio) => radio.tabIndex === 0 || radio.checked),
      [{ label: "WebP", tabIndex: 0, checked: true }],
    );
    assert.deepEqual(await tabInto(page), { role: "radio", label: "WebP" });
  } finally {
    await close();
  }
});

test("once the probe finds the saved format's encoder, that format is checked and holds the Tab stop", async () => {
  const { page, close } = await open("heic");
  try {
    assert.deepEqual(await tabInto(page), { role: "radio", label: "PNG" });
    await page.evaluate(() => globalThis.__caps.resolve({ webp: true, avif: false, heic: true }));
    await group(page).getByRole("radio", { name: "HEIC", exact: true }).waitFor();
    assert.deepEqual(
      (await radios(page)).filter((radio) => radio.tabIndex === 0 || radio.checked),
      [{ label: "HEIC", tabIndex: 0, checked: true }],
    );
    assert.deepEqual(await tabInto(page), { role: "radio", label: "HEIC" });
    await page.keyboard.press("Home");
    assert.deepEqual(await focused(page), { role: "radio", label: "PNG" });
    assert.equal(await setting(page), "png");
  } finally {
    await close();
  }
});

test("an offered format keeps the single Tab stop on itself", async () => {
  const { page, close } = await open("jpeg");
  try {
    assert.deepEqual(
      (await radios(page)).filter((radio) => radio.tabIndex === 0 || radio.checked),
      [{ label: "JPG", tabIndex: 0, checked: true }],
    );
    assert.deepEqual(await tabInto(page), { role: "radio", label: "JPG" });
    await page.keyboard.press("End");
    assert.deepEqual(await focused(page), { role: "radio", label: "BMP" });
    assert.equal(await setting(page), "bmp");
  } finally {
    await close();
  }
});
