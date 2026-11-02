// npm run dev or a production preview must be running at APP_URL.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { appCandidates } from "./app-url.mjs";
import { launchChrome } from "./chrome.mjs";
import { requireCutout } from "./require-server.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
let browser;
beforeEach(async () => { browser = await launchChrome(); });
afterEach(async () => { await browser?.close(); });

async function newPage(options) {
  const page = await browser.newPage(options);
  // Platform editor integration is unrelated to workspace behavior; keep CDN outages out of functional tests.
  return page;
}

async function openWorkspace(width = 1280) {
  const page = await newPage({ viewport: { width, height: 800 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  return page;
}

async function uploadGraphic(page, count = 1) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = "black"; ctx.fillRect(24, 24, 48, 48);
    return canvas.toDataURL().split(",")[1];
  });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await chooser).setFiles(
    Array.from({ length: count }, (_, i) => ({
      name: `graphic-${i + 1}.png`, mimeType: "image/png", buffer: Buffer.from(base64, "base64"),
    })),
  );
  await page.getByRole("toolbar", { name: "Image actions" }).waitFor();
}

test("idle screen does not request ML assets or models", async () => {
  const page = await newPage();
  const modelRequests = [];
  page.on("request", (request) => {
    if (/huggingface|transformers|\.onnx(?:\?|$)/.test(request.url())) {
      modelRequests.push(new URL(request.url()).pathname);
    }
  });
  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded" });
    // Observe beyond the former 2.5-second idle warmup deadline.
    await page.waitForTimeout(3500);
    assert.deepEqual(modelRequests, []);
  } finally { await page.close(); }
});

test("Download saves the selected image with one click", async () => {
  const page = await openWorkspace();
  try {
    await uploadGraphic(page);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /^Download(?: PNG)?$/ }).click();
    assert.equal((await download).suggestedFilename(), "graphic-1-cutout.png");
  } finally { await page.close(); }
});

test("Space activates a focused toolbar button instead of stealing the key for peek", async () => {
  const page = await openWorkspace();
  try {
    await uploadGraphic(page);
    const compare = page.getByRole("button", { name: "Compare", exact: true });
    await compare.focus();
    await page.keyboard.press("Space");
    assert.equal(await compare.getAttribute("aria-pressed"), "true");
  } finally { await page.close(); }
});

test("keyboard help closes with Escape without clearing the image", async () => {
  const page = await openWorkspace();
  try {
    await uploadGraphic(page);
    await page.locator("body").click({ position: { x: 2, y: 100 } });
    await page.keyboard.press("?");
    await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 1);
  } finally { await page.close(); }
});

test("mobile toolbar has accessible icon names and batch statuses", async () => {
  const page = await openWorkspace(375);
  try {
    await uploadGraphic(page, 3);
    await page.getByRole("button", { name: "Compare", exact: true }).waitFor();
    await page.getByRole("button", { name: "Info", exact: true }).waitFor();
    await page.getByRole("button", { name: /graphic-3.png.*Ready/ }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { await page.close(); }
});


test("static GPU preview stops requesting frames and still responds to compare", async () => {
  const page = await newPage();
  const gpuErrors = [];
  page.on("console", (message) => {
    if (/While validating|GPUValidationError|CreateSampler/.test(message.text())) gpuErrors.push(message.text());
  });
  try {
    await page.addInitScript(() => {
      window.gpuValidationErrors = [];
      if (navigator.gpu) {
        const requestAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
        navigator.gpu.requestAdapter = async (...args) => {
          const adapter = await requestAdapter(...args);
          if (adapter) {
            const requestDevice = adapter.requestDevice.bind(adapter);
            adapter.requestDevice = async (...options) => {
              const device = await requestDevice(...options);
              device.addEventListener("uncapturederror", (event) => window.gpuValidationErrors.push(event.error.message));
              return device;
            };
          }
          return adapter;
        };
      }
      window.nativeRaf = window.requestAnimationFrame.bind(window);
      window.scheduledFrames = 0;
      window.requestAnimationFrame = (callback) => {
        window.scheduledFrames++;
        return window.nativeRaf(callback);
      };
    });
    await page.goto(appUrl);
    await uploadGraphic(page);
    await page.locator(".stage-media[data-gpu]").waitFor().catch(async (error) => {
      throw new Error(`${error.message} GPU validation: ${JSON.stringify(await page.evaluate(() => window.gpuValidationErrors))}`);
    });
    const frames = await page.evaluate(async () => {
      const waitFrames = async (n) => {
        for (let i = 0; i < n; i++) await new Promise(window.nativeRaf);
      };
      await waitFrames(30);
      window.scheduledFrames = 0;
      await waitFrames(20);
      return window.scheduledFrames;
    });
    assert.ok(frames <= 1, `Static preview scheduled ${frames} animation frames`);
    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const slider = page.getByRole("slider", { name: /compare/i });
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await slider.getAttribute("aria-valuenow"), "53");
    await page.setViewportSize({ width: 768, height: 800 });
    await page.locator(".stage-media[data-gpu]").waitFor();
    assert.deepEqual(gpuErrors, []);
    assert.deepEqual(await page.evaluate(() => window.gpuValidationErrors), []);
  } finally { await page.close(); }
});


test("WebGL preview recovers after context loss without a continuous render loop", async () => {
  const page = await newPage();
  try {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "gpu", { value: undefined });
      window.nativeRaf = window.requestAnimationFrame.bind(window);
      window.scheduledFrames = 0;
      window.requestAnimationFrame = (callback) => {
        window.scheduledFrames++;
        return window.nativeRaf(callback);
      };
    });
    await page.goto(appUrl);
    await uploadGraphic(page);
    await page.locator('.stage-media[data-gpu^="webgl"]').waitFor();
    const stage = page.locator(".stage-media");
    // Reuse the adjacent static-preview test's 30-frame settle / 20-frame observation
    // and <=1 scheduling bound. Observer frames bypass the instrumented app rAF.
    const assertQuiet = async (label) => {
      const frames = await page.evaluate(async () => {
        const waitFrames = async (n) => {
          for (let i = 0; i < n; i++) await new Promise(window.nativeRaf);
        };
        await waitFrames(30);
        window.scheduledFrames = 0;
        await waitFrames(20);
        return window.scheduledFrames;
      });
      assert.ok(frames <= 1, `${label}: static preview scheduled ${frames} animation frames`);
    };
    const pixels = async () => {
      const png = await stage.screenshot({ animations: "disabled" });
      return page.evaluate(async (base64) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
        try {
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d");
          ctx.drawImage(bitmap, 0, 0);
          return [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1]].map(([x, y]) =>
            Array.from(ctx.getImageData(Math.round(x * (bitmap.width - 1)), Math.round(y * (bitmap.height - 1)), 1, 1).data),
          );
        } finally { bitmap.close(); }
      }, png.toString("base64"));
    };
    // Interior points of uploadGraphic's black square and removed white background:
    // no edge interpolation, numeric tolerance or backend-label-only success.
    const black = [0, 0, 0, 255];
    const white = [255, 255, 255, 255];
    const assertCutout = ([center, ...background]) => {
      assert.deepEqual(center, black, "the visible subject must remain black");
      for (const pixel of background) {
        assert.equal(pixel[3], 255, "the visible checkerboard must be opaque");
        assert.notDeepEqual(pixel, black, "a blank black canvas is not recovery");
        assert.notDeepEqual(pixel, white, "the stale original background is not recovery");
      }
    };
    await assertQuiet("before loss");
    assertCutout(await pixels());
    assert.equal(await page.evaluate(() => {
      const canvas = document.querySelector(".stage-media canvas");
      const gl = canvas.getContext("webgl2");
      const extension = gl.getExtension("WEBGL_lose_context");
      window.webglRecovery = { canvas, gl, extension, lost: 0, restored: 0 };
      canvas.addEventListener("webglcontextlost", (event) => {
        window.webglRecovery.lost++;
        window.webglRecovery.lossTrusted = event.isTrusted;
        window.webglRecovery.lossPrevented = event.defaultPrevented;
      });
      canvas.addEventListener("webglcontextrestored", (event) => {
        window.webglRecovery.restored++;
        window.webglRecovery.restoreTrusted = event.isTrusted;
      });
      return Boolean(extension) && !gl.isContextLost();
    }), true, "a live native WebGL context and lose-context extension are required");
    await page.evaluate(() => window.webglRecovery.extension.loseContext());
    await page.waitForFunction(() => window.webglRecovery.lost === 1 && window.webglRecovery.gl.isContextLost());
    assert.deepEqual(await page.evaluate(() => ({
      trusted: window.webglRecovery.lossTrusted,
      prevented: window.webglRecovery.lossPrevented,
    })), { trusted: true, prevented: true });

    // Reviewed UI-04 (906cee2) advances to a fresh lower backend after failed paint;
    // it does not promote the Stage back to the retired WebGL canvas on restore.
    await page.locator('.stage-media[data-gpu="2d"]').waitFor();
    assert.equal(await page.evaluate(() => {
      const current = document.querySelector(".stage-media canvas");
      window.recoveredStageCanvas = current;
      return current !== window.webglRecovery.canvas && !window.webglRecovery.canvas.isConnected;
    }), true);
    assertCutout(await pixels());
    await assertQuiet("during native WebGL loss");
    await page.evaluate(() => window.webglRecovery.extension.restoreContext());
    await page.waitForFunction(() => window.webglRecovery.restored === 1 && !window.webglRecovery.gl.isContextLost());
    assert.equal(await page.evaluate(() => window.webglRecovery.restoreTrusted), true);
    assertCutout(await pixels());
    await assertQuiet("after native WebGL restore");

    await page.getByRole("button", { name: "Compare", exact: true }).click();
    const slider = page.getByRole("slider", { name: "Compare original and result", exact: true });
    await slider.focus();
    await page.keyboard.press("End");
    assert.equal(await slider.getAttribute("aria-valuenow"), "100");
    const source = await pixels();
    assert.deepEqual(source, [black, white, white], "Compare must show the original file");
    assert.throws(() => assertCutout(source), "the cutout oracle must reject stale original pixels");
    // Negative blank-display control on the actual visible fallback canvas. Home
    // must then request a real application repaint, restoring the cutout itself.
    await page.evaluate(() => {
      const canvas = window.recoveredStageCanvas;
      canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    });
    const blank = await pixels();
    assert.throws(() => assertCutout(blank), "the cutout oracle must reject a blank visible canvas");
    await page.keyboard.press("Home");
    assert.equal(await slider.getAttribute("aria-valuenow"), "0");
    assertCutout(await pixels());
    await page.setViewportSize({ width: 768, height: 800 });
    assertCutout(await pixels());
    await assertQuiet("after compare and resize");
    assert.equal(await page.evaluate(() => window.recoveredStageCanvas === document.querySelector(".stage-media canvas")), true);
    assert.equal(await stage.getAttribute("data-gpu"), "2d");
    assert.equal(await page.getByRole("toolbar", { name: "Image actions", exact: true }).isVisible(), true);
  } finally { await page.close(); }
});


test("switching ready batch images keeps the live GPU canvas", async () => {
  const page = await openWorkspace();
  try {
    await uploadGraphic(page, 2);
    await page.getByRole("button", { name: "graphic-2.png · Ready", exact: true }).waitFor();
    await page.locator(".stage-media[data-gpu]").waitFor();
    await page.evaluate(() => { window.originalStageCanvas = document.querySelector(".stage-media canvas"); });
    await page.getByRole("button", { name: "graphic-2.png · Ready", exact: true }).click();
    await page.locator(".stage-media[data-gpu]").waitFor();
    assert.equal(await page.evaluate(() => window.originalStageCanvas === document.querySelector(".stage-media canvas")), true);
    const image = await page.locator(".stage-media canvas").evaluate((canvas) => canvas.toDataURL());
    assert.ok(image.length > 100, "Selected image must have a drawable canvas");
  } finally { await page.close(); }
});

test("Escape closes Adjust from an editable control and keeps the image", async () => {
  const page = await openWorkspace();
  try {
    await uploadGraphic(page);
    await page.getByRole("button", { name: "Adjust", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Width", exact: true }).focus();
    await page.keyboard.press("Escape");
    await page.locator('#cutout-adjust[aria-hidden="false"]').waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("toolbar", { name: "Image actions" }).count(), 1);
  } finally { await page.close(); }
});
