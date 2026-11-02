// "Download original, cleaned" must never hand back location data (F-PRIV-01, F-SEC-06).
// npm run dev or a production server must be running at APP_URL.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { after, before, test } from "node:test";
import ExifReader from "exifreader";
import { launchChrome } from "./chrome.mjs";
import { appCandidates } from "./app-url.mjs";
import { requireCutout } from "./require-server.mjs";
import { rgbTiffWithGps, withGpsExif } from "../src/lib/fixtures/make-fixtures.mjs";

const appUrl = await requireCutout(appCandidates("http://127.0.0.1:8080/"));
let browser;
before(async () => {
  browser = await launchChrome();
});
after(async () => {
  await browser?.close();
});

async function openWorkspace() {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(20000);
  await page.addInitScript(() => {
    delete window.showSaveFilePicker;
  });
  await page.goto(new URL("/?e2e", appUrl).href, { waitUntil: "domcontentloaded" });
  return page;
}

/** A dark square on white, as JPEG bytes and raw RGB, drawn by the browser. */
async function drawnImage(page) {
  const { jpeg, png, rgb } = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = "black";
    ctx.fillRect(24, 24, 48, 48);
    const rgba = ctx.getImageData(0, 0, 96, 96).data;
    const rgb = [];
    for (let i = 0; i < rgba.length; i += 4) rgb.push(rgba[i], rgba[i + 1], rgba[i + 2]);
    return {
      jpeg: canvas.toDataURL("image/jpeg").split(",")[1],
      png: canvas.toDataURL("image/png").split(",")[1],
      rgb,
    };
  });
  return { jpeg: Buffer.from(jpeg, "base64"), png: Buffer.from(png, "base64"), rgb };
}

async function upload(page, name, mimeType, buffer) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose files", exact: true }).click();
  await (await chooser).setFiles({ name, mimeType, buffer: Buffer.from(buffer) });
}

async function downloadCleaned(page) {
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  const strip = page.getByRole("checkbox", { name: "Strip metadata" });
  if (!(await strip.isChecked())) await strip.check();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download original, cleaned" }).click();
  const file = await download;
  return { name: file.suggestedFilename(), bytes: await readFile(await file.path()) };
}

const gpsOf = (bytes) =>
  ExifReader.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), {
    expanded: true,
  }).gps;

test("a JPEG with GPS downloads without it, named by its real type", async () => {
  const page = await openWorkspace();
  try {
    const { jpeg } = await drawnImage(page);
    const withGps = withGpsExif(jpeg);
    assert.ok(gpsOf(withGps)?.Latitude);
    // The incoming name must not choose the extension of the saved file.
    await upload(page, "photo.html", "image/jpeg", withGps);
    const { name, bytes } = await downloadCleaned(page);
    assert.equal(name, "photo-cleaned.jpg");
    assert.equal(gpsOf(bytes), undefined);
    assert.equal(bytes.includes(Buffer.from("Taken at home")), false);
  } finally {
    await page.close();
  }
});

test("a TIFF with GPS is re-encoded to PNG without it", async () => {
  const page = await openWorkspace();
  try {
    const { rgb } = await drawnImage(page);
    const tiff = rgbTiffWithGps(96, 96, rgb);
    assert.ok(gpsOf(tiff)?.Latitude);
    await upload(page, "scan.tiff", "image/tiff", tiff);
    const { name, bytes } = await downloadCleaned(page);
    assert.equal(name, "scan-cleaned.png");
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47]);
    assert.equal(gpsOf(bytes), undefined);
    // Full size came back, so there is no "saved smaller" notice.
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().errorMessage),
      null,
    );
  } finally {
    await page.close();
  }
});

test("a real HEIC is saved at full size with no 'larger' notice", async () => {
  const page = await openWorkspace();
  try {
    // 64×64 coded extent, cropped to 64×48 by 'clap': the whole picture is 64×48.
    const heic = await readFile(new URL("../src/lib/fixtures/tiny.heic", import.meta.url));
    await upload(page, "tiny.heic", "image/heic", heic);
    // Once removal is finished nothing else touches the notice area.
    await page.waitForFunction(() => {
      const items = window.__cutoutTest.useWorkspace.getState().items;
      return items.length > 0 && items.every((item) => item.status === "done" || item.status === "error");
    });
    const download = page.waitForEvent("download");
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().downloadOriginal());
    const file = await download;
    const bytes = await readFile(await file.path());
    assert.equal(file.suggestedFilename(), "tiny-cleaned.png");
    assert.deepEqual([bytes.readUInt32BE(16), bytes.readUInt32BE(20)], [64, 48]);
    await page.waitForTimeout(300);
    assert.equal(
      await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().errorMessage),
      null,
    );
  } finally {
    await page.close();
  }
});

test("a HEIC the browser cannot decode saves nothing and says why", async () => {
  const page = await openWorkspace();
  try {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypheic"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("mif1heic"),
      Buffer.from("Exif\0\0GPSLatitude 37.7749 GPSLongitude -122.4194"),
    ]);
    await upload(page, "home.heic", "image/heic", heic);
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().items.length > 0);
    let downloaded = false;
    page.on("download", () => (downloaded = true));
    const message = await page.evaluate(async () => {
      const store = window.__cutoutTest.useWorkspace;
      await store.getState().downloadOriginal();
      return store.getState().errorMessage;
    });
    assert.match(message ?? "", /Couldn’t remove the metadata/);
    await page.waitForTimeout(500);
    assert.equal(downloaded, false);
  } finally {
    await page.close();
  }
});

test("generator metadata that is not text cannot take down the Info panel", async () => {
  const page = await openWorkspace();
  try {
    const { png } = await drawnImage(page);
    // NovelAI-style comment whose fields are objects and arrays instead of text (F-SEC-04).
    const comment = JSON.stringify({ prompt: { x: 1 }, uc: 1, steps: { y: 2 }, seed: [1] });
    const data = Buffer.from(`tEXtComment\0${comment}`, "latin1");
    const chunk = Buffer.alloc(data.length + 8);
    chunk.writeUInt32BE(data.length - 4, 0);
    data.copy(chunk, 4);
    chunk.writeUInt32BE(crc32(data) >>> 0, data.length + 4);
    const crafted = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    await upload(page, "novel.png", "image/png", crafted);
    await page.waitForFunction(() => window.__cutoutTest.useWorkspace.getState().activeId);
    await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().openInfo());
    const info = page.locator("#cutout-info");
    await info.getByText("NovelAI", { exact: true }).waitFor();
    assert.equal(await info.getByRole("heading", { name: "Image information" }).isVisible(), true);
  } finally {
    await page.close();
  }
});
