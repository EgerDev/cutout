/**
 * Writes public/third-party/THIRD_PARTY_NOTICES.txt from what Cutout depends on:
 * every package in the production dependency tree and Nitro's server/build closure
 * (Nitro is a devDependency but generates shipped server code), plus every
 * vendored package under vendor/ (with its declared licence and its own
 * LICENSE/NOTICE files), ONNX Runtime's notices
 * for the code compiled into onnxruntime-web's WebAssembly, and the runtime
 * models from src/lib/model-notices.ts. Output depends only on the lockfile and
 * the installed packages, so scripts/third-party-notices.test.mjs can compare it
 * byte for byte with the committed file.
 *
 * Usage: node scripts/third-party-notices.mjs
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MODEL_NOTICES, modelUrl } from "../src/lib/model-notices.ts";

export const NOTICES_FILE = "public/third-party/THIRD_PARTY_NOTICES.txt";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ORT_LICENSE = "scripts/data/onnxruntime-LICENSE.txt";
const ORT_NOTICES = "scripts/data/onnxruntime-ThirdPartyNotices.txt";
// onnxruntime-web 1.22.0-dev.20250409-89f8206ba4 was built from this commit.
const ORT_COMMIT =
  "https://github.com/microsoft/onnxruntime/blob/89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0";
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;
const RULE = "=".repeat(78);
const lf = (text) => text.replace(/\r\n?/g, "\n").trimEnd();

/**
 * Lockfile paths of the production and server-framework closures. Follows dependencies the way Node
 * resolves them (nearest node_modules first) and does not descend into packages
 * limited to one OS/CPU: those are native build tools (esbuild, lightningcss,
 * rollup, sharp) that are neither bundled for browsers nor the same on every
 * machine.
 */
function productionPackages(lock) {
  const packages = lock.packages;
  const seen = new Set();
  const resolve = (from, name) => {
    for (let dir = from; ;) {
      const candidate = `${dir ? `${dir}/` : ""}node_modules/${name}`;
      if (packages[candidate]) return candidate;
      if (!dir) return null;
      const cut = dir.lastIndexOf("/node_modules/");
      dir = cut === -1 ? "" : dir.slice(0, cut);
    }
  };
  const visit = (path) => {
    const entry = packages[path];
    for (const name of Object.keys({
      ...entry.dependencies,
      ...entry.optionalDependencies,
      ...entry.peerDependencies,
    })) {
      const dep = resolve(path, name);
      if (!dep || seen.has(dep) || packages[dep].os || packages[dep].cpu) continue;
      seen.add(dep);
      visit(dep);
    }
  };
  visit(""); // the root's devDependencies are not followed
  const server = resolve("", "nitro");
  if (!server) throw new Error("The shipped Nitro server framework is missing from the lockfile");
  seen.add(server);
  visit(server);
  return [...seen];
}

function packageSection(path, entry) {
  const dir = join(ROOT, path);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const name = path.includes("node_modules/")
    ? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)
    : manifest.name;
  const licence = manifest.license ?? entry.license ?? "not declared";
  const repo =
    typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const files = readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort();
  const lines = [RULE, `${name} ${manifest.version}`, `License: ${licence}`];
  if (repo) lines.push(`Source: ${repo.replace(/^git\+/, "")}`);
  lines.push("");
  if (files.length === 0)
    lines.push(`(The package ships no licence file; it declares ${licence}.)`, "");
  for (const file of files)
    lines.push(`--- ${file} ---`, lf(readFileSync(join(dir, file), "utf8")), "");
  return { key: `${name}\0${manifest.version}`, text: lines.join("\n") };
}

/** Packages committed under vendor/ (the rebuilt heic-to): they ship but are not in the lockfile. */
export function vendoredPackages() {
  return readdirSync(join(ROOT, "vendor"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `vendor/${entry.name}`)
    .filter((path) => readdirSync(join(ROOT, path)).includes("package.json"));
}

function modelSection() {
  const lines = [
    RULE,
    "RUNTIME MODELS",
    RULE,
    "",
    "Not bundled. The visitor's browser downloads these weights from Hugging Face",
    "(or the mirror set by VITE_MODEL_HOST) at the pinned revision when a feature",
    "first needs them, and caches them locally.",
    "",
  ];
  for (const model of MODEL_NOTICES) {
    lines.push(
      model.id,
      `  Revision: ${model.revision}`,
      `  Used for: ${model.use}`,
      `  Licence declared by the publisher: ${model.licence}`,
      `  Converted from: ${model.upstream}`,
      `  ${modelUrl(model.id)}`,
    );
    if (model.note) lines.push(`  Note: ${model.note}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderNotices() {
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const sections = [...productionPackages(lock), ...vendoredPackages()]
    .map((path) => packageSection(path, lock.packages[path]))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const header = [
    "Cutout — third-party notices",
    "",
    "Cutout's original application code is licensed under MIT (see LICENSE and NOTICE",
    "in the source repository). Third-party components retain their own licenses.",
    "Earlier Apache-2.0 grants remain valid; see /third-party/Apache-2.0.txt.",
    "",
    "Generated by scripts/third-party-notices.mjs from package-lock.json; do not",
    "edit by hand. The npm list includes the production tree and Nitro's server/build",
    "dependency closure (Nitro generates shipped code despite being a devDependency). It",
    "also names build tools (Vite, Rollup, Tailwind and similar) whose code is not",
    "sent to browsers. Platform-specific native binaries used only while building",
    "are omitted.",
    "",
    "The HEIC decoder is heic-to 1.5.2 rebuilt with libheif 1.23.5 and libde265 1.1.3",
    "(all LGPL-3.0-or-later), patched only to build with Emscripten 5. Its corresponding",
    "source, patches and build script are published next to this file under",
    "/third-party/source/ (see BUILD.md there).",
    "",
    "ExifReader 4.45.0 is used unmodified under MPL-2.0. Its exact npm package,",
    "including src/ and its MPL license, is available at",
    "/third-party/source/exifreader-4.45.0.tgz (package-lock.json integrity verified).",
    "",
    "Sections: npm packages; ONNX Runtime third-party notices; runtime models.",
    "",
  ].join("\n");
  const ortHeader = [
    RULE,
    "ONNX RUNTIME LICENSE AND THIRD-PARTY NOTICES",
    RULE,
    "",
    "The onnxruntime-web package ships its WebAssembly build without its licence or",
    "these notices. Both are copied from the commit it was built from:",
    `${ORT_COMMIT}/LICENSE`,
    `${ORT_COMMIT}/ThirdPartyNotices.txt`,
    "",
  ].join("\n");
  return [
    header,
    ...sections.map((s) => s.text),
    ortHeader,
    lf(readFileSync(join(ROOT, ORT_LICENSE), "utf8")),
    "",
    lf(readFileSync(join(ROOT, ORT_NOTICES), "utf8")),
    "",
    modelSection(),
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  writeFileSync(join(ROOT, NOTICES_FILE), renderNotices());
  console.log(`wrote ${NOTICES_FILE}`);
}
