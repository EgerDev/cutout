import assert from "node:assert/strict";
import test from "node:test";
import { missingCapabilities } from "./capabilities.ts";

test("missingCapabilities names what the browser lacks", () => {
  const full = {
    OffscreenCanvas: class {},
    WebAssembly: {},
    createImageBitmap: () => undefined,
    Worker: class {},
  };
  assert.deepEqual(missingCapabilities(full), []);
  // Playwright's Windows WebKit: everything but OffscreenCanvas.
  assert.deepEqual(missingCapabilities({ ...full, OffscreenCanvas: undefined }), [
    "OffscreenCanvas",
  ]);
  assert.deepEqual(missingCapabilities({}), [
    "OffscreenCanvas",
    "WebAssembly",
    "createImageBitmap",
    "Worker",
  ]);
});
