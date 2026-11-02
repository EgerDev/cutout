import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchFirefox } from "./firefox.mjs";

const redirected = (name) =>
  name.startsWith("cutout-firefox-appdata-") || name.startsWith("cutout-firefox-localappdata-");

async function withIsolatedTmp(fn) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-firefox-test-"));
  const origTmp = os.tmpdir;
  os.tmpdir = () => parent;
  try {
    return await fn(parent);
  } finally {
    os.tmpdir = origTmp;
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

test("Playwright Firefox launches with redirected app data and cleans it up", async (t) => {
  await withIsolatedTmp(async (parent) => {
    const before = new Set(fs.readdirSync(parent).filter(redirected));
    let browser;
    let pair;
    try {
      browser = await launchFirefox();
    } catch (error) {
      if (!/Executable doesn't exist/.test(String(error?.message))) throw error;
      const reason = "Playwright Firefox is not installed (npx playwright install firefox)";
      if (process.env.CUTOUT_REQUIRE_TOOLS) assert.fail(`${reason}; CUTOUT_REQUIRE_TOOLS is set`);
      t.skip(reason);
      return;
    }
    try {
      const page = await browser.newPage();
      assert.match(await page.evaluate(() => navigator.userAgent), /Firefox\/\d+/);
      const acquired = fs
        .readdirSync(parent)
        .filter((name) => redirected(name) && !before.has(name));
      const app = acquired.filter((name) => name.startsWith("cutout-firefox-appdata-"));
      const local = acquired.filter((name) => name.startsWith("cutout-firefox-localappdata-"));
      assert.equal(app.length, 1, "this invocation acquired MOZ_APP_DATA");
      assert.equal(local.length, 1, "this invocation acquired MOZ_LOCAL_APP_DATA");
      pair = [path.join(parent, app[0]), path.join(parent, local[0])];
      assert.deepEqual(
        pair.map((dir) => fs.existsSync(dir)),
        [true, true],
        "the acquired pair exists during the session",
      );
      await page.close();
    } finally {
      await browser.close();
    }
    assert.deepEqual(
      pair.map((dir) => fs.existsSync(dir)),
      [false, false],
      "the same acquired pair is gone after close",
    );
  });
});

test("a launch rejection removes this invocation's acquired directories", async () => {
  await withIsolatedTmp(async (parent) => {
    const missing = path.join(parent, "no-such-firefox");
    const before = new Set(fs.readdirSync(parent).filter(redirected));
    await assert.rejects(launchFirefox({ executablePath: missing }), (error) => {
      assert.match(String(error?.message), /executable|launch/i);
      return true;
    });
    const leftover = fs
      .readdirSync(parent)
      .filter((name) => redirected(name) && !before.has(name));
    assert.deepEqual(leftover, []);
  });
});

test("second mkdtemp failure removes the first acquired directory", async () => {
  // Controlled filesystem fault: the second mkdtemp fails with EACCES. Throwing a
  // coded error is platform-independent — a read-only-directory chmod does not
  // block creation inside the directory on Windows, so the POSIX trick never
  // fails there and the test leaks a live browser.
  await withIsolatedTmp(async (parent) => {
    const origMake = fs.mkdtempSync;
    let calls = 0;
    let error;
    try {
      fs.mkdtempSync = (...args) => {
        calls += 1;
        if (calls === 2) {
          const failure = new Error("EACCES: permission denied, mkdtemp");
          failure.code = "EACCES";
          failure.syscall = "mkdtemp";
          throw failure;
        }
        return origMake(...args);
      };
      try {
        await launchFirefox();
      } catch (caught) {
        error = caught;
      }
      assert.equal(error?.code, "EACCES");
      assert.equal(calls, 2);
      assert.deepEqual(
        fs.readdirSync(parent).filter(redirected),
        [],
        "first acquired directory is removed when the second allocation fails",
      );
    } finally {
      fs.mkdtempSync = origMake;
    }
  });
});
