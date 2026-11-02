import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildCorpusManifest } from "./benchmark/build-corpus-manifest.mjs";
import { edgeCases, shadowHaloBackdrop } from "./benchmark/generate-known-alpha.mjs";

test("shadow-halo variants pair dark backgrounds with dark backdrops", () => {
  // Even indices are the dark-field variant; a light backdrop there would test a
  // second light-field shadow instead of the intended dark-field one (#27 review).
  for (let i = 0; i < edgeCases.length * 3; i += 1) {
    const bg = shadowHaloBackdrop(i);
    const mean = (bg[0] + bg[1] + bg[2]) / 3;
    if (i % 2) assert.ok(mean > 150, `index ${i} should be the light field`);
    else assert.ok(mean < 100, `index ${i} should be the dark field`);
  }
});

test("the manifest labels edge-case fixtures by their generated categories", async (t) => {
  // Without the shared category table, known-41+ inherit the original ten labels
  // round-robin and category-grouped metrics silently misattribute them.
  const root = await mkdtemp(join(tmpdir(), "cutout-corpus-"));
  t.after(() => import("node:fs/promises").then((f) => f.rm(root, { recursive: true, force: true })));
  await mkdir(join(root, "aim500/input"), { recursive: true });
  await mkdir(join(root, "aim500/alpha"), { recursive: true });
  await writeFile(
    join(root, "aim500/source-index.json"),
    JSON.stringify({ records: [], dataset: "stub" }),
  );
  await mkdir(join(root, "known-alpha/input"), { recursive: true });
  await mkdir(join(root, "known-alpha/alpha"), { recursive: true });
  await mkdir(join(root, "current"), { recursive: true });
  const png = await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
    .png()
    .toBuffer();
  const ids = ["known-00", "known-41", "known-42", "known-43", "known-44", "known-45", "known-46", "known-47", "known-48", "known-49"];
  for (const id of ids) {
    await writeFile(join(root, "known-alpha/input", `${id}.png`), png);
    await writeFile(join(root, "known-alpha/alpha", `${id}.png`), png);
  }
  await writeFile(join(root, "current/sample.jpg"), await sharp(png).jpeg().toBuffer());
  const manifest = await buildCorpusManifest(root);
  const byId = Object.fromEntries(manifest.fixtures.map((f) => [f.id, f.category]));
  for (const id of ids) {
    const number = Number(id.slice(6));
    assert.equal(
      byId[id],
      number >= 41 ? edgeCases[(number - 41) % edgeCases.length] : "portrait-hair",
      `${id} category`,
    );
  }
});
