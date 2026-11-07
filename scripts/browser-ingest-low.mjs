// Owned ingest/metadata controls. Native engines, production CSP, no page source imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test as nodeTest } from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { webkit } from "playwright";
import { launchChrome, tolerantTest } from "./chrome.mjs";

// Every test here is named "<engine>: …"; a webkit one skips if Linux WPE WebKit crashes.
const test = tolerantTest(nodeTest, (name) => name.startsWith("webkit:"));
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";

const url = await requireCutout(appCandidates("http://127.0.0.1:18400/"));
const gps = await readFile(new URL("../src/lib/fixtures/gps.jpg", import.meta.url));
const plain = Buffer.concat([
  gps.subarray(0, 2),
  gps.subarray(gps.indexOf(Buffer.from([0xff, 0xdb]))),
]);
const sos = plain.indexOf(Buffer.from([0xff, 0xda]));
const scan = sos + 2 + plain.readUInt16BE(sos + 2);
const secret = Buffer.from("GPS PLANTED-SECRET");
const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0, secret.length + 2]), secret]);
// Keep one browser process alive at a time on the development Mac. Tests are
// sequential; each test closes its context before the next engine can start.
let activeBrowser;
let activeEngine;
async function browserFor(engine) {
  if (engine !== activeEngine || !activeBrowser?.isConnected()) {
    await activeBrowser?.close();
    activeBrowser = undefined;
    activeEngine = undefined;
    activeBrowser =
      engine === "chromium"
        ? await launchChrome({ bypassCSP: false })
        : await webkit.launch({ headless: true });
    activeEngine = engine;
  }
  return activeBrowser;
}
after(async () => activeBrowser?.close());
async function poll(page, predicate, arg, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await page.evaluate(predicate, arg);
    if (value) return value;
    await page.waitForTimeout(25);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}
async function open(t, engine, search = "?e2e", configure) {
  const context = await (
    await browserFor(engine)
  ).newContext({ acceptDownloads: true, bypassCSP: false });
  t.after(() => context.close());
  const page = await context.newPage();
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  if (configure) await configure(page);
  const response = await page.goto(new URL(search, url).href);
  if (process.env.CUTOUT_EXPECT_COMMIT) {
    assert.ok(response.headers()["content-security-policy"]);
    assert.equal(
      (await (await context.request.get(new URL("/version.json", url).href)).json()).commit,
      process.env.CUTOUT_EXPECT_COMMIT,
    );
  }
  await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace));
  return page;
}
async function installSource(page, bytes, name = "crafted.jpg") {
  await page.evaluate(
    ({ bytes, name }) => {
      const store = window.__cutoutTest.useWorkspace;
      const source = new File([Uint8Array.from(bytes)], name, { type: "image/jpeg" });
      store.setState({
        items: [
          {
            id: "metadata",
            name,
            source,
            sourceUrl: "",
            resultBlob: null,
            resultUrl: null,
            preview: null,
            width: 16,
            height: 16,
            status: "error",
          },
        ],
        activeId: "metadata",
        phase: "error",
        errorMessage: null,
      });
    },
    { bytes: [...bytes], name },
  );
}
async function decoded(page, bytes) {
  return page.evaluate(
    async (bytes) => {
      const image = await createImageBitmap(
        new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" }),
      );
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(image, 0, 0);
      image.close();
      return {
        width: canvas.width,
        height: canvas.height,
        pixels: Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data),
      };
    },
    [...bytes],
  );
}
for (const engine of ["chromium", "webkit"]) {
  test(`${engine}: cleaned-original store refuses TEM/SOI smuggling and truncated scan boundaries`, async (t) => {
    const page = await open(t, engine);
    const downloads = [];
    page.on("download", (entry) => downloads.push(entry));
    const fakeLength = Buffer.from([0, comment.length + 2]);
    const tails = [
      ...[0x01, 0xd8].map((marker) =>
        Buffer.concat([
          Buffer.from([0x12, 0xff, marker]),
          fakeLength,
          comment,
          Buffer.from([0xff, 0xd9]),
        ]),
      ),
      Buffer.from([0x12]),
      Buffer.from([0x12, 0xff]),
      Buffer.from([0x12, 0xff, 0xc4]),
      Buffer.from([0x12, 0xff, 0xc4, 0]),
      Buffer.from([0x12, 0xff, 0xc4, 0, 20, 0xff, 0xd9]),
    ];
    for (const tail of tails) {
      await installSource(page, Buffer.concat([plain.subarray(0, scan), tail]));
      const message = await page.evaluate(async () => {
        const store = window.__cutoutTest.useWorkspace;
        await store.getState().downloadOriginal();
        return store.getState().errorMessage;
      });
      assert.match(message ?? "", /Couldn’t remove the metadata.*Nothing was saved/);
    }
    await page.waitForTimeout(100);
    assert.equal(downloads.length, 0);
  });

  test(`${engine}: native baseline/progressive/restart JPEG cleaning preserves decoded pixels and scan bytes`, async (t) => {
    const page = await open(t, engine);
    const header = Buffer.from(plain.subarray(0, sos));
    const progressiveHeader = Buffer.from(header);
    progressiveHeader[progressiveHeader.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xc2;
    const progressive = Buffer.concat([
      progressiveHeader,
      Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 0, 0, 0, 0x0f]),
      comment,
      Buffer.from([0xff, 0xda, 0, 8, 1, 1, 0, 1, 63, 0, 0x0f, 0xff, 0xd9]),
    ]);
    const restarts = Buffer.concat([
      header,
      Buffer.from([0xff, 0xdd, 0, 4, 0, 1]),
      plain.subarray(sos, scan),
      Buffer.from([0x3f, 0xff, 0xd0, 0x3f, 0xff, 0xd1, 0x3f, 0xff, 0xd2, 0x3f, 0xff, 0xd9]),
    ]);
    for (const [name, input] of [
      ["baseline", gps],
      ["progressive", progressive],
      ["restarts", restarts],
    ]) {
      const before = await decoded(page, input);
      assert.deepEqual([before.width, before.height], [16, 16]);
      await installSource(page, input, `${name}.jpg`);
      const download = page.waitForEvent("download");
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadOriginal());
      const output = await readFile(await (await download).path());
      assert.equal(output.includes(secret), false);
      assert.equal(output.includes(Buffer.from("Taken at home")), false);
      assert.deepEqual(await decoded(page, output), before, name);
      // Original compressed image data stays byte-for-byte except dropped marker segments.
      if (name === "baseline") assert.deepEqual(output, plain);
      if (name === "restarts") assert.deepEqual(output, restarts);
      if (name === "progressive")
        assert.deepEqual(
          output,
          Buffer.concat([
            progressive.subarray(0, progressive.indexOf(comment)),
            progressive.subarray(progressive.indexOf(comment) + comment.length),
          ]),
        );
    }
  });
}

for (const engine of ["chromium", "webkit"]) {
  test(`${engine}: JPEG orientation survives cleaning exactly once`, async (t) => {
    const page = await open(t, engine);
    const jpeg = Buffer.from(
      await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = 48;
        canvas.height = 32;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, 48, 32);
        ctx.fillStyle = "#2468bd";
        ctx.fillRect(0, 0, 24, 16);
        return Array.from(
          Uint8Array.from(atob(canvas.toDataURL("image/jpeg").split(",")[1]), (c) =>
            c.charCodeAt(0),
          ),
        );
      }),
    );
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const exif = Buffer.from([
        0x45,
        0x78,
        0x69,
        0x66,
        0,
        0,
        0x4d,
        0x4d,
        0,
        42,
        0,
        0,
        0,
        8,
        0,
        1,
        1,
        0x12,
        0,
        3,
        0,
        0,
        0,
        1,
        0,
        orientation,
        0,
        0,
        0,
        0,
        0,
        0,
      ]);
      const input = Buffer.concat([
        jpeg.subarray(0, 2),
        Buffer.from([0xff, 0xe1, 0, exif.length + 2]),
        exif,
        comment,
        jpeg.subarray(2),
      ]);
      const before = await decoded(page, input);
      assert.deepEqual([before.width, before.height], orientation >= 5 ? [32, 48] : [48, 32]);
      await installSource(page, input);
      const download = page.waitForEvent("download");
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadOriginal());
      const output = await readFile(await (await download).path());
      assert.deepEqual(await decoded(page, output), before, `orientation ${orientation}`);
      assert.equal(output.includes(secret), false);
    }
  });
}

for (const engine of ["chromium", "webkit"]) {
  test(
    `${engine}: native worker preview stays bounded, preserves dimensions/pixels and recovers after decode refusal`,
    { timeout: 60_000 },
    async (t) => {
      const page = await open(t, engine);
      let workerUrl;
      page.on("request", (request) => {
        if (/decode-worker(?:\.ts|-[^/]+\.js)/.test(request.url())) workerUrl = request.url();
      });
      await page.evaluate(async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 2400;
        canvas.height = 1200;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, 2400, 1200);
        ctx.fillStyle = "black";
        ctx.fillRect(600, 300, 1200, 600);
        const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        // Valid PNG with harmless trailing padding selects the app's real worker path (>3 MB).
        window.__previewSource = new File([png, new Uint8Array(3_100_000)], "preview.png", {
          type: "image/png",
        });
        await window.__cutoutTest.useWorkspace.getState().receiveFiles([window.__previewSource]);
      });
      const preview = await poll(page, () => {
        const item = window.__cutoutTest.useWorkspace.getState().items[0];
        return (
          item?.preview && {
            original: [item.width, item.height],
            preview: [item.preview.width, item.preview.height],
          }
        );
      });
      assert.deepEqual(preview, { original: [2400, 1200], preview: [1600, 800] });
      assert.ok(workerUrl, "real worker module was requested");
      const result = await page.evaluate(async (workerUrl) => {
        const worker = new Worker(workerUrl, { type: "module" });
        try {
          const ask = (id, file) =>
            new Promise((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error(`decode worker request ${id} did not answer`)),
                10_000,
              );
              worker.onerror = (error) => {
                clearTimeout(timer);
                reject(error);
              };
              worker.onmessage = ({ data }) => {
                clearTimeout(timer);
                resolve(data);
              };
              worker.postMessage({ id, file, type: file.type, maxEdge: 1600 });
            });
          const refused = await ask(1, new File(["broken"], "bad.png", { type: "image/png" }));
          const healthy = await ask(2, window.__previewSource);
          const canvas = new OffscreenCanvas(healthy.bitmap.width, healthy.bitmap.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(healthy.bitmap, 0, 0);
          const hash = Array.from(
            new Uint8Array(
              await crypto.subtle.digest(
                "SHA-256",
                ctx.getImageData(0, 0, canvas.width, canvas.height).data,
              ),
            ),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          const pixels = [
            Array.from(ctx.getImageData(20, 20, 1, 1).data),
            Array.from(ctx.getImageData(800, 400, 1, 1).data),
          ];
          const dimensions = [
            healthy.width,
            healthy.height,
            healthy.bitmap.width,
            healthy.bitmap.height,
          ];
          healthy.bitmap.close();
          canvas.width = canvas.height = 0;
          let contextless;
          try {
            const blank = new OffscreenCanvas(2, 2).transferToImageBitmap();
            contextless = "returned bitmap";
            blank.close();
          } catch (error) {
            contextless = error.name;
          }
          return {
            refused: Boolean(refused.error) && !refused.bitmap,
            dimensions,
            pixels,
            contextless,
            hash,
          };
        } finally {
          worker.terminate();
        }
      }, workerUrl);
      console.log("healthy-preview", engine, result.hash);
      assert.equal(result.refused, true);
      assert.deepEqual(result.dimensions, [2400, 1200, 1600, 800]);
      assert.deepEqual(result.pixels, [
        [255, 255, 255, 255],
        [0, 0, 0, 255],
      ]);
      assert.equal(
        result.contextless,
        "InvalidStateError",
        "native no-context transfer already fails safe here",
      );
    },
  );
}

function graphicPng() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(96);
  header.writeUInt32BE(96, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(96 * (1 + 96 * 4));
  for (let y = 0; y < 96; y++)
    for (let x = 0; x < 96; x++) {
      const at = y * 385 + 1 + x * 4,
        color = x >= 24 && x < 72 && y >= 24 && y < 72 ? 0 : 255;
      rows[at] = rows[at + 1] = rows[at + 2] = color;
      rows[at + 3] = 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const graphic = graphicPng();
const remote = "https://images.example/linked.png";
const search = `?e2e&src=${encodeURIComponent(remote)}&preset=amazon&bg=blur&format=jpeg&download=1`;
async function launchPage(t, engine, { holdFetch = false, noSource = false } = {}) {
  let requests = 0,
    pendingRoute;
  const page = await open(
    t,
    engine,
    noSource ? "?e2e&preset=amazon&bg=blur&format=jpeg&download=1" : search,
    async (page) => {
      await page.route("https://images.example/**", (route) => {
        requests++;
        if (holdFetch) {
          pendingRoute = route;
          return;
        }
        return route.fulfill({
          body: graphic,
          contentType: "image/png",
          headers: {
            "access-control-allow-origin": "*",
            "cross-origin-resource-policy": "cross-origin",
          },
        });
      });
      await page.route(/huggingface\.co|\.onnx(?:\?|$)/, (route) => route.abort());
    },
  );
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  assert.equal(requests, 0, "no source request before real consent");
  assert.equal(new URL(page.url()).search, "", "query stripped before confirmation");
  let downloads = 0;
  page.on("download", () => downloads++);
  return {
    page,
    dialog,
    requests: () => requests,
    route: () => pendingRoute,
    downloads: () => downloads,
  };
}
async function ingestGraphic(page, names = ["own.png"]) {
  await page.evaluate(
    async ({ bytes, names }) => {
      const files = names.map(
        (name) => new File([Uint8Array.from(bytes)], name, { type: "image/png" }),
      );
      await window.__cutoutTest.useWorkspace.getState().receiveFiles(files);
    },
    { bytes: [...graphic], names },
  );
  await poll(page, () => {
    const items = window.__cutoutTest.useWorkspace.getState().items;
    return items.length && items.every((item) => item.status === "done");
  });
}
async function holdFinishedLink(page) {
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    window.__held = null;
    window.__stopHold = store.subscribe(() => {
      const item = store.getState().items.find((entry) => entry.name === "linked.png");
      if (item?.status !== "done" || window.__held) return;
      window.__held = item;
      store.setState({
        items: store
          .getState()
          .items.map((entry) => (entry.id === item.id ? { ...entry, status: "working" } : entry)),
      });
    });
  });
}
async function releaseFinishedLink(page) {
  await page.evaluate(() => {
    const store = window.__cutoutTest.useWorkspace;
    window.__stopHold();
    store.setState({
      items: store
        .getState()
        .items.map((entry) =>
          entry.id === window.__held.id && entry.source === window.__held.source
            ? window.__held
            : entry,
        ),
    });
  });
}
async function settings(page) {
  return page.evaluate(() => {
    const s = window.__cutoutTest.useWorkspace.getState(),
      edit = s.settings[s.activeId];
    return {
      name: s.items.find((item) => item.id === s.activeId)?.name,
      preset: edit?.preset,
      background: edit?.background,
      format: edit?.exportFormat,
      error: s.errorMessage,
    };
  });
}
for (const engine of ["chromium", "webkit"]) {
  test(`${engine}: real consent and healthy linked work download exactly once after a controlled 120s target hold`, async (t) => {
    const flow = await launchPage(t, engine),
      { page, dialog } = flow;
    await page.clock.install();
    await holdFinishedLink(page);
    await dialog.getByRole("button", { name: "Load and download", exact: true }).click();
    await poll(page, () => Boolean(window.__held));
    assert.equal(flow.requests(), 1);
    assert.equal(flow.downloads(), 0);
    console.log(
      "healthy-removal",
      engine,
      await page.evaluate(async () => {
        const bytes = await window.__held.resultBlob.arrayBuffer();
        return {
          dimensions: [window.__held.width, window.__held.height],
          sha256: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
        };
      }),
    );
    // Real graphic removal already completed. Only terminal publication is held, so engine
    // watchdogs/model loads cannot create a false red or green for launch lifetime.
    await page.clock.fastForward(120_001);
    assert.equal(flow.downloads(), 0);
    const download = page.waitForEvent("download");
    void download.catch(() => {});
    await releaseFinishedLink(page);
    assert.equal((await settings(page)).preset, "amazon", "late completion still applies its plan");
    const file = await download;
    assert.equal(file.suggestedFilename(), "linked-cutout.jpg");
    assert.ok((await readFile(await file.path())).length > 100);
    assert.deepEqual(await settings(page), {
      name: "linked.png",
      preset: "amazon",
      background: { type: "blur" },
      format: "jpeg",
      error: null,
    });
    await releaseFinishedLink(page);
    await page.waitForTimeout(100);
    assert.equal(flow.downloads(), 1);
  });

  test(`${engine}: dropped/replaced/selected/removed/edited/error/navigation targets never receive stale launch effects`, async (t) => {
    for (const change of ["drop", "source", "select", "remove", "edit", "error", "guide"])
      await t.test(change, async (t) => {
        const flow = await launchPage(t, engine),
          { page, dialog } = flow;
        await holdFinishedLink(page);
        await dialog.getByRole("button", { name: "Load and download", exact: true }).click();
        await poll(page, () => Boolean(window.__held));
        if (change === "drop") {
          // Exercise the actual document drop handler, after consent has closed its dialog.
          await page.evaluate(
            (bytes) => {
              const dt = new DataTransfer();
              dt.items.add(new File([Uint8Array.from(bytes)], "own.png", { type: "image/png" }));
              document.dispatchEvent(
                new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }),
              );
            },
            [...graphic],
          );
          await poll(
            page,
            () =>
              window.__cutoutTest.useWorkspace.getState().items[0]?.name === "own.png" &&
              window.__cutoutTest.useWorkspace.getState().items[0].status === "done",
          );
        } else if (change === "guide") {
          await page.getByRole("link", { name: "Guide", exact: true }).first().click();
          await page.getByRole("heading", { name: "Guide", exact: true }).waitFor();
        } else
          await page.evaluate((change) => {
            const store = window.__cutoutTest.useWorkspace,
              s = store.getState(),
              target = s.items[0];
            if (change === "source")
              store.setState({
                items: [
                  {
                    ...target,
                    source: new File([target.source], "replacement.png", { type: "image/png" }),
                    status: "done",
                  },
                ],
              });
            if (change === "select") {
              store.setState({
                items: [
                  ...s.items,
                  {
                    ...window.__held,
                    id: "own",
                    name: "own.png",
                    source: new File([target.source], "own.png", { type: "image/png" }),
                  },
                ],
                settings: { ...s.settings, own: s.settings[target.id] },
              });
              store.getState().selectItem("own");
            }
            if (change === "remove") s.removeItem(target.id);
            if (change === "edit") s.setBackground({ type: "color", color: "#123456" });
            if (change === "error")
              store.setState({
                items: [{ ...target, status: "error", error: "Controlled target error" }],
                errorMessage: "Controlled target error",
              });
          }, change);
        if (change === "error") {
          await page.evaluate(() => {
            window.__stopHold();
            const s = window.__cutoutTest.useWorkspace.getState();
            s.retryItem(s.items[0].id);
          });
          await poll(
            page,
            () => window.__cutoutTest.useWorkspace.getState().items[0]?.status === "done",
          );
        }
        await releaseFinishedLink(page);
        await page.waitForTimeout(150);
        assert.equal(flow.downloads(), 0, change);
        const edit = await settings(page);
        assert.notEqual(edit.preset, "amazon", change);
        assert.notEqual(edit.format, "jpeg", change);
        if (change === "edit")
          assert.deepEqual(edit.background, { type: "color", color: "#123456" });
        else assert.notDeepEqual(edit.background, { type: "blur" });
      });
  });

  test(`${engine}: held ingest validation cannot replace an existing selection; previous done items receive no plan`, async (t) => {
    const flow = await launchPage(t, engine),
      { page, dialog } = flow;
    await ingestGraphic(page, ["own-a.png", "own-b.png"]);
    await page.evaluate(() => {
      window.__gateWaiting = false;
      let hold = true;
      const slice = File.prototype.slice;
      File.prototype.slice = function (...args) {
        const blob = slice.apply(this, args);
        if (this.name === "linked.png" && hold) {
          const read = blob.arrayBuffer.bind(blob);
          blob.arrayBuffer = () =>
            new Promise((resolve) => {
              window.__gateWaiting = true;
              window.__releaseGate = async () => {
                hold = false;
                resolve(await read());
              };
            });
        }
        return blob;
      };
    });
    await dialog.getByRole("button", { name: "Load and download", exact: true }).click();
    await poll(page, () => window.__gateWaiting);
    await page.waitForTimeout(100);
    assert.equal(flow.downloads(), 0);
    await page.evaluate(() => {
      const s = window.__cutoutTest.useWorkspace.getState();
      s.selectItem(s.items[1].id);
      void window.__releaseGate();
    });
    await page.waitForTimeout(300);
    assert.deepEqual(
      await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return {
          names: s.items.map((item) => item.name),
          active: s.items.find((item) => item.id === s.activeId)?.name,
        };
      }),
      { names: ["own-a.png", "own-b.png"], active: "own-b.png" },
    );
    assert.equal(flow.downloads(), 0);
  });

  test(`${engine}: fetch success/error belong to the latest intent and current failures remain visible`, async (t) => {
    for (const outcome of ["stale-error", "stale-success", "current-error"])
      await t.test(outcome, async (t) => {
        const flow = await launchPage(t, engine, { holdFetch: true }),
          { page, dialog } = flow;
        await dialog.getByRole("button", { name: "Load and download", exact: true }).click();
        for (let attempt = 0; !flow.route() && attempt < 1000; attempt++)
          await page.waitForTimeout(10);
        assert.ok(flow.route(), "confirmed fetch reached the controlled boundary");
        if (outcome !== "current-error") await ingestGraphic(page);
        await flow.route().fulfill(
          outcome === "stale-success"
            ? {
                body: graphic,
                contentType: "image/png",
                headers: { "access-control-allow-origin": "*" },
              }
            : {
                status: 500,
                body: "controlled failure",
                headers: { "access-control-allow-origin": "*" },
              },
        );
        if (outcome === "current-error")
          await poll(page, () => Boolean(window.__cutoutTest.useWorkspace.getState().errorMessage));
        else {
          await page.waitForTimeout(150);
          assert.equal((await settings(page)).name, "own.png");
          assert.equal((await settings(page)).error, null);
        }
        assert.equal(flow.downloads(), 0);
      });
  });

  test(`${engine}: no-src consent applies to the current item or its first subsequent ingest`, async (t) => {
    for (const current of [true, false])
      await t.test(String(current), async (t) => {
        const flow = await launchPage(t, engine, { noSource: true }),
          { page, dialog } = flow;
        if (current) await ingestGraphic(page);
        const download = page.waitForEvent("download");
        await dialog.getByRole("button", { name: "Download when ready", exact: true }).click();
        if (!current) await ingestGraphic(page);
        assert.equal((await download).suggestedFilename(), "own-cutout.jpg");
        assert.equal(flow.downloads(), 1);
        assert.equal(flow.requests(), 0);
        assert.equal((await settings(page)).preset, "amazon");
      });
  });
}

for (const engine of ["chromium", "webkit"]) {
  for (const change of ["select", "edit", "guide", "source", "result", "away-back", "reset"])
    test(`${engine}: pending native encoding lifetime ${change}`, async (t) => {
      const flow = await launchPage(t, engine, { noSource: true }),
        { page, dialog } = flow;
      await ingestGraphic(page, ["own-a.png", "own-b.png"]);
      const files = [];
      page.on("download", (file) => {
        files.push(file);
      });
      await page.evaluate(() => {
        const original = HTMLCanvasElement.prototype.toBlob;
        window.__exportHeld = false;
        HTMLCanvasElement.prototype.toBlob = function (callback, mime, ...args) {
          return original.call(
            this,
            (blob) => {
              if (mime === "image/jpeg" && !window.__exportHeld) {
                window.__exportHeld = true;
                window.__releaseExport = () => callback(blob);
              } else callback(blob);
            },
            mime,
            ...args,
          );
        };
      });
      await dialog.getByRole("button", { name: "Download when ready", exact: true }).click();
      await poll(page, () => window.__exportHeld);
      assert.equal(flow.downloads(), 0);
      if (change === "guide") {
        await page.getByRole("link", { name: "Guide", exact: true }).first().click();
        await page.getByRole("heading", { name: "Guide", exact: true }).waitFor();
      } else
        await page.evaluate((change) => {
          const s = window.__cutoutTest.useWorkspace.getState();
          if (change === "select") s.selectItem(s.items[1].id);
          else if (change === "result")
            window.__cutoutTest.useWorkspace.setState({
              items: s.items.map((i, index) =>
                index === 0
                  ? { ...i, resultBlob: new Blob([i.resultBlob], { type: "image/png" }) }
                  : i,
              ),
            });
          else if (change === "source")
            window.__cutoutTest.useWorkspace.setState({
              items: s.items.map((i, index) =>
                index === 0
                  ? { ...i, source: new File([i.source], "replaced.png", { type: "image/png" }) }
                  : i,
              ),
            });
          else if (change === "away-back") {
            s.selectItem(s.items[1].id);
            s.selectItem(s.items[0].id);
          } else if (change === "reset") s.reset();
          else s.setBackground({ type: "color", color: "#123456" });
        }, change);
      await page.evaluate(() => window.__releaseExport());
      await page.waitForTimeout(400);
      for (const file of files) {
        if (process.env.CUTOUT_DOWNLOAD_DIR)
          await file.saveAs(`${process.env.CUTOUT_DOWNLOAD_DIR}/lifetime-${engine}-${change}.jpg`);
        assert.equal((await readFile(await file.path())).readUInt16BE(0), 0xffd8);
      }
      const wrongSaved =
        change === "select"
          ? await page.evaluate(() => {
              const store = window.__cutoutTest.useWorkspace;
              store.getState().removeItem(store.getState().items[0].id);
              const e = new Event("beforeunload", { cancelable: true });
              window.dispatchEvent(e);
              return !e.defaultPrevented;
            })
          : null;
      const snapshot = await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return {
          active: s.items.find((i) => i.id === s.activeId)?.name,
          exporting: s.exporting,
          saved: s.saved,
        };
      });
      console.log("reviewer-download-lifetime", {
        engine,
        change,
        downloads: flow.downloads(),
        snapshot,
        wrongSaved,
      });
      assert.equal(
        flow.downloads(),
        0,
        "cancelled launch must not download after pending encoding",
      );
      assert.equal(snapshot.saved, false);
      assert.equal(snapshot.exporting, false);
      assert.equal(
        await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().errorMessage),
        null,
      );
      if (change === "select")
        assert.equal(wrongSaved, false, "unexported second item must remain guarded");
    });
}

for (const engine of ["chromium", "webkit"])
  for (const change of ["select", "edit", "source", "result", "away-back", "guide"])
    test(`${engine}: linked pending native export ${change}`, async (t) => {
      const flow = await launchPage(t, engine),
        { page, dialog } = flow,
        files = [];
      page.on("download", (f) => files.push(f));
      await page.evaluate(() => {
        const native = HTMLCanvasElement.prototype.toBlob;
        window.__exportHeld = false;
        HTMLCanvasElement.prototype.toBlob = function (cb, mime, ...args) {
          return native.call(
            this,
            (blob) => {
              if (mime === "image/jpeg" && !window.__exportHeld) {
                window.__exportHeld = true;
                window.__releaseExport = () => cb(blob);
              } else cb(blob);
            },
            mime,
            ...args,
          );
        };
      });
      await dialog.getByRole("button", { name: "Load and download", exact: true }).click();
      await poll(page, () => window.__exportHeld);
      if (change === "guide") {
        await page.getByRole("link", { name: "Guide", exact: true }).first().click();
        await page.getByRole("heading", { name: "Guide", exact: true }).waitFor();
      } else
        await page.evaluate((change) => {
          const store = window.__cutoutTest.useWorkspace,
            s = store.getState(),
            i = s.items[0];
          if (change === "edit") {
            s.setBackground({ type: "color", color: "#123456" });
            return;
          }
          if (change === "source" || change === "result") {
            store.setState({
              items: [
                {
                  ...i,
                  ...(change === "source"
                    ? { source: new File([i.source], "replacement.png", { type: "image/png" }) }
                    : { resultBlob: new Blob([i.resultBlob], { type: "image/png" }) }),
                },
              ],
            });
            return;
          }
          store.setState({
            items: [
              i,
              {
                ...i,
                id: "other",
                name: "other.png",
                source: new File([i.source], "other.png", { type: "image/png" }),
              },
            ],
            settings: { ...s.settings, other: s.settings[i.id] },
          });
          s.selectItem("other");
          if (change === "away-back") s.selectItem(i.id);
        }, change);
      await page.evaluate(() => window.__releaseExport());
      await page.waitForTimeout(400);
      for (const f of files) {
        if (process.env.CUTOUT_DOWNLOAD_DIR)
          await f.saveAs(`${process.env.CUTOUT_DOWNLOAD_DIR}/linked-${engine}-${change}.jpg`);
        assert.equal((await readFile(await f.path())).readUInt16BE(0), 0xffd8);
      }
      console.log("linked-pending-export", {
        engine,
        change,
        downloads: flow.downloads(),
        name: files[0]?.suggestedFilename(),
      });
      assert.equal(flow.downloads(), 0);
      const state = await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return { saved: s.saved, exporting: s.exporting, error: s.errorMessage };
      });
      assert.deepEqual(state, { saved: false, exporting: false, error: null });
    });

// Picker/share are controlled API promises, while processing and JPEG bytes stay native.
// A dispatched close/share is deliberately allowed to finish; only later effects are gated.
for (const engine of ["chromium", "webkit"])
  for (const boundary of ["picker", "create", "write", "close", "native-share", "share-dialog"])
    for (const outcome of ["success", "error"])
      test(`${engine}: launch pending ${boundary} ${outcome} cancellation`, async (t) => {
        const flow = await launchPage(t, engine, { noSource: true }),
          { page, dialog } = flow;
        await ingestGraphic(page, ["save-a.png", "save-b.png"]);
        await page.evaluate(
          ({ boundary, outcome }) => {
            window.__nativeTrace = [];
            const hold = (value) =>
              new Promise((resolve, reject) => {
                window.__nativeHeld = true;
                window.__releaseNative = () =>
                  outcome === "error"
                    ? reject(
                        Object.assign(new Error("late controlled native failure"), {
                          name: "NotAllowedError",
                        }),
                      )
                    : resolve(value);
              });
            const writable = {
              write: async (blob) => {
                window.__nativeTrace.push("write");
                const bytes = new Uint8Array(await blob.arrayBuffer());
                if (bytes[0] !== 255 || bytes[1] !== 216)
                  throw new Error("expected actual JPEG bytes");
                if (boundary === "write") await hold();
              },
              close: async () => {
                window.__nativeTrace.push("close");
                if (boundary === "close") await hold();
              },
              abort: async () => {
                window.__nativeTrace.push("abort");
              },
            };
            const handle = {
              createWritable: async () => {
                window.__nativeTrace.push("create");
                return boundary === "create" ? hold(writable) : writable;
              },
            };
            if (boundary.includes("share")) {
              Object.defineProperty(navigator, "userAgent", {
                configurable: true,
                value: "iPhone OS 18_0",
              });
              Object.defineProperty(navigator, "userActivation", {
                configurable: true,
                value: { isActive: boundary !== "share-dialog" },
              });
              Object.defineProperty(navigator, "canShare", {
                configurable: true,
                value: () => true,
              });
              Object.defineProperty(navigator, "share", {
                configurable: true,
                value: async ({ files }) => {
                  window.__nativeTrace.push("share");
                  const bytes = new Uint8Array(await files[0].arrayBuffer());
                  if (bytes[0] !== 255 || bytes[1] !== 216)
                    throw new Error("expected actual JPEG bytes");
                  return hold();
                },
              });
            } else
              window.showSaveFilePicker = () => {
                window.__nativeTrace.push("picker");
                return boundary === "picker" ? hold(handle) : Promise.resolve(handle);
              };
          },
          { boundary, outcome },
        );
        await dialog.getByRole("button", { name: "Download when ready", exact: true }).click();
        if (boundary === "share-dialog") {
          const ready = page.getByRole("dialog", { name: "Your image is ready" });
          await ready.waitFor();
          if (outcome === "error") {
            await ready.getByRole("button", { name: "Share image", exact: true }).click();
            await poll(page, () => window.__nativeHeld);
          }
        } else await poll(page, () => window.__nativeHeld);
        await page.evaluate(() => {
          const store = window.__cutoutTest.useWorkspace;
          store.getState().selectItem(store.getState().items[1].id);
        });
        await poll(page, () => !window.__cutoutTest.useWorkspace.getState().exporting);
        await page.evaluate(() => window.__releaseNative?.());
        await page.waitForTimeout(150);
        assert.equal(flow.downloads(), 0);
        const state = await page.evaluate(() => {
          const store = window.__cutoutTest.useWorkspace,
            s = store.getState();
          store.getState().removeItem(s.items[0].id);
          const event = new Event("beforeunload", { cancelable: true });
          window.dispatchEvent(event);
          return {
            saved: s.saved,
            exporting: s.exporting,
            error: s.errorMessage,
            guarded: event.defaultPrevented,
            trace: window.__nativeTrace,
          };
        });
        assert.deepEqual(
          {
            saved: state.saved,
            exporting: state.exporting,
            error: state.error,
            guarded: state.guarded,
          },
          { saved: false, exporting: false, error: null, guarded: true },
        );
        if (boundary === "picker") assert.deepEqual(state.trace, ["picker"]);
        if (boundary === "create" && outcome === "success")
          assert.deepEqual(state.trace, ["picker", "create", "abort"]);
        if (boundary === "write")
          assert.deepEqual(state.trace, ["picker", "create", "write", "abort"]);
        if (boundary === "close" && outcome === "success")
          assert.deepEqual(state.trace, ["picker", "create", "write", "close"]);
        if (boundary === "share-dialog" && outcome === "success") assert.deepEqual(state.trace, []);
        assert.equal(await page.getByRole("dialog", { name: "Your image is ready" }).count(), 0);
        console.log("controlled-native-save", { engine, boundary, outcome, ...state });
      });

for (const engine of ["chromium", "webkit"])
  test(`${engine}: unheld current launch exports once and marks only its exported settings`, async (t) => {
    const flow = await launchPage(t, engine, { noSource: true }),
      { page, dialog } = flow;
    await ingestGraphic(page, ["healthy-a.png", "healthy-b.png"]);
    await page.evaluate(() => window.__cutoutTest.useWorkspace.setState({ saved: true }));
    const waiting = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download when ready", exact: true }).click();
    const file = await waiting;
    const bytes = await readFile(await file.path());
    assert.equal(bytes.readUInt16BE(0), 0xffd8);
    if (process.env.CUTOUT_DOWNLOAD_DIR)
      await file.saveAs(`${process.env.CUTOUT_DOWNLOAD_DIR}/healthy-current-${engine}.jpg`);
    await poll(page, () => !window.__cutoutTest.useWorkspace.getState().exporting);
    assert.equal(flow.downloads(), 1);
    const state = await page.evaluate(() => {
      const store = window.__cutoutTest.useWorkspace,
        s = store.getState();
      store.getState().removeItem(s.items[1].id);
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return { saved: s.saved, error: s.errorMessage, guarded: event.defaultPrevented };
    });
    assert.deepEqual(state, { saved: true, error: null, guarded: false });
  });

// Controlled AbortSignal.any absence on current engines. Not a historical Safari runtime.
for (const engine of ["chromium", "webkit"])
  for (const noSource of [false, true])
    test(`${engine}: supported browser without AbortSignal.any ${noSource ? "current" : "linked"}`, async (t) => {
      const flow = await launchPage(t, engine, { noSource }),
        { page, dialog } = flow;
      if (noSource) await ingestGraphic(page);
      await page.evaluate(() =>
        Object.defineProperty(AbortSignal, "any", { value: undefined, configurable: true }),
      );
      const files = [];
      page.on("download", (d) => files.push(d));
      await dialog
        .getByRole("button", {
          name: noSource ? "Download when ready" : "Load and download",
          exact: true,
        })
        .click();
      await poll(page, () => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return s.errorMessage || s.saved;
      });
      await page.waitForTimeout(150);
      const automatic = await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState(),
          i = s.items[0];
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return {
          error: s.errorMessage,
          saved: s.saved,
          exporting: s.exporting,
          status: i?.status,
          guarded: e.defaultPrevented,
        };
      });
      const automaticDownloads = flow.downloads();
      await page.evaluate(() =>
        window.__cutoutTest.useWorkspace.setState({ errorMessage: null, saved: false }),
      );
      const next = page.waitForEvent("download");
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadActive("jpeg"));
      const manual = await next;
      assert.equal((await readFile(await manual.path())).readUInt16BE(0), 0xffd8);
      if (process.env.CUTOUT_DOWNLOAD_DIR) {
        const label = (process.env.CUTOUT_EXPECT_COMMIT ?? "dev").slice(0, 7);
        const kind = noSource ? "current" : "linked";
        await manual.saveAs(
          `${process.env.CUTOUT_DOWNLOAD_DIR}/compat-${label}-${engine}-${kind}-manual.jpg`,
        );
        for (let i = 0; i < automaticDownloads; i++)
          await files[i].saveAs(
            `${process.env.CUTOUT_DOWNLOAD_DIR}/compat-${label}-${engine}-${kind}-automatic.jpg`,
          );
      }
      console.log("supported-missing-any", {
        engine,
        noSource,
        automaticDownloads,
        manualDownloads: 1,
        automatic,
      });
      assert.equal(automatic.status, "done");
      assert.equal(
        automatic.error,
        null,
        "healthy supported-browser launch must not throw on an optional newer API",
      );
      assert.equal(automaticDownloads, 1);
      assert.equal(automatic.saved, true);
      assert.equal(automatic.guarded, false);
      assert.equal(flow.downloads(), automaticDownloads + 1);
    });
