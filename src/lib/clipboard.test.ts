import assert from "node:assert/strict";
import test from "node:test";
import { copyPngOrShare } from "./clipboard.ts";

test("copyPngOrShare falls back to failed when clipboard and share are missing", async () => {
  const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
  const result = await copyPngOrShare(blob, "cutout.png");
  assert.equal(result, "failed");
});
