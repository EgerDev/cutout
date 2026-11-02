import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(/\/$/, "");
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runVariantBlock } from "./benchmark/browser-runner.mjs";
import { launchChrome } from "./chrome.mjs";
import { installFake, readFakeLog } from "./fake-transformers.mjs";

test("new removal publishes its own progress when the previous throttle clock is pending", async () => {
  const browser = await launchChrome();
  try {
    const page = await browser.newPage();
    await page.goto(verifiedAppUrl);
    // Given a real graphic and a paused progress throttle clock.
    const image = await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = "black";
      ctx.fillRect(24, 24, 48, 48);
      const original = window.setTimeout.bind(window);
      window.throttleTimers = new Set();
      window.setTimeout = (fn, delay, ...args) => {
        const id = original(fn, delay === 80 ? 60000 : delay, ...args);
        if (delay === 80) window.throttleTimers.add(id);
        return id;
      };
      return canvas.toDataURL().split(",")[1];
    });
    const upload = async (name) => {
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Choose files", exact: true }).click();
      await (await chooser).setFiles({
        name, mimeType: "image/png", buffer: Buffer.from(image, "base64"),
      });
      await page.waitForFunction((name) => {
        const item = window.__cutoutTest?.useWorkspace?.getState().items[0];
        return item?.name === name && item.status === "done";
      }, name);
    };
    await upload("first.png");
    await page.evaluate(() => {
      window.progressEvents = [];
      window.__cutoutTest?.useWorkspace.subscribe((state, previous) => {
        if (state.progress !== previous.progress) window.progressEvents.push(state.progress.message);
      });
      window.__cutoutTest?.useWorkspace.getState().reset();
    });
    // When the next image is processed before the old throttle would expire.
    await upload("second.png");
    const events = await page.evaluate(() => window.progressEvents);
    // Then the next image announces progress instead of inheriting stale status.
    assert.ok(events.length > 0, "The next image emitted no progress");
    await page.evaluate(() => {
      for (const id of window.throttleTimers) clearTimeout(id);
    });
  } finally {
    await browser.close();
  }
});

// C05: the real queue over the faked Transformers.js boundary (worker and page). A failure that only
// reads like a cancel (an error named AbortError while the item was never stopped) used to requeue the
// item with no end; S2-V04 counted 1734 runs in 6 s. It must settle once, with a bounded number of runs.
async function queueOnePhoto({ adapter, config }) {
  const browser = await launchChrome();
  try {
    const context = await browser.newContext();
    await installFake(context, {
      deviceMemory: 8,
      adapter,
      page: config,
      worker: config,
      workerEnv: { deviceMemory: 8, adapter },
    });
    const page = await context.newPage();
    await page.goto(verifiedAppUrl);
    // A colourful photo, so the graphics shortcuts leave it to the model.
    const photo = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 120;
      canvas.height = 80;
      const ctx = canvas.getContext("2d");
      const gradient = ctx.createLinearGradient(0, 0, 120, 80);
      gradient.addColorStop(0, "#1357d5");
      gradient.addColorStop(0.5, "#f28b12");
      gradient.addColorStop(1, "#45b96b");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 120, 80);
      ctx.fillStyle = "#7020b8";
      ctx.fillRect(40, 30, 40, 30);
      return canvas.toDataURL().split(",")[1];
    });
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose files", exact: true }).click();
    await (await chooser).setFiles({ name: "photo.png", mimeType: "image/png", buffer: Buffer.from(photo, "base64") });
    await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
    await page.evaluate(() => {
      const store = window.__cutoutTest.useWorkspace;
      window.statuses = [store.getState().items[0]?.status ?? "none"];
      store.subscribe((state) => {
        const status = state.items[0]?.status;
        if (status && status !== window.statuses.at(-1)) window.statuses.push(status);
      });
    });
    const settled = await page
      .waitForFunction(
        () => ["done", "error"].includes(window.__cutoutTest.useWorkspace.getState().items[0]?.status),
        null,
        { timeout: 15_000 },
      )
      .then(
        () => true,
        () => false,
      );
    const count = async () => {
      const log = await readFakeLog(page);
      return {
        runs: log.filter((e) => e.type === "run" && e.phase === "model").length,
        loads: log.filter((e) => e.type === "from_pretrained" && e.kind === "model").length,
        workerLoads: log.filter((e) => e.type === "from_pretrained" && e.ctx === "worker").length,
      };
    };
    const first = await count();
    // Long enough for a requeued item to run again many times over.
    await page.waitForTimeout(1500);
    const later = await count();
    const item = await page.evaluate(() => {
      const { status, error, retryable, provider } = window.__cutoutTest.useWorkspace.getState().items[0];
      return { status, error, retryable, provider, statuses: window.statuses };
    });
    // The first queued state belongs to ingest; only a return after working is a requeue.
    const requeues = item.statuses.slice(item.statuses.indexOf("working") + 1).filter((status) => status === "queued").length;
    return { settled, first, later, item, requeues };
  } finally {
    await browser.close();
  }
}

test("C05: a model failure named AbortError with a live signal is recovered by the compatibility pass, never requeued", async () => {
  // WebGPU's readback rejection after a device loss, on every WebGPU run; WASM works.
  const config = {
    mask: `(call) => {
      if (call.device === "webgpu")
        throw new DOMException("Failed to execute 'mapAsync' on 'GPUBuffer': Device is lost", "AbortError");
      return (u, v) => (u >= 0.25 && u < 0.75 && v >= 0.2 && v < 0.8 ? 20 : -20);
    }`,
  };
  const { settled, first, later, item, requeues } = await queueOnePhoto({ adapter: true, config });
  assert.ok(settled, `the item settles (${requeues} requeues, ${later.runs} model runs)`);
  assert.deepEqual([item.status, item.provider], ["done", "wasm"]);
  assert.equal(requeues, 0, "never requeued");
  assert.ok(first.workerLoads > 0, "the worker ran it");
  assert.equal(later.runs, first.runs, "nothing runs after it settles");
});

test("C05: a load failure named AbortError with a live signal ends in a retryable error, never requeued", async () => {
  // Uncoded load failures whose text says "abort" classify as cancelled; the item was never stopped.
  const config = {
    load: `(call) => {
      if (call.kind === "model") throw new DOMException("The operation was aborted.", "AbortError");
    }`,
  };
  const { settled, first, later, item, requeues } = await queueOnePhoto({ adapter: false, config });
  assert.ok(settled, `the item settles (${requeues} requeues, ${later.loads} model loads)`);
  assert.equal(item.status, "error");
  assert.equal(item.retryable, true, "Retry is offered");
  assert.notEqual(item.error, "Stopped.", "not the cancel copy");
  assert.equal(requeues, 0, "never requeued");
  assert.ok(first.workerLoads > 0, "the worker ran it");
  assert.equal(later.loads, first.loads, "nothing loads after it settles");
});

for (const mixed of [false, true]) {
  test(`E03-03 / E03-G-02: ${mixed ? "mixed-failure" : "first-15"} notice survives queue drain until dismissed`, async () => {
    const browser = await launchChrome();
    try {
      const context = await browser.newContext();
      if (mixed) {
        const config = { load: `(call) => { if (call.kind === "model") throw new Error("Failed to fetch"); }` };
        await installFake(context, { deviceMemory: 8, adapter: false, page: config, worker: config,
          workerEnv: { deviceMemory: 8, adapter: false } });
      }
      const page = await context.newPage();
      await page.goto(verifiedAppUrl);
      const pngs = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 96;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, 96, 96);
        ctx.fillStyle = "black";
        ctx.fillRect(24, 24, 48, 48);
        const graphic = canvas.toDataURL().split(",")[1];
        const gradient = ctx.createLinearGradient(0, 0, 96, 96);
        gradient.addColorStop(0, "#1357d5");
        gradient.addColorStop(0.5, "#f28b12");
        gradient.addColorStop(1, "#45b96b");
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, 96, 96);
        return { graphic, photo: canvas.toDataURL().split(",")[1] };
      });
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "Choose files", exact: true }).click();
      await (await chooser).setFiles(Array.from({ length: mixed ? 2 : 20 }, (_, i) => ({
        name: `notice-${i}.png`, mimeType: "image/png",
        buffer: Buffer.from(mixed && i === 0 ? pngs.photo : pngs.graphic, "base64"),
      })));
      await page.waitForFunction(() => {
        const s = window.__cutoutTest?.useWorkspace.getState();
        return s?.phase === "result" && s.items.every(i => ["done", "error"].includes(i.status));
      });
      const state = await page.evaluate(() => {
        const s = window.__cutoutTest.useWorkspace.getState();
        return { notice: s.errorMessage, statuses: s.items.map(i => i.status) };
      });
      if (mixed) {
        assert.deepEqual(state.statuses, ["error", "done"]);
        assert.match(state.notice, /local remover/);
      } else {
        assert.equal(state.statuses.length, 15);
        assert.equal(state.notice, "Loaded the first 15 of 20 images. Drop the rest next.");
      }
      await page.getByRole("alert").getByText(state.notice, { exact: true }).waitFor();
      await page.getByRole("button", { name: "Dismiss", exact: true }).click();
      assert.equal(await page.getByRole("alert").count(), 0);
      assert.equal(await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().errorMessage), null);
    } finally {
      await browser.close();
    }
  });
}


test("F-E07-01: the benchmark runner accepts replacement and completes two fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cutout-ux-benchmark-"));
  try {
    const inputPath = join(directory, "graphic.png");
    await writeFile(inputPath, await sharp({ create: { width: 96, height: 96, channels: 4, background: "white" } })
      .composite([{ input: await sharp({ create: { width: 48, height: 48, channels: 4, background: "black" } }).png().toBuffer(), left: 24, top: 24 }])
      .png().toBuffer());
    const fixtures = ["first", "second"].map(id => ({ id, category: "synthetic-boundary", evaluation: "known-alpha", inputPath, input: { path: inputPath } }));
    const { rows } = await runVariantBlock({
      url: verifiedAppUrl, profileDirectory: join(directory, "profile"),
      outputDirectory: directory, requestedProvider: "wasm", mode: "auto", fixtures,
      variant: "candidate", pair: 0, order: 0, warmups: 0, timeoutMs: 15_000,
      saveOutputs: false, signal: new AbortController().signal,
    });
    assert.deepEqual(rows.map(row => [row.fixtureId, row.status]), [["first", "completed"], ["second", "completed"]]);
    assert.equal(rows[0].outputSha256, rows[1].outputSha256);
    assert.ok(rows.every(row => row.method === "logo"), "the regression uses graphics without loading models");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
