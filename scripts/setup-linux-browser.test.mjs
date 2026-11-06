import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installSoftwareChrome, softwareChromeScript } from "./setup-linux-browser.mjs";

test("software browser wrapper enables GPU cases and preserves forced WASM controls", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cutout-chrome-wrapper-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "browser's binary");
  const wrapper = join(dir, "wrapper");
  writeFileSync(binary, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  writeFileSync(wrapper, softwareChromeScript(binary), { mode: 0o755 });
  // The wrapper is a POSIX shell script by design; on Windows run it through the
  // sh that ships with Git rather than exec'ing it directly.
  const sh = (file, args, options) =>
    process.platform === "win32"
      ? execFileSync("sh", [file, ...args], options)
      : execFileSync(file, args, options);
  const run = (...args) => sh(wrapper, args, { encoding: "utf8" }).trim().split("\n");
  assert.ok(run("--headless").includes("--enable-unsafe-webgpu"));
  assert.deepEqual(run("--headless", "--disable-gpu"), ["--headless", "--disable-gpu"]);
  assert.equal(
    sh(wrapper, ["--headless"], {
      encoding: "utf8",
      env: { ...process.env, CUTOUT_SOFTWARE_WEBGPU: "0" },
    }).trim(),
    "--headless",
  );
});

test("wrapper installation updates its own file and refuses an unrelated installation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cutout-chrome-install-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const wrapper = join(dir, "chrome");
  installSoftwareChrome(wrapper, "/long/path/to/browser");
  installSoftwareChrome(wrapper, "/browser");
  assert.equal(readFileSync(wrapper, "utf8"), softwareChromeScript("/browser"));
  // A crash after exclusive creation can leave an empty wrapper; recover it.
  writeFileSync(wrapper, "");
  installSoftwareChrome(wrapper, "/browser");
  assert.equal(readFileSync(wrapper, "utf8"), softwareChromeScript("/browser"));
  for (const contents of ["real browser", "x".repeat(4097)]) {
    writeFileSync(wrapper, contents);
    assert.throws(() => installSoftwareChrome(wrapper, "/browser"), /existing Chrome/);
    assert.equal(readFileSync(wrapper, "utf8"), contents);
  }
});

test(
  "wrapper installation refuses links without modifying their targets",
  { skip: process.platform === "win32" },
  (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cutout-chrome-links-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const target = join(dir, "target");
    const wrapper = join(dir, "chrome");
    const original = softwareChromeScript("/original-browser");
    writeFileSync(target, original);
    for (const link of [symlinkSync, linkSync]) {
      link(target, wrapper);
      assert.throws(() => installSoftwareChrome(wrapper, "/replacement"));
      assert.equal(readFileSync(target, "utf8"), original);
      rmSync(wrapper);
    }
  },
);
