#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { runVariantBlock } from "./benchmark/browser-runner.mjs";
import { servedBuild, servedBuildChanges } from "./benchmark/served-build.mjs";
import {
  BenchmarkContractError,
  inRun,
  loadCorpus,
  nondeterministicOutputError,
  outputIdentity,
  pairedLatency,
  qualityCapturePolicy,
  validateCompletedRuns,
  verifyBuild,
} from "./benchmark/contract.mjs";

const run = promisify(execFile);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const providers = new Set(["webgpu", "wasm"]);
const modes = new Set(["quick", "auto", "maximum"]);
const splits = new Set(["smoke", "tune", "heldout"]);

const HELP = `Usage:
  node scripts/benchmark-removal.mjs --baseline-url URL --candidate-url URL \\
    --baseline-commit SHA --candidate-commit SHA --provider webgpu|wasm [options]

Required assertions:
  --baseline-url URL        Production baseline origin
  --candidate-url URL       Production candidate origin
  --baseline-commit SHA     Exact 40-character commit from baseline /version.json
  --candidate-commit SHA    Exact 40-character commit from candidate /version.json
  --provider NAME           Required provider lane; off-provider model runs fail by default

Options:
  --manifest PATH           Corpus manifest (default: .omo/benchmarks/cutout-owned-engine/corpus/manifest.json)
  --split NAME              smoke, tune, or heldout (default: smoke)
  --mode NAME               quick, auto, or maximum (default: auto)
  --pairs N                 Alternating paired blocks (default: 30)
  --warmups N               Untimed warmups per block (default: 3)
  --timeout-ms N            Per navigation/removal timeout (default: 180000)
  --output PATH             New artifact directory (required)
  --quality-policy PATH     Explicit known-alpha quality-only policy JSON (no latency inference)
  --quality-policy-sha256 HASH
                            Preregistered SHA-256 of exact policy bytes; both flags required
                            Scoring also requires this external pin. Strict output identity only.
  --heldout-lock PATH       Implementation-lock JSON required for heldout
  --baseline-dir PATH       Checkout the baseline server was built from: at --baseline-commit,
                            clean, and its .output/public served byte for byte (start and end)
  --candidate-dir PATH      The same for the candidate server
  --allow-dirty             Permit a dirty source tree and record every path
  --allow-nondeterministic-outputs
                            Record, instead of failing on, a later pair whose output hash
                            differs from pair 0's for the same fixture and variant
  --help                    Show this help

Release eligibility requires both --baseline-dir and --candidate-dir, successful served-byte
checks at lane start and end, and clean runner and served checkouts.
Without both flags, the lane is runnable but explicitly non-release; manifest.sources records
releaseEligible: false and names each unverified checkout in releaseIneligibleReasons.
`;

const valueOptions = new Set([
  "--baseline-url",
  "--candidate-url",
  "--baseline-commit",
  "--candidate-commit",
  "--provider",
  "--manifest",
  "--split",
  "--mode",
  "--pairs",
  "--warmups",
  "--timeout-ms",
  "--output",
  "--heldout-lock",
  "--quality-policy",
  "--quality-policy-sha256",
  "--baseline-dir",
  "--candidate-dir",
]);

function parseArgs(argv) {
  const values = new Map();
  let allowDirty = false;
  let allowNondeterministicOutputs = false;
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--help") return { help: true };
    if (key === "--allow-dirty") {
      allowDirty = true;
      continue;
    }
    if (key === "--allow-nondeterministic-outputs") {
      allowNondeterministicOutputs = true;
      continue;
    }
    // A mistyped option must not silently drop a check (--candidate-dir above all).
    if (key.startsWith("--") && !valueOptions.has(key)) throw new Error(`Unknown option ${key}`);
    if (!key.startsWith("--") || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error(`Missing value for ${key}`);
    if (values.has(key)) throw new Error(`Duplicate option ${key}`);
    values.set(key, argv[index + 1]);
    index += 1;
  }
  const integer = (key, fallback) => {
    const value = Number(values.get(key) ?? fallback);
    if (!Number.isInteger(value) || value < 0) throw new Error(`${key} must be a non-negative integer`);
    return value;
  };
  const options = {
    baselineUrl: values.get("--baseline-url"),
    candidateUrl: values.get("--candidate-url"),
    baselineCommit: values.get("--baseline-commit"),
    candidateCommit: values.get("--candidate-commit"),
    requestedProvider: values.get("--provider"),
    manifestPath: resolve(values.get("--manifest") ?? ".omo/benchmarks/cutout-owned-engine/corpus/manifest.json"),
    split: values.get("--split") ?? "smoke",
    mode: values.get("--mode") ?? "auto",
    pairs: integer("--pairs", 30),
    warmups: integer("--warmups", 3),
    timeoutMs: integer("--timeout-ms", 180_000),
    outputDirectory: values.get("--output") ? resolve(values.get("--output")) : undefined,
    heldoutLock: values.get("--heldout-lock"),
    qualityPolicyPath: values.get("--quality-policy"),
    qualityPolicySha256: values.get("--quality-policy-sha256"),
    baselineDir: values.get("--baseline-dir") && resolve(values.get("--baseline-dir")),
    candidateDir: values.get("--candidate-dir") && resolve(values.get("--candidate-dir")),
    allowDirty,
    allowNondeterministicOutputs,
  };
  for (const key of ["baselineUrl", "candidateUrl", "baselineCommit", "candidateCommit", "requestedProvider", "outputDirectory"])
    if (!options[key]) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  commit.parse(options.baselineCommit);
  commit.parse(options.candidateCommit);
  if (!providers.has(options.requestedProvider)) throw new Error("--provider must be webgpu or wasm");
  if (!modes.has(options.mode)) throw new Error("--mode must be quick, auto, or maximum");
  if (!splits.has(options.split)) throw new Error("--split must be smoke, tune, or heldout");
  if (options.pairs < 1) throw new Error("--pairs must be at least 1");
  if (Boolean(options.qualityPolicyPath) !== Boolean(options.qualityPolicySha256))
    throw new Error("--quality-policy and --quality-policy-sha256 are required together");
  if (options.qualityPolicyPath && options.allowNondeterministicOutputs)
    throw new Error("quality-only capture requires strict output identity");
  return options;
}

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function heldoutReleased(options) {
  if (options.split !== "heldout") return false;
  if (!options.heldoutLock) throw new Error("--heldout-lock is required for the heldout split");
  const lock = z.object({
    candidateCommit: commit,
    corpusManifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    lockedAt: z.string().datetime(),
  }).parse(JSON.parse(await readFile(options.heldoutLock, "utf8")));
  if (lock.candidateCommit !== options.candidateCommit)
    throw new Error("Heldout lock does not name the candidate commit");
  if (lock.corpusManifestSha256 !== await hash(options.manifestPath))
    throw new Error("Heldout lock does not match the corpus manifest");
  return true;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  const { stdout } = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"]);
  const dirtyPaths = stdout.trim() ? stdout.trim().split("\n") : [];
  if (dirtyPaths.length && !options.allowDirty)
    throw new Error("Working tree is dirty; commit/stash it or pass --allow-dirty to record a non-release run");
  await mkdir(dirname(options.outputDirectory), { recursive: true });
  await mkdir(options.outputDirectory, { recursive: false });
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Benchmark interrupted"));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  const profiles = {
    baseline: await mkdtemp(join(os.tmpdir(), "cutout-benchmark-baseline-")),
    candidate: await mkdtemp(join(os.tmpdir(), "cutout-benchmark-candidate-")),
  };
  let artifact = { status: "initializing" };
  const rows = [];
  try {
    const released = await heldoutReleased(options);
    const corpus = await loadCorpus(options.manifestPath, options.split, released);
    const manifestSha256 = await hash(options.manifestPath);
    let qualityPolicy;
    if (options.qualityPolicyPath) {
      qualityPolicy = { json: await readFile(options.qualityPolicyPath, "utf8"), sha256: options.qualityPolicySha256 };
      options.qualityCapture = qualityCapturePolicy(qualityPolicy, {
        ...options, expectedSha256: options.qualityPolicySha256, manifestSha256, fixtures: corpus.fixtures,
      });
    }
    const lane = {
      baseline: { url: options.baselineUrl, commit: options.baselineCommit, dir: options.baselineDir },
      candidate: { url: options.candidateUrl, commit: options.candidateCommit, dir: options.candidateDir },
    };
    // The commit string, then the served bytes (C54), at lane start and again at lane end.
    const verified = async (variant, phase) => {
      const { url, commit, dir } = lane[variant];
      try {
        const version = await verifyBuild(url, commit, options.timeoutMs, abort.signal);
        const served = await servedBuild(url, {
          checkoutDir: dir,
          expectedCommit: commit,
          allowDirty: options.allowDirty,
          timeoutMs: options.timeoutMs,
          signal: abort.signal,
        });
        return { version, served };
      } catch (error) {
        throw inRun(error, { variant, phase });
      }
    };
    const versions = {
      baseline: await verified("baseline", "version check"),
      candidate: await verified("candidate", "version check"),
    };
    const releaseIneligibleReasons = new Set(["lane-incomplete"]);
    if (qualityPolicy) releaseIneligibleReasons.add("quality-only-no-performance-or-release-eligibility");
    if (dirtyPaths.length) releaseIneligibleReasons.add("runner-checkout-dirty");
    for (const [variant, { served }] of Object.entries(versions)) {
      if (!served.checkout) releaseIneligibleReasons.add(`${variant}-checkout-unverified`);
      else if (served.checkout.dirtyPaths.length) releaseIneligibleReasons.add(`${variant}-checkout-dirty`);
    }
    artifact = {
      schemaVersion: 1,
      status: "running",
      startedAt: new Date().toISOString(),
      protocol: {
        ...(qualityPolicy ? { purpose: "quality-only", qualityCapture: qualityPolicy } : {}),
        split: options.split,
        mode: options.mode,
        requestedProvider: options.requestedProvider,
        pairs: options.pairs,
        warmupsPerBlock: options.warmups,
        order: "AB/BA alternating by pair; one engine context alive at a time",
        timeoutMs: options.timeoutMs,
        headlineTiming: qualityPolicy ? "unavailable: quality-only capture; completeMs is diagnostic only" : "completeMs: input publication to completed usable result",
        outputIdentity: "sha256 of every measured result blob, hashed in the page; pair 0 is each fixture and variant's reference",
        allowNondeterministicOutputs: options.allowNondeterministicOutputs,
      },
      sources: {
        baseline: { url: options.baselineUrl, commit: options.baselineCommit, version: versions.baseline.version.version, served: versions.baseline.served },
        candidate: { url: options.candidateUrl, commit: options.candidateCommit, version: versions.candidate.version.version, served: versions.candidate.served },
        dirtyPaths,
        servedBytesVerified: Object.values(versions).every(({ served }) => Boolean(served.checkout)),
        releaseEligible: false,
        releaseIneligibleReasons: [...releaseIneligibleReasons],
        packageLockSha256: await hash("package-lock.json"),
      },
      host: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().map((cpu) => cpu.model) },
      corpus: {
        manifestPath: options.manifestPath,
        manifestSha256,
        heldoutState: corpus.heldoutState,
        fixtures: corpus.fixtures.map(({ inputPath: _inputPath, alphaPath: _alphaPath, ...fixture }) => fixture),
      },
    };
    await writeFile(join(options.outputDirectory, "manifest.json"), JSON.stringify(artifact, null, 2));
    // Every row reaches runs.jsonl as soon as its run is complete and checked.
    const onRow = async (row) => {
      const complete = { ...row, commit: row.variant === "baseline" ? options.baselineCommit : options.candidateCommit };
      const changed = outputIdentity([...rows, complete]).nondeterministic.find(
        (entry) => entry.pair === complete.pair && entry.fixtureId === complete.fixtureId && entry.variant === complete.variant,
      );
      if (changed && !options.allowNondeterministicOutputs) throw nondeterministicOutputError(changed, complete);
      rows.push(complete);
      await appendFile(join(options.outputDirectory, "runs.jsonl"), `${JSON.stringify(complete)}\n`);
    };
    for (let pair = 0; pair < options.pairs; pair += 1) {
      const order = pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
      for (let index = 0; index < order.length; index += 1) {
        const variant = order[index];
        const block = await runVariantBlock({
          ...options,
          variant,
          pair,
          order: index,
          url: variant === "baseline" ? options.baselineUrl : options.candidateUrl,
          fixtures: corpus.fixtures,
          profileDirectory: profiles[variant],
          saveOutputs: pair === 0 || Boolean(qualityPolicy),
          referenceOutputs: new Map(
            rows.filter((row) => row.pair === 0 && row.variant === variant).map((row) => [row.fixtureId, row.outputSha256]),
          ),
          signal: abort.signal,
          onRow,
        });
        artifact.browser ??= block.browserEnvironment;
      }
    }
    for (const variant of ["baseline", "candidate"]) {
      const { served } = await verified(variant, "lane end");
      const changes = servedBuildChanges(artifact.sources[variant].served, served);
      if (changes.length > 0)
        throw new BenchmarkContractError(`the served build changed during the lane: ${changes.join(", ")}`, {
          variant,
          phase: "lane end",
        });
      artifact.sources[variant].served.recheckedAtLaneEnd = true;
      if (served.checkout?.dirtyPaths.length) releaseIneligibleReasons.add(`${variant}-checkout-dirty`);
    }
    const { stdout: runnerStatusAtLaneEnd } = await run("git", ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]);
    artifact.sources.dirtyPathsAtLaneEnd = runnerStatusAtLaneEnd.trim() ? runnerStatusAtLaneEnd.trim().split("\n") : [];
    if (artifact.sources.dirtyPathsAtLaneEnd.length) releaseIneligibleReasons.add("runner-checkout-dirty");
    validateCompletedRuns(rows, corpus.fixtures.map((fixture) => fixture.id), options.pairs, options);
    if (qualityPolicy && await hash(options.qualityPolicyPath) !== options.qualityPolicySha256)
      throw new BenchmarkContractError("Quality policy changed during capture");
    if (qualityPolicy && await hash(options.manifestPath) !== manifestSha256)
      throw new BenchmarkContractError("Corpus manifest changed during quality capture");
    artifact.status = "completed";
    artifact.outputIdentity = { ...outputIdentity(rows), allowed: options.allowNondeterministicOutputs };
    artifact.completedAt = new Date().toISOString();
    artifact.latency = qualityPolicy ? null : pairedLatency(rows);
    if (qualityPolicy) artifact.performance = { eligible: false, reason: "quality-only capture; completeMs is diagnostic only; no requested-provider pooling or FASTER inference" };
    releaseIneligibleReasons.delete("lane-incomplete");
    artifact.sources.releaseIneligibleReasons = [...releaseIneligibleReasons];
    artifact.sources.releaseEligible = releaseIneligibleReasons.size === 0;
    await writeFile(join(options.outputDirectory, "manifest.json"), JSON.stringify(artifact, null, 2));
    process.stdout.write(`${JSON.stringify({ ok: true, output: options.outputDirectory, runs: rows.length })}\n`);
  } catch (error) {
    artifact.status = "failed";
    artifact.failedAt = new Date().toISOString();
    // Which run broke the contract and with what row; runs.jsonl holds every row before it.
    artifact.error = error instanceof Error
      ? { name: error.name, message: error.message, run: error.run, offendingRow: error.row }
      : { name: "Unknown", message: String(error) };
    artifact.completedRows = rows.length;
    await writeFile(join(options.outputDirectory, "failure.json"), JSON.stringify(artifact, null, 2));
    throw error;
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await Promise.all(Object.values(profiles).map((profile) => rm(profile, { recursive: true, force: true })));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
