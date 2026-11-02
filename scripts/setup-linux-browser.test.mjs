import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { softwareChromeScript } from "./setup-linux-browser.mjs";

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
