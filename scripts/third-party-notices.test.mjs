import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { MODEL_NOTICES } from "../src/lib/model-notices.ts";
import { NOTICES_FILE, renderNotices, vendoredPackages } from "./third-party-notices.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

// Every source file under src/ (minus tests and the list itself).
const sourceFiles = (dir) =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$|model-notices\.ts$/.test(entry.name)
      ? [path]
      : [];
  });
const MODEL_SOURCES = sourceFiles("src");
const MIME = /^(image|text|application|video|audio|font|model)\//;
const REVISION = /["']([0-9a-f]{40})["']/g;
const revisions = (text) => [...text.matchAll(REVISION)].map((m) => m[1]);
/** Quoted `org/name` strings within a few lines of a pinned 40-hex revision: model ids. */
const quotedIds = (text) => {
  const pins = [...text.matchAll(REVISION)].map((m) => m.index);
  return [...text.matchAll(/["']([A-Za-z0-9][\w.-]*\/[\w.-]+)["']/g)]
    .filter((m) => !MIME.test(m[1]) && pins.some((at) => Math.abs(at - m.index) < 400))
    .map((m) => m[1]);
};

test("the committed notices file is exactly what the generator produces", () => {
  const committed = readFileSync(join(root, NOTICES_FILE));
  const fresh = Buffer.from(renderNotices(), "utf8");
  assert.ok(
    committed.equals(fresh),
    `${NOTICES_FILE} is stale: run \`node scripts/third-party-notices.mjs\` and commit the result`,
  );
});

test("the distributed ExifReader source matches the locked MPL package", () => {
  const locked = JSON.parse(read("package-lock.json")).packages["node_modules/exifreader"];
  const archive = readFileSync(
    join(root, `public/third-party/source/exifreader-${locked.version}.tgz`),
  );
  assert.equal(`sha512-${createHash("sha512").update(archive).digest("base64")}`, locked.integrity);
  const source = gunzipSync(archive);
  assert.ok(source.includes(Buffer.from("package/src/exif-reader.js\0")), "preferred source ships");
  assert.ok(source.includes(Buffer.from("package/LICENSE\0")), "the MPL license ships");
});

test("notices include the server framework and its separately locked runtime dependencies", () => {
  const lock = JSON.parse(read("package-lock.json"));
  const notices = renderNotices();
  for (const [name, path] of [
    ["nitro", "node_modules/nitro"],
    ["h3", "node_modules/h3"],
    ["rou3", "node_modules/h3/node_modules/rou3"],
    ["srvx", "node_modules/srvx"],
  ]) {
    assert.ok(
      notices.includes(`${name} ${lock.packages[path].version}\nLicense:`),
      `${name} server notice`,
    );
  }
});

test("every model the code downloads is in model-notices.ts with its pinned revision", () => {
  const listed = new Set(MODEL_NOTICES.map((m) => m.id));
  const listedRevisions = new Set(MODEL_NOTICES.map((m) => m.revision));
  for (const file of MODEL_SOURCES) {
    const text = read(file);
    for (const id of quotedIds(text))
      assert.ok(listed.has(id), `${file} uses ${id}, missing from model-notices.ts`);
    for (const rev of revisions(text))
      assert.ok(listedRevisions.has(rev), `${file} pins ${rev}, missing from model-notices.ts`);
  }
});

test("model-notices.ts lists only models and revisions the code actually uses", () => {
  const text = MODEL_SOURCES.map(read).join("\n");
  const used = new Set(quotedIds(text));
  for (const model of MODEL_NOTICES) {
    assert.ok(used.has(model.id), `${model.id} is listed but nothing downloads it`);
    assert.ok(
      text.includes(model.revision),
      `${model.id}@${model.revision} is not the pinned revision`,
    );
  }
});

test("every vendored package is listed with its licence text", () => {
  const notices = renderNotices();
  const vendored = vendoredPackages();
  assert.ok(vendored.includes("vendor/heic-to"), "the rebuilt HEIC decoder is vendored");
  for (const path of vendored) {
    const manifest = JSON.parse(read(`${path}/package.json`));
    assert.ok(
      notices.includes(`${manifest.name} ${manifest.version}\nLicense: ${manifest.license}`),
      `${path} is missing from the notices`,
    );
  }
  assert.ok(notices.includes(read("vendor/heic-to/LICENSE").trimEnd()), "heic-to's LGPL notice");
});
