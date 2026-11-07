import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { ESLint } from "eslint";

const require = createRequire(import.meta.url);

// Keep the scoped minimatch overrides compatible with their actual consumers.
for (const consumer of ["eslint", "@eslint/config-array", "@typescript-eslint/typescript-estree"]) {
  const { Minimatch, minimatch } = createRequire(require.resolve(consumer))("minimatch");

  test(`${consumer} matches source globs and bounds pattern amplification`, () => {
    const matcher = new Minimatch("src/**/*.{ts,tsx}", { dot: true });
    assert.equal(matcher.pattern, "src/**/*.{ts,tsx}");
    assert.equal(matcher.match("src/lib/engine.ts"), true);
    assert.equal(matcher.match("src/routes/index.tsx"), true);
    assert.equal(matcher.match("src/lib", true), true);
    assert.equal(matcher.match("scripts/example.mjs"), false);
    assert.equal(minimatch(".config/example.ts", "**/*.ts", { dot: true }), true);

    // GHSA-g3hv-75wg-m249: only 16 expansions on a vulnerable version, so
    // this regression stays bounded even if an override is accidentally removed.
    assert.throws(
      () =>
        new Minimatch(Array(4).fill("**/../a/b").join("/"), {
          optimizationLevel: 2,
          braceExpandMax: 8,
        }),
      { name: "RangeError", message: /too many patterns/ },
    );
  });
}

test("patched globs preserve ESLint's source selection and generated-file exclusions", async () => {
  const eslint = new ESLint();
  for (const file of [
    "src/lib/engine.ts",
    "src/routes/index.tsx",
    "scripts/fake-transformers.mjs",
  ]) {
    assert.equal(await eslint.isPathIgnored(file), false, file);
  }
  for (const file of [
    "src/routeTree.gen.ts",
    "vendor/heic-to/package.json",
    "node_modules/minimatch/index.js",
    ".codex/example.ts",
  ]) {
    assert.equal(await eslint.isPathIgnored(file), true, file);
  }
  const [result] = await eslint.lintText("export const value: number = 1;\n", {
    filePath: "src/lib/dependency-security-check.ts",
  });
  assert.equal(result.errorCount, 0);
  assert.equal(result.warningCount, 0);
});
