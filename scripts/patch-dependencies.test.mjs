// Runs scripts/patch-dependencies.mjs against untouched copies of the packages it edits, taken from
// the npm cache (npm ci already put them there), so a patch that stops matching upstream
// fails here and at install instead of silently shipping unpatched code.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts/patch-dependencies.mjs");
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8")).packages;
const ortKey = Object.keys(lock).find((key) => key.endsWith("node_modules/onnxruntime-web"));
// The minified bundle is what the app loads (the package's default "import" export); the
// unminified build uses different variable names, so both shapes are covered.
const ortFiles = ["ort.bundle.min.mjs", "ort.webgpu.mjs"];

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

/** A temp project root holding pristine transformers.js and onnxruntime-web files. */
function pristineRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-dependencies-"));
  const unpack = (name, version, destination, members) => {
    const tarball = execFileSync(
      "npm",
      ["pack", "--prefer-offline", "--silent", "--pack-destination", dir, `${name}@${version}`],
      { cwd: dir, encoding: "utf8", shell: process.platform === "win32" },
    )
      .trim()
      .split(/\r?\n/)
      .pop();
    fs.mkdirSync(path.join(dir, destination), { recursive: true });
    // Relative paths: GNU tar reads "C:\..." as a remote host.
    execFileSync("tar", ["-xzf", tarball, "-C", destination, "--strip-components=1", ...members], {
      cwd: dir,
    });
  };
  unpack(
    "@huggingface/transformers",
    lock["node_modules/@huggingface/transformers"].version,
    "node_modules/@huggingface/transformers",
    ["package/dist/transformers.web.js"],
  );
  unpack(
    "onnxruntime-web",
    lock[ortKey].version,
    ortKey,
    ortFiles.map((file) => `package/dist/${file}`),
  );
  return dir;
}

function snapshot(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!full.endsWith(".tgz")) files[path.relative(dir, full)] = fs.readFileSync(full);
    }
  };
  walk(path.join(dir, "node_modules"));
  return files;
}

// Each target in the shapes the script matches (the GatherND regexes allow optional spaces).
const chain = "        ? (webInferenceChain = webInferenceChain.then(run))\n        result = buffer;\n    }";
const inputDims = (v) =>
  `\${${v}.length === 1 ? "index += i32(uniforms.input_dims);" : "index += i32(uniforms.input_dims[input_dim_idx]);"}`;
const sliceDims = (v) =>
  `\${${v}.length===1?"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data);":"relative_slice_offset += index * i32(uniforms.sizes_from_slice_dims_data[dim_idx]);"}`;
const webFile = "node_modules/@huggingface/transformers/dist/transformers.web.js";
const ortFile = "node_modules/onnxruntime-web/dist/ort.webgpu.mjs";

/** A temp project root holding a hand-written transformers.web.js and ort build. */
function syntheticRoot(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "patch-dependencies-synthetic-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

const copies = (text, target) => text.split(target).length - 1;

for (const fault of ["write-error", "kill", "rename-error"]) {
  test(`a ${fault} during patch publication leaves the original bundle complete`, (t) => {
    const original = `${chain}\n${"// untouched tail\n".repeat(10000)}`;
    const dir = syntheticRoot(t, {
      [webFile]: original,
      [ortFile]: `computeSliceOffsets\n${inputDims("u")}\n${sliceDims("u")}`,
    });
    const target = path.join(dir, webFile);
    fs.chmodSync(target, 0o751);
    // Inject a real partial filesystem write in a separate process, without touching
    // the installed dependencies. This catches in-place truncation, not just API use.
    const preload = path.join(dir, "fault.mjs");
    fs.writeFileSync(preload, `
      import fs from "node:fs";
      const target = ${JSON.stringify(target)};
      const fault = ${JSON.stringify(fault)};
      const paths = new Map();
      const open = fs.openSync;
      fs.openSync = function (file, ...args) {
        const fd = open.call(this, file, ...args);
        paths.set(fd, String(file));
        return fd;
      };
      const write = fs.writeFileSync;
      fs.writeFileSync = function (file, data, ...args) {
        const name = typeof file === "number" ? paths.get(file) : String(file);
        if (name?.startsWith(target) && fault !== "rename-error") {
          write.call(this, file, data.slice(0, 150), ...args);
          if (fault === "kill") process.kill(process.pid, "SIGKILL");
          throw Object.assign(new Error("synthetic disk write failure"), { code: "EIO" });
        }
        return write.call(this, file, data, ...args);
      };
      const rename = fs.renameSync;
      fs.renameSync = function (from, to) {
        if (to === target && fault === "rename-error")
          throw Object.assign(new Error("synthetic rename failure"), { code: "EIO" });
        return rename.call(this, from, to);
      };
    `);
    // --import takes a URL on Windows (a bare C:\ path parses as scheme "c:").
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, script, dir], {
      encoding: "utf8",
    });
    // Windows terminates the process without a signal: exit code 1, signal null.
    if (fault === "kill" && process.platform !== "win32")
      assert.equal(result.signal, "SIGKILL", result.stderr);
    else if (fault === "kill")
      assert.equal(result.status, 1, result.stderr);
    else assert.notEqual(result.status, 0, "a failed publication must fail the install");
    assert.equal(fs.readFileSync(target, "utf8"), original, "no truncated or partial target");
    // POSIX mode bits survive the failed publication. Windows has no rwx bits to
    // preserve: chmod maps onto the read-only flag, so a writable file is 0o666.
    assert.equal(
      fs.statSync(target).mode & 0o777,
      process.platform === "win32" ? 0o666 : 0o751,
    );
    if (fault !== "kill")
      assert.deepEqual(fs.readdirSync(path.dirname(target)), [path.basename(target)]);
    // A fresh process can recover; a killed process may leave an unused temporary file.
    assert.equal(run([dir]).status, 0);
    assert.equal(run(["--check", dir]).status, 0);
    assert.ok(fs.readFileSync(target, "utf8").endsWith("// untouched tail\n"));
    assert.equal(
      fs.statSync(target).mode & 0o777,
      process.platform === "win32" ? 0o666 : 0o751,
      "preserve executable file mode",
    );
  });
}

test("an unmatched anchor prevents publishing any planned patches", (t) => {
  const dir = syntheticRoot(t, {
    [webFile]: chain,
    [ortFile]: `computeSliceOffsets\n${inputDims("u")}\nupstream changed the other anchor`,
  });
  const before = snapshot(dir);
  assert.equal(run([dir]).status, 1);
  assert.deepEqual(snapshot(dir), before, "validation failure must leave every original intact");
});

test("--check is read-only for both unpatched and patched bundles", (t) => {
  const dir = syntheticRoot(t, {
    [webFile]: chain,
    [ortFile]: `computeSliceOffsets\n${inputDims("u")}\n${sliceDims("u")}`,
    "node_modules/.vite/cache": "keep during checks",
  });
  const before = snapshot(dir);
  assert.equal(run(["--check", dir]).status, 1);
  assert.deepEqual(snapshot(dir), before);
  assert.equal(run([dir]).status, 0);
  fs.mkdirSync(path.join(dir, "node_modules/.vite"));
  fs.writeFileSync(path.join(dir, "node_modules/.vite/cache"), "keep during checks");
  const patched = snapshot(dir);
  assert.equal(run(["--check", dir]).status, 0);
  assert.deepEqual(snapshot(dir), patched);
});

test("a bundle carrying a target twice gets both copies patched", (t) => {
  const dir = syntheticRoot(t, {
    [webFile]: `function a() {\n${chain}\n}\nfunction b() {\n${chain}\n}\n`,
    [ortFile]: [
      "function computeSliceOffsets() {}",
      `var a = \`${inputDims("u")}\`;`,
      `var b = \`${inputDims("w")}\`;`,
      `var c = \`${sliceDims("u")}\`;`,
      `var d = \`${sliceDims("w")}\`;`,
    ].join("\n"),
  });

  const result = run([dir]);
  assert.equal(result.status, 0, result.stderr);
  const web = fs.readFileSync(path.join(dir, webFile), "utf8");
  const ort = fs.readFileSync(path.join(dir, ortFile), "utf8");
  assert.equal(copies(web, chain), 0, "no unpatched inference chain may remain");
  assert.equal(copies(web, "webInferenceChain.catch(() => {}).then(run)"), 2);
  for (const v of ["u", "w"]) {
    assert.equal(copies(ort, inputDims(v)), 0, `input_dims template for ${v} left unpatched`);
    assert.equal(copies(ort, sliceDims(v)), 0, `slice template for ${v} left unpatched`);
  }
  assert.equal(copies(ort, "input_dims[input_dim_idx / 4u][input_dim_idx % 4u]"), 2);
  assert.equal(copies(ort, "sizes_from_slice_dims_data[dim_idx / 4u][dim_idx % 4u]"), 2);
  assert.equal(run(["--check", dir]).status, 0);
});

test("--check fails a file that still carries an unpatched copy next to the marker", (t) => {
  const patchedChain =
    "        ? (webInferenceChain = webInferenceChain.catch(() => {}).then(run))";
  // Half-patched: one copy done, one left (what a first-occurrence replace produces).
  const dir = syntheticRoot(t, {
    [webFile]: `function a() {\n${patchedChain}\n}\nfunction b() {\n${chain}\n}\n`,
    // The marker text is present but no target was ever patched.
    [ortFile]: [
      "function computeSliceOffsets() {}",
      'var m = "input_dims[input_dim_idx / 4u][input_dim_idx % 4u]";',
      'var n = "sizes_from_slice_dims_data[dim_idx / 4u][dim_idx % 4u]";',
      `var a = \`${inputDims("u")}\`;`,
      `var c = \`${sliceDims("u")}\`;`,
    ].join("\n"),
  });

  const check = run(["--check", dir]);
  assert.equal(check.status, 1, "a remaining target must fail the check, marker or not");
  assert.match(
    check.stderr,
    /transformers\.web\.js: "inference chain survives a failed run" is not applied \(1 unpatched/,
  );
  assert.match(check.stderr, /ort\.webgpu\.mjs: "GatherND input_dims" is not applied/);
  assert.match(
    check.stderr,
    /ort\.webgpu\.mjs: "GatherND sizes_from_slice_dims_data" is not applied/,
  );

  // A real run finishes the job, after which the check passes.
  const result = run([dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(copies(fs.readFileSync(path.join(dir, webFile), "utf8"), chain), 0);
  assert.equal(copies(fs.readFileSync(path.join(dir, ortFile), "utf8"), inputDims("u")), 0);
  assert.equal(run(["--check", dir]).status, 0);
});

test("the installed dependencies carry every patch", () => {
  const result = run(["--check"]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});

test("a fresh copy gets every patch, and a second run changes nothing", (t) => {
  const dir = pristineRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(run(["--check", dir]).status, 1, "pristine files must fail the check");
  const first = run([dir]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(run(["--check", dir]).status, 0, "every marker present after patching");

  const web = fs.readFileSync(
    path.join(dir, "node_modules/@huggingface/transformers/dist/transformers.web.js"),
    "utf8",
  );
  assert.ok(web.includes("env.customCache?.verify?.(path_or_repo_id, filename, revision, buffer)"));
  assert.match(web, /webInferenceChain\.catch\(\(\) => \{\}\)\.then\(run\)/);
  for (const file of ortFiles) {
    const code = fs.readFileSync(path.join(dir, ortKey, "dist", file), "utf8");
    assert.ok(code.includes("input_dims[input_dim_idx / 4u][input_dim_idx % 4u]"), file);
    assert.ok(code.includes("sizes_from_slice_dims_data[dim_idx / 4u][dim_idx % 4u]"), file);
  }

  const before = snapshot(dir);
  const second = run([dir]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(snapshot(dir), before, "the second run must not change any byte");
});

test("a target that no longer matches upstream fails the install", (t) => {
  const dir = pristineRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const web = path.join(dir, "node_modules/@huggingface/transformers/dist/transformers.web.js");
  const code = fs.readFileSync(web, "utf8");
  const target = "webInferenceChain = webInferenceChain.then(run)";
  assert.ok(code.includes(target));
  fs.writeFileSync(web, code.replace(target, "webInferenceChain = webInferenceChain.then(go)"));

  const result = run([dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /transformers\.web\.js/);
});

test("a changed onnxruntime shader fails the install", (t) => {
  const dir = pristineRoot();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundle = path.join(dir, ortKey, "dist", ortFiles[0]);
  const code = fs.readFileSync(bundle, "utf8");
  fs.writeFileSync(bundle, code.replace("sizes_from_slice_dims_data[dim_idx]", "sizes[dim_idx]"));

  const result = run([dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ort\.bundle\.min\.mjs/);
});


test("the hub hook rejects before either cache publication or returning the buffer", async () => {
  const code = fs.readFileSync(path.join(root, webFile), "utf8");
  const start = code.indexOf("        await _env_js__WEBPACK_IMPORTED_MODULE_2__.env.customCache?.verify?.");
  assert.ok(start >= 0);
  const end = code.indexOf("\n    }", start);
  const fragment = code.slice(start, end);
  const runBuffer = new Function("_env_js__WEBPACK_IMPORTED_MODULE_2__", "buffer", `
    return (async () => {
      const path_or_repo_id = "model", filename = "config.json", revision = "pin";
      let result;
      ${fragment}
      await _env_js__WEBPACK_IMPORTED_MODULE_2__.env.customCache.put();
      return result;
    })();
  `);
  const bytes = new Uint8Array([1, 2, 3]);
  let puts = 0;
  const reason = new Error("bad bytes");
  const env = { customCache: { verify() { throw reason; }, put() { puts++; } } };
  await assert.rejects(runBuffer({ env }, bytes), (error) => error === reason);
  assert.equal(puts, 0);
  env.customCache.verify = () => {};
  assert.equal(await runBuffer({ env }, bytes), bytes, "pass the original buffer without copying");
  assert.equal(puts, 1);
});
