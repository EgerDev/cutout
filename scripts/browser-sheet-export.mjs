import { requireCutout } from "./require-server.mjs";
import { appCandidates } from "./app-url.mjs";
const verifiedAppUrl = (await requireCutout(appCandidates("http://127.0.0.1:8080/"))).replace(
  /\/$/,
  "",
);
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { unzipSync, strFromU8 } from "fflate";
import { launchChrome } from "./chrome.mjs";

const url = verifiedAppUrl;
const moduleBase = process.env.MODULE_URL ?? url;
let browser, page;

beforeEach(async () => {
  browser = await launchChrome();
  page = await browser.newPage();
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__cutoutTest?.useWorkspace));
});
afterEach(async () => {
  await browser?.close();
});

test("sprite exports preserve every duplicate and case-colliding frame", async () => {
  // Given three cutouts with colliding names and distinct colors.
  const report = await page.evaluate(async (base) => {
    const { renderSheet, spriteArchive } = await import(`${base}/src/lib/editor/sheet.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const items = await Promise.all(
      ["#ff0000", "#00ff00", "#0000ff"].map(async (color, index) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d");
        context.fillStyle = color;
        context.fillRect(0, 0, 16, 16);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const name = index === 2 ? "Graphic.png" : "graphic.png";
        return {
          name,
          source: new File([blob], name, { type: "image/png" }),
          result: blob,
          settings: defaults,
        };
      }),
    );

    // When the real renderer packs and archives the three sprites.
    const rendered = await renderSheet(items, { kind: "sprite", cell: 32 });
    const bitmap = await createImageBitmap(rendered.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = Object.values(rendered.atlas).map(({ x, y, w, h }) =>
      Array.from(context.getImageData(x + Math.floor(w / 2), y + Math.floor(h / 2), 1, 1).data),
    );
    const archive = spriteArchive(
      new Uint8Array(await rendered.blob.arrayBuffer()),
      rendered.atlas,
      {
        width: rendered.width,
        height: rendered.height,
      },
    );
    return {
      atlas: rendered.atlas,
      pixels,
      zip: Array.from(new Uint8Array(await archive.arrayBuffer())),
    };
  }, moduleBase);

  // Then every input has its own frame, correct pixel, and serialized atlas entry.
  const names = Object.keys(report.atlas);
  assert.equal(names.length, 3);
  assert.equal(new Set(names.map((name) => name.toLowerCase())).size, 3);
  assert.deepEqual(report.pixels, [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ]);
  const files = unzipSync(Uint8Array.from(report.zip));
  assert.deepEqual(Array.from(files["sprites.png"].slice(0, 4)), [137, 80, 78, 71]);
  assert.deepEqual(JSON.parse(strFromU8(files["sprites.json"])).frames, report.atlas);
});

test("exported matte restores one subject while leaving its neighbor removed", async () => {
  // Given two subjects removed by a single wide hint.
  const pixels = await page.evaluate(async (base) => {
    const { labelPieces, pieceAt, setPieces } = await import(`${base}/src/lib/editor/hints.ts`);
    const { encodeExport } = await import(`${base}/src/lib/editor/export.ts`);
    const { defaults } = await import(`${base}/src/lib/editor/model.ts`);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 100;
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(40, 40, 5, 20);
    context.fillStyle = "#00ff00";
    context.fillRect(46, 40, 5, 20);
    const image = context.getImageData(0, 0, 100, 100);
    const alpha = Uint8Array.from({ length: 10000 }, (_, index) => image.data[index * 4 + 3]);
    const pieces = labelPieces(alpha, 100, 100);
    const hints = [{ kind: "remove", size: 0.12, points: [{ x: 0.45, y: 0.5 }] }];
    const blob = await new Promise((resolve) => canvas.toBlob(resolve));

    // When one subject is restored and the edited matte is exported.
    const next = setPieces(pieces, hints, [pieceAt(pieces, 43, 50, 0)], false);
    const exported = await encodeExport({
      result: blob,
      source: new File([blob], "two-subjects.png", { type: "image/png" }),
      settings: { ...defaults, hints: next },
    });
    const bitmap = await createImageBitmap(exported.blob);
    context.clearRect(0, 0, 100, 100);
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [43, 48].map((x) => Array.from(context.getImageData(x, 50, 1, 1).data));
  }, moduleBase);

  // Then the restored subject is opaque and the other stays transparent in the PNG.
  assert.deepEqual(pixels[0], [255, 0, 0, 255]);
  assert.equal(pixels[1][3], 0);
});

for (const label of ["jpeg", "passport"]) {
  test(`sprite tiles preserve transparency with ${label} settings`, async () => {
    const pixels = await page.evaluate(
      async ({ base, label }) => {
        const { renderSheet } = await import(`${base}/src/lib/editor/sheet.ts`);
        const { defaults, presetPatch } = await import(`${base}/src/lib/editor/model.ts`);
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ff0000";
        ctx.fillRect(0, 0, 16, 16);
        ctx.clearRect(6, 6, 4, 4);
        ctx.clearRect(2, 2, 1, 1);
        ctx.fillStyle = "rgba(255, 0, 0, 0.5)";
        ctx.fillRect(2, 2, 1, 1);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve));
        const settings = {
          ...defaults,
          ...(label === "passport" ? presetPatch("passport") : { exportFormat: "jpeg" }),
        };
        const rendered = await renderSheet(
          [
            {
              name: "sprite.png",
              source: new File([blob], "sprite.png", { type: "image/png" }),
              result: blob,
              settings,
            },
          ],
          { kind: "sprite", cell: 64 },
        );
        const bitmap = await createImageBitmap(rendered.blob);
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        ctx.drawImage(bitmap, 0, 0);
        bitmap.close();
        const { x, y, w, h } = Object.values(rendered.atlas)[0];
        const alpha = ctx.getImageData(x, y, w, h).data.filter((_, i) => i % 4 === 3);
        return {
          center: Array.from(
            ctx.getImageData(x + Math.floor(w / 2), y + Math.floor(h / 2), 1, 1).data,
          ),
          partial: alpha.some((a) => a > 0 && a < 255),
        };
      },
      { base: moduleBase, label },
    );
    assert.equal(pixels.center[3], 0, "the hole inside the frame stays transparent");
    assert.equal(pixels.partial, true, "partial alpha survives JPEG export settings");
  });
}
