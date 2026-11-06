/**
 * Downloads every model file the app can load, at the revisions it pins, into a directory
 * laid out like Hugging Face (<model>/resolve/<revision>/<file>): what VITE_MODEL_HOST
 * points at. Serve that directory as the mirror (deploy/Caddyfile's /models block, or
 * any static host with CORS allowing your site).
 *
 *   node scripts/mirror-models.mjs [directory]   # default ./models; re-runs skip done files
 *   node scripts/mirror-models.mjs --list        # what would be downloaded, and the total
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MODEL_NOTICES } from "../src/lib/model-notices.ts";
import { REMOVAL_MODELS, REMOVAL_MODEL_SHA256 } from "../src/lib/removal-model-specs.ts";

const HUB = "https://huggingface.co";
const args = process.argv.slice(2);
const listOnly = args.includes("--list");
const root = args.find((arg) => !arg.startsWith("--")) ?? "models";

/**
 * The ONNX variants each model's code asks for ("" = fp32 model.onnx). A mirror without
 * one breaks that path, so scripts/mirror-models.test.mjs fails for a model not listed.
 */
export const VARIANTS = {
  // removal-model-specs.ts: fp16 on WebGPU, fp32 on WASM (also the compatibility retry).
  "studioludens/birefnet-lite-512": ["", "_fp16"],
  // engine.ts loadLiteEngine: fp16 on WASM.
  "imgly/isnet-general-onnx": ["_fp16"],
  // enhance.ts loadPipeline: fp32 on WebGPU, q8 on WASM.
  "Xenova/swin2SR-lightweight-x2-64": ["", "_quantized"],
  "Xenova/swin2SR-compressed-sr-x4-48": ["", "_quantized"],
  // editor/depth.ts: fp16, then fp32 on WebGPU, q8 on WASM.
  "onnx-community/depth-anything-v2-small": ["", "_fp16", "_quantized"],
};

/** Configs and tokenizers, plus the ONNX variants `id`'s code requests. */
export function wanted(id, path) {
  if (!path.includes("/")) return /\.(json|txt)$/.test(path);
  const variant = /^onnx\/model(_fp16|_quantized)?\.onnx(_data)?$/.exec(path);
  return Boolean(variant && (VARIANTS[id] ?? []).includes(variant[1] ?? ""));
}

async function filesOf({ id, revision }) {
  const response = await fetch(`${HUB}/api/models/${id}/tree/${revision}?recursive=true`);
  if (!response.ok) throw new Error(`${id}@${revision}: listing failed (${response.status})`);
  const entries = await response.json();
  return entries.filter((entry) => entry.type === "file" && wanted(id, entry.path));
}

/**
 * The SHA-256 a mirrored file must have: the app's own pin for the removal models (it checks
 * those bytes in the browser, so a mirror must serve them unchanged), else Hugging Face's LFS
 * oid. Undefined for a small non-LFS file of another model.
 */
export function expectedSha256(id, revision, file) {
  const kind = Object.keys(REMOVAL_MODELS).find(
    (key) => REMOVAL_MODELS[key].modelId === id && REMOVAL_MODELS[key].revision === revision,
  );
  const pinned = kind ? REMOVAL_MODEL_SHA256[kind][file.path] : undefined;
  const lfs = file.lfs?.oid;
  if (pinned && lfs && pinned !== lfs)
    throw new Error(`${id}/${file.path}: Hugging Face reports ${lfs}, the app pins ${pinned}`);
  return pinned ?? lfs;
}

async function sha256Of(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function download(id, revision, file) {
  const target = join(root, id, "resolve", revision, file.path);
  const expected = expectedSha256(id, revision, file);
  const done = await stat(target).catch(() => null);
  // A same-size file is reused only when its bytes are right: browsers reject a wrong one.
  if (done?.size === file.size && (!expected || (await sha256Of(target)) === expected))
    return false;
  await mkdir(dirname(target), { recursive: true });
  const response = await fetch(`${HUB}/${id}/resolve/${revision}/${file.path}`);
  if (!response.ok || !response.body)
    throw new Error(`${id}/${file.path}: download failed (${response.status})`);
  // Written beside the target and renamed at the end, so an interrupted run leaves no
  // half file that a mirror would serve (and cache) as complete.
  const partial = `${target}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (expected && (await sha256Of(partial)) !== expected) {
    await rm(partial, { force: true });
    throw new Error(`${id}/${file.path}: downloaded bytes do not match SHA-256 ${expected}`);
  }
  await rename(partial, target);
  return true;
}

if (import.meta.main) {
  let total = 0;
  for (const model of MODEL_NOTICES) {
    const files = await filesOf(model);
    for (const file of files) {
      total += file.size;
      if (listOnly) {
        console.log(`${(file.size / 1e6).toFixed(1).padStart(8)} MB  ${model.id}/${file.path}`);
        continue;
      }
      const fetched = await download(model.id, model.revision, file);
      console.log(`${fetched ? "fetched" : "present"}  ${model.id}/${file.path}`);
    }
  }
  console.log(`${(total / 1e9).toFixed(2)} GB in ${listOnly ? "the mirror" : root}`);
}
