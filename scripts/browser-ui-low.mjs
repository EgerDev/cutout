import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appCandidates, e2eUrl } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";

const url = await requireCutout(appCandidates("http://127.0.0.1:18370/"));
let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function open(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  return page;
}

test("removing another image preserves undo/redo without restoring its settings", async (t) => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const { defaults } = await import("/src/lib/editor/model.ts");
    const store = window.__cutoutTest.useWorkspace;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const item = (id) => ({
      id,
      name: id + ".png",
      source: new File([blob], id + ".png", { type: "image/png" }),
      sourceUrl: "",
      resultBlob: blob,
      resultUrl: null,
      preview: null,
      width: 16,
      height: 16,
      status: "done",
    });
    store.setState({
      items: [item("a"), item("b")],
      activeId: "a",
      settings: { a: defaults, b: defaults },
      past: [],
      future: [],
    });
    const state = () => store.getState();
    state().changeEdit({ feather: 2 }, undefined, "a");
    state().changeEdit({ feather: 3 }, undefined, "b");
    state().changeEdit({ feather: 4 }, undefined, "a");
    state().undo();
    state().removeItem("b");
    const remaining = { past: state().past.length, future: state().future.length };
    state().undo();
    const undone = state().settings.a.feather;
    state().redo();
    const redone = state().settings.a.feather;
    state().redo();
    return {
      remaining,
      undone,
      redone,
      final: state().settings.a.feather,
      ids: state().items.map((item) => item.id),
      keys: Object.keys(state().settings),
    };
  });
  assert.deepEqual(result, {
    remaining: { past: 1, future: 1 },
    undone: 0,
    redone: 2,
    final: 4,
    ids: ["a"],
    keys: ["a"],
  });
});

test("global messages have no unbound Retry; Batch retries name and target their own item", async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    const item = (id, retryable) => ({
      id,
      name: `${id}.png`,
      source: new File(["bad"], `${id}.png`, { type: "image/png" }),
      sourceUrl: "",
      preview: null,
      resultBlob: null,
      resultUrl: null,
      width: 16,
      height: 16,
      status: "error",
      error: `${id} failed`,
      retryable,
    });
    store.setState({
      items: [item("A", true), item("B", false)],
      activeId: "A",
      phase: "error",
      errorMessage: "B failed",
    });
    window.__retryTargets = [];
    const retry = store.getState().retryItem;
    store.setState({
      retryItem: (id) => {
        window.__retryTargets.push(id);
        retry(id);
      },
    });
  });
  assert.equal(
    await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).count(),
    0,
    "B's message must not offer A's Retry",
  );
  await page.evaluate(() =>
    window.__cutoutTest.useWorkspace.setState({ errorMessage: "An unrelated export failed" }),
  );
  assert.equal(
    await page.getByRole("alert").getByRole("button", { name: "Retry", exact: true }).count(),
    0,
  );
  await page.getByRole("button", { name: /^Batch \(/ }).click();
  const dialog = page.getByRole("dialog", { name: "Batch images" });
  assert.equal(
    await dialog.getByRole("button", { name: "Retry B.png", exact: true }).isDisabled(),
    true,
  );
  await dialog.getByRole("button", { name: "Retry A.png", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__retryTargets), ["A"]);
  assert.equal(
    await page.evaluate(
      () => window.__cutoutTest.useWorkspace.getState().items.find((i) => i.id === "B").status,
    ),
    "error",
  );
});

test("Batch quality reuses relevant inputs, serializes held work, and prunes stale results", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/src/lib/editor/quality-live.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
      window.__quality = { calls: [], pending: [], active: 0, maxActive: 0 };
      export async function inspectEditedQuality(result, source, settings, width, height) {
        const q = window.__quality;
        q.active++; q.maxActive = Math.max(q.maxActive, q.active);
        q.calls.push({ name: source.name, feather: settings.feather, width, height, resultSize: result.size });
        try { return await new Promise((resolve, reject) => q.pending.push({ name: source.name, resolve, reject })); }
        finally { q.active--; }
      }
    `,
    }),
  );
  await page.route("**/src/lib/editor/archive.ts*", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `export async function createArchive(snapshots) { window.__archived = snapshots.map(s => s.id); return new Blob(['zip']); }`,
    }),
  );
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 24;
    canvas.getContext("2d").fillRect(8, 6, 16, 12);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    window.__qualityBlob = blob;
    window.__qualityItem = (id, status = "done") => ({
      id,
      name: `${id}.png`,
      source: new File([blob], `${id}.png`, { type: "image/png" }),
      sourceUrl: URL.createObjectURL(blob),
      preview: null,
      resultBlob: status === "done" ? blob : null,
      resultUrl: status === "done" ? URL.createObjectURL(blob) : null,
      width: 32,
      height: 24,
      status,
    });
    window.__cutoutTest.useWorkspace.setState({
      items: [
        window.__qualityItem("A"),
        window.__qualityItem("B"),
        window.__qualityItem("C", "working"),
      ],
      activeId: "A",
      phase: "result",
    });
  });
  await page.getByRole("button", { name: /^Batch \(/ }).click();
  const dialog = page.getByRole("dialog", { name: "Batch images" });
  const count = () => page.evaluate(() => window.__quality.calls.length);
  const release = (name, { error = false, warnings = 0 } = {}) =>
    page.evaluate(
      ({ name, error, warnings }) => {
        const q = window.__quality;
        const index = q.pending.findIndex((p) => p.name === name);
        if (index < 0) throw new Error(`no held inspection for ${name}`);
        const [p] = q.pending.splice(index, 1);
        if (error) p.reject(new Error("controlled inspection failure"));
        else p.resolve(Array.from({ length: warnings }, () => ({ message: "warning" })));
      },
      { name, error, warnings },
    );
  const calls = async (n) => {
    await page.waitForFunction((n) => window.__quality?.calls.length >= n, n);
    assert.equal(await count(), n);
  };
  await calls(1);
  for (let step = 0; step < 6; step++) {
    await page.evaluate((step) => {
      const store = window.__cutoutTest.useWorkspace;
      store.setState((s) => ({
        items: s.items.map((i) => ({ ...i, durationMs: step })),
        settings: { ...s.settings },
        previewBusy: Boolean(step % 2),
      }));
    }, step);
    await page.waitForTimeout(30);
  }
  assert.equal(
    await count(),
    1,
    "unrelated preview/status/reference churn must join the held inspection",
  );
  await release("A.png", { warnings: 1 });
  await calls(2); // B is held; A's next inspection must use its latest inputs only.
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    store.getState().setFeather(2);
    store.setState((s) => ({
      items: s.items
        .filter((i) => i.id !== "B")
        .map((i) =>
          i.id === "A"
            ? {
                ...i,
                source: new File([window.__qualityBlob], "A-edited.png", { type: "image/png" }),
                resultBlob: new Blob([window.__qualityBlob, "new"]),
                width: 40,
              }
            : {
                ...i,
                status: "done",
                resultBlob: window.__qualityBlob,
                resultUrl: URL.createObjectURL(window.__qualityBlob),
              },
        ),
    }));
  });
  await page.waitForTimeout(100);
  assert.equal(await count(), 2, "real edits queue behind the single active inspection");
  await release("B.png", { error: true });
  await calls(3);
  assert.deepEqual(await page.evaluate(() => window.__quality.calls[2]), {
    name: "A-edited.png",
    feather: 2,
    width: 40,
    height: 24,
    resultSize: await page.evaluate(() => window.__qualityBlob.size + 3),
  });
  await release("A-edited.png");
  await calls(4);
  await release("C.png", { error: true });
  await dialog.getByText("Quality check unavailable", { exact: true }).waitFor();
  assert.equal(await dialog.getByRole("button", { name: "Retry batch quality checks" }).count(), 1);
  assert.equal(
    await dialog.getByText("Ready", { exact: true }).count(),
    1,
    "obsolete A warnings and removed B errors cannot publish",
  );
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    store.setState((s) => ({ items: [...s.items], settings: { ...s.settings } }));
  });
  await page.waitForTimeout(100);
  assert.equal(await count(), 4, "an unrelated update must not retry an inspection error");
  await dialog.getByLabel("Skip images with quality warnings in ZIP").check();
  await dialog.getByRole("button", { name: "Download all ZIP", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__archived));
  assert.deepEqual(
    await page.evaluate(() => window.__archived),
    ["A"],
    "quality errors are excluded from a filtered ZIP",
  );
  await dialog.getByRole("button", { name: "Retry batch quality checks" }).click();
  await calls(5);
  assert.equal(await page.evaluate(() => window.__quality.calls[4].name), "C.png");
  await release("C.png", { warnings: 2 });
  await dialog.getByText("2 warnings", { exact: true }).waitFor();
  await dialog.getByLabel("Skip images with quality warnings in ZIP").check();
  await dialog.getByRole("button", { name: "Download all ZIP", exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__archived));
  assert.deepEqual(await page.evaluate(() => window.__archived), ["A"]);
  for (const change of ["width", "height", "settings", "source", "result"]) {
    const before = await count();
    await page.evaluate((change) => {
      const store = window.__cutoutTest.useWorkspace;
      if (change === "settings") {
        store.getState().setFeather(3);
        return;
      }
      store.setState((s) => ({
        items: s.items.map((item) => {
          if (item.id !== "A") return item;
          if (change === "width" || change === "height")
            return { ...item, [change]: item[change] + 1 };
          if (change === "source")
            return {
              ...item,
              source: new File([window.__qualityBlob], "A-edited.png", { type: "image/png" }),
            };
          return { ...item, resultBlob: new Blob([window.__qualityBlob]) };
        }),
      }));
    }, change);
    await calls(before + 1);
    assert.equal(
      await page.evaluate(() => window.__quality.calls.at(-1).name),
      "A-edited.png",
      `${change}: only edited A is inspected`,
    );
    await release("A-edited.png");
    await dialog.getByText("Ready", { exact: true }).waitFor();
  }
  t.diagnostic(
    `inspections after six unrelated updates: 1; after five independent input changes: ${await count()}; maximum active work checked below`,
  );
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    store.setState((s) => ({ items: [...s.items, window.__qualityItem("D")] }));
  });
  await calls(11);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: /^Batch \(/ }).click();
  await page.waitForTimeout(100);
  assert.equal(await count(), 11, "reopen waits for the existing held inspection");
  await release("D.png");
  // Closing releases the cache; a reopened Batch scans current inputs once each.
  await calls(12);
  await release("A-edited.png");
  await calls(13);
  await release("C.png");
  await calls(14);
  await release("D.png");
  await page.waitForFunction(() => window.__quality.active === 0);
  assert.equal(await page.evaluate(() => window.__quality.maxActive), 1);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__cutoutTest.useWorkspace.setState({ items: [] }));
  await page.waitForTimeout(100);
  assert.equal(await count(), 14, "closed Batch owns no further inspections");
});

test("Batch reuses completed real quality inspections across unrelated updates", async (t) => {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.route("**/src/lib/editor/quality-live.ts*", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace(
      "export async function inspectEditedQuality(",
      "async function realInspectEditedQuality(",
    );
    assert.ok(
      body.includes("async function realInspectEditedQuality("),
      "instrument the real module, not a substitute",
    );
    await route.fulfill({
      response,
      body:
        body +
        `\nexport async function inspectEditedQuality(...args) { window.__realQualityCalls = (window.__realQualityCalls ?? 0) + 1; return realInspectEditedQuality(...args); }`,
    });
  });
  await page.goto(e2eUrl(url));
  await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "red";
    ctx.fillRect(16, 12, 32, 24);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));
    const items = ["real-A", "real-B"].map((id) => ({
      id,
      name: `${id}.png`,
      source: new File([blob], `${id}.png`, { type: "image/png" }),
      sourceUrl: URL.createObjectURL(blob),
      resultBlob: blob,
      resultUrl: URL.createObjectURL(blob),
      preview: null,
      width: 64,
      height: 48,
      status: "done",
    }));
    window.__cutoutTest.useWorkspace.setState({ items, activeId: items[0].id, phase: "result" });
  });
  await page.getByRole("button", { name: /^Batch \(/ }).click();
  const dialog = page.getByRole("dialog", { name: "Batch images" });
  await page.waitForFunction(() => window.__realQualityCalls === 2);
  await dialog.getByText("Checking quality…", { exact: true }).first().waitFor({ state: "hidden" });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(
      (i) =>
        window.__cutoutTest.useWorkspace.setState((s) => ({
          items: s.items.map((item) => ({ ...item, durationMs: i })),
          settings: { ...s.settings },
          previewBusy: Boolean(i % 2),
        })),
      i,
    );
    await page.waitForTimeout(30);
  }
  assert.equal(await page.evaluate(() => window.__realQualityCalls), 2);
  await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setFeather(1));
  await page.waitForFunction(() => window.__realQualityCalls === 3);
  await dialog.getByText("Checking quality…", { exact: true }).first().waitFor({ state: "hidden" });
  assert.equal(await dialog.getByText("Quality check unavailable", { exact: true }).count(), 0);
  t.diagnostic(
    "real inspectEditedQuality/renderCanvas calls: initial 2; after six unrelated updates 2; after one edit 3",
  );
});


test("E05-G-02: Retry targets the active failure and respects retryable false", async (t) => {
  const page = await open(t);
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    const item = (id, retryable) => ({
      id, name: `${id}.png`, source: new File(["bad"], `${id}.png`, { type: "image/png" }),
      sourceUrl: "", preview: null, resultBlob: null, resultUrl: null, width: 16, height: 16,
      status: "error", error: `${id} failed`, ...(retryable === undefined ? {} : { retryable }),
    });
    window.__retryTargets = [];
    store.setState({
      items: [item("A"), item("B", false)], activeId: "A", phase: "error", errorMessage: "A failed",
      retryItem: (id) => window.__retryTargets.push(id),
    });
  });
  const alert = page.getByRole("alert");
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.__retryTargets), ["A"]);
  await page.evaluate(() => window.__cutoutTest.useWorkspace.setState({ activeId: "B", errorMessage: "B failed" }));
  assert.equal(await alert.getByRole("button", { name: "Retry", exact: true }).count(), 0);
  await alert.getByRole("button", { name: "Dismiss", exact: true }).click();
  assert.equal(await alert.count(), 0);
});
