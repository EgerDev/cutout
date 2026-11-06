#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { z } from "zod";
import { loadCorpus, outputIdentity, pairedLatency, qualityCapturePolicy, validateCompletedRuns } from "./benchmark/contract.mjs";
import { alphaMetrics } from "./benchmark/quality.mjs";

const HELP = `Usage:
  node scripts/compare-removal-quality.mjs --benchmark PATH [--output PATH]
    [--allow-output-differences]

Reads a completed paired benchmark, validates every expected run and output,
and writes ground-truth alpha metrics. Visual-only fixtures are reported as
unscored; baseline output is never treated as accuracy ground truth.

It also compares every fixture's pair-0 baseline and candidate outputs (PNG
bytes, decoded RGBA, method, actual provider) and, after writing the report,
exits 1 if any differ.

  --quality-policy-sha256 HASH
                            Required external policy pin when scoring quality-only capture
  --allow-output-differences  Differences are expected (a quality experiment,
                              not a parity run): report them and exit 0
`;

const artifactSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal("completed"),
  protocol: z.object({
    split: z.enum(["smoke", "tune", "heldout"]),
    pairs: z.number().int().positive(),
    purpose: z.literal("quality-only").optional(),
    mode: z.enum(["quick", "auto", "maximum"]).optional(),
    requestedProvider: z.enum(["webgpu", "wasm"]).optional(),
    qualityCapture: z.object({ json: z.string(), sha256: z.string() }).strict().optional(),
    allowNondeterministicOutputs: z.boolean().optional(),
  }),
  sources: z.object({ baseline: z.object({ commit: z.string() }), candidate: z.object({ commit: z.string() }) }).optional(),
  corpus: z.object({ manifestPath: z.string().min(1), manifestSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
});

function options(argv) {
  if (argv.includes("--help")) return { help: true };
  const values = new Map();
  let allowOutputDifferences = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--allow-output-differences") {
      allowOutputDifferences = true;
      continue;
    }
    if (!argv[index]?.startsWith("--") || !argv[index + 1]) throw new Error(`Invalid option ${argv[index] ?? ""}`);
    values.set(argv[index], argv[index + 1]);
    index += 1;
  }
  if (!values.get("--benchmark")) throw new Error("--benchmark is required");
  const benchmark = resolve(values.get("--benchmark"));
  return { benchmark, qualityPolicySha256: values.get("--quality-policy-sha256"), output: resolve(values.get("--output") ?? join(benchmark, "quality.json")), allowOutputDifferences };
}

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function localPath(root, path) {
  const full = resolve(root, path);
  if (relative(root, full).startsWith("..")) throw new Error(`Artifact path escapes benchmark: ${path}`);
  return full;
}

async function predictedAlpha(path) {
  const image = sharp(path, { failOn: "error" });
  const metadata = await image.metadata();
  if (!metadata.hasAlpha) throw new Error(`${path} has no alpha channel`);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = new Uint8Array(info.width * info.height);
  for (let pixel = 0; pixel < alpha.length; pixel += 1) alpha[pixel] = data[pixel * info.channels + 3];
  return { alpha, width: info.width, height: info.height };
}

/** The PNG's bytes and its decoded 8-bit RGBA, as hashes (never the pixels themselves). */
async function decodedOutput(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1) throw new Error(`${path} must be an independent regular PNG file`);
  const bytes = await readFile(path);
  const image = sharp(bytes, { failOn: "error" });
  if ((await image.metadata()).format !== "png") throw new Error(`${path} is not a PNG file`);
  const { data, info } = await image.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const digest = (buffer) => createHash("sha256").update(buffer).digest("hex");
  return { pngSha256: digest(bytes), rgbaSha256: digest(data), width: info.width, height: info.height, channels: info.channels };
}

/**
 * The parity claim: for every fixture, pair 0's baseline and candidate outputs are the same
 * PNG bytes, the same decoded RGBA, from the same method on the same provider. Each saved PNG
 * must also be the bytes the page hashed when the run completed.
 */
async function identityOf(fixture, runIndex, benchmark, qualityOnly = false) {
  const sides = {};
  for (const variant of ["baseline", "candidate"]) {
    const runRow = runIndex.get(`0:${fixture.id}:${variant}`);
    const outputPath = runRow.outputPath;
    const annotate = (error) => {
      if (!qualityOnly) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${fixture.id} ${variant} pair 0 (${outputPath}): ${reason}`);
    };
    if (!outputPath) annotate(new Error(`${fixture.id} ${variant} has no saved output`));
    let path;
    try {
      path = localPath(benchmark, outputPath);
    } catch (error) {
      annotate(error);
    }
    let output;
    try {
      if (relative(await realpath(benchmark), await realpath(path)).startsWith(".."))
        throw new Error(`${fixture.id} ${variant} output resolves outside benchmark`);
      output = await decodedOutput(path);
    } catch (error) {
      annotate(error);
    }
    if (output.pngSha256 !== runRow.outputSha256)
      annotate(new Error(`${fixture.id} ${variant} saved output does not match the sha256 recorded when it ran`));
    sides[variant] = { ...output, method: runRow.method, actualProvider: runRow.actualProvider };
  }
  const baselineRow = runIndex.get(`0:${fixture.id}:baseline`);
  const candidateRow = runIndex.get(`0:${fixture.id}:candidate`);
  const baselineFile = await realpath(localPath(benchmark, baselineRow.outputPath));
  const candidateFile = await realpath(localPath(benchmark, candidateRow.outputPath));
  if (baselineFile === candidateFile) {
    const error = new Error(`${fixture.id} outputs must be independent regular PNG files`);
    if (!qualityOnly) throw error;
    throw new Error(
      `${fixture.id} candidate pair 0 (${candidateRow.outputPath}): ${error.message}; also ${fixture.id} baseline pair 0 (${baselineRow.outputPath})`,
    );
  }
  const { baseline, candidate } = sides;
  const problems = [];
  if (baseline.pngSha256 !== candidate.pngSha256) problems.push("PNG bytes differ");
  if (
    baseline.rgbaSha256 !== candidate.rgbaSha256 ||
    baseline.width !== candidate.width ||
    baseline.height !== candidate.height
  )
    problems.push("decoded RGBA differs");
  if (baseline.method !== candidate.method) problems.push(`method ${baseline.method} != ${candidate.method}`);
  if (baseline.actualProvider !== candidate.actualProvider)
    problems.push(`actualProvider ${baseline.actualProvider} != ${candidate.actualProvider}`);
  return { fixtureId: fixture.id, identical: problems.length === 0, problems, baseline, candidate };
}

/**
 * Quality-only artifacts save every pair. Pair-0 identity is already verified; later files must
 * be independent regular PNGs whose actual bytes match that identity. Default/performance lanes
 * still only require pair 0 on disk.
 */
async function assertQualitySavedEvidence(fixtures, runIndex, benchmark, identity, pairs) {
  const verified = new Map(identity.map((entry) => [entry.fixtureId, entry]));
  const root = await realpath(benchmark);
  const seenPath = new Map();
  const seenInode = new Map();
  for (const fixture of fixtures) {
    const pair0 = verified.get(fixture.id);
    for (let pair = 0; pair < pairs; pair += 1) {
      for (const variant of ["baseline", "candidate"]) {
        const runRow = runIndex.get(`${pair}:${fixture.id}:${variant}`);
        const outputPath = runRow.outputPath;
        const fail = (message) => {
          throw new Error(`${fixture.id} ${variant} pair ${pair} (${outputPath}): ${message}`);
        };
        if (!outputPath) fail("has no saved output");
        let path;
        try {
          path = localPath(benchmark, outputPath);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
        }
        let stat;
        try {
          stat = await lstat(path);
        } catch {
          fail("saved output is missing");
        }
        if (stat.isSymbolicLink()) fail("must be an independent regular PNG file, not a symlink");
        if (!stat.isFile() || stat.nlink !== 1) fail("must be an independent regular PNG file");
        const resolved = await realpath(path);
        if (relative(root, resolved).startsWith("..")) fail("output resolves outside benchmark");
        let output;
        try {
          output = await decodedOutput(path);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          fail(/not a PNG|unsupported image format/i.test(message) ? "is not a PNG file" : message);
        }
        if (output.pngSha256 !== runRow.outputSha256)
          fail("saved output does not match the sha256 recorded when it ran");
        const previousPath = seenPath.get(resolved);
        if (previousPath) fail(`reuses ${previousPath}'s canonical file`);
        seenPath.set(resolved, `${fixture.id} ${variant} pair ${pair}`);
        const inode = `${stat.dev}:${stat.ino}`;
        const previousInode = seenInode.get(inode);
        if (previousInode) fail(`reuses ${previousInode}'s inode`);
        seenInode.set(inode, `${fixture.id} ${variant} pair ${pair}`);
        const reference = pair0[variant];
        if (
          output.pngSha256 !== reference.pngSha256 ||
          output.rgbaSha256 !== reference.rgbaSha256 ||
          output.width !== reference.width ||
          output.height !== reference.height
        )
          fail("does not match verified pair 0 PNG/RGBA identity");
        if (runRow.method !== reference.method)
          fail(`method ${runRow.method} != verified pair 0 ${reference.method}`);
        if (runRow.actualProvider !== reference.actualProvider)
          fail(`actualProvider ${runRow.actualProvider} != verified pair 0 ${reference.actualProvider}`);
      }
    }
  }
}

async function truthAlpha(path) {
  const { data, info } = await sharp(path, { failOn: "error" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { alpha: new Uint8Array(data), width: info.width, height: info.height };
}

function average(rows, metric) {
  return rows.reduce((sum, row) => sum + row[metric], 0) / rows.length;
}

function aggregate(rows) {
  if (rows.length === 0) return null;
  return Object.fromEntries(["mae", "mse", "gradientMae", "boundaryF1"].map((metric) => [metric, average(rows, metric)]));
}

async function main(argv) {
  const selected = options(argv);
  if (selected.help) {
    process.stdout.write(HELP);
    return;
  }
  const manifest = artifactSchema.parse(JSON.parse(await readFile(join(selected.benchmark, "manifest.json"), "utf8")));
  if (await hash(manifest.corpus.manifestPath) !== manifest.corpus.manifestSha256)
    throw new Error("Corpus manifest changed after benchmark execution");
  const corpus = await loadCorpus(manifest.corpus.manifestPath, manifest.protocol.split, true);
  const capture = manifest.protocol.qualityCapture;
  const qualityOnly = manifest.protocol.purpose === "quality-only";
  if (qualityOnly !== Boolean(capture) || (!qualityOnly && selected.qualityPolicySha256))
    throw new Error("Quality-only purpose/policy identity mismatch");
  if (qualityOnly && (selected.allowOutputDifferences || manifest.protocol.allowNondeterministicOutputs))
    throw new Error("quality-only capture requires strict output identity");
  const qualityCapture = qualityOnly ? qualityCapturePolicy(capture, {
    expectedSha256: selected.qualityPolicySha256,
    manifestSha256: manifest.corpus.manifestSha256,
    fixtures: corpus.fixtures,
    ...manifest.protocol,
    baselineCommit: manifest.sources?.baseline.commit,
    candidateCommit: manifest.sources?.candidate.commit,
  }) : undefined;
  const text = await readFile(join(selected.benchmark, "runs.jsonl"), "utf8");
  const rows = text.trim().split("\n").map((line) => JSON.parse(line));
  const allowNondeterministicOutputs = manifest.protocol.allowNondeterministicOutputs === true;
  const runIndex = validateCompletedRuns(rows, corpus.fixtures.map((fixture) => fixture.id), manifest.protocol.pairs, {
    allowNondeterministicOutputs,
    qualityCapture,
  });
  const identity = [];
  for (const fixture of corpus.fixtures) identity.push(await identityOf(fixture, runIndex, selected.benchmark, qualityOnly));
  if (qualityOnly)
    await assertQualitySavedEvidence(corpus.fixtures, runIndex, selected.benchmark, identity, manifest.protocol.pairs);
  const differing = identity.filter((entry) => !entry.identical);
  const scored = [];
  const unscored = [];
  for (const fixture of corpus.fixtures) {
    if (fixture.evaluation === "visual-only") {
      unscored.push({ fixtureId: fixture.id, reason: "No licensed ground-truth alpha annotation" });
      continue;
    }
    const truth = await truthAlpha(fixture.alphaPath);
    const variants = {};
    for (const variant of ["baseline", "candidate"]) {
      const runRow = runIndex.get(`0:${fixture.id}:${variant}`);
      if (!runRow.outputPath) throw new Error(`${fixture.id} ${variant} has no saved output`);
      const path = localPath(selected.benchmark, runRow.outputPath);
      const prediction = await predictedAlpha(path);
      if (prediction.width !== fixture.input.width || prediction.height !== fixture.input.height)
        throw new Error(`${fixture.id} ${variant} output dimensions changed`);
      if (truth.width !== prediction.width || truth.height !== prediction.height)
        throw new Error(`${fixture.id} annotation dimensions do not match output`);
      variants[variant] = {
        outputSha256: await hash(path),
        ...alphaMetrics(prediction.alpha, truth.alpha, truth.width, truth.height),
      };
    }
    scored.push({
      fixtureId: fixture.id,
      category: fixture.category,
      evaluation: fixture.evaluation,
      baseline: variants.baseline,
      candidate: variants.candidate,
      delta: {
        mae: variants.candidate.mae - variants.baseline.mae,
        mse: variants.candidate.mse - variants.baseline.mse,
        gradientMae: variants.candidate.gradientMae - variants.baseline.gradientMae,
        boundaryF1: variants.candidate.boundaryF1 - variants.baseline.boundaryF1,
      },
    });
  }
  const categories = [...new Set(scored.map((row) => row.category))].sort().map((category) => {
    const group = scored.filter((row) => row.category === category);
    return { category, fixtures: group.length, baseline: aggregate(group.map((row) => row.baseline)), candidate: aggregate(group.map((row) => row.candidate)) };
  });
  const real = scored.filter((row) => row.evaluation === "real-alpha");
  const known = scored.filter((row) => row.evaluation === "known-alpha");
  const report = {
    schemaVersion: 1,
    benchmarkManifestSha256: await hash(join(selected.benchmark, "manifest.json")),
    definitions: {
      alphaScale: "8-bit alpha normalized to [0,1]",
      mae: "mean absolute alpha error",
      mse: "mean squared alpha error",
      gradientMae: "mean absolute horizontal/vertical alpha-gradient error",
      boundaryF1: "exact one-pixel binary boundary F1 at alpha >= 0.5",
    },
    coverage: {
      realAnnotated: real.length,
      syntheticKnownAlpha: known.length,
      visualOnly: unscored.length,
      hasRealAnnotatedMetrics: real.length > 0,
      allExecutableFixturesScored: unscored.length === 0,
      note: real.length > 0
        ? "Real annotations provide metrics for the listed fixtures only; sample count, category coverage, and prespecified acceptance thresholds must be assessed before any broader quality claim. Synthetic masks remain a separate deterministic contract set."
        : "No real photographic annotations were scored, so photographic quality claims are unavailable.",
    },
    realAnnotated: { baseline: aggregate(real.map((row) => row.baseline)), candidate: aggregate(real.map((row) => row.candidate)) },
    syntheticKnownAlpha: { baseline: aggregate(known.map((row) => row.baseline)), candidate: aggregate(known.map((row) => row.candidate)) },
    identity: {
      expectation: selected.allowOutputDifferences ? "differences allowed (--allow-output-differences)" : "identical",
      compared: "pair 0 baseline vs candidate: PNG sha256, decoded RGBA sha256 and dimensions, method, actualProvider",
      fixtures: identity.length,
      identical: identity.length - differing.length,
      differing: differing.map(({ fixtureId, problems }) => ({ fixtureId, problems })),
      perFixture: identity,
    },
    outputNondeterminism: { ...outputIdentity(rows), allowed: allowNondeterministicOutputs },
    ...(qualityOnly ? { purpose: "quality-only", qualityCapture: capture,
      performance: { eligible: false, reason: "quality-only capture; no latency inference" } } : {}),
    latency: qualityOnly ? null : pairedLatency(rows),
    categories,
    fixtures: scored,
    unscored,
  };
  await writeFile(selected.output, JSON.stringify(report, null, 2));
  if (differing.length > 0 && !selected.allowOutputDifferences)
    throw new Error(
      `Baseline and candidate outputs differ for ${differing.length} of ${identity.length} fixtures: ${differing
        .map((entry) => `${entry.fixtureId} (${entry.problems.join(", ")})`)
        .join("; ")}. Report: ${selected.output}`,
    );
  process.stdout.write(
    `${JSON.stringify({ ok: true, output: selected.output, scored: scored.length, unscored: unscored.length, identical: identity.length - differing.length, differing: differing.length })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
