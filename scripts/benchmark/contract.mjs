import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import sharp from "sharp";
import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/);
const fileSchema = z.object({
  path: z.string().min(1),
  sha256,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const fixtureSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  split: z.enum(["smoke", "tune", "heldout"]),
  category: z.string().min(1),
  evaluation: z.enum(["real-alpha", "known-alpha", "visual-only"]),
  input: fileSchema,
  alpha: fileSchema.optional(),
  provenance: z.object({
    sourceUrl: z.string().min(1),
    license: z.string().min(1),
    sourceId: z.string().min(1).optional(),
    annotationSourceId: z.string().min(1).optional(),
    note: z.string().min(1).optional(),
  }),
});
const corpusSchema = z.object({
  schemaVersion: z.literal(1),
  heldoutState: z.enum(["locked", "released"]),
  datasets: z.array(z.object({ name: z.string().min(1) }).passthrough()).optional(),
  excludedFixtures: z.array(fixtureSchema).optional(),
  fixtures: z.array(fixtureSchema).min(1),
});
const versionSchema = z.object({ version: z.string().min(1), commit: commitSha });

/** "photo-b candidate pair 0", "baseline (version check)": where in a lane a contract broke. */
function runLabel({ fixtureId, variant, pair, phase }) {
  return [
    fixtureId,
    variant,
    pair === undefined ? undefined : `pair ${pair}`,
    phase && `(${phase})`,
  ]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join(" ");
}

/**
 * A broken benchmark contract. Raised inside a lane, it names the run (fixture, variant, pair,
 * and the phase when it is not a measured run) and keeps the offending row, so the lane's
 * failure.json says which run broke the contract and with what (S3-B-EVIDENCE-04).
 */
export class BenchmarkContractError extends Error {
  constructor(message, run = undefined, row = undefined) {
    super(message);
    this.name = "BenchmarkContractError";
    if (run) inRun(this, run, row);
  }
}

/**
 * Records the run an error happened in, once (the innermost caller knows it best). A contract
 * error also says it in its message; any other error (a browser timeout) keeps its message.
 */
export function inRun(error, run, row = undefined) {
  if (!error || typeof error !== "object" || error.run) return error;
  error.run = Object.fromEntries(
    Object.entries(run).filter(([, value]) => value !== undefined && value !== null),
  );
  if (row !== undefined) error.row = row;
  if (error instanceof BenchmarkContractError) error.message = `${runLabel(run)}: ${error.message}`;
  return error;
}

const runOf = (row) => ({ fixtureId: row.fixtureId, variant: row.variant, pair: row.pair });

async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function fixturePath(root, path) {
  const full = resolve(root, path);
  const local = relative(root, full);
  if (local.startsWith("..") || resolve(root, local) !== full)
    throw new BenchmarkContractError(`Fixture path escapes corpus directory: ${path}`);
  return full;
}

async function verifyFile(root, record, label) {
  const path = fixturePath(root, record.path);
  const actual = await digest(path);
  if (actual !== record.sha256)
    throw new BenchmarkContractError(`${label} SHA-256 ${actual} does not match ${record.sha256}`);
  return path;
}

export async function loadCorpus(manifestPath, split, heldoutReleased = false) {
  const parsed = corpusSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  if (split === "heldout" && parsed.heldoutState !== "released" && !heldoutReleased)
    throw new BenchmarkContractError(
      "Held-out corpus is locked until an implementation lock is supplied",
    );
  const root = dirname(resolve(manifestPath));
  const selected = parsed.fixtures.filter((fixture) => fixture.split === split);
  if (selected.length === 0) throw new BenchmarkContractError(`Corpus has no ${split} fixtures`);
  const ids = new Set();
  const fixtures = [];
  for (const fixture of selected) {
    if (ids.has(fixture.id))
      throw new BenchmarkContractError(`Duplicate fixture id: ${fixture.id}`);
    ids.add(fixture.id);
    if (fixture.evaluation !== "visual-only" && !fixture.alpha)
      throw new BenchmarkContractError(`${fixture.id} has no alpha annotation`);
    const inputPath = await verifyFile(root, fixture.input, `${fixture.id} input`);
    const metadata = await sharp(inputPath).metadata();
    if (metadata.width !== fixture.input.width || metadata.height !== fixture.input.height)
      throw new BenchmarkContractError(`${fixture.id} dimensions do not match manifest`);
    const alphaPath = fixture.alpha
      ? await verifyFile(root, fixture.alpha, `${fixture.id} alpha`)
      : undefined;
    if (alphaPath) {
      const alphaMetadata = await sharp(alphaPath).metadata();
      if (
        alphaMetadata.width !== fixture.alpha.width ||
        alphaMetadata.height !== fixture.alpha.height
      )
        throw new BenchmarkContractError(`${fixture.id} alpha dimensions do not match manifest`);
      if (alphaMetadata.width !== metadata.width || alphaMetadata.height !== metadata.height)
        throw new BenchmarkContractError(`${fixture.id} alpha dimensions do not match input`);
    }
    fixtures.push({ ...fixture, inputPath, alphaPath });
  }
  return { ...parsed, manifestPath: resolve(manifestPath), fixtures };
}

export async function verifyBuild(url, expectedCommit, timeoutMs, signal) {
  commitSha.parse(expectedCommit);
  let response;
  try {
    const requestSignal = signal
      ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
      : AbortSignal.timeout(timeoutMs);
    response = await fetch(new URL("version.json", url), { signal: requestSignal });
  } catch (error) {
    throw new BenchmarkContractError(`Could not read version.json from ${url}: ${String(error)}`);
  }
  if (!response.ok)
    throw new BenchmarkContractError(`version.json returned HTTP ${response.status}`);
  const version = versionSchema.parse(await response.json());
  if (version.commit !== expectedCommit)
    throw new BenchmarkContractError(
      `Build reported ${version.commit}; expected commit ${expectedCommit}`,
    );
  return version;
}

export function assertProvider(requested, actual, run = undefined, row = undefined) {
  if (requested !== actual)
    throw new BenchmarkContractError(
      `Run requested ${requested} but production reported ${actual}`,
      run,
      row,
    );
}

// A quality policy is separately pinned by the operator, then re-bound to the actual corpus
// and lane by both capture and scoring. A row (or a copied JSON policy) cannot authorize itself.
const qualityPolicies = new WeakSet();
const legacyBaselineCommit = "5522eee10d0b974531b8f9c07dd4798625dfeea0";
const qualityPolicySchema = z
  .object({
    schemaVersion: z.literal(1),
    purpose: z.literal("known-alpha-quality-capture"),
    corpusManifestSha256: sha256,
    baselineCommit: commitSha,
    candidateCommit: commitSha,
    split: z.enum(["smoke", "tune", "heldout"]),
    mode: z.enum(["quick", "auto", "maximum"]),
    requestedProvider: z.literal("webgpu"),
    expectations: z
      .array(
        z
          .object({
            fixtureId: z.string().min(1),
            method: z.literal("model"),
            actualProvider: z.literal("wasm"),
            route: z.literal("primary-processing-then-compatibility"),
            // Only this original wrapper can hide compatibility progress behind its monotonic guard.
            // Selection/lane/source authorization still comes from the external policy SHA pin.
            baselineObservability: z
              .object({
                commit: z.literal(legacyBaselineCommit),
                route: z.literal("primary-switch-result-v1"),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function qualityCapturePolicy(record, binding) {
  const bad = (message) => {
    throw new BenchmarkContractError(`Invalid quality policy: ${message}`);
  };
  if (
    !record ||
    typeof record.json !== "string" ||
    !sha256.safeParse(binding.expectedSha256).success ||
    record.sha256 !== binding.expectedSha256 ||
    createHash("sha256").update(record.json).digest("hex") !== binding.expectedSha256
  )
    bad("missing or mismatched policy SHA-256");
  const policy = qualityPolicySchema.parse(JSON.parse(record.json));
  for (const key of ["split", "mode", "requestedProvider", "baselineCommit", "candidateCommit"])
    if (policy[key] !== binding[key]) bad(`${key} does not match lane`);
  if (policy.corpusManifestSha256 !== binding.manifestSha256)
    bad("corpus manifest does not match lane");
  const seen = new Set();
  for (const entry of policy.expectations) {
    const fixture = binding.fixtures.find((fixture) => fixture.id === entry.fixtureId);
    if (!fixture || fixture.evaluation !== "known-alpha")
      bad(`${entry.fixtureId} is not a selected known-alpha fixture`);
    if (seen.has(entry.fixtureId)) bad(`duplicate expectation ${entry.fixtureId}`);
    if (entry.baselineObservability && policy.baselineCommit !== legacyBaselineCommit)
      bad("baseline observability declaration does not match the original source commit");
    seen.add(entry.fixtureId);
  }
  // Copy the only corpus fields needed below; callers cannot change authorization later.
  const context = Object.freeze({
    sha256: record.sha256,
    policy: Object.freeze({
      ...policy,
      expectations: Object.freeze(
        policy.expectations.map((entry) =>
          Object.freeze({
            ...entry,
            ...(entry.baselineObservability
              ? { baselineObservability: Object.freeze(entry.baselineObservability) }
              : {}),
          }),
        ),
      ),
    }),
    fixtures: Object.freeze(
      binding.fixtures.map(({ id, evaluation, input }) =>
        Object.freeze({ id, evaluation, fileName: input.path.split("/").at(-1) }),
      ),
    ),
  });
  qualityPolicies.add(context);
  return context;
}

function checkQualityRow(row, run, context) {
  const bad = (message) => {
    throw new BenchmarkContractError(message, run, row);
  };
  if (!qualityPolicies.has(context)) bad("unverified quality capture context");
  const { policy } = context;
  // Live measured runs and warmups must be as source-bound as stored/scored rows.
  // In particular, a candidate row cannot claim baseline observability through run metadata.
  if (
    (row.variant !== "baseline" && row.variant !== "candidate") ||
    (run?.variant !== undefined && run.variant !== row.variant)
  )
    bad("quality-only row/run variant does not match");
  if (run?.fixtureId !== undefined && run.fixtureId !== row.fixtureId)
    bad("quality-only row/run fixture identity does not match");
  if (
    row.commit !== policy[`${row.variant}Commit`] ||
    (run?.commit !== undefined && run.commit !== row.commit)
  )
    bad("quality-only row source commit does not match policy");
  const fixture = context.fixtures.find((fixture) => fixture.id === row.fixtureId);
  if (row.capturePurpose !== "quality-only" || row.qualityPolicySha256 !== context.sha256)
    bad("quality-only row is missing its policy identity");
  if (
    !fixture ||
    fixture.evaluation !== row.evaluation ||
    row.removalMode !== policy.mode ||
    row.requestedProvider !== policy.requestedProvider
  )
    bad("quality-only row does not match its corpus/lane identity");
  const expectation = policy.expectations.find((entry) => entry.fixtureId === row.fixtureId);
  if (!expectation) {
    if (row.method === "model") assertProvider(row.requestedProvider, row.actualProvider, run, row);
    return;
  }
  if (row.method !== expectation.method || row.actualProvider !== expectation.actualProvider)
    bad("quality-only row does not match the declared method/provider path");
  const evidence = row.routeEvidence;
  const job = evidence?.jobs?.[0];
  const progress = job?.progress;
  const switches = Array.isArray(progress)
    ? progress.flatMap((event, index) =>
        event?.stage === "loading" && event.message === "Switching to compatibility mode"
          ? [index]
          : [],
      )
    : [];
  const cutting = (event) => event?.stage === "cutting" && event.message === "Finding subject";
  const compatibilityObserved =
    switches.length === 1 && progress.slice(switches[0] + 1).some(cutting);
  const legacy =
    row.variant === "baseline" &&
    row.commit === legacyBaselineCommit &&
    expectation.baselineObservability;
  if (
    (legacy || evidence?.compatibilityProcessing !== undefined) &&
    evidence?.compatibilityProcessing !== (compatibilityObserved ? "observed" : "not-observed")
  )
    bad("compatibility processing visibility does not match worker observations");
  if (
    evidence?.source !== "worker-messages-v1" ||
    evidence.primaryExecutedProvider !== null ||
    evidence.gpu?.available !== true ||
    !Array.isArray(evidence.jobs) ||
    evidence.jobs.length !== 1 ||
    !Number.isInteger(job?.jobId) ||
    typeof job.workerUrl !== "string" ||
    !job.workerUrl ||
    job.fileName !== fixture.fileName ||
    job.mode !== policy.mode ||
    job.noWebgpu !== false ||
    job.outcome?.type !== "done" ||
    job.outcome.method !== row.method ||
    job.outcome.provider !== row.actualProvider ||
    job.outcome.workerHadGpu !== true ||
    switches.length !== 1 ||
    !progress.slice(0, switches[0]).some(cutting) ||
    (!legacy && !compatibilityObserved)
  )
    bad("missing or mismatched primary/compat route evidence (worker messages)");
}

/**
 * Every run names its method and the provider that actually ran it, and a model run must have
 * run on the requested provider. Non-model runs (illustration, logo, flood, passthrough, or a
 * graphic recovered after a model failure) report "fallback": they stay valid parity and
 * quality evidence but never count as the requested provider's latency (pairedLatency).
 * Only a separately verified quality policy can authorize its declared compatibility path;
 * every quality row is marked and refused by the unchanged performance/statistics path.
 */
export function checkRunRow(row, run = runOf(row), qualityCapture = undefined) {
  if (typeof row.method !== "string" || !row.method)
    throw new BenchmarkContractError("no method recorded", run, row);
  if (typeof row.actualProvider !== "string" || !row.actualProvider)
    throw new BenchmarkContractError("no actualProvider recorded", run, row);
  if (qualityCapture !== undefined) return checkQualityRow(row, run, qualityCapture);
  if (row.capturePurpose !== undefined || row.qualityPolicySha256 !== undefined)
    throw new BenchmarkContractError(
      "quality-only capture cannot be used as performance evidence",
      run,
      row,
    );
  if (row.method === "model") assertProvider(row.requestedProvider, row.actualProvider, run, row);
}

/**
 * Pair 0's output hash is each fixture and variant's reference: a later run whose result blob
 * hashes differently returned other bytes for the same input, which a latency median would
 * otherwise absorb unseen (C55).
 */
export function outputIdentity(rows) {
  const reference = new Map();
  for (const row of rows)
    if (row.pair === 0) reference.set(`${row.fixtureId}:${row.variant}`, row.outputSha256);
  const nondeterministic = [];
  for (const row of rows) {
    const expected = reference.get(`${row.fixtureId}:${row.variant}`);
    if (row.pair !== 0 && expected !== undefined && row.outputSha256 !== expected)
      nondeterministic.push({
        fixtureId: row.fixtureId,
        variant: row.variant,
        pair: row.pair,
        outputSha256: row.outputSha256,
        pair0OutputSha256: expected,
      });
  }
  return { rows: rows.length, references: reference.size, nondeterministic };
}

export function nondeterministicOutputError(entry, row) {
  return new BenchmarkContractError(
    `output sha256 ${entry.outputSha256} differs from pair 0's ${entry.pair0OutputSha256} (a lane run with --allow-nondeterministic-outputs records this instead)`,
    { fixtureId: entry.fixtureId, variant: entry.variant, pair: entry.pair },
    row,
  );
}

export function validateCompletedRuns(
  rows,
  fixtureIds,
  pairs,
  { allowNondeterministicOutputs = false, qualityCapture } = {},
) {
  if (qualityCapture !== undefined && allowNondeterministicOutputs)
    throw new BenchmarkContractError("quality-only capture requires strict output identity");
  const index = new Map();
  for (const row of rows) {
    const broken = (message) => new BenchmarkContractError(message, runOf(row), row);
    if (!Number.isInteger(row.pair) || !Number.isInteger(row.order))
      throw broken("run pair/order must be integers");
    if (row.pair < 0 || row.pair >= pairs)
      throw broken(`run pair ${row.pair} is outside 0..${pairs - 1}`);
    if (row.order !== 0 && row.order !== 1) throw broken(`run order ${row.order} must be 0 or 1`);
    if (!fixtureIds.includes(row.fixtureId))
      throw broken(`unexpected fixture ${String(row.fixtureId)}`);
    if (row.variant !== "baseline" && row.variant !== "candidate")
      throw broken(`invalid variant ${String(row.variant)}`);
    if (row.status !== "completed")
      throw broken(`run status ${String(row.status)} is not completed`);
    checkRunRow(row, runOf(row), qualityCapture);
    if (qualityCapture && row.commit !== qualityCapture.policy[`${row.variant}Commit`])
      throw broken("quality-only row source commit does not match policy");
    if (!Number.isFinite(row.completeMs) || row.completeMs <= 0) throw broken("invalid completeMs");
    if (typeof row.outputSha256 !== "string" || !/^[0-9a-f]{64}$/.test(row.outputSha256))
      throw broken("no outputSha256 recorded");
    const expectedOrder =
      row.pair % 2 === 0
        ? row.variant === "baseline"
          ? 0
          : 1
        : row.variant === "candidate"
          ? 0
          : 1;
    if (row.order !== expectedOrder)
      throw broken(`pair ${row.pair} does not alternate baseline/candidate order`);
    const key = `${row.pair}:${row.fixtureId}:${row.variant}`;
    if (index.has(key)) throw broken("duplicate run");
    index.set(key, row);
  }
  for (let pair = 0; pair < pairs; pair += 1) {
    for (const fixtureId of fixtureIds) {
      for (const variant of ["baseline", "candidate"])
        if (!index.has(`${pair}:${fixtureId}:${variant}`))
          throw new BenchmarkContractError(`missing ${variant} run`, { fixtureId, variant, pair });
    }
  }
  if (qualityCapture) {
    for (let pair = 0; pair < pairs; pair += 1)
      for (const fixtureId of fixtureIds) {
        const baseline = index.get(`${pair}:${fixtureId}:baseline`);
        const candidate = index.get(`${pair}:${fixtureId}:candidate`);
        if (
          baseline.method !== candidate.method ||
          baseline.actualProvider !== candidate.actualProvider
        )
          throw new BenchmarkContractError(
            "quality-only baseline/candidate method/provider differ",
            runOf(candidate),
            candidate,
          );
      }
  }
  const [changed] = outputIdentity(rows).nondeterministic;
  if (changed && !allowNondeterministicOutputs)
    throw nondeterministicOutputError(
      changed,
      index.get(`${changed.pair}:${changed.fixtureId}:${changed.variant}`),
    );
  return index;
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function interval(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return {
    low: ordered[Math.floor((ordered.length - 1) * 0.025)],
    high: ordered[Math.ceil((ordered.length - 1) * 0.975)],
  };
}

/** The registered gate quantity: change in median completeMs (candidate/baseline, baseline − candidate). */
function medians(values) {
  const baselineMedianMs = median(values.map((value) => value.baseline));
  const candidateMedianMs = median(values.map((value) => value.candidate));
  const empty = values.length === 0;
  return {
    baselineMedianMs,
    candidateMedianMs,
    ratioOfMedians: empty ? null : candidateMedianMs / baselineMedianMs,
    differenceOfMediansMs: empty ? null : baselineMedianMs - candidateMedianMs,
  };
}

/**
 * One group's latency (the cohort or a category). The bootstrap resamples whole AB/BA pair
 * blocks: the gate quantity is recomputed from the pooled rows of the resampled blocks, the
 * paired statistic from their block medians. An interval is null with a reason, never a
 * zero-width "95 %" interval, when no resampling can vary it (fewer than 2 blocks, or every
 * block giving the same input: identical rows for the gate, an identical block median for the
 * paired statistic) or when its bounds coincide anyway. Blocks whose own medians agree can
 * still pool to different medians, so the gate is judged by its rows, not by block summaries.
 */
function summarize(values, iterations, seed) {
  const blocks = [...new Set(values.map((value) => value.pair))].map((pair) => {
    const block = values.filter((value) => value.pair === pair);
    return {
      values: block,
      rows: JSON.stringify(
        block.map((value) => [value.fixtureId, value.baseline, value.candidate]).sort(),
      ),
      difference: median(block.map((value) => value.difference)),
      ratio: median(block.map((value) => value.ratio)),
    };
  });
  const rng = random(seed);
  const boot = { ratioOfMedians: [], differenceOfMediansMs: [], ratio: [], difference: [] };
  for (let iteration = 0; blocks.length > 1 && iteration < iterations; iteration += 1) {
    const sample = Array.from(
      { length: blocks.length },
      () => blocks[Math.floor(rng() * blocks.length)],
    );
    boot.ratio.push(median(sample.map((value) => value.ratio)));
    boot.difference.push(median(sample.map((value) => value.difference)));
    const pooled = medians(sample.flatMap((block) => block.values));
    boot.ratioOfMedians.push(pooled.ratioOfMedians);
    boot.differenceOfMediansMs.push(pooled.differenceOfMediansMs);
  }
  const intervalsUnavailable = {};
  const confidence = (field, bootstrap, blockInput, label) => {
    let reason = null;
    if (blocks.length < 2)
      reason = `${blocks.length} paired block(s); an interval needs at least 2`;
    else if (new Set(blocks.map(blockInput)).size < 2)
      reason = `every block has the same ${label}, so resampling blocks cannot vary it`;
    const bounds = interval(bootstrap);
    if (reason === null && bounds.low === bounds.high)
      reason =
        "the 2.5% and 97.5% bootstrap bounds coincide, so the interval would have zero width";
    if (reason === null) return bounds;
    intervalsUnavailable[field] = reason;
    return null;
  };
  return {
    pairs: blocks.length,
    observations: values.length,
    ...medians(values),
    ratioOfMediansConfidence95: confidence(
      "ratioOfMediansConfidence95",
      boot.ratioOfMedians,
      (block) => block.rows,
      "rows",
    ),
    differenceOfMediansConfidence95: confidence(
      "differenceOfMediansConfidence95",
      boot.differenceOfMediansMs,
      (block) => block.rows,
      "rows",
    ),
    pairedMedianRatio: median(blocks.map((value) => value.ratio)),
    pairedMedianDifferenceMs: median(blocks.map((value) => value.difference)),
    pairedRatioConfidence95: confidence(
      "pairedRatioConfidence95",
      boot.ratio,
      (block) => block.ratio,
      "paired median ratio",
    ),
    pairedDifferenceConfidence95: confidence(
      "pairedDifferenceConfidence95",
      boot.difference,
      (block) => block.difference,
      "paired median difference",
    ),
    intervalsUnavailable,
  };
}

function counts(rows, key) {
  const result = {};
  for (const row of rows) result[row[key]] = (result[row[key]] ?? 0) + 1;
  return result;
}

export function pairedLatency(rows, iterations = 10_000, seed = 730_241) {
  const observations = new Map();
  for (const row of rows) {
    checkRunRow(row);
    const key = `${row.pair}:${row.fixtureId}`;
    const pair = observations.get(key) ?? {
      pair: row.pair,
      fixtureId: row.fixtureId,
      category: row.category ?? "uncategorized",
      rows: [],
    };
    pair[row.variant] = row.completeMs;
    pair.rows.push(row);
    observations.set(key, pair);
  }
  // A lane measures model time on the requested provider. A non-model run (illustration,
  // passthrough, a graphic recovered after a model failure) takes a different code path, so
  // its whole observation is left out, partner included, and counted with its reason.
  const included = [];
  const excluded = [];
  const byReason = {};
  for (const observation of observations.values()) {
    if (observation.rows.every((row) => row.method === "model")) {
      included.push(observation);
      continue;
    }
    excluded.push(observation);
    for (const row of observation.rows) {
      const reason =
        row.method === "model" ? "paired with a non-model run" : `non-model method: ${row.method}`;
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
  }
  const excludedRows = excluded.reduce((sum, observation) => sum + observation.rows.length, 0);
  const exclusions = {
    inputRows: rows.length,
    includedRows: rows.length - excludedRows,
    excludedRows,
    excludedObservations: excluded.length,
    byReason,
    fixtureIds: [...new Set(excluded.map((observation) => observation.fixtureId))].sort(),
  };
  const coverage = Object.fromEntries(
    ["baseline", "candidate"].map((variant) => {
      const variantRows = rows.filter((row) => row.variant === variant);
      return [
        variant,
        {
          rows: variantRows.length,
          methods: counts(variantRows, "method"),
          actualProviders: counts(variantRows, "actualProvider"),
        },
      ];
    }),
  );
  const values = included.map(({ pair, fixtureId, category, baseline, candidate }) => ({
    pair,
    fixtureId,
    category,
    baseline,
    candidate,
    difference: baseline - candidate,
    ratio: candidate / baseline,
  }));
  const byFixture = [...new Set(values.map((value) => value.fixtureId))].sort().map((fixtureId) => {
    const fixture = values.filter((value) => value.fixtureId === fixtureId);
    return {
      fixtureId,
      pairs: fixture.length,
      ...medians(fixture),
      pairedMedianRatio: median(fixture.map((value) => value.ratio)),
      pairedMedianDifferenceMs: median(fixture.map((value) => value.difference)),
    };
  });
  const byCategory = [...new Set(values.map((value) => value.category))]
    .sort()
    .map((category, index) => ({
      category,
      ...summarize(
        values.filter((value) => value.category === category),
        iterations,
        seed + index + 1,
      ),
    }));
  const worstCohort =
    [...byCategory].sort((left, right) => right.ratioOfMedians - left.ratioOfMedians)[0] ?? null;
  return {
    definitions: {
      rows: "model runs only: an observation (pair, fixture) counts when both variants ran the model on the requested provider; the rest are counted in exclusions",
      ratioOfMedians:
        "median candidate completeMs / median baseline completeMs: the registered gate quantity (< 1 is faster)",
      differenceOfMediansMs:
        "median baseline completeMs - median candidate completeMs (> 0 is faster)",
      pairedMedianRatio:
        "median over AB/BA blocks of each block's median candidate/baseline ratio (descriptive; can disagree with the gate in sign)",
      pairedMedianDifferenceMs:
        "median over AB/BA blocks of each block's median baseline - candidate difference (descriptive)",
      intervals:
        "95% percentile bootstrap resampling whole AB/BA blocks; null (reason in intervalsUnavailable) when fewer than 2 blocks, every block gives the same input, or the bounds coincide",
    },
    ...summarize(values, iterations, seed),
    bootstrap: { iterations, seed, unit: "paired AB/BA block" },
    exclusions,
    coverage,
    byFixture,
    byCategory,
    worstCohort,
  };
}
