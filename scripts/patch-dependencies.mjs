// Install-time edits to transformers.js and onnxruntime-web (see NOTICE). Each patch names a
// target and a marker that exists only once it is applied. Every copy of the target is
// replaced (a bundle can carry it more than once, and a marker proves only one copy was
// done); a copy left after patching, or neither target nor marker, means the upstream file
// changed, so the install fails instead of shipping it silently unpatched. --check fails
// while any copy of a target remains, marker or not.
// Usage: node scripts/patch-dependencies.mjs [--check] [projectRoot]
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
const root = path.resolve(
  args.find((arg) => arg !== "--check") ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), ".."),
);

/** @type {{ file: string, name: string, find: string | RegExp, replace: string | ((...m: string[]) => string), marker: string }[]} */
const patches = [
  // hub.js swallows match/put errors and may run without Cache Storage. Verify the buffer
  // outside those catches, before either caching or returning bytes to JSON/ORT. No clone.
  {
    file: "node_modules/@huggingface/transformers/dist/transformers.web.js",
    name: "verify model bytes before cache or use",
    find: "        result = buffer;\n    }",
    replace: "        await _env_js__WEBPACK_IMPORTED_MODULE_2__.env.customCache?.verify?.(path_or_repo_id, filename, revision, buffer);\n        result = buffer; // cutout: verified model bytes\n    }",
    marker: "result = buffer; // cutout: verified model bytes",
  },
  // transformers.js queues browser inference on one promise chain; one rejected run left
  // the chain rejected, so every later run in that thread (removal, crops, depth)
  // failed with the old error until a reload.
  {
    file: "node_modules/@huggingface/transformers/dist/transformers.web.js",
    name: "inference chain survives a failed run",
    find: "        ? (webInferenceChain = webInferenceChain.then(run))",
    replace: "        ? (webInferenceChain = webInferenceChain.catch(() => {}).then(run))",
    marker: "webInferenceChain.catch(() => {}).then(run)",
  },
];

// ONNX Runtime Web's WebGPU GatherND shader indexes uniform arrays longer than 4 as if they
// were flat; they are packed as vec4s. Every build of the file carries the shader (the
// bundle is what the app loads); minifiers rename the array variable, hence the regexes.
const gatherPatches = [
  {
    name: "GatherND input_dims",
    find: /\$\{(\w+)\.length\s*===\s*1\s*\?\s*"index \+= i32\(uniforms\.input_dims\);"\s*:\s*"index \+= i32\(uniforms\.input_dims\[input_dim_idx\]\);"\s*\}/g,
    replace: (_, v) =>
      `\${${v}.length===1?"index += i32(uniforms.input_dims);":${v}.length>4?"index += i32(uniforms.input_dims[input_dim_idx / 4u][input_dim_idx % 4u]);":"index += i32(uniforms.input_dims[input_dim_idx]);"}`,
    marker: "input_dims[input_dim_idx / 4u][input_dim_idx % 4u]",
  },
  {
    name: "GatherND sizes_from_slice_dims_data",
    find: /\$\{(\w+)\.length\s*===\s*1\s*\?\s*"relative_slice_offset \+= index \* i32\(uniforms\.sizes_from_slice_dims_data\);"\s*:\s*"relative_slice_offset \+= index \* i32\(uniforms\.sizes_from_slice_dims_data\[dim_idx\]\);"\s*\}/g,
    replace: (_, v) =>
      `\${${v}.length===1?"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data);":${v}.length>4?"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data[dim_idx / 4u][dim_idx % 4u]);":"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data[dim_idx]);"}`,
    marker: "sizes_from_slice_dims_data[dim_idx / 4u][dim_idx % 4u]",
  },
];
const ortShaderFiles = [
  "node_modules/onnxruntime-web/dist",
  "node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist",
].flatMap((dir) => {
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return [];
  return fs
    .readdirSync(full)
    .filter((name) => /^ort.*\.m?js$/.test(name))
    .map((name) => `${dir}/${name}`)
    .filter((file) =>
      fs.readFileSync(path.join(root, file), "utf8").includes("computeSliceOffsets"),
    );
});
for (const file of ortShaderFiles) {
  for (const patch of gatherPatches) patches.push({ file, ...patch });
}

/** How many copies of a target the code holds (the regexes are global). */
function copies(code, find) {
  return typeof find === "string" ? code.split(find).length - 1 : (code.match(find) ?? []).length;
}

let failed = false;
function fail(message) {
  console.error(`[patch-dependencies] ${message}`);
  failed = true;
}
if (ortShaderFiles.length === 0) fail("no onnxruntime-web build with the GatherND shader found");

const byFile = Map.groupBy(patches, (patch) => patch.file);
const pending = [];
for (const [file, filePatches] of byFile) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) {
    fail(`${file} is missing`);
    continue;
  }
  const original = fs.readFileSync(full, "utf8");
  let code = original;
  for (const patch of filePatches) {
    const targets = copies(code, patch.find);
    if (targets === 0) {
      if (!code.includes(patch.marker))
        fail(`${file}: "${patch.name}" target not found; upstream changed`);
      continue;
    }
    if (checkOnly) {
      fail(`${file}: "${patch.name}" is not applied (${targets} unpatched)`);
      continue;
    }
    code = code.replaceAll(
      patch.find,
      typeof patch.replace === "string" ? () => patch.replace : patch.replace,
    );
    const left = copies(code, patch.find);
    if (left > 0) fail(`${file}: "${patch.name}" left ${left} of ${targets} unpatched`);
    if (!code.includes(patch.marker)) fail(`${file}: "${patch.name}" did not produce its marker`);
  }
  if (!checkOnly && code !== original) {
    pending.push({ file, full, code });
  }
}

/** Publish a whole bundle at once; a failed write must never truncate the live file. */
function atomicWrite(full, code) {
  const temporary = `${full}.${randomUUID()}.patching`;
  let fd;
  try {
    fd = fs.openSync(temporary, "wx");
    // chmod after creation preserves the real file's mode regardless of the umask.
    fs.fchmodSync(fd, fs.statSync(full).mode);
    fs.writeFileSync(fd, code);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, full);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

// Validate every anchor before publishing any changes, including files already patched.
if (!failed) {
  for (const { file, full, code } of pending) {
    atomicWrite(full, code);
    console.log(`[patch-dependencies] Patched ${file}`);
  }
}

if (failed) {
  process.exitCode = 1;
} else if (!checkOnly) {
  // Vite pre-bundles dependencies; drop that cache so it picks up the patched files.
  const viteCache = path.join(root, "node_modules/.vite");
  if (fs.existsSync(viteCache)) fs.rmSync(viteCache, { recursive: true, force: true });
}
