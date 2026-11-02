// The committed .wasm files must be exactly what `npm run build:wasm` makes from the .wat
// sources (wabt 1.0.37), so the binaries can be reviewed as text. Skips when wat2wasm is not
// installed, unless CUTOUT_REQUIRE_TOOLS is set (CI), where a missing tool fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const wat2wasm = process.env.WAT2WASM || "wat2wasm";

test("key-simd.wasm rebuilds byte-for-byte from its .wat source", (t) => {
  const probe = spawnSync(wat2wasm, ["--version"], { encoding: "utf8" });
  if (probe.error) {
    const reason = `${wat2wasm} is not installed (wabt 1.0.37)`;
    if (process.env.CUTOUT_REQUIRE_TOOLS) assert.fail(`${reason}; CUTOUT_REQUIRE_TOOLS is set`);
    t.skip(reason);
    return;
  }
  t.diagnostic(`wat2wasm ${probe.stdout.trim()}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-wasm-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ["key-simd"]) {
    const out = path.join(dir, `${name}.wasm`);
    const built = spawnSync(wat2wasm, [path.join(root, `src/lib/${name}.wat`), "-o", out], {
      encoding: "utf8",
    });
    assert.equal(built.status, 0, built.stderr);
    assert.deepEqual(
      fs.readFileSync(out),
      fs.readFileSync(path.join(root, `src/lib/${name}.wasm`)),
      `src/lib/${name}.wasm differs from its .wat; run npm run build:wasm`,
    );
  }
});
