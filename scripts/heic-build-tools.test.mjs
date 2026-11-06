import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = new URL("../public/third-party/source/", import.meta.url);
const read = (file) => readFileSync(new URL(file, source), "utf8");

test("HEIC build dependencies pin esbuild and every native package by integrity", () => {
  const manifest = JSON.parse(read("heic-build-tools/package.json"));
  const lock = JSON.parse(read("heic-build-tools/package-lock.json"));
  assert.deepEqual(manifest.dependencies, { esbuild: "0.25.12" });
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  const esbuild = lock.packages["node_modules/esbuild"];
  assert.equal(esbuild.version, manifest.dependencies.esbuild);
  assert.ok(Object.keys(esbuild.optionalDependencies).length > 0);
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === "") continue;
    assert.match(path, /^node_modules\/(esbuild|@esbuild\/[a-z0-9-]+)$/);
    assert.equal(entry.version, esbuild.version, path);
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//, path);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, path);
  }
  for (const [name, version] of Object.entries(esbuild.optionalDependencies)) {
    assert.equal(lock.packages[`node_modules/${name}`]?.version, version, name);
  }
});

test("HEIC rebuild documentation identifies the current build recipe and locked inputs", () => {
  const docs = read("BUILD.md");
  for (const file of [
    "build-heic-to.sh",
    "heic-build-tools/package.json",
    "heic-build-tools/package-lock.json",
  ]) {
    const hash = createHash("sha256").update(read(file)).digest("hex");
    const row = docs.split("\n").find((line) => line.includes(`\`${file}\``));
    assert.ok(row?.includes(hash), `${file}: update the documented SHA-256`);
  }
});
