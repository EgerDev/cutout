import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { runInNewContext } from "node:vm";
import {
  checkRunRow,
  pairedLatency,
  qualityCapturePolicy,
  validateCompletedRuns,
} from "./benchmark/contract.mjs";
import * as runner from "./benchmark/browser-runner.mjs";

// Authored protocol cases, independent of any corpus or historical trace.
const baselineCommit = "5522eee10d0b974531b8f9c07dd4798625dfeea0";
const candidateCommit = "c".repeat(40);
const sha = "a".repeat(64);
const fixture = {
  id: "authored",
  evaluation: "known-alpha",
  input: { path: "input/authored.png" },
};
const cutting = () => ({ stage: "cutting", message: "Finding subject", progress: 0.6 });
const switching = () => ({
  stage: "loading",
  message: "Switching to compatibility mode",
  progress: 0.72,
});
const declaration = () => ({ commit: baselineCommit, route: "primary-switch-result-v1" });

function setup({
  declared = true,
  mode = "maximum",
  changePolicy = () => {},
  changeBinding = () => {},
} = {}) {
  const policy = {
    schemaVersion: 1,
    purpose: "known-alpha-quality-capture",
    corpusManifestSha256: sha,
    baselineCommit,
    candidateCommit,
    split: "smoke",
    mode,
    requestedProvider: "webgpu",
    expectations: [
      {
        fixtureId: fixture.id,
        method: "model",
        actualProvider: "wasm",
        route: "primary-processing-then-compatibility",
        ...(declared ? { baselineObservability: declaration() } : {}),
      },
    ],
  };
  changePolicy(policy);
  const json = JSON.stringify(policy);
  const record = { json, sha256: createHash("sha256").update(json).digest("hex") };
  const binding = {
    expectedSha256: record.sha256,
    manifestSha256: sha,
    baselineCommit: policy.baselineCommit,
    candidateCommit: policy.candidateCommit,
    split: "smoke",
    mode,
    requestedProvider: "webgpu",
    fixtures: [fixture],
  };
  changeBinding(binding);
  return { policy, record, binding };
}

function evidence({ complete = false, mode = "maximum" } = {}) {
  return {
    source: "worker-messages-v1",
    gpu: { available: true },
    primaryExecutedProvider: null,
    compatibilityProcessing: complete ? "observed" : "not-observed",
    jobs: [
      {
        workerUrl: "http://authored.invalid/worker.js",
        jobId: 8,
        fileName: "authored.png",
        mode,
        noWebgpu: false,
        progress: [cutting(), switching(), ...(complete ? [cutting()] : [])],
        outcome: { type: "done", method: "model", provider: "wasm", workerHadGpu: true },
      },
    ],
  };
}

function rows(record, mode = "maximum") {
  return ["baseline", "candidate"].map((variant, order) => ({
    fixtureId: fixture.id,
    evaluation: fixture.evaluation,
    variant,
    order,
    pair: 0,
    commit: variant === "baseline" ? baselineCommit : candidateCommit,
    status: "completed",
    method: "model",
    actualProvider: "wasm",
    requestedProvider: "webgpu",
    removalMode: mode,
    completeMs: 10,
    outputSha256: sha,
    capturePurpose: "quality-only",
    qualityPolicySha256: record.sha256,
    routeEvidence: evidence({ complete: variant === "candidate", mode }),
  }));
}

function context(s) {
  return qualityCapturePolicy(s.record, s.binding);
}

test("ordinary policy still rejects an authored baseline with no post-switch cutting", () => {
  const s = setup({ declared: false });
  assert.throws(() => checkRunRow(rows(s.record)[0], undefined, context(s)), /route evidence/);
});

test("declared exact legacy baseline records absent processing and retains a strict candidate", () => {
  for (const mode of ["quick", "auto", "maximum"]) {
    const s = setup({ mode }),
      c = context(s),
      pair = rows(s.record, mode);
    assert.doesNotThrow(() => validateCompletedRuns(pair, [fixture.id], 1, { qualityCapture: c }));
    assert.equal(pair[0].routeEvidence.compatibilityProcessing, "not-observed");
    assert.equal(pair[0].routeEvidence.primaryExecutedProvider, null);
    assert.equal(pair[0].routeEvidence.jobs[0].progress.length, 2);
    assert.throws(() => pairedLatency(pair), /quality-only/);
    const candidate = pair[1];
    candidate.routeEvidence = evidence({ mode });
    assert.throws(() => checkRunRow(candidate, undefined, c), /route evidence/);
  }
});

test("legacy visibility must agree with actual progress, including available processing", () => {
  const s = setup(),
    c = context(s),
    row = rows(s.record)[0];
  row.routeEvidence.compatibilityProcessing = "observed";
  assert.throws(() => checkRunRow(row, undefined, c), /visibility/);
  row.routeEvidence = evidence({ complete: true });
  assert.doesNotThrow(() => checkRunRow(row, undefined, c));
  row.routeEvidence.compatibilityProcessing = "not-observed";
  assert.throws(() => checkRunRow(row, undefined, c), /visibility/);
  delete row.routeEvidence.compatibilityProcessing;
  assert.throws(() => checkRunRow(row, undefined, c), /visibility/);
});

test("policy declaration is finite, externally pinned, source-bound and selected known-alpha only", () => {
  for (const changePolicy of [
    (p) => (p.baselineCommit = "b".repeat(40)),
    (p) => (p.expectations[0].baselineObservability.commit = "b".repeat(40)),
    (p) => (p.expectations[0].baselineObservability.route = "optional-progress"),
    (p) => (p.expectations[0].baselineObservability.variant = "candidate"),
    (p) => (p.expectations[0].fixtureId = "unselected"),
    (p) => p.expectations.push(p.expectations[0]),
    (p) => (p.allowFallback = true),
  ])
    assert.throws(() => context(setup({ changePolicy })));
  for (const patch of [
    { expectedSha256: "d".repeat(64) },
    { manifestSha256: "d".repeat(64) },
    { baselineCommit: "b".repeat(40) },
    { candidateCommit: "d".repeat(40) },
    { mode: "quick" },
    { split: "tune" },
    { requestedProvider: "wasm" },
    { fixtures: [] },
    { fixtures: [{ ...fixture, evaluation: "real-alpha" }] },
  ])
    assert.throws(() => context(setup({ changeBinding: (b) => Object.assign(b, patch) })));
  const s = setup();
  s.record.json += " ";
  assert.throws(() => context(s), /SHA-256/);
});

test("rows and warmup API cannot self-authorize through variant or commit contradictions", () => {
  const s = setup(),
    c = context(s),
    row = rows(s.record)[0];
  for (const patch of [
    { variant: "candidate" },
    { variant: "other" },
    { variant: undefined },
    { commit: candidateCommit },
    { commit: undefined },
    { commit: "b".repeat(40) },
  ])
    assert.throws(() => checkRunRow({ ...row, ...patch }, undefined, c), /source|variant/);
  assert.throws(
    () => checkRunRow(row, { fixtureId: fixture.id, variant: "candidate", phase: "warmup 0" }, c),
    /variant/,
  );
  assert.throws(() => checkRunRow(row, { fixtureId: "other", variant: "baseline" }, c), /identity/);
  assert.throws(
    () => checkRunRow(row, { variant: "baseline", commit: candidateCommit }, c),
    /source commit/,
  );
  for (const fake of [s.record, JSON.parse(JSON.stringify(c)), { ...c }, c.policy])
    assert.throws(() => checkRunRow(row, undefined, fake), /unverified quality/);
  assert.ok(Object.isFrozen(c.policy.expectations[0].baselineObservability));
  assert.throws(
    () => (c.policy.expectations[0].baselineObservability.commit = candidateCommit),
    TypeError,
  );
  const pair = rows(s.record);
  pair[0].commit = candidateCommit;
  assert.throws(
    () => validateCompletedRuns(pair, [fixture.id], 1, { qualityCapture: c }),
    /source commit/,
  );
  const disguised = rows(s.record);
  Object.assign(disguised[1], {
    variant: "baseline",
    commit: baselineCommit,
    order: 0,
    routeEvidence: evidence(),
  });
  assert.throws(() => checkRunRow(disguised[1], { variant: "candidate" }, c), /variant/);
  assert.throws(
    () => validateCompletedRuns(disguised, [fixture.id], 1, { qualityCapture: c }),
    /duplicate run/,
  );
});

test("legacy declaration retains primary switch result correlation and GPU/provider guards", () => {
  const s = setup(),
    c = context(s);
  for (const change of [
    (r) => r.routeEvidence.jobs[0].progress.shift(),
    (r) => r.routeEvidence.jobs[0].progress.pop(),
    (r) => r.routeEvidence.jobs[0].progress.reverse(),
    (r) => r.routeEvidence.jobs[0].progress.push(switching()),
    (r) => delete r.routeEvidence.jobs[0].outcome,
    (r) => (r.routeEvidence.jobs[0].outcome.type = "error"),
    (r) => (r.routeEvidence.jobs[0].outcome.method = "flood"),
    (r) => (r.routeEvidence.jobs[0].outcome.provider = "webgpu"),
    (r) => (r.routeEvidence.jobs[0].fileName = "other.png"),
    (r) => (r.routeEvidence.jobs[0].mode = "auto"),
    (r) => (r.routeEvidence.jobs[0].jobId = null),
    (r) => (r.routeEvidence.jobs[0].workerUrl = ""),
    (r) => r.routeEvidence.jobs.push(structuredClone(r.routeEvidence.jobs[0])),
    (r) => (r.routeEvidence.jobs[0].noWebgpu = true),
    (r) => (r.routeEvidence.jobs[0].outcome.workerHadGpu = false),
    (r) => (r.routeEvidence.gpu.available = false),
    (r) => (r.routeEvidence.primaryExecutedProvider = "webgpu"),
    (r) => (r.method = "flood"),
    (r) => (r.actualProvider = "webgpu"),
    (r) => (r.requestedProvider = "wasm"),
    (r) => (r.removalMode = "auto"),
    (r) => (r.evaluation = "real-alpha"),
    (r) => (r.fixtureId = "unselected"),
    (r) => (r.qualityPolicySha256 = "d".repeat(64)),
    (r) => delete r.capturePurpose,
  ]) {
    const row = rows(s.record)[0];
    change(row);
    assert.throws(() => checkRunRow(row, undefined, c));
  }
});

test("undeclared fixtures and other baseline policies retain strict provider/route checks", () => {
  const s = setup({
    changeBinding: (b) => b.fixtures.push({ ...fixture, id: "control", evaluation: "real-alpha" }),
  });
  const c = context(s),
    row = rows(s.record)[0];
  assert.throws(
    () => checkRunRow({ ...row, fixtureId: "control", evaluation: "real-alpha" }, undefined, c),
    /requested webgpu/,
  );
  const ordinary = setup({
    declared: false,
    changePolicy: (p) => (p.baselineCommit = "b".repeat(40)),
  });
  const other = rows(ordinary.record)[0];
  other.commit = ordinary.policy.baselineCommit;
  assert.throws(() => checkRunRow(other, undefined, context(ordinary)), /route evidence/);
  other.routeEvidence = evidence({ complete: true });
  assert.doesNotThrow(() => checkRunRow(other, undefined, context(ordinary)));
  assert.throws(() => checkRunRow(row), /quality-only/);
  const { capturePurpose: _p, qualityPolicySha256: _h, ...unmarked } = row;
  assert.throws(() => checkRunRow(unmarked), /requested webgpu/);
  assert.throws(
    () =>
      validateCompletedRuns(rows(s.record), [fixture.id], 1, {
        qualityCapture: c,
        allowNondeterministicOutputs: true,
      }),
    /strict output identity/,
  );
  const changed = rows(s.record);
  changed.push(
    ...rows(s.record).map((r) => ({
      ...r,
      pair: 1,
      order: 1 - r.order,
      outputSha256: r.variant === "candidate" ? "d".repeat(64) : sha,
    })),
  );
  assert.throws(
    () => validateCompletedRuns(changed, [fixture.id], 2, { qualityCapture: c }),
    /differs from pair 0/,
  );
});

// Executes only the source-owned init callback in a JS realm: no browser, server, CLI or model.
async function protocol() {
  class Worker {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.listeners = [];
    }
    postMessage(...args) {
      this.sent.push(args);
    }
    addEventListener(type, listener) {
      if (type === "message") this.listeners.push(listener);
    }
    receive(data) {
      for (const listener of this.listeners) listener({ data });
    }
  }
  const window = { Worker };
  await runner.observeQualityRoute({
    addInitScript: (fn) => runInNewContext(`(${fn.toString()})()`, { window }),
  });
  return { window, worker: new window.Worker("http://authored.invalid/worker.js") };
}

function request(worker, id = 8) {
  worker.postMessage({
    type: "run",
    id,
    file: { name: "authored.png" },
    mode: "maximum",
    noWebgpu: false,
  });
}
function progress(worker, event, id = 8) {
  worker.receive({ type: "progress", id, progress: event });
}
function done(worker, id = 8) {
  worker.receive({
    type: "done",
    id,
    result: { method: "model", provider: "wasm", workerHadGpu: true },
  });
}
function liveRow(s, window, variant = "baseline") {
  const result = {
    removalMode: "maximum",
    workerJobs: JSON.parse(JSON.stringify(window.__benchmarkWorkerJobs)),
  };
  const options = { qualityCapture: context(s), variant, baselineCommit, candidateCommit };
  return {
    ...rows(s.record)[variant === "baseline" ? 0 : 1],
    ...runner.qualityCaptureFields(options, fixture, result, { available: true }),
  };
}

test("pure worker observer forwards messages and records truthful live/warmup visibility", async () => {
  const s = setup(),
    { window, worker } = await protocol();
  request(worker);
  progress(worker, cutting());
  progress(worker, switching());
  done(worker);
  const row = liveRow(s, window),
    c = context(s);
  assert.equal(worker.sent.length, 1);
  assert.equal(worker.sent[0][0].type, "run");
  assert.equal(row.routeEvidence.compatibilityProcessing, "not-observed");
  assert.match(row.routeEvidence.limitation, /not observed|unavailable/);
  assert.doesNotThrow(() =>
    checkRunRow(row, { fixtureId: fixture.id, variant: "baseline", phase: "warmup 0" }, c),
  );
  assert.throws(() => checkRunRow(liveRow(s, window, "candidate"), undefined, c), /route evidence/);
  const wrong = runner.qualityCaptureFields(
    { qualityCapture: c, variant: "baseline", baselineCommit: candidateCommit },
    fixture,
    { removalMode: "maximum", workerJobs: row.routeEvidence.jobs },
    { available: true },
  );
  assert.throws(() => checkRunRow({ ...row, ...wrong }, undefined, c), /source commit/);
});

test("pure observer refuses wrong job/worker and completion before required progress", async () => {
  for (const fault of ["wrong-job", "wrong-worker", "early-result", "old-job"]) {
    const s = setup(),
      { window, worker } = await protocol();
    if (fault === "old-job") {
      request(worker, 7);
      window.__benchmarkWorkerJobs = [];
    }
    request(worker);
    if (fault === "early-result") done(worker);
    const target =
      fault === "wrong-worker" ? new window.Worker("http://authored.invalid/other.js") : worker;
    const id = fault === "wrong-job" || fault === "old-job" ? 7 : 8;
    progress(target, cutting(), id);
    progress(target, switching(), id);
    done(worker);
    assert.throws(
      () => checkRunRow(liveRow(s, window), undefined, context(s)),
      /route evidence/,
      fault,
    );
  }
});

test("pure observer records actual post-switch processing on both live variants", async () => {
  const s = setup(),
    { window, worker } = await protocol();
  const sent = {
    type: "run",
    id: 8,
    file: { name: "authored.png" },
    mode: "maximum",
    noWebgpu: false,
  };
  const transfer = [];
  worker.postMessage(sent, transfer);
  assert.equal(worker.sent[0][0], sent);
  assert.equal(worker.sent[0][1], transfer);
  progress(worker, cutting());
  progress(worker, switching());
  progress(worker, cutting());
  done(worker);
  for (const variant of ["baseline", "candidate"]) {
    const row = liveRow(s, window, variant);
    assert.equal(row.routeEvidence.compatibilityProcessing, "observed");
    assert.doesNotThrow(() =>
      checkRunRow(row, { fixtureId: fixture.id, variant, phase: "warmup 0" }, context(s)),
    );
  }
  progress(worker, switching()); // A completed job cannot acquire later route evidence.
  assert.equal(window.__benchmarkWorkerJobs[0].progress.length, 3);
});
