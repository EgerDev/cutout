// G1, static half: no module or stylesheet under src/ or server/ imports the retired `@bg0/*` package, in any import form.
// It is a source scan, not a behavioural test. The behavioural half is the zero-`bg0`-request assertion
// at the end of scripts/browser-owned-removal.mjs; G1 passes only when both pass, reported together.
//
// The scan parses each file with the TypeScript compiler API (already installed), so comments,
// strings, regex literals and JSX text can never be mistaken for a module specifier.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const RETIRED = /^@bg0\//;

/** Every module specifier that names the retired package, in any import/export/require form. */
export function bg0Specifiers(source: string, fileName = "fixture.tsx"): string[] {
  const found: string[] = [];
  if (fileName.endsWith(".css")) {
    // Tokenize comments and strings together so example text cannot become an import.
    const tokens =
      source.match(
        /\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|@import\b|url\(|[^\s"'(){};]+|[(){};]/gi,
      ) ?? [];
    let importing = false;
    for (const token of tokens) {
      if (token.startsWith("/*")) continue;
      if (token.toLowerCase() === "@import") {
        importing = true;
        continue;
      }
      if (!importing || token.toLowerCase() === "url(") continue;
      const specifier = /^["']/.test(token) ? token.slice(1, -1) : token;
      if (RETIRED.test(specifier)) found.push(specifier);
      importing = false;
    }
    return found;
  }
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const check = (node: ts.Node | undefined) => {
    if (
      node &&
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      RETIRED.test(node.text)
    )
      found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    // import x from "…", import "…", import type …, import { type X } from "…"
    if (ts.isImportDeclaration(node)) check(node.moduleSpecifier);
    // export * from "…", export * as x from "…", export {…} from "…", export type {…} from "…"
    else if (ts.isExportDeclaration(node)) check(node.moduleSpecifier);
    // import x = require("…")
    else if (ts.isExternalModuleReference(node)) check(node.expression);
    // typeof import("…"), import("…").Type
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument))
      check(node.argument.literal);
    // await import("…"), require("…"); whitespace, newlines and backtick quotes are irrelevant to the AST
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    )
      check(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

// ---- self-check: the scanner is trusted only if every form is flagged and every near-miss is not

const FLAGGED: Record<string, string> = {
  "default import": `import x from "@bg0/browser";`,
  "named import": `import { prepareEngine } from "@bg0/browser";`,
  "namespace import": `import * as bg0 from "@bg0/browser";`,
  "side-effect import": `import "@bg0/browser";`,
  "type import": `import type { X } from '@bg0/browser';`,
  "inline type import": `import { type X } from "@bg0/browser";`,
  "export star": `export * from "@bg0/browser";`,
  "export star as": `export * as bg0 from "@bg0/browser";`,
  "re-export": `export { x } from "@bg0/browser";`,
  "type re-export": `export type { X } from "@bg0/browser";`,
  "dynamic import": `const m = await import("@bg0/browser");`,
  "dynamic import over lines": `const m = await import(\n  "@bg0/browser"\n);`,
  "dynamic import, backtick quotes": "const m = await import(`@bg0/browser`);",
  "dynamic import, single quotes": `const m = import('@bg0/browser');`,
  "type-position import": `let x: typeof import("@bg0/browser");`,
  "multi-line named clause": `import {\n  a,\n  b,\n} from\n  "@bg0/browser";`,
  "require call": `const m = require("@bg0/browser");`,
  "import equals": `import m = require("@bg0/browser");`,
  subpath: `import x from "@bg0/browser/deep";`,
};

const NOT_FLAGGED: Record<string, string> = {
  "plain string mention": `const note = "see @bg0/browser licence";`,
  "line comment": `// import x from "@bg0/browser";\nconst a = 1;`,
  "block comment": `/* import("@bg0/browser") */ const a = 1;`,
  "jsx text": `export const x = <code>@bg0/browser 0.1.1 library</code>;`,
  "different scope": `import x from "@bg0x/other";`,
  "scope prefix lookalike": `import x from "bg0/browser";`,
  "relative path": `import x from "./not-@bg0/browser";`,
  "string comparison (engine.test.ts hook)": `if (specifier === "@bg0/browser") return 1;`,
  "regex literal (engine.test.ts G1 guard)": "assert.doesNotMatch(source, /[\"'`]@bg0\\//);",
  "template mention": "const t = `used by @bg0/browser`;",
};

test("scanner self-check: every import form is flagged", () => {
  for (const [name, source] of Object.entries(FLAGGED))
    assert.ok(bg0Specifiers(source).length > 0, `${name} must be flagged: ${source}`);
});

test("scanner self-check: mentions, comments and lookalikes are not flagged", () => {
  for (const [name, source] of Object.entries(NOT_FLAGGED))
    assert.deepEqual(bg0Specifiers(source), [], `${name} must not be flagged: ${source}`);
});

// ---- the tree scan (only meaningful once the self-check above holds)

const roots = [new URL("../", import.meta.url), new URL("../../server/", import.meta.url)];
const files = roots
  .flatMap((url) => {
    const root = fileURLToPath(url);
    return readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.(?:[cm]?[jt]sx?|css)$/.test(path) && !path.includes("node_modules"))
      .map((path) => `${root}${path}`);
  })
  .sort();

test("src/ and server/ have source and stylesheets to scan", () => {
  assert.ok(files.length > 50, `expected the whole source tree, found ${files.length} files`);
  // Separators are platform-dependent: Windows paths use \.
  assert.ok(files.some((path) => /[\\/]server[\\/]/.test(path) && path.endsWith(".ts")));
  assert.ok(files.some((path) => path.endsWith(".css")));
});

test("no module or stylesheet under src/ or server/ imports @bg0/*", () => {
  const offenders = files.flatMap((path) =>
    bg0Specifiers(readFileSync(path, "utf8"), path).map((specifier) => `${path}: ${specifier}`),
  );
  assert.deepEqual(offenders, [], "the owned removal engine must not import the retired package");
});

test("C28: stylesheet package imports are scanned without treating comments as imports", () => {
  for (const source of [
    '@import "@bg0/browser/style.css";',
    '@import url("@bg0/browser/style.css");',
    "@import url(@bg0/browser/style.css);",
  ])
    assert.deepEqual(bg0Specifiers(source, "style.css"), ["@bg0/browser/style.css"]);
  assert.deepEqual(
    bg0Specifiers(
      '/* @import "@bg0/browser/style.css"; */ .x::after { content: "@bg0/browser"; }',
      "style.css",
    ),
    [],
  );
});
