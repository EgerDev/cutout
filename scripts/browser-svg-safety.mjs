// No path may give an SVG a same-origin blob: URL (F-SEC-01), and production pages do not
// hand the store to other scripts (F-SEC-08).
// npm run dev or a production server must be running at APP_URL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96">
<rect width="96" height="96" fill="white"/><rect x="24" y="24" width="48" height="48"/>
<script>document.title = "PWNED"; localStorage.setItem("pwned", location.origin);</script></svg>`;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let browser, context;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function openWorkspace(query = "?e2e") {
  context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  await page.goto(new URL(`/${query}`, appUrl).href, { waitUntil: "domcontentloaded" });
  return page;
}

async function upload(page, name, mimeType, content) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(content) });
  await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().items.length > 0);
}

/** What a user gets by opening this object URL in its own tab. */
async function assertSafeBlobUrl(page, url) {
  assert.match(url, /^blob:/);
  const { type, head } = await page.evaluate(async (href) => {
    const blob = await (await fetch(href)).blob();
    return { type: blob.type, head: [...new Uint8Array(await blob.slice(0, 8).arrayBuffer())] };
  }, url);
  assert.equal(type, "image/png");
  assert.deepEqual(head, PNG_SIGNATURE);
  const tab = await context.newPage();
  await tab.goto(url);
  await tab.waitForTimeout(800);
  assert.notEqual(await tab.title(), "PWNED");
  assert.equal(await page.evaluate(() => localStorage.getItem("pwned")), null);
  await tab.close();
}

const activeItem = (page) =>
  page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState();
    const item = s.items.find((entry) => entry.id === s.activeId);
    return { url: item.sourceUrl, type: item.source.type, name: item.name };
  });

test("a dropped SVG becomes a PNG before it gets an object URL", async () => {
  const page = await openWorkspace();
  try {
    await upload(page, "logo.svg", "image/svg+xml", SVG);
    const item = await activeItem(page);
    assert.equal(item.type, "image/png");
    assert.equal(item.name, "logo.png");
    await assertSafeBlobUrl(page, item.url);
  } finally {
    await context.close();
  }
});

test("an SVG that claims to be a PNG is rasterised too", async () => {
  const page = await openWorkspace();
  try {
    await upload(page, "photo.png", "image/png", SVG);
    const item = await activeItem(page);
    assert.equal(item.type, "image/png");
    await assertSafeBlobUrl(page, item.url);
  } finally {
    await context.close();
  }
});

test("an SVG background image gets a PNG object URL", async () => {
  const page = await openWorkspace();
  try {
    await upload(page, "logo.svg", "image/svg+xml", SVG);
    const url = await page.evaluate(async (svg) => {
      const store = window.__cutoutTest.useWorkspace;
      store.getState().setBackgroundImage(new File([svg], "bg.svg", { type: "image/svg+xml" }));
      for (let i = 0; i < 100; i++) {
        const s = store.getState();
        const url = s.settings[s.activeId]?.backgroundImageUrl;
        if (url) return url;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }, SVG);
    await assertSafeBlobUrl(page, url);
  } finally {
    await context.close();
  }
});

test("a saved workspace holding SVG is restored as PNG", async () => {
  const page = await openWorkspace();
  try {
    await upload(page, "graphic.svg", "image/svg+xml", SVG);
    // Write what a build from before rasterising would have saved: SVG source and background.
    await page.evaluate(async (svg) => {
      const s = window.__cutoutTest.useWorkspace.getState();
      const svgFile = new File([svg], "logo.svg", { type: "image/svg+xml" });
      const settings = {
        ...s.settings[s.activeId],
        backgroundImageUrl: null,
        backgroundBlob: svgFile,
        background: { type: "image", url: "" },
      };
      const snapshot = {
        version: 2,
        savedAt: Date.now(),
        activeIndex: 0,
        items: [
          { name: "logo.svg", source: svgFile, result: null, width: 96, height: 96, settings },
        ],
      };
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("cutout-workspace", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("sessions");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("sessions", "readwrite");
        transaction.objectStore("sessions").put(snapshot, "current");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      localStorage.setItem("cutout.saved", "1");
    }, SVG);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Saved workspace" }).click();
    await page.getByRole("button", { name: "Resume saved workspace" }).click();
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().items.length > 0);
    const item = await activeItem(page);
    assert.equal(item.type, "image/png");
    await assertSafeBlobUrl(page, item.url);
    const background = await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      return s.settings[s.activeId].backgroundImageUrl;
    });
    await assertSafeBlobUrl(page, background);
  } finally {
    await context.close();
  }
});

test("one saved image that cannot be drawn does not stop the rest from resuming", async () => {
  const page = await openWorkspace();
  try {
    await upload(page, "graphic.svg", "image/svg+xml", SVG);
    await page.evaluate(async (svg) => {
      const s = window.__cutoutTest.useWorkspace.getState();
      const settings = s.settings[s.activeId];
      // Markup no browser can draw, saved by a build from before rasterising, next to a good one.
      const broken = new File(["<svg"], "broken.svg", { type: "image/svg+xml" });
      const good = new File([svg], "logo.svg", { type: "image/svg+xml" });
      const snapshot = {
        version: 2,
        savedAt: Date.now(),
        activeIndex: 1,
        items: [
          { name: "broken.svg", source: broken, result: null, width: 96, height: 96, settings },
          { name: "logo.svg", source: good, result: null, width: 96, height: 96, settings },
        ],
      };
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("cutout-workspace", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("sessions");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("sessions", "readwrite");
        transaction.objectStore("sessions").put(snapshot, "current");
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
      });
      db.close();
      localStorage.setItem("cutout.saved", "1");
    }, SVG);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Saved workspace" }).click();
    await page.getByRole("button", { name: "Resume saved workspace" }).click();
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().items.length > 0);
    const restored = await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      return { names: s.items.map((item) => item.name), active: s.activeId, error: s.errorMessage };
    });
    assert.deepEqual(restored.names, ["logo.png"]);
    assert.ok(restored.active, "the image that could be restored is active");
    assert.match(restored.error ?? "", /couldn’t be restored/);
  } finally {
    await context.close();
  }
});

test("a background picked for one image never lands on another", async () => {
  const page = await openWorkspace();
  try {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (
      await chooser
    ).setFiles([
      { name: "a.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG) },
      { name: "b.svg", mimeType: "image/svg+xml", buffer: Buffer.from(SVG) },
    ]);
    await page.waitForFunction(
      () => window.__cutoutTest.useWorkspace.getState().items.length === 2,
    );
    const backgrounds = await page.evaluate(async (svg) => {
      const store = window.__cutoutTest.useWorkspace;
      const [first, second] = store.getState().items.map((item) => item.id);
      store.getState().selectItem(first);
      // Rasterising the SVG background takes a moment; switch images before it finishes.
      store.getState().setBackgroundImage(new File([svg], "bg.svg", { type: "image/svg+xml" }));
      store.getState().selectItem(second);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const settings = store.getState().settings;
      return [
        settings[first]?.backgroundImageUrl ?? null,
        settings[second]?.backgroundImageUrl ?? null,
      ];
    }, SVG);
    assert.equal(backgrounds[1], null, "the background must not land on the image switched to");
  } finally {
    await context.close();
  }
});

test("the later of two quick drops wins, whichever needed rasterising", async () => {
  const page = await openWorkspace();
  try {
    await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
    for (const order of [
      ["png", "svg"],
      ["svg", "png"],
    ]) {
      const names = await page.evaluate(
        async ({ order, svg }) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 96;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "white";
          ctx.fillRect(0, 0, 96, 96);
          ctx.fillStyle = "black";
          ctx.fillRect(24, 24, 48, 48);
          const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const make = (kind, name) =>
            kind === "png"
              ? new File([png], `${name}.png`, { type: "image/png" })
              : new File([svg], `${name}.svg`, { type: "image/svg+xml" });
          const store = window.__cutoutTest.useWorkspace;
          store.getState().receiveFiles([make(order[0], "first")]);
          store.getState().receiveFiles([make(order[1], "second")]);
          await new Promise((resolve) => setTimeout(resolve, 1500));
          return store.getState().items.map((item) => item.name);
        },
        { order, svg: SVG },
      );
      assert.deepEqual(names, [`second.png`], `${order.join(" then ")}: ${names}`);
    }
  } finally {
    await context.close();
  }
});

test("markup that cannot be drawn is dropped and the idle screen comes back", async () => {
  const page = await openWorkspace();
  try {
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (
      await chooser
    ).setFiles({
      name: "page.png",
      mimeType: "image/png",
      buffer: Buffer.from("<html><script>document.title='PWNED'</script></html>"),
    });
    await page.getByText("This image is damaged or in a format this browser can’t read.").waitFor();
    const state = await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      return { phase: s.phase, items: s.items.length };
    });
    assert.deepEqual(state, { phase: "idle", items: 0 });
    await page.getByRole("button", { name: "Choose files", exact: true }).waitFor();
  } finally {
    await context.close();
  }
});

const PAGE =
  "<html><title>PWNED</title><script>document.title='PWNED'</script><h1>Sign in</h1></html>";

test("markup behind a form feed, a NUL or 80 spaces never gets an object URL", async () => {
  const page = await openWorkspace();
  try {
    await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
    for (const pad of ["\f", "\v", "\0", " ".repeat(80)]) {
      const state = await page.evaluate(async (body) => {
        const store = window.__cutoutTest.useWorkspace;
        const minted = [];
        const mint = URL.createObjectURL;
        URL.createObjectURL = (blob) => {
          minted.push(blob.type);
          return mint.call(URL, blob);
        };
        try {
          store.setState({ errorMessage: null });
          // A drop of an extensionless, type-less file: the C37 path.
          store.getState().receiveFiles([new File([body], "payload", { type: "" })]);
          for (let i = 0; i < 100 && !store.getState().errorMessage; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
        } finally {
          URL.createObjectURL = mint;
        }
        const s = store.getState();
        return { items: s.items.length, error: s.errorMessage, minted };
      }, pad + PAGE);
      const label = JSON.stringify(pad.slice(0, 2));
      assert.equal(state.items, 0, label);
      assert.match(state.error ?? "", /damaged or in a format/, label);
      // Only the SVG decoder's own image/svg+xml URL, never one typed "" or as a page.
      assert.ok(
        state.minted.every((type) => type.startsWith("image/")),
        state.minted.join(),
      );
    }
    // A real image without a type is typed by its bytes; a drawing gets a type shown as such.
    const sourceOf = (kind) =>
      page.evaluate(
        async ({ kind, markup }) => {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 32;
          canvas.getContext("2d").fillRect(8, 8, 16, 16);
          const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
          const file = {
            png: new File([png], "photo", { type: "" }),
            pdf: new File(["%PDF-1.7\n", markup], "sheet.pdf", { type: "" }),
            dxf: new File(["  0\nSECTION\n", markup], "plan.dxf", { type: "image/vnd.dxf" }),
          }[kind];
          const store = window.__cutoutTest.useWorkspace;
          store.getState().receiveFiles([file]);
          for (let i = 0; i < 100 && store.getState().items[0]?.name !== file.name; i++)
            await new Promise((resolve) => setTimeout(resolve, 50));
          const item = store.getState().items[0];
          const blob = await (await fetch(item.sourceUrl)).blob();
          return { type: item.source.type, urlType: blob.type, url: item.sourceUrl };
        },
        { kind, markup: PAGE },
      );
    const png = await sourceOf("png");
    assert.deepEqual([png.type, png.urlType], ["image/png", "image/png"]);
    await assertSafeBlobUrl(page, png.url);
    const pdf = await sourceOf("pdf");
    assert.deepEqual([pdf.type, pdf.urlType], ["application/pdf", "application/pdf"]);
    // WebKit renders application/dxf or image/vnd.dxf as a page; plain text it shows as text.
    const dxf = await sourceOf("dxf");
    assert.deepEqual([dxf.type, dxf.urlType], ["text/plain", "text/plain"]);
  } finally {
    await context.close();
  }
});

test("a launch link is refused unless its type is exactly an image's and its bytes are one", async () => {
  const PNG = Buffer.from(PNG_SIGNATURE.concat(Array(56).fill(0)));
  for (const [type, body] of [
    ["image/png, text/html", PNG],
    ["image/png, text/html", " ".repeat(80) + PAGE],
    ["image/png", " ".repeat(80) + PAGE],
  ]) {
    const page = await openWorkspace(
      `?e2e&src=${encodeURIComponent("https://evil.example/x.png")}`,
    );
    try {
      await page.route("https://evil.example/**", (route) =>
        route.fulfill({
          status: 200,
          body,
          headers: { "content-type": type, "access-control-allow-origin": "*" },
        }),
      );
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Load image" }).click();
      await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().errorMessage);
      const state = await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return { items: s.items.length, error: s.errorMessage };
      });
      assert.equal(state.items, 0, type);
      const copy = type === "image/png"
        ? "We couldn’t process this image on this device."
        : "That file isn’t a photo or drawing we can open.";
      assert.equal(
        state.error,
        `${copy} Choose a file from your device to continue.`,
        type,
      );
    } finally {
      await context.close();
    }
  }
});

test("a production page without ?e2e does not expose the store", async () => {
  const dev = (await fetch(new URL("/@vite/client", appUrl))).ok;
  const page = await openWorkspace("");
  try {
    // The workspace, and with it the store module, has loaded once its file button renders.
    await page.getByRole("button", { name: "Choose files", exact: true }).waitFor();
    await page.waitForLoadState("networkidle");
    const exposed = await page.evaluate(() => ({
      legacy: "useWorkspace" in window,
      test: "__cutoutTest" in window,
    }));
    assert.equal(exposed.legacy, false);
    // The dev server always exposes the test hook; production only with ?e2e.
    assert.equal(exposed.test, dev);
  } finally {
    await context.close();
  }
});

test("launch links accept PNG aliases and HEIC sequence headers with safe File types", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=",
    "base64",
  );
  // This is a real still under sequence headers, not a claim about sequence decoding.
  const heic = await readFile(new URL("../src/lib/fixtures/tiny.heic", import.meta.url));
  for (const [type, body, expected] of [
    ["image/x-png", png, "image/png"],
    ["image/x-png; charset=binary", png, "image/png"],
    ["image/heic-sequence", heic, "image/heic"],
    ["image/heif-sequence", heic, "image/heic"],
  ]) {
    const page = await openWorkspace(`?e2e&src=${encodeURIComponent("https://cdn.example/photo")}`);
    try {
      await page.route("https://cdn.example/**", (route) =>
        route.fulfill({
          status: 200,
          body,
          headers: { "content-type": type, "access-control-allow-origin": "*" },
        }),
      );
      await page.getByRole("button", { name: "Load image", exact: true }).click();
      await page.waitForFunction(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return s.items.length || s.errorMessage;
      });
      const source = await page.evaluate(async () => {
        const s = window.__cutoutTest.useWorkspace.getState();
        const item = s.items[0];
        const blob = item ? await (await fetch(item.sourceUrl)).blob() : null;
        return { type: item?.source.type, urlType: blob?.type, error: s.errorMessage };
      });
      assert.equal(source.error, null, type);
      assert.equal(source.type, expected, type);
      assert.equal(source.urlType, expected, type);
    } finally {
      await context.close();
    }
  }
});
