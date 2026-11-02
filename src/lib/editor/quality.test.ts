import assert from "node:assert/strict";
import test from "node:test";
import { defaults } from "./model.ts";
import { inspectQuality } from "./quality.ts";

function alpha(width: number, height: number, fill = 0) {
  return new Uint8Array(width * height).fill(fill);
}

test("flags an empty matte as a high-severity subject problem", () => {
  const issues = inspectQuality({
    alpha: alpha(32, 32, 0),
    width: 32,
    height: 32,
    sourceWidth: 32,
    sourceHeight: 32,
    settings: defaults,
  });
  assert.equal(issues[0]?.id, "empty");
  assert.equal(issues[0]?.severity, "high");
});

test("flags a subject that touches the output edge", () => {
  const mask = alpha(40, 40, 0);
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 12; x += 1) mask[y * 40 + x] = 255;
  const issues = inspectQuality({
    alpha: mask,
    width: 40,
    height: 40,
    sourceWidth: 40,
    sourceHeight: 40,
    settings: defaults,
  });
  assert.ok(issues.some((issue) => issue.id === "edge"));
});

test("flags upscaling and a missed file-size target", () => {
  const mask = alpha(20, 20, 255);
  const issues = inspectQuality({
    alpha: mask,
    width: 20,
    height: 20,
    sourceWidth: 20,
    sourceHeight: 20,
    settings: { ...defaults, exportWidth: 400, exportHeight: 400 },
    encoded: { width: 400, height: 400, metTarget: false },
  });
  assert.ok(issues.some((issue) => issue.id === "upscale"));
  assert.ok(issues.some((issue) => issue.id === "size-target" && issue.severity === "high"));
});

test("a filled interior subject on a padded canvas is clean", () => {
  const mask = alpha(40, 40, 0);
  for (let y = 8; y < 32; y += 1) for (let x = 8; x < 32; x += 1) mask[y * 40 + x] = 255;
  const issues = inspectQuality({
    alpha: mask,
    width: 40,
    height: 40,
    sourceWidth: 40,
    sourceHeight: 40,
    settings: defaults,
  });
  assert.equal(issues.length, 0);
});
