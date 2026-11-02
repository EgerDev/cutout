import assert from "node:assert/strict";
import test from "node:test";
import { planIngest } from "./files.ts";

const png = (name: string) => new File([new Uint8Array(8)], name, { type: "image/png" });
const wasm = () =>
  new File([new Uint8Array([0x00, 0x61, 0x73, 0x6d])], "module.wasm", { type: "application/wasm" });
const junk = () => new File(["nope"], ".DS_Store", { type: "" });

test("planIngest processes valid images alongside unsupported strays", () => {
  const plan = planIngest([png("good.png"), wasm(), junk()]);
  assert.deepEqual(
    plan.images.map((f) => f.name),
    ["good.png"],
  );
  assert.equal(plan.errorMessage, null);
});

test("planIngest explains a wasm-only drop instead of processing", () => {
  const plan = planIngest([wasm(), wasm()]);
  assert.deepEqual(plan.images, []);
  assert.match(plan.errorMessage ?? "", /WebAssembly module/);
});

test("planIngest explains a drop with no usable files", () => {
  const plan = planIngest([junk(), new File(["x"], "notes.txt", { type: "" })]);
  assert.deepEqual(plan.images, []);
  assert.ok(plan.errorMessage);
});

test("planIngest caps at 15 images and says so", () => {
  const files = Array.from({ length: 20 }, (_, i) => png(`batch-${i + 1}.png`));
  const plan = planIngest(files);
  assert.equal(plan.images.length, 15);
  assert.match(plan.errorMessage ?? "", /first 15 of 20/);
});

test("planIngest stays silent within the cap", () => {
  const plan = planIngest([png("a.png"), png("b.png")]);
  assert.equal(plan.images.length, 2);
  assert.equal(plan.errorMessage, null);
});

test("planIngest keeps dotfiles out while saving hidden images", () => {
  const plan = planIngest([
    new File([new Uint8Array(8)], ".DS_Store", { type: "" }),
    new File([new Uint8Array(8)], ".shot.png", { type: "" }),
  ]);
  assert.deepEqual(
    plan.images.map((f) => f.name),
    [".shot.png"],
  );
  assert.equal(plan.errorMessage, null);
});
