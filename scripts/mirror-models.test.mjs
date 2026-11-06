import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { MODEL_NOTICES } from "../src/lib/model-notices.ts";
import { REMOVAL_MODELS, REMOVAL_MODEL_SHA256 } from "../src/lib/removal-model-specs.ts";
import { VARIANTS, expectedSha256, wanted } from "./mirror-models.mjs";

test("every model the app downloads has its mirrored variants decided", () => {
  for (const { id } of MODEL_NOTICES) assert.ok(VARIANTS[id]?.length, id);
});

test("the mirror keeps configs, tokenizers and only the requested ONNX variants", () => {
  const id = "Xenova/swin2SR-lightweight-x2-64";
  assert.equal(wanted(id, "tokenizer.json"), true);
  assert.equal(wanted(id, "merges.txt"), true);
  assert.equal(wanted(id, "onnx/model_quantized.onnx"), true);
  assert.equal(wanted(id, "onnx/model.onnx"), true);
  assert.equal(wanted(id, "onnx/model_fp16.onnx"), false);
  assert.equal(wanted(id, "onnx/text_model.onnx"), false);
  assert.equal(wanted(id, "pytorch_model.bin"), false);
  assert.equal(wanted("studioludens/birefnet-lite-512", "onnx/model.onnx"), true);
});

test("mirrored files are held to the app's pins, else Hugging Face's LFS oid", () => {
  const { modelId, revision } = REMOVAL_MODELS.birefnet;
  const pin = REMOVAL_MODEL_SHA256.birefnet["config.json"];
  assert.equal(expectedSha256(modelId, revision, { path: "config.json" }), pin);
  const onnx = REMOVAL_MODEL_SHA256.birefnet["onnx/model.onnx"];
  assert.equal(
    expectedSha256(modelId, revision, { path: "onnx/model.onnx", lfs: { oid: onnx } }),
    onnx,
  );
  assert.throws(
    () =>
      expectedSha256(modelId, revision, { path: "onnx/model.onnx", lfs: { oid: "0".repeat(64) } }),
    /pins/,
  );
  const other = { path: "onnx/model.onnx", lfs: { oid: "a".repeat(64) } };
  assert.equal(expectedSha256("Xenova/swin2SR-lightweight-x2-64", "main", other), "a".repeat(64));
  assert.equal(
    expectedSha256("Xenova/swin2SR-lightweight-x2-64", "main", { path: "config.json" }),
    undefined,
  );
});

test("the mirror repairs same-size corruption, reuses verified files and rejects bad downloads", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cutout-mirror-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { modelId, revision } = REMOVAL_MODELS.isnet;
  const config = '{\n  "model_type": "isnet"\n}';
  const target = path.join(root, modelId, "resolve", revision, "config.json");
  const loader = path.join(root, "fetch.mjs");
  const fetched = path.join(root, "fetched");
  fs.writeFileSync(
    loader,
    `
    import fs from "node:fs";
    globalThis.fetch = async (url) => {
      if (url.includes("/api/models/")) return Response.json(
        url.includes(${JSON.stringify(`/api/models/${modelId}/`)})
          ? [{ type: "file", path: "config.json", size: ${Buffer.byteLength(config)} }] : []
      );
      fs.writeFileSync(${JSON.stringify(fetched)}, "yes");
      return new Response(process.env.MIRROR_TEST_BAD ? "bad" : ${JSON.stringify(config)});
    };
  `,
  );
  const run = (bad = false) =>
    spawnSync(
      process.execPath,
      [
        // --import takes a URL on Windows (a bare C:\ path parses as scheme "c:").
        "--import",
        pathToFileURL(loader).href,
        path.join(import.meta.dirname, "mirror-models.mjs"),
        root,
      ],
      {
        encoding: "utf8",
        env: { ...process.env, MIRROR_TEST_BAD: bad ? "1" : "" },
        timeout: 10_000,
      },
    );

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "x".repeat(Buffer.byteLength(config)));
  const repaired = run();
  assert.equal(repaired.status, 0, repaired.stderr);
  assert.equal(fs.readFileSync(target, "utf8"), config);
  assert.ok(fs.existsSync(fetched));

  fs.unlinkSync(fetched);
  const reused = run(true);
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(fs.existsSync(fetched), false);

  fs.unlinkSync(target);
  const rejected = run(true);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /do not match SHA-256/);
  assert.equal(fs.existsSync(target), false);
  assert.equal(fs.existsSync(`${target}.partial`), false);
});
