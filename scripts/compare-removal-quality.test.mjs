import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { alphaMetrics } from "./benchmark/quality.mjs";

test("known-alpha metrics distinguish an exact mask from an eroded edge", () => {
  const truth = Uint8Array.from([0, 0, 0, 0, 0, 64, 192, 0, 0, 255, 255, 0, 0, 0, 0, 0]);
  const exact = alphaMetrics(truth, truth, 4, 4);
  const eroded = alphaMetrics(
    Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0, 0]),
    truth,
    4,
    4,
  );
  assert.deepEqual(exact, { mae: 0, mse: 0, gradientMae: 0, boundaryF1: 1 });
  assert.ok(eroded.mae > 0);
  assert.ok(eroded.mse > 0);
  assert.ok(eroded.gradientMae > 0);
  assert.ok(eroded.boundaryF1 < 1);
});

test("quality metrics reject missing pixels instead of truncating", () => {
  assert.throws(() => alphaMetrics(Uint8Array.of(0), Uint8Array.of(0, 1), 1, 2), /pixel count/);
});

test("nonempty boundaries with no matching pixels have zero F1", () => {
  const truth = Uint8Array.of(0, 255, 0, 0, 0, 0, 0, 0);
  const predicted = Uint8Array.of(0, 0, 0, 0, 0, 0, 255, 0);
  assert.equal(alphaMetrics(predicted, truth, 8, 1).boundaryF1, 0);
});

// C51: the scorer is the in-repo parity check, so planted defects must fail it. A synthetic
// lane on disk: a three-fixture corpus of generated 4×4 RGBA PNGs (one known-alpha, one
// real-alpha, one visual-only), pair-0 outputs that equal the inputs on both sides, and rows
// carrying everything the benchmark records.
const script = join(dirname(fileURLToPath(import.meta.url)), "compare-removal-quality.mjs");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function rgba(seed) {
  const pixels = Buffer.alloc(4 * 4 * 4);
  for (let pixel = 0; pixel < 16; pixel += 1)
    pixels.set(
      [40 * seed, 15 * pixel, 255 - 12 * pixel, pixel % 5 === 0 ? 0 : 15 * pixel],
      pixel * 4,
    );
  return pixels;
}

const png = (pixels, options = {}) =>
  sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } })
    .png(options)
    .toBuffer();

async function syntheticLane(t) {
  const dir = await mkdtemp(join(tmpdir(), "cutout-quality-lane-"));
  if (!process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    t.after(() => rm(dir, { force: true, recursive: true }));
  const corpusDir = join(dir, "corpus");
  const lane = join(dir, "lane");
  await mkdir(join(corpusDir, "input"), { recursive: true });
  const fixtures = [];
  const rows = [];
  for (const [seed, [id, evaluation]] of [
    ["known-a", "known-alpha"],
    ["real-b", "real-alpha"],
    ["visual-c", "visual-only"],
  ].entries()) {
    const pixels = rgba(seed);
    const input = await png(pixels);
    await writeFile(join(corpusDir, "input", `${id}.png`), input);
    const fixture = {
      id,
      split: "smoke",
      category: "synthetic",
      evaluation,
      input: { path: `input/${id}.png`, sha256: sha256(input), width: 4, height: 4 },
      provenance: { sourceUrl: "generated:compare-removal-quality.test", license: "CC0-1.0" },
    };
    if (evaluation !== "visual-only") {
      const alpha = await sharp(
        Buffer.from(Array.from({ length: 16 }, (_, pixel) => pixels[pixel * 4 + 3])),
        {
          raw: { width: 4, height: 4, channels: 1 },
        },
      )
        .png()
        .toBuffer();
      await writeFile(join(corpusDir, "input", `${id}-alpha.png`), alpha);
      fixture.alpha = { path: `input/${id}-alpha.png`, sha256: sha256(alpha), width: 4, height: 4 };
    }
    fixtures.push(fixture);
    for (const [order, variant] of ["baseline", "candidate"].entries()) {
      const outputPath = `outputs/${variant}/${id}.png`;
      await mkdir(join(lane, "outputs", variant), { recursive: true });
      await writeFile(join(lane, outputPath), input);
      rows.push({
        pair: 0,
        order,
        variant,
        fixtureId: id,
        category: "synthetic",
        evaluation,
        status: "completed",
        completeMs: 100 + order,
        method: "model",
        requestedProvider: "wasm",
        actualProvider: "wasm",
        outputSha256: sha256(input),
        outputPath,
      });
    }
  }
  const manifestPath = join(corpusDir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, heldoutState: "locked", fixtures }),
  );
  const manifest = {
    schemaVersion: 1,
    status: "completed",
    protocol: { split: "smoke", pairs: 1 },
    corpus: { manifestPath, manifestSha256: sha256(await readFile(manifestPath)) },
  };
  await writeFile(join(lane, "manifest.json"), JSON.stringify(manifest));
  const writeRows = () =>
    writeFile(join(lane, "runs.jsonl"), rows.map((row) => JSON.stringify(row)).join("\n"));
  await writeRows();
  return {
    lane,
    manifest,
    fixtures,
    manifestPath,
    rows,
    row: (id, variant) => rows.find((row) => row.fixtureId === id && row.variant === variant),
    /** Replaces one saved output; the row's hash follows unless the artifact is to look tampered. */
    async plant(id, variant, bytes, { rehash = true } = {}) {
      await writeFile(join(lane, `outputs/${variant}/${id}.png`), bytes);
      if (rehash) this.row(id, variant).outputSha256 = sha256(bytes);
      await writeRows();
    },
    writeRows,
  };
}

function score(lane, ...extra) {
  const result = spawnSync(process.execPath, [script, "--benchmark", lane, ...extra], {
    encoding: "utf8",
  });
  if (process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    appendFileSync(
      join(lane, "scorer-invocations.jsonl"),
      `${JSON.stringify({
        command: process.execPath,
        args: [script, "--benchmark", lane, ...extra],
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
      })}\n`,
    );
  const report = (() => {
    try {
      return JSON.parse(readFileSync(join(lane, "quality.json"), "utf8"));
    } catch {
      return null;
    }
  })();
  return { ...result, report };
}

test("identical baseline and candidate outputs pass, and the report lists each fixture's identity", async (t) => {
  const { lane } = await syntheticLane(t);
  const result = score(lane);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.identity.expectation, "identical");
  assert.equal(result.report.identity.fixtures, 3);
  assert.equal(result.report.identity.identical, 3);
  assert.deepEqual(result.report.identity.differing, []);
  const visual = result.report.identity.perFixture.find((entry) => entry.fixtureId === "visual-c");
  assert.equal(visual.baseline.pngSha256, visual.candidate.pngSha256);
  assert.match(visual.baseline.rgbaSha256, /^[0-9a-f]{64}$/);
});

test("a swapped candidate cutout fails the scorer and names the fixture (planted defect)", async (t) => {
  const synthetic = await syntheticLane(t);
  // The same picture with a different alpha edge: what negctl2-wasm planted.
  const swapped = rgba(0);
  swapped[4 * 6 + 3] = 255;
  await synthetic.plant("known-a", "candidate", await png(swapped));
  const result = score(synthetic.lane);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /known-a \(PNG bytes differ, decoded RGBA differs\)/);
  // The report is still written, with the evidence.
  assert.deepEqual(result.report.identity.differing, [
    { fixtureId: "known-a", problems: ["PNG bytes differ", "decoded RGBA differs"] },
  ]);
  assert.equal(result.report.identity.identical, 2);
});

test("the same pixels in different PNG bytes still fail: the parity claim is byte identity", async (t) => {
  const synthetic = await syntheticLane(t);
  const reencoded = await png(rgba(1), { compressionLevel: 0, adaptiveFiltering: false });
  assert.notEqual(sha256(reencoded), synthetic.row("real-b", "candidate").outputSha256);
  await synthetic.plant("real-b", "candidate", reencoded);
  const result = score(synthetic.lane);
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.identity.differing, [
    { fixtureId: "real-b", problems: ["PNG bytes differ"] },
  ]);
});

test("a method or provider difference fails, visual-only fixtures included", async (t) => {
  const synthetic = await syntheticLane(t);
  Object.assign(synthetic.row("visual-c", "candidate"), {
    method: "illustration",
    actualProvider: "fallback",
  });
  await synthetic.writeRows();
  const result = score(synthetic.lane);
  assert.equal(result.status, 1);
  assert.deepEqual(result.report.identity.differing, [
    {
      fixtureId: "visual-c",
      problems: ["method model != illustration", "actualProvider wasm != fallback"],
    },
  ]);
});

test("--allow-output-differences reports the differences and exits 0", async (t) => {
  const synthetic = await syntheticLane(t);
  const swapped = rgba(2);
  swapped[3] = 255;
  await synthetic.plant("visual-c", "candidate", await png(swapped));
  const result = score(synthetic.lane, "--allow-output-differences");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.report.identity.expectation, /allowed/);
  assert.deepEqual(
    result.report.identity.differing.map((entry) => entry.fixtureId),
    ["visual-c"],
  );
});

test("a saved output that is not the bytes the page hashed is refused", async (t) => {
  const synthetic = await syntheticLane(t);
  await synthetic.plant("known-a", "baseline", await png(rgba(1)), { rehash: false });
  const result = score(synthetic.lane);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /known-a baseline saved output does not match the sha256 recorded/);
  assert.doesNotMatch(result.stderr, /pair 0 \(/);
});

async function qualitySyntheticLane(t, { pairs = 1 } = {}) {
  const lane = await syntheticLane(t);
  const policy = {
    schemaVersion: 1,
    purpose: "known-alpha-quality-capture",
    corpusManifestSha256: lane.manifest.corpus.manifestSha256,
    baselineCommit: "b".repeat(40),
    candidateCommit: "c".repeat(40),
    split: "smoke",
    mode: "auto",
    requestedProvider: "webgpu",
    expectations: [
      {
        fixtureId: "known-a",
        method: "model",
        actualProvider: "wasm",
        route: "primary-processing-then-compatibility",
      },
    ],
  };
  const json = JSON.stringify(policy),
    pin = sha256(json);
  Object.assign(lane.manifest.protocol, {
    purpose: "quality-only",
    mode: "auto",
    requestedProvider: "webgpu",
    qualityCapture: { json, sha256: pin },
  });
  lane.manifest.sources = {
    baseline: { commit: policy.baselineCommit },
    candidate: { commit: policy.candidateCommit },
  };
  for (const row of lane.rows) {
    Object.assign(row, {
      capturePurpose: "quality-only",
      qualityPolicySha256: pin,
      removalMode: "auto",
      requestedProvider: "webgpu",
      actualProvider: row.fixtureId === "known-a" ? "wasm" : "webgpu",
      commit: policy[`${row.variant}Commit`],
    });
    if (row.fixtureId === "known-a")
      row.routeEvidence = {
        source: "worker-messages-v1",
        primaryExecutedProvider: null,
        gpu: { available: true },
        jobs: [
          {
            jobId: 1,
            workerUrl: "http://localhost/assets/removal-worker.js",
            fileName: "known-a.png",
            mode: "auto",
            noWebgpu: false,
            progress: [
              { stage: "cutting", message: "Finding subject" },
              { stage: "loading", message: "Switching to compatibility mode" },
              { stage: "cutting", message: "Finding subject" },
            ],
            outcome: { type: "done", method: "model", provider: "wasm", workerHadGpu: true },
          },
        ],
      };
  }
  if (pairs > 1) {
    lane.manifest.protocol.pairs = pairs;
    const extras = [];
    for (const row of lane.rows) {
      for (let pair = 1; pair < pairs; pair += 1) {
        const outputPath = `outputs/${row.variant}/pair-${pair}/${row.fixtureId}.png`;
        await mkdir(join(lane.lane, dirname(outputPath)), { recursive: true });
        await writeFile(
          join(lane.lane, outputPath),
          await readFile(join(lane.lane, row.outputPath)),
        );
        extras.push({
          ...row,
          pair,
          order:
            pair % 2 === 0
              ? row.variant === "baseline"
                ? 0
                : 1
              : row.variant === "candidate"
                ? 0
                : 1,
          outputPath,
          completeMs: row.completeMs + pair,
        });
      }
    }
    lane.rows.push(...extras);
  }
  const writeManifest = () =>
    writeFile(join(lane.lane, "manifest.json"), JSON.stringify(lane.manifest));
  await writeManifest();
  await lane.writeRows();
  return {
    ...lane,
    pin,
    writeManifest,
    pairRow: (id, variant, pair) =>
      lane.rows.find((row) => row.fixtureId === id && row.variant === variant && row.pair === pair),
  };
}

test("quality-only scoring requires the external pin, preserves exact identity and publishes no latency", async (t) => {
  const lane = await qualitySyntheticLane(t);
  const pass = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(pass.report.latency, null);
  assert.equal(pass.report.performance.eligible, false);
  assert.equal(pass.report.identity.identical, 3);
  for (const args of [
    [],
    ["--quality-policy-sha256", "d".repeat(64)],
    ["--quality-policy-sha256", lane.pin, "--allow-output-differences"],
  ])
    assert.equal(score(lane.lane, ...args).status, 1);
  lane.manifest.protocol.allowNondeterministicOutputs = true;
  await lane.writeManifest();
  assert.equal(score(lane.lane, "--quality-policy-sha256", lane.pin).status, 1);
});

test("quality-only scoring retains nonzero PNG/RGBA mismatch exits and named independent output evidence", async (t) => {
  for (const samePixels of [false, true]) {
    const lane = await qualitySyntheticLane(t);
    const pixels = rgba(0);
    if (!samePixels) pixels[7] = 255;
    await lane.plant("known-a", "candidate", await png(pixels, { compressionLevel: 0 }));
    const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /known-a.*PNG bytes differ/);
    assert.deepEqual(result.report.identity.differing, [
      {
        fixtureId: "known-a",
        problems: samePixels ? ["PNG bytes differ"] : ["PNG bytes differ", "decoded RGBA differs"],
      },
    ]);
  }
});

test("quality-only scoring rejects tampered policy/corpus/mode/route and method/provider identities", async (t) => {
  for (const change of [
    (l) => (l.manifest.protocol.qualityCapture.json += " "),
    (l) => (l.manifest.protocol.mode = "maximum"),
    (l) => (l.manifest.corpus.manifestSha256 = "d".repeat(64)),
    (l) => (l.row("known-a", "baseline").method = "illustration"),
    (l) => (l.row("known-a", "candidate").actualProvider = "webgpu"),
    (l) => (l.row("known-a", "baseline").routeEvidence.jobs[0].progress = []),
    (l) => delete l.manifest.protocol.qualityCapture,
    (l) => delete l.manifest.protocol.purpose,
  ]) {
    const lane = await qualitySyntheticLane(t);
    change(lane);
    await lane.writeManifest();
    await lane.writeRows();
    const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
    assert.equal(result.status, 1, result.stdout);
    if (result.stderr.includes("primary/compat") || result.stderr.includes("declared method"))
      assert.match(result.stderr, /known-a (baseline|candidate) pair 0/);
  }
});

test("scorer refuses non-PNG files and shared or linked outputs even when row hashes match", async (t) => {
  const { link, symlink } = await import("node:fs/promises");
  for (const kind of ["jpeg", "hardlink", "symlink"]) {
    const lane = await syntheticLane(t);
    const baseline = join(lane.lane, "outputs/baseline/known-a.png"),
      candidate = join(lane.lane, "outputs/candidate/known-a.png");
    if (kind === "jpeg")
      await lane.plant(
        "known-a",
        "candidate",
        await sharp(rgba(0), { raw: { width: 4, height: 4, channels: 4 } })
          .jpeg()
          .toBuffer(),
      );
    else {
      await rm(candidate);
      await (kind === "hardlink" ? link : symlink)(baseline, candidate);
    }
    const result = score(lane.lane);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a PNG|independent regular PNG/);
  }
});

test("default scoring does not require later-pair files", async (t) => {
  const lane = await syntheticLane(t);
  lane.manifest.protocol.pairs = 2;
  lane.rows.push(
    ...lane.rows
      .filter((row) => row.pair === 0)
      .map((row) => ({
        ...row,
        pair: 1,
        order: row.variant === "candidate" ? 0 : 1,
        outputPath: null,
        completeMs: row.completeMs + 3,
      })),
  );
  await writeFile(join(lane.lane, "manifest.json"), JSON.stringify(lane.manifest));
  await lane.writeRows();
  const result = score(lane.lane);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.identity.identical, 3);
});

test("quality-only scoring of independent later-pair files with identical bytes still succeeds", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.identity.identical, 3);
  assert.equal(result.report.latency, null);
  assert.equal(result.report.performance.eligible, false);
});

test("quality-only pair-0 corruption still fails when later pairs are intact", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  await lane.plant("known-a", "candidate", await png(rgba(2)), { rehash: false });
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /known-a candidate pair 0 \(outputs\/candidate\/known-a\.png\)/);
  assert.match(result.stderr, /saved output does not match the sha256 recorded/);
});

test("quality-only scoring rejects later-pair deletion, tamper, symlink, hardlink and reused files", async (t) => {
  const { link, symlink } = await import("node:fs/promises");
  for (const kind of [
    "missing",
    "tamper",
    "dimensions",
    "symlink",
    "hardlink",
    "reuse-path",
    "reuse-pair0",
  ]) {
    const lane = await qualitySyntheticLane(t, { pairs: 2 });
    const row = lane.pairRow("known-a", "candidate", 1);
    const dest = join(lane.lane, row.outputPath);
    const baselinePair1 = lane.pairRow("known-a", "baseline", 1);
    if (kind === "missing") await rm(dest);
    else if (kind === "tamper") await writeFile(dest, "not a PNG\n");
    else if (kind === "dimensions") {
      const small = await sharp(Buffer.alloc(2 * 2 * 4, 255), {
        raw: { width: 2, height: 2, channels: 4 },
      })
        .png()
        .toBuffer();
      await writeFile(dest, small);
    } else if (kind === "symlink") {
      await rm(dest);
      await symlink(join(lane.lane, "../corpus/input/known-a.png"), dest);
    } else if (kind === "hardlink") {
      await rm(dest);
      await link(join(lane.lane, baselinePair1.outputPath), dest);
    } else if (kind === "reuse-path") {
      row.outputPath = baselinePair1.outputPath;
      await lane.writeRows();
    } else {
      row.outputPath = lane.row("known-a", "candidate").outputPath;
      await lane.writeRows();
    }
    const waived = score(
      lane.lane,
      "--quality-policy-sha256",
      lane.pin,
      "--allow-output-differences",
    );
    const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
    assert.equal(result.status, 1, `${kind} accepted: ${result.stdout} ${result.stderr}`);
    assert.equal(waived.status, 1, `${kind} waived: ${waived.stdout} ${waived.stderr}`);
    assert.match(result.stderr, /known-a \S+ pair 1 \(outputs\/[^)]+known-a\.png\)/);
    if (kind === "missing") assert.match(result.stderr, /missing/);
    else if (kind === "tamper") assert.match(result.stderr, /not a PNG/);
    else if (kind === "dimensions")
      assert.match(result.stderr, /saved output does not match the sha256 recorded/);
    else if (kind === "symlink")
      assert.match(result.stderr, /symlink|independent regular PNG|outside benchmark/);
    else if (kind === "hardlink") assert.match(result.stderr, /independent regular PNG/);
    else assert.match(result.stderr, /reuses .+ canonical file/);
  }
});

test("quality-only later lexical traversal retains fixture variant pair and path", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  lane.pairRow("known-a", "candidate", 1).outputPath = "../../outside/known-a.png";
  await lane.writeRows();
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a candidate pair 1 \(\.\.\/\.\.\/outside\/known-a\.png\)/);
  assert.match(result.stderr, /escapes benchmark/);
});

test("quality-only pair-0 corrupt decode retains fixture variant pair and path", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  await writeFile(join(lane.lane, lane.row("known-a", "candidate").outputPath), "not a PNG\n");
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a candidate pair 0 \(outputs\/candidate\/known-a\.png\)/);
  assert.match(result.stderr, /unsupported image format|not a PNG/);
});

test("quality-only pair-0 missing file retains fixture variant pair and path", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  await rm(join(lane.lane, lane.row("known-a", "candidate").outputPath));
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a candidate pair 0 \(outputs\/candidate\/known-a\.png\)/);
  assert.match(result.stderr, /ENOENT|no such file|saved output is missing/);
});

test("default pair-0 decode still fails without quality-only row context", async (t) => {
  const lane = await syntheticLane(t);
  await writeFile(join(lane.lane, "outputs/candidate/known-a.png"), "not a PNG\n");
  const result = score(lane.lane);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported image format|not a PNG|independent regular PNG/);
  assert.doesNotMatch(result.stderr, /pair 0 \(/);
});

test("quality-only pair-0 missing saved path retains fixture variant pair", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  lane.row("known-a", "candidate").outputPath = null;
  await lane.writeRows();
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a candidate pair 0 \(null\)/);
  assert.match(result.stderr, /has no saved output/);
});

test("quality-only pair-0 partner-file reuse retains fixture variant pair and paths", async (t) => {
  const lane = await qualitySyntheticLane(t, { pairs: 2 });
  lane.row("known-a", "candidate").outputPath = lane.row("known-a", "baseline").outputPath;
  await lane.writeRows();
  const result = score(lane.lane, "--quality-policy-sha256", lane.pin);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a candidate pair 0 \(outputs\/baseline\/known-a\.png\)/);
  assert.match(result.stderr, /known-a baseline pair 0 \(outputs\/baseline\/known-a\.png\)/);
  assert.match(result.stderr, /independent regular PNG files/);
});

test("default pair-0 shared output still fails without quality-only row context", async (t) => {
  const lane = await syntheticLane(t);
  lane.row("known-a", "candidate").outputPath = lane.row("known-a", "baseline").outputPath;
  await lane.writeRows();
  const result = score(lane.lane);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /known-a outputs must be independent regular PNG files/);
  assert.doesNotMatch(result.stderr, /pair 0 \(/);
});
