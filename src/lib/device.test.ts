import assert from "node:assert/strict";
import test from "node:test";
import {
  SERVER_ENV,
  adoptHostEnv,
  appleVersion,
  isIosUserAgent,
  readClient,
  readEnv,
} from "./device.ts";
import { processingLimits } from "./files.ts";

test("the server profile is the desktop profile, and readEnv returns it without a window", () => {
  assert.deepEqual(readEnv(), SERVER_ENV);
  const server = readClient(SERVER_ENV);
  assert.equal(server.ios, false);
  assert.equal(server.android, false);
  assert.equal(server.phone, false);
  assert.equal(server.compact, false);
});

test("appleVersion reads iPhone and desktop-class Safari agents", () => {
  assert.equal(
    appleVersion(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Version/17.5 Mobile Safari",
    ),
    17,
  );
  assert.equal(
    appleVersion(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Version/18.1 Mobile Safari",
    ),
    18,
  );
  assert.equal(
    appleVersion("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15"),
    17,
  );
  assert.equal(
    appleVersion("Mozilla/5.0 (Linux; Android 14) Chrome/124.0 Mobile Safari/537.36"),
    0,
  );
});

test("iPad with a desktop agent counts as iOS only with a coarse multi-touch pointer", () => {
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/17.4 Safari/605.1.15";
  assert.equal(isIosUserAgent(ipad, 5, true), true);
  assert.equal(isIosUserAgent(ipad, 5, false), false, "a Mac trackpad is not an iPad");
  assert.equal(isIosUserAgent(ipad, 0), false);
});

test("a worker applies the page's phone budget once the page sends its environment", () => {
  const iphone = {
    ...SERVER_ENV,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile Safari",
    maxTouchPoints: 5,
    pointerCoarse: true,
  };
  assert.equal(processingLimits(8).side, processingLimits(8, SERVER_ENV).side);
  adoptHostEnv(iphone);
  try {
    assert.deepEqual(readEnv(), iphone);
    assert.deepEqual(processingLimits(8), { pixels: 16_000_000, side: 4096 });
  } finally {
    adoptHostEnv(SERVER_ENV);
  }
});
