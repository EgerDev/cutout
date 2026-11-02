// The stage, sheet and layout checks that used to live here matched source text; they are
// now behavioural tests in scripts/browser-stage-ui.mjs (npm run test:ui) and
// scripts/browser-adjust-pipeline.mjs (npm run test:editor).
import assert from "node:assert/strict";
import test from "node:test";
import * as engine from "./engine.ts";
import * as files from "./files.ts";

test("idle warmup helpers are not shipped", () => {
  assert.equal("warmupDot" in files, false);
  assert.equal("cancelWarmup" in engine, false);
  assert.equal(typeof engine.warmupBiRefNet, "function");
  assert.equal(engine.warmupBiRefNet(), engine.warmupBiRefNet());
});
