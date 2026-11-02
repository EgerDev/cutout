// Review focus 5: CI must not be green by accident. With CUTOUT_REQUIRE_E2E set, an e2e
// suite that finds no server of this build fails instead of skipping.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const suites = fs
  .readdirSync(path.join(root, "scripts/e2e"))
  .filter((name) => name.endsWith(".test.mjs"))
  .map((name) => `scripts/e2e/${name}`);

let closedUrl, otherBuild;
before(async () => {
  const listen = async (handler) => {
    const server = http.createServer(handler).listen(0, "127.0.0.1");
    await once(server, "listening");
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
  };
  const closed = await listen(() => {});
  closedUrl = closed.url;
  closed.server.close();
  // Another build of Cutout: right manifest, different commit.
  otherBuild = await listen((req, res) => {
    const body = {
      "/manifest.webmanifest": { name: "Cutout" },
      "/version.json": { commit: "other" },
    }[new URL(req.url, "http://x").pathname];
    res.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? {}));
  });
});
after(() => otherBuild.server.close());

/** Runs one test file in a child process; resolves with its exit code and output. */
async function runSuite(file, env) {
  const clean = { ...process.env };
  for (const key of [
    "APP_URL",
    "DEV_URL",
    "CUTOUT_REQUIRE_E2E",
    "CUTOUT_EXPECT_COMMIT",
    "NODE_TEST_CONTEXT", // set by the parent runner; the child would refuse to run
  ]) {
    delete clean[key];
  }
  const child = spawn(process.execPath, ["--test", file], {
    cwd: root,
    env: { ...clean, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const [code] = await once(child, "exit");
  return { code, output };
}

test("there are e2e suites to guard", () => assert.ok(suites.length >= 3, suites.join()));

for (const file of suites) {
  test(`${file}: no server → skipped locally, failed when required`, async () => {
    const local = await runSuite(file, { APP_URL: closedUrl });
    assert.equal(local.code, 0, local.output);
    assert.match(local.output, /skipped 1/);

    const required = await runSuite(file, { APP_URL: closedUrl, CUTOUT_REQUIRE_E2E: "1" });
    assert.notEqual(required.code, 0, required.output);
    assert.match(required.output, /CUTOUT_REQUIRE_E2E/);
  });

  test(`${file}: another build on the port → failed when required`, async () => {
    const result = await runSuite(file, {
      APP_URL: otherBuild.url,
      CUTOUT_REQUIRE_E2E: "1",
      CUTOUT_EXPECT_COMMIT: "this-checkout",
    });
    assert.notEqual(result.code, 0, result.output);
    assert.match(result.output, /CUTOUT_REQUIRE_E2E/);
  });
}

test("a missing Playwright Firefox fails the Firefox suite when required", async (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-browsers-"));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
  const file = "scripts/browser-firefox-worker.mjs";
  const env = { PLAYWRIGHT_BROWSERS_PATH: empty, DEV_URL: closedUrl };
  const local = await runSuite(file, env);
  assert.equal(local.code, 0, local.output);
  assert.match(local.output, /skipped 1/);
  const required = await runSuite(file, { ...env, CUTOUT_REQUIRE_E2E: "1" });
  assert.notEqual(required.code, 0, required.output);
});
