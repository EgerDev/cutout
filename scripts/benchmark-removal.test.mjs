import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";
import { launchChromeContext } from "./chrome.mjs";
import { providerLaunchArgs } from "./benchmark/browser-runner.mjs";
import { servedBuild, servedBuildChanges } from "./benchmark/served-build.mjs";
import {
  assertProvider,
  checkRunRow,
  qualityCapturePolicy,
  loadCorpus,
  outputIdentity,
  pairedLatency,
  validateCompletedRuns,
  verifyBuild,
} from "./benchmark/contract.mjs";
import {
  combinedNetworkSummary,
  observeContextNetwork,
  observeNetwork,
  summarizeNetwork,
} from "./benchmark/network-telemetry.mjs";

const sha = "a".repeat(64);

test("forces WASM Chrome process controls into a page and same-origin module worker", async (t) => {
  const server = http.createServer((request, response) => {
    response.writeHead(200, {
      "content-type":
        request.url === "/adapter-worker.mjs" ? "application/javascript" : "text/html",
    });
    response.end(
      request.url === "/adapter-worker.mjs"
        ? "const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null; postMessage(Boolean(adapter));"
        : '<!doctype html><script type="module">try { window.__adapter = Boolean(navigator.gpu && await navigator.gpu.requestAdapter()); } catch (error) { window.__adapterError = String(error); }</script>',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const probe = async (args) => {
    const profile = await mkdtemp(join(tmpdir(), "cutout-provider-control-"));
    let context;
    try {
      context = await launchChromeContext(profile, { args });
      const page = await context.newPage();
      await page.goto(origin, { waitUntil: "networkidle" });
      // The inline module's adapter await settles on its own clock — under parallel
      // load it can outlive `networkidle`, so wait for it like the worker's probe
      // instead of reading `__adapter` while it is still undefined.
      await page.waitForFunction(
        () => window.__adapter !== undefined || window.__adapterError !== undefined,
        undefined,
        { timeout: 5_000 },
      );
      return {
        page: await page.evaluate(() => {
          if (window.__adapterError !== undefined)
            throw new Error(`page adapter probe rejected: ${window.__adapterError}`);
          return window.__adapter;
        }),
        worker: await page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const worker = new Worker("/adapter-worker.mjs", { type: "module" });
              const timeout = window.setTimeout(() => {
                worker.terminate();
                reject(new Error("module worker adapter probe timed out"));
              }, 5_000);
              worker.onmessage = (event) => {
                window.clearTimeout(timeout);
                worker.terminate();
                resolve(event.data);
              };
              worker.onerror = (event) => {
                window.clearTimeout(timeout);
                worker.terminate();
                reject(new Error(event.message));
              };
            }),
        ),
      };
    } finally {
      await context?.close();
      await rm(profile, { force: true, recursive: true });
    }
  };

  // Given native Chrome may or may not have a supported adapter on its host.
  const native = await probe([]);
  // When the benchmark requests WASM, Then its process controls reject adapters in both realms.
  assert.deepEqual(await probe(providerLaunchArgs("wasm")), { page: false, worker: false });
  if (native.page || native.worker) assert.deepEqual(native, { page: true, worker: true });
});

test("rejects a fixture whose bytes do not match its pinned SHA-256", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cutout-corpus-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, "input"));
  await writeFile(join(directory, "input", "fixture.png"), "changed");
  await writeFile(
    join(directory, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      heldoutState: "locked",
      fixtures: [
        {
          id: "fixture",
          split: "smoke",
          category: "synthetic-boundary",
          evaluation: "known-alpha",
          input: { path: "input/fixture.png", sha256: sha, width: 1, height: 1 },
          alpha: { path: "input/fixture.png", sha256: sha, width: 1, height: 1 },
          provenance: { sourceUrl: "generated:fixture", license: "CC0-1.0" },
        },
      ],
    }),
  );
  await assert.rejects(loadCorpus(join(directory, "manifest.json"), "smoke"), /SHA-256/);
});

test("rejects an alpha annotation whose decoded dimensions do not match its input", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cutout-alpha-dimensions-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  await mkdir(join(directory, "input"));
  const inputPath = join(directory, "input", "fixture.png");
  const alphaPath = join(directory, "input", "fixture-alpha.png");
  await sharp({ create: { width: 1, height: 1, channels: 4, background: "white" } })
    .png()
    .toFile(inputPath);
  await sharp({ create: { width: 2, height: 1, channels: 3, background: "white" } })
    .png()
    .toFile(alphaPath);
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const manifest = {
    schemaVersion: 1,
    heldoutState: "locked",
    fixtures: [
      {
        id: "fixture",
        split: "smoke",
        category: "synthetic-boundary",
        evaluation: "known-alpha",
        input: { path: "input/fixture.png", sha256: await digest(inputPath), width: 1, height: 1 },
        alpha: {
          path: "input/fixture-alpha.png",
          sha256: await digest(alphaPath),
          width: 2,
          height: 1,
        },
        provenance: { sourceUrl: "generated:fixture", license: "CC0-1.0" },
      },
    ],
  };
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(loadCorpus(join(directory, "manifest.json"), "smoke"), /alpha.*dimensions/i);
});

test("rejects a production server whose version.json names another commit", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ version: "0.1.0", commit: "b".repeat(40) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(verifyBuild(url, "a".repeat(40), 1_000), /expected commit/);
});

test("times out a version.json endpoint that never completes", async (t) => {
  const server = http.createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  await assert.rejects(verifyBuild(url, "a".repeat(40), 20), /Could not read version.json/);
});

test("cancels a hung version check without leaving the server connection open", async (t) => {
  const server = http.createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const controller = new AbortController();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const checking = verifyBuild(url, "a".repeat(40), 10_000, controller.signal);
  controller.abort(new Error("test cancellation"));
  await assert.rejects(checking, /Could not read version.json/);
});

test("records real encoded bytes, chunked completion, and browser cache source flags", async (t) => {
  let cacheRequests = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/chunked") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("chunk-one");
      response.end("chunk-two");
      return;
    }
    if (request.url === "/cache") {
      cacheRequests += 1;
      response.writeHead(200, {
        "cache-control": "public, max-age=3600",
        "content-type": "text/plain",
      });
      response.end("cacheable");
      return;
    }
    if (request.url === "/sw.js") {
      response.writeHead(200, {
        "content-type": "application/javascript",
        "service-worker-allowed": "/",
      });
      response.end(`
        self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
        self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
        self.addEventListener("fetch", (event) => {
          if (new URL(event.request.url).pathname === "/cache")
            event.respondWith(new Response("service-worker-cache", { headers: { "content-type": "text/plain" } }));
        });
      `);
      return;
    }
    if (request.url === "/worker.js") {
      response.writeHead(200, { "content-type": "application/javascript" });
      response.end(
        `self.onmessage = () => fetch("/worker-chunked").then((response) => response.text()).then(() => postMessage("done"));`,
      );
      return;
    }
    if (request.url === "/worker-chunked") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("worker-one");
      response.end("worker-two");
      return;
    }
    if (request.url === "/failure") {
      response.destroy();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>network probe</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const profile = await mkdtemp(join(tmpdir(), "cutout-network-"));
  const context = await launchChromeContext(profile, { viewport: { width: 800, height: 600 } });
  let fixtureId = "startup";
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const telemetry = await observeNetwork(cdp, () => fixtureId);
  const contextTelemetry = observeContextNetwork(context, () => fixtureId);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    await page.goto(origin);
    fixtureId = "chunked";
    await page.evaluate(() => fetch("/chunked").then((response) => response.text()));
    await telemetry.waitForSettled("chunked", 2_000);
    fixtureId = "service-worker-setup";
    await page.evaluate(() =>
      navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready),
    );
    await page.reload();
    fixtureId = "cache-hit";
    await page.evaluate(() => fetch("/cache").then((response) => response.text()));
    await telemetry.waitForSettled("cache-hit", 2_000);
    const chunked = summarizeNetwork(
      telemetry.entriesFor("chunked").filter((entry) => entry.url.endsWith("/chunked")),
    );
    const cached = summarizeNetwork(
      telemetry.entriesFor("cache-hit").filter((entry) => entry.url.endsWith("/cache")),
    );
    assert.equal(chunked.completedCount, 1);
    assert.equal(chunked.failedCount, 0);
    assert.equal(chunked.incompleteCount, 0);
    assert.ok(chunked.encodedDataLength > 0);
    assert.equal("bytes" in chunked, false);
    assert.equal(cacheRequests, 0);
    assert.equal(cached.cache.fromServiceWorker > 0, true);
    fixtureId = "worker-fetch";
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const worker = new Worker("/worker.js");
          window.__networkProbeWorker = worker;
          worker.onmessage = resolve;
          worker.onerror = reject;
          worker.postMessage("start");
        }),
    );
    await contextTelemetry.waitForSettled("worker-fetch", 2_000);
    const combined = combinedNetworkSummary(
      telemetry.entriesFor("worker-fetch"),
      contextTelemetry.entriesFor("worker-fetch"),
    );
    assert.equal(
      combined.browserContext.entries.some((entry) => entry.url.endsWith("/worker-chunked")),
      true,
    );
    assert.equal(combined.completeEncodedCoverage, false);
    assert.equal(combined.workerEncodedDataLength.value, null);
    assert.match(combined.workerEncodedDataLength.reason, /do not expose/);
    fixtureId = "failed-request";
    await page.evaluate(() => fetch("/failure").catch(() => null));
    await contextTelemetry.waitForSettled("failed-request", 2_000);
    await telemetry.waitForSettled("failed-request", 2_000);
    const failed = combinedNetworkSummary(
      telemetry.entriesFor("failed-request"),
      contextTelemetry.entriesFor("failed-request"),
    );
    assert.equal(failed.pageTarget.failedCount, 1);
    assert.equal(failed.browserContext.failedCount, 1);
    assert.equal(failed.completeEncodedCoverage, false);
    assert.match(failed.pageTarget.entries[0].failure.errorText, /ERR_/);
  } finally {
    await page.evaluate(() => window.__networkProbeWorker?.terminate()).catch(() => undefined);
    contextTelemetry.stop();
    await telemetry.stop();
    await cdp.detach();
    await context.close();
    await rm(profile, { force: true, recursive: true });
  }
});

test("rejects fallback when WebGPU was explicitly requested", () => {
  assert.throws(() => assertProvider("webgpu", "wasm"), /requested webgpu.*reported wasm/);
  assert.doesNotThrow(() => assertProvider("wasm", "wasm"));
});

test("rejects malformed and incomplete paired run artifacts", () => {
  const valid = [
    {
      pair: 0,
      order: 0,
      variant: "baseline",
      fixtureId: "one",
      status: "completed",
      method: "model",
      requestedProvider: "wasm",
      actualProvider: "wasm",
      completeMs: 10,
      outputSha256: sha,
    },
    {
      pair: 0,
      order: 1,
      variant: "candidate",
      fixtureId: "one",
      status: "completed",
      method: "model",
      requestedProvider: "wasm",
      actualProvider: "wasm",
      completeMs: 9,
      outputSha256: sha,
    },
  ];
  assert.doesNotThrow(() => validateCompletedRuns(valid, ["one"], 1));
  assert.throws(() => validateCompletedRuns(valid.slice(0, 1), ["one"], 1), /missing candidate/);
  assert.throws(
    () => validateCompletedRuns([{ ...valid[0], completeMs: "fast" }, valid[1]], ["one"], 1),
    /completeMs/,
  );
  assert.throws(
    () => validateCompletedRuns([...valid, { ...valid[0], pair: 1 }], ["one"], 1),
    /outside/,
  );
  assert.throws(
    () => validateCompletedRuns([{ ...valid[0], order: 2 }, valid[1]], ["one"], 1),
    /order 2 must be 0 or 1/,
  );
});

test("paired statistics are deterministic and preserve pair identity", () => {
  const rows = Array.from({ length: 30 }, (_, pair) => [
    {
      pair,
      order: pair % 2,
      variant: "baseline",
      fixtureId: "one",
      category: "products",
      status: "completed",
      method: "model",
      requestedProvider: "wasm",
      actualProvider: "wasm",
      completeMs: 100 + pair,
      outputSha256: sha,
    },
    {
      pair,
      order: 1 - (pair % 2),
      variant: "candidate",
      fixtureId: "one",
      category: "products",
      status: "completed",
      method: "model",
      requestedProvider: "wasm",
      actualProvider: "wasm",
      completeMs: 90 + pair,
      outputSha256: sha,
    },
  ]).flat();
  validateCompletedRuns(rows, ["one"], 30);
  const first = pairedLatency(rows, 2_000, 730_241);
  const second = pairedLatency(rows, 2_000, 730_241);
  assert.deepEqual(first, second);
  assert.equal(first.pairs, 30);
  assert.equal(first.observations, 30);
  assert.equal(first.bootstrap.unit, "paired AB/BA block");
  // Baselines 100..129, candidates 90..119.
  assert.deepEqual(first.byFixture, [
    {
      fixtureId: "one",
      pairs: 30,
      baselineMedianMs: 114.5,
      candidateMedianMs: 104.5,
      ratioOfMedians: 104.5 / 114.5,
      differenceOfMediansMs: 10,
      pairedMedianRatio: first.byFixture[0].pairedMedianRatio,
      pairedMedianDifferenceMs: 10,
    },
  ]);
  assert.equal(first.byCategory[0].category, "products");
  assert.equal(first.byCategory[0].pairs, 30);
  assert.equal(first.worstCohort.category, "products");
  assert.equal(first.ratioOfMedians, 104.5 / 114.5);
  assert.equal(first.differenceOfMediansMs, 10);
  assert.ok(first.ratioOfMediansConfidence95.high < 1);
  assert.equal(first.pairedMedianDifferenceMs, 10);
  // Every block's paired difference is exactly 10, so resampling blocks cannot vary it.
  assert.equal(first.pairedDifferenceConfidence95, null);
  assert.match(first.intervalsUnavailable.pairedDifferenceConfidence95, /every block/);
});

/** Rows for one paired observation: baseline then candidate, in the AB/BA order of the pair. */
function pairRows(pair, fixtureId, category, baselineMs, candidateMs) {
  const row = {
    pair,
    fixtureId,
    category,
    status: "completed",
    method: "model",
    requestedProvider: "wasm",
    actualProvider: "wasm",
    outputSha256: hashOf(fixtureId),
  };
  return [
    { ...row, order: pair % 2, variant: "baseline", completeMs: baselineMs },
    { ...row, order: 1 - (pair % 2), variant: "candidate", completeMs: candidateMs },
  ];
}

const median = (values) => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

test("the headline is the gate's ratio of medians, even where the paired median disagrees in sign", () => {
  // S2-V07 Case A: four block shapes of one fixture, repeated to 24 pairs.
  const shapes = [
    [10, 14],
    [2, 1.9],
    [100, 99.5],
    [200, 150],
  ];
  const rows = Array.from({ length: 24 }, (_, pair) =>
    pairRows(pair, "fa", "c1", ...shapes[pair % 4]),
  ).flat();
  const latency = pairedLatency(rows, 2_000, 730_241);

  // Median wall time: baseline (10 + 100) / 2 = 55, candidate (14 + 99.5) / 2 = 56.75: slower.
  assert.equal(latency.baselineMedianMs, 55);
  assert.equal(latency.candidateMedianMs, 56.75);
  assert.equal(latency.ratioOfMedians, 56.75 / 55);
  assert.equal(latency.differenceOfMediansMs, -1.75);
  // The paired statistic says faster: median of ratios (0.95 + 0.995) / 2, of differences 0.3.
  assert.ok(Math.abs(latency.pairedMedianRatio - 0.9725) < 1e-12);
  assert.ok(Math.abs(latency.pairedMedianDifferenceMs - 0.3) < 1e-12);
  assert.ok(latency.ratioOfMedians > 1 && latency.pairedMedianRatio < 1);

  // The gate interval is a block bootstrap of the ratio of medians: resample whole pairs,
  // pool their rows, take the medians. Recomputed independently with the same generator.
  let state = 730_241;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const ratios = [];
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const pairs = Array.from({ length: 24 }, () => Math.floor(next() * 24));
    const sample = pairs.flatMap((pair) => rows.filter((row) => row.pair === pair));
    const side = (variant) =>
      median(sample.filter((row) => row.variant === variant).map((row) => row.completeMs));
    ratios.push(side("candidate") / side("baseline"));
  }
  ratios.sort((left, right) => left - right);
  assert.deepEqual(latency.ratioOfMediansConfidence95, {
    low: ratios[Math.floor(1_999 * 0.025)],
    high: ratios[Math.ceil(1_999 * 0.975)],
  });
  assert.ok(latency.ratioOfMediansConfidence95.low <= latency.ratioOfMedians);
  assert.ok(latency.ratioOfMediansConfidence95.high >= latency.ratioOfMedians);
  assert.deepEqual(latency.intervalsUnavailable, {});
});

test("an interval no resampling can vary is null, not a zero-width 95% interval", () => {
  // S2-V07 Case B: thirty identical five-category blocks.
  const ratios = { plants: 1.5, products: 0.7, glass: 0.8, pets: 0.85, portrait: 0.95 };
  const rows = Array.from({ length: 30 }, (_, pair) =>
    Object.entries(ratios).flatMap(([category, ratio]) =>
      pairRows(pair, `f-${category}`, category, 400, 400 * ratio),
    ),
  ).flat();
  const latency = pairedLatency(rows, 500, 730_241);
  // Candidate medians: 600, 280, 320, 340, 380 → 340.
  assert.equal(latency.ratioOfMedians, 340 / 400);
  assert.equal(latency.differenceOfMediansMs, 60);
  for (const summary of [latency, ...latency.byCategory]) {
    for (const field of [
      "ratioOfMediansConfidence95",
      "differenceOfMediansConfidence95",
      "pairedRatioConfidence95",
      "pairedDifferenceConfidence95",
    ]) {
      assert.equal(summary[field], null, `${summary.category ?? "cohort"} ${field}`);
      assert.match(summary.intervalsUnavailable[field], /every block/);
    }
  }
  assert.equal(latency.worstCohort.category, "plants");
  assert.equal(latency.worstCohort.ratioOfMedians, 1.5);

  // Case C: one pair (the parity lanes' shape) has no interval at all.
  const single = pairedLatency(pairRows(0, "fx", "cat", 200, 180), 500, 730_241);
  assert.equal(single.ratioOfMedians, 0.9);
  assert.equal(single.differenceOfMediansMs, 20);
  assert.equal(single.ratioOfMediansConfidence95, null);
  assert.equal(single.pairedRatioConfidence95, null);
  assert.match(single.intervalsUnavailable.ratioOfMediansConfidence95, /1 paired block/);
});

test("a gate interval with no spread is null even when the blocks differ", () => {
  // Every candidate is 0.9× (or 10 ms under) its baseline, so every resample of these
  // different blocks gives the same ratio (difference): the bounds coincide.
  const scaled = Array.from({ length: 4 }, (_, pair) =>
    pairRows(pair, "one", "products", 100 * (pair + 1), 90 * (pair + 1)),
  ).flat();
  const shifted = Array.from({ length: 4 }, (_, pair) =>
    pairRows(pair, "one", "products", 100 + pair, 90 + pair),
  ).flat();
  for (const summary of [pairedLatency(scaled, 100), pairedLatency(scaled, 100).byCategory[0]]) {
    assert.equal(summary.ratioOfMediansConfidence95, null);
    assert.match(summary.intervalsUnavailable.ratioOfMediansConfidence95, /bounds coincide/);
  }
  const latency = pairedLatency(shifted, 100);
  assert.equal(latency.differenceOfMediansConfidence95, null);
  assert.match(latency.intervalsUnavailable.differenceOfMediansConfidence95, /bounds coincide/);
});

test("blocks with equal medians of their own still give a gate interval when pooled", () => {
  // Each block's own medians are equal (2/2 and 10/10: ratio 1, difference 0), but a
  // resample that mixes the two shapes pools rows whose medians differ, so the gate
  // quantity varies and its interval must be published.
  const shapes = [
    [
      [1, 2],
      [3, 2],
    ],
    [
      [10, 5],
      [10, 15],
    ],
  ];
  const rows = Array.from({ length: 4 }, (_, pair) =>
    shapes[pair % 2].flatMap(([baselineMs, candidateMs], index) =>
      pairRows(pair, `f${index + 1}`, "c1", baselineMs, candidateMs),
    ),
  ).flat();
  const latency = pairedLatency(rows, 500, 730_241);
  // Pooled: baseline 1 1 3 3 10 10 10 10 → 6.5, candidate 2 2 2 2 5 5 15 15 → 3.5.
  assert.equal(latency.ratioOfMedians, 3.5 / 6.5);
  assert.equal(latency.differenceOfMediansMs, 3);
  for (const field of ["ratioOfMediansConfidence95", "differenceOfMediansConfidence95"]) {
    assert.notEqual(latency[field], null, `${field}: ${latency.intervalsUnavailable[field]}`);
    assert.ok(latency[field].low < latency[field].high, field);
  }
  // Mixes give ratios 0.5, 0.538 and 0.667; unmixed resamples give 1.
  assert.deepEqual(latency.ratioOfMediansConfidence95, { low: 0.5, high: 1 });
  // Both shapes' paired median difference is 0 (−1/+1 and +5/−5), so that one stays null.
  assert.deepEqual(Object.keys(latency.intervalsUnavailable), ["pairedDifferenceConfidence95"]);
});

test("latency uses model runs only and reports what it left out and why (C53)", () => {
  const rows = [
    ...pairRows(0, "photo", "products", 100, 90),
    ...pairRows(1, "photo", "products", 110, 95),
    // Both engines take the illustration path on pair 0; on pair 1 only the candidate
    // passes the image through, so the baseline's model run loses its partner.
    ...pairRows(0, "art", "logos", 2, 1).map((row) => ({
      ...row,
      method: "illustration",
      actualProvider: "fallback",
    })),
    ...pairRows(1, "art", "logos", 2, 1).map((row) =>
      row.variant === "candidate"
        ? { ...row, method: "passthrough", actualProvider: "fallback" }
        : row,
    ),
  ];
  // Non-model runs stay valid parity and quality evidence, with the provider they report.
  validateCompletedRuns(rows, ["photo", "art"], 2);
  const latency = pairedLatency(rows, 100);
  assert.equal(latency.observations, 2);
  assert.equal(latency.ratioOfMedians, 92.5 / 105);
  assert.deepEqual(
    latency.byFixture.map((fixture) => fixture.fixtureId),
    ["photo"],
  );
  assert.deepEqual(
    latency.byCategory.map((category) => category.category),
    ["products"],
  );
  assert.deepEqual(latency.exclusions, {
    inputRows: 8,
    includedRows: 4,
    excludedRows: 4,
    excludedObservations: 2,
    byReason: {
      "non-model method: illustration": 2,
      "non-model method: passthrough": 1,
      "paired with a non-model run": 1,
    },
    fixtureIds: ["art"],
  });
  assert.deepEqual(latency.coverage, {
    baseline: {
      rows: 4,
      methods: { model: 3, illustration: 1 },
      actualProviders: { wasm: 3, fallback: 1 },
    },
    candidate: {
      rows: 4,
      methods: { model: 2, illustration: 1, passthrough: 1 },
      actualProviders: { wasm: 2, fallback: 2 },
    },
  });

  // A lane with no model run at all has no latency, not NaN.
  const none = pairedLatency(
    rows.filter((row) => row.fixtureId === "art" && row.pair === 0),
    100,
  );
  assert.equal(none.observations, 0);
  assert.equal(none.ratioOfMedians, null);
  assert.equal(none.differenceOfMediansMs, null);
  assert.equal(none.ratioOfMediansConfidence95, null);
  assert.match(none.intervalsUnavailable.ratioOfMediansConfidence95, /0 paired block/);
  assert.equal(none.worstCohort, null);
});

test("a model run off the requested provider, or a run with no provider, is rejected (C53)", () => {
  const rows = pairRows(0, "photo", "products", 100, 90);
  const flipped = [{ ...rows[0], actualProvider: "webgpu" }, rows[1]];
  assert.throws(
    () => validateCompletedRuns(flipped, ["photo"], 1),
    /requested wasm.*reported webgpu/,
  );
  assert.throws(() => pairedLatency(flipped, 100), /requested wasm.*reported webgpu/);
  const unrecorded = [{ ...rows[0], actualProvider: undefined }, rows[1]];
  assert.throws(() => validateCompletedRuns(unrecorded, ["photo"], 1), /no actualProvider/);
  assert.throws(() => pairedLatency(unrecorded, 100), /no actualProvider/);
  const noMethod = [rows[0], { ...rows[1], method: undefined }];
  assert.throws(() => validateCompletedRuns(noMethod, ["photo"], 1), /no method/);
  // A non-model run is not held to the requested provider; it reports what ran it.
  const graphic = rows.map((row) => ({ ...row, method: "logo", actualProvider: "fallback" }));
  assert.doesNotThrow(() => validateCompletedRuns(graphic, ["photo"], 1));
});

test("every contract error from a run names its fixture, variant and pair and keeps the row (S3-B-EVIDENCE-04)", () => {
  const rows = pairRows(0, "photo", "products", 100, 90);
  const broken = { ...rows[1], completeMs: -1 };
  const error = captured(() => validateCompletedRuns([rows[0], broken], ["photo"], 1));
  assert.equal(error.name, "BenchmarkContractError");
  assert.match(error.message, /^photo candidate pair 0: invalid completeMs$/);
  assert.deepEqual(error.run, { fixtureId: "photo", variant: "candidate", pair: 0 });
  assert.deepEqual(error.row, broken);
  const missing = captured(() => validateCompletedRuns([rows[0]], ["photo"], 1));
  assert.match(missing.message, /^photo candidate pair 0: missing candidate run$/);
  const flipped = captured(() =>
    pairedLatency([{ ...rows[0], actualProvider: "webgpu" }, rows[1]], 10),
  );
  assert.match(
    flipped.message,
    /^photo baseline pair 0: Run requested wasm but production reported webgpu$/,
  );
  assert.equal(flipped.row.actualProvider, "webgpu");
});

function hashOf(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("every run records its output hash, and a later pair must reproduce pair 0's (C55)", () => {
  const rows = [
    ...pairRows(0, "photo", "products", 100, 90),
    ...pairRows(1, "photo", "products", 101, 91),
  ];
  validateCompletedRuns(rows, ["photo"], 2);
  assert.deepEqual(outputIdentity(rows), { rows: 4, references: 2, nondeterministic: [] });

  const unhashed = rows.map((row, index) =>
    index === 3 ? { ...row, outputSha256: undefined } : row,
  );
  assert.match(
    captured(() => validateCompletedRuns(unhashed, ["photo"], 2)).message,
    /^photo candidate pair 1: no outputSha256 recorded/,
  );

  // Pair 1's candidate returned other bytes for the same input.
  const changed = rows.map((row) =>
    row.pair === 1 && row.variant === "candidate" ? { ...row, outputSha256: hashOf("other") } : row,
  );
  const error = captured(() => validateCompletedRuns(changed, ["photo"], 2));
  assert.match(
    error.message,
    /^photo candidate pair 1: output sha256 [0-9a-f]{64} differs from pair 0's [0-9a-f]{64}/,
  );
  assert.equal(error.row.outputSha256, hashOf("other"));
  const recorded = {
    fixtureId: "photo",
    variant: "candidate",
    pair: 1,
    outputSha256: hashOf("other"),
    pair0OutputSha256: hashOf("photo"),
  };
  assert.deepEqual(outputIdentity(changed).nondeterministic, [recorded]);
  // A lane that declares nondeterminism acceptable records it instead of failing.
  assert.doesNotThrow(() =>
    validateCompletedRuns(changed, ["photo"], 2, { allowNondeterministicOutputs: true }),
  );
});

/** The error a function throws (assert.throws returns nothing). */
function captured(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a throw");
}

// A lane end to end: the real CLI and browser runner against two stand-in production apps.
// Each app is a few lines of page script that answers the runner's window.__cutoutTest
// contract and returns the input file as its "cutout", built into the .output/public of a
// temporary git checkout and served from there. Per-file behaviour (method, provider, bytes)
// comes from /fake-config.json, which also counts the blocks (one page load per block).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const benchmarkScript = join(repoRoot, "scripts/benchmark-removal.mjs");
const qualityScript = join(repoRoot, "scripts/compare-removal-quality.mjs");
const run = promisify(execFile);

const fakeAppScript = `
const config = await (await fetch("/fake-config.json")).json();
const listeners = new Set();
let state = {
  items: [],
  activeId: null,
  progress: null,
  removalMode: "auto",
  setRemovalMode: (removalMode) => set({ removalMode }),
};
function set(patch) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}
let next = 0;
const input = document.querySelector("input");
input.addEventListener("change", async () => {
  for (const file of input.files) {
    const id = "item-" + next++;
    const behaviour = { ...config.files["*"], ...config.files[file.name] };
    const active = behaviour.fromBlock === undefined || config.block >= behaviour.fromBlock;
    set({ items: [...state.items, { id, name: file.name, status: "processing" }], activeId: id });
    set({ progress: { stage: "inference", progress: 0.5, message: "Removing" } });
    const bytes = active && behaviour.outputBase64
      ? Uint8Array.from(atob(behaviour.outputBase64), (char) => char.charCodeAt(0))
      : new Uint8Array(await file.arrayBuffer());
    const bitmap = await createImageBitmap(file);
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (active && behaviour.compat) {
      const worker = new Worker("/assets/removal-worker-1.js", { type: "module" });
      await new Promise((resolve) => {
        worker.addEventListener("message", ({ data }) => {
          if (data.type === "done") { worker.terminate(); resolve(); }
        });
        worker.postMessage({ type: "run", id: next, file, mode: state.removalMode,
          noWebgpu: behaviour.noWebgpu, missingRoute: behaviour.missingRoute,
          provider: behaviour.provider || config.provider, method: behaviour.method || "model" });
      });
    }
    const parts = active && behaviour.extraByte && config.block >= (behaviour.extraByteFromBlock ?? 0) ? [bytes, new Uint8Array([config.block])] : [bytes];
    const done = {
      id,
      name: file.name,
      status: "done",
      resultBlob: new Blob(parts, { type: "image/png" }),
      provider: (active && behaviour.provider) || config.provider,
      method: (active && behaviour.method) || "model",
      width: bitmap.width,
      height: bitmap.height,
      durationMs: 5,
      removalNote: "clean",
    };
    set({ items: state.items.map((item) => (item.id === id ? done : item)) });
  }
  input.value = "";
});
window.__cutoutTest = {
  useWorkspace: {
    getState: () => state,
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
  },
};
`;

async function git(cwd, ...args) {
  return (
    await run(
      "git",
      [
        "-c",
        "user.name=bench",
        "-c",
        "user.email=bench@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd },
    )
  ).stdout.trim();
}

/** A temp git checkout whose .output/public holds the fake app's build. */
async function fakeCheckout(t, name) {
  const dir = await mkdtemp(join(tmpdir(), `cutout-fake-${name}-`));
  if (!process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    t.after(() => rm(dir, { force: true, recursive: true }));
  await writeFile(join(dir, ".gitignore"), ".output/\n");
  await writeFile(join(dir, "README"), `${name}\n`);
  // Also usable as a clean runner checkout, independent of edits in the real worktree.
  await writeFile(
    join(dir, "package-lock.json"),
    await readFile(join(repoRoot, "package-lock.json")),
  );
  await git(dir, "init", "-q");
  await git(dir, "add", ".");
  await git(dir, "commit", "-q", "-m", name);
  const commit = await git(dir, "rev-parse", "HEAD");
  const publicDir = join(dir, ".output/public");
  await mkdir(join(publicDir, "assets"), { recursive: true });
  await writeFile(
    join(publicDir, "index.html"),
    '<!doctype html><meta charset="utf-8"><title>fake app</title><input type="file" aria-label="Choose files"><script type="module" src="/assets/app-1.js"></script>',
  );
  await writeFile(join(publicDir, "assets/app-1.js"), fakeAppScript);
  await writeFile(
    join(publicDir, "assets/removal-worker-1.js"),
    `
self.onmessage = ({ data }) => {
  const progress = (stage, message) => postMessage({ type: "progress", id: data.id, progress: { stage, message, progress: 0.7 } });
  progress("cutting", "Finding subject");
  if (!data.missingRoute) progress("loading", "Switching to compatibility mode");
  progress("cutting", "Finding subject");
  postMessage({ type: "done", id: data.id, result: { method: data.method, provider: data.provider, workerHadGpu: true } });
};
`,
  );
  await writeFile(join(publicDir, "version.json"), JSON.stringify({ version: "0.1.0", commit }));
  return { dir, commit, publicDir };
}

/** Serves a fake checkout's build; `files` sets per-file behaviour, `served` overrides bytes. */
async function fakeApp(t, name, { files = {}, provider = "wasm", swap, onBlock } = {}) {
  const checkout = await fakeCheckout(t, name);
  const state = { blocks: 0, files, provider, served: new Map(), swap, requests: [] };
  const types = { html: "text/html", js: "application/javascript", json: "application/json" };
  const server = http.createServer(async (request, response) => {
    const { pathname } = new URL(request.url, "http://localhost");
    state.requests.push(pathname);
    if (pathname === "/fake-config.json") {
      state.blocks += 1;
      if (onBlock) await onBlock();
      if (state.blocks === state.swap?.atBlock)
        for (const [path, body] of Object.entries(state.swap.served)) state.served.set(path, body);
      response.writeHead(200, { "content-type": types.json, "cache-control": "no-store" });
      response.end(
        JSON.stringify({ block: state.blocks, provider: state.provider, files: state.files }),
      );
      return;
    }
    const file = pathname === "/" ? "index.html" : pathname.slice(1);
    const body = state.served.has(pathname)
      ? state.served.get(pathname)
      : await readFile(join(checkout.publicDir, file)).catch(() => null);
    if (body === null) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": types[file.split(".").at(-1)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { ...checkout, state, url: `http://127.0.0.1:${server.address().port}/` };
}

/** A three-fixture smoke corpus of generated 4×4 RGBA PNGs (two scored, one visual-only). */
async function fakeCorpus(t) {
  const dir = await mkdtemp(join(tmpdir(), "cutout-fake-corpus-"));
  if (!process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    t.after(() => rm(dir, { force: true, recursive: true }));
  await mkdir(join(dir, "input"));
  const digest = async (path) =>
    createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  const fixtures = [];
  for (const [index, [id, category, evaluation]] of [
    ["photo-a", "products", "known-alpha"],
    ["photo-b", "products", "known-alpha"],
    ["art-c", "logos", "visual-only"],
  ].entries()) {
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1)
      pixels.set(
        [60 * index, 20 * pixel, 255 - 10 * pixel, pixel % 4 === 0 ? 0 : 17 * pixel],
        pixel * 4,
      );
    const inputPath = join(dir, "input", `${id}.png`);
    await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } })
      .png()
      .toFile(inputPath);
    const fixture = {
      id,
      split: "smoke",
      category,
      evaluation,
      input: { path: `input/${id}.png`, sha256: await digest(inputPath), width: 4, height: 4 },
      provenance: { sourceUrl: "generated:benchmark-removal.test", license: "CC0-1.0" },
    };
    if (evaluation !== "visual-only") {
      const alphaPath = join(dir, "input", `${id}-alpha.png`);
      const alpha = Buffer.from(Array.from({ length: 16 }, (_, pixel) => pixels[pixel * 4 + 3]));
      await sharp(alpha, { raw: { width: 4, height: 4, channels: 1 } })
        .png()
        .toFile(alphaPath);
      fixture.alpha = {
        path: `input/${id}-alpha.png`,
        sha256: await digest(alphaPath),
        width: 4,
        height: 4,
      };
    }
    fixtures.push(fixture);
  }
  const manifestPath = join(dir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, heldoutState: "locked", fixtures }),
  );
  return { dir, manifestPath, fileOf: (id) => `${id}.png` };
}

/** Task B step 3: the scorer on a finished lane, and the report it wrote. */
async function scoreLane(output, extra = []) {
  const result = await run(process.execPath, [qualityScript, "--benchmark", output, ...extra]).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  if (process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    await appendFile(
      join(dirname(output), "scorer-invocations.jsonl"),
      `${JSON.stringify({ command: process.execPath, args: [qualityScript, "--benchmark", output, ...extra], ...result })}\n`,
    );
  return { ...result, report: JSON.parse(await readFile(join(output, "quality.json"), "utf8")) };
}

/** Runs the benchmark CLI as Task B does (plus --allow-dirty), and reads what it wrote. */
async function runLane(
  t,
  {
    baseline,
    candidate,
    corpus,
    pairs = 1,
    warmups = 0,
    extra = [],
    cwd = repoRoot,
    allowDirty = true,
    provider = "wasm",
  },
) {
  const parent = await mkdtemp(join(tmpdir(), "cutout-fake-lane-"));
  if (!process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    t.after(() => rm(parent, { force: true, recursive: true }));
  const output = join(parent, "lane");
  const args = [
    benchmarkScript,
    "--baseline-url",
    baseline.url,
    "--candidate-url",
    candidate.url,
    "--baseline-commit",
    baseline.commit,
    "--candidate-commit",
    candidate.commit,
    "--provider",
    provider,
    "--mode",
    "auto",
    "--split",
    "smoke",
    "--pairs",
    String(pairs),
    "--warmups",
    String(warmups),
    "--timeout-ms",
    "20000",
    "--manifest",
    corpus.manifestPath,
    "--output",
    output,
    ...(allowDirty ? ["--allow-dirty"] : []),
    ...extra,
  ];
  const result = await run(process.execPath, args, { cwd }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
  if (process.env.CUTOUT_BENCHMARK_KEEP_ARTIFACTS)
    await writeFile(
      join(parent, "invocation.json"),
      JSON.stringify(
        {
          command: process.execPath,
          args,
          cwd,
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          env: Object.fromEntries(
            [
              "TMPDIR",
              "npm_config_cache",
              "npm_config_logs_dir",
              "GIT_OPTIONAL_LOCKS",
              "APP_URL",
              "DEV_URL",
            ].map((key) => [key, process.env[key]]),
          ),
        },
        null,
        2,
      ),
    );
  const json = (name) => readFile(join(output, name), "utf8").then(JSON.parse, () => null);
  const runs = await readFile(join(output, "runs.jsonl"), "utf8").catch(() => "");
  return {
    ...result,
    output,
    manifest: await json("manifest.json"),
    failure: await json("failure.json"),
    rows: runs.trim()
      ? runs
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [],
  };
}

test("a lane against two stand-in apps completes and records every run (end to end)", async (t) => {
  const corpus = await fakeCorpus(t);
  const files = { [corpus.fileOf("art-c")]: { method: "illustration", provider: "fallback" } };
  const baseline = await fakeApp(t, "baseline", { files });
  const candidate = await fakeApp(t, "candidate", { files });
  const lane = await runLane(t, { baseline, candidate, corpus, pairs: 2, warmups: 1 });
  assert.equal(lane.code, 0, lane.stderr);
  assert.equal(lane.manifest.status, "completed");
  assert.equal(lane.rows.length, 2 * 2 * 3);
  for (const row of lane.rows) {
    assert.equal(row.requestedProvider, "wasm");
    assert.equal(row.actualProvider, row.fixtureId === "art-c" ? "fallback" : "wasm");
    assert.equal(
      row.outputPath !== null,
      row.pair === 0,
      `${row.fixtureId} ${row.variant} ${row.pair}`,
    );
    // C55: every measured run carries the sha256 the page computed from its result blob.
    const input = await readFile(join(corpus.dir, "input", corpus.fileOf(row.fixtureId)));
    assert.equal(row.outputSha256, hashOf(input), `${row.fixtureId} ${row.variant} ${row.pair}`);
    if (row.outputPath)
      assert.equal(hashOf(await readFile(join(lane.output, row.outputPath))), row.outputSha256);
  }
  assert.deepEqual(lane.manifest.outputIdentity, {
    rows: 12,
    references: 6,
    nondeterministic: [],
    allowed: false,
  });
  // C53 at the runner: the illustration fixture is a valid row but not latency.
  assert.deepEqual(lane.manifest.latency.exclusions.fixtureIds, ["art-c"]);
  assert.equal(lane.manifest.latency.observations, 4);
  assert.equal(baseline.state.blocks, 2);
  assert.equal(candidate.state.blocks, 2);
  // C51: the scorer finds every fixture identical (the illustration one included).
  const scored = await scoreLane(lane.output);
  assert.equal(scored.code, 0, scored.stderr);
  assert.equal(scored.report.identity.identical, 3);
  assert.deepEqual(scored.report.latency.exclusions.fixtureIds, ["art-c"]);
});

test("a provider flip mid-block names the run, keeps the block's finished rows and the offending one (S3-B-EVIDENCE-04)", async (t) => {
  const corpus = await fakeCorpus(t);
  const baseline = await fakeApp(t, "baseline");
  const candidate = await fakeApp(t, "candidate", {
    files: { [corpus.fileOf("photo-b")]: { provider: "webgpu" } },
  });
  const lane = await runLane(t, { baseline, candidate, corpus });
  assert.equal(lane.code, 1);
  assert.match(
    lane.stderr,
    /photo-b candidate pair 0: .*requested wasm but production reported webgpu/,
  );
  // Rows reach runs.jsonl as they complete: the whole baseline block, and the candidate's
  // first fixture, which finished before the flip.
  assert.deepEqual(
    lane.rows.map((row) => `${row.variant}:${row.fixtureId}`),
    ["baseline:photo-a", "baseline:photo-b", "baseline:art-c", "candidate:photo-a"],
  );
  assert.equal(lane.failure.status, "failed");
  assert.equal(lane.failure.completedRows, 4);
  assert.equal(lane.failure.error.name, "BenchmarkContractError");
  assert.deepEqual(lane.failure.error.run, { fixtureId: "photo-b", variant: "candidate", pair: 0 });
  const offending = lane.failure.error.offendingRow;
  assert.equal(offending.fixtureId, "photo-b");
  assert.equal(offending.method, "model");
  assert.equal(offending.requestedProvider, "wasm");
  assert.equal(offending.actualProvider, "webgpu");
  assert.equal(offending.removalNote, "clean");
  assert.ok(Array.isArray(offending.stages));
});

test("a later pair whose output differs from pair 0 fails the lane, or is recorded when allowed (C55)", async (t) => {
  const corpus = await fakeCorpus(t);
  // From the second block on (pair 1), the candidate returns one byte more for photo-a.
  const files = { [corpus.fileOf("photo-a")]: { extraByte: true, fromBlock: 2 } };
  const strict = await runLane(t, {
    baseline: await fakeApp(t, "baseline"),
    candidate: await fakeApp(t, "candidate", { files }),
    corpus,
    pairs: 2,
  });
  assert.equal(strict.code, 1);
  assert.match(
    strict.stderr,
    /photo-a candidate pair 1: output sha256 [0-9a-f]{64} differs from pair 0's/,
  );
  assert.deepEqual(strict.failure.error.run, {
    fixtureId: "photo-a",
    variant: "candidate",
    pair: 1,
  });
  const offending = strict.failure.error.offendingRow;
  assert.notEqual(
    offending.outputSha256,
    strict.rows.find(
      (row) => row.pair === 0 && row.variant === "candidate" && row.fixtureId === "photo-a",
    ).outputSha256,
  );
  // The differing output is kept next to pair 0's, under its pair.
  assert.equal(offending.outputPath, "outputs/candidate/pair-1/photo-a.png");
  assert.equal(
    hashOf(await readFile(join(strict.output, offending.outputPath))),
    offending.outputSha256,
  );
  // Pair 1 runs candidate first (BA): nothing of it reached runs.jsonl.
  assert.equal(strict.rows.length, 6);

  const allowed = await runLane(t, {
    baseline: await fakeApp(t, "baseline"),
    candidate: await fakeApp(t, "candidate", { files }),
    corpus,
    pairs: 2,
    extra: ["--allow-nondeterministic-outputs"],
  });
  assert.equal(allowed.code, 0, allowed.stderr);
  assert.equal(allowed.manifest.protocol.allowNondeterministicOutputs, true);
  assert.equal(allowed.rows.length, 12);
  assert.deepEqual(
    allowed.manifest.outputIdentity.nondeterministic.map(
      ({ fixtureId, variant, pair }) => `${fixtureId} ${variant} ${pair}`,
    ),
    ["photo-a candidate 1"],
  );
  // The scorer honours what the lane declared, and reports it.
  const scored = await scoreLane(allowed.output);
  assert.equal(scored.code, 0, scored.stderr);
  assert.equal(scored.report.outputNondeterminism.allowed, true);
  assert.equal(scored.report.outputNondeterminism.nondeterministic.length, 1);
});

test("served bytes must be the checkout's build, at a clean checkout of the named commit (C54)", async (t) => {
  const app = await fakeApp(t, "candidate");
  const options = { checkoutDir: app.dir, expectedCommit: app.commit, timeoutMs: 5_000 };
  const served = await servedBuild(app.url, options);
  assert.equal(served.checkout.head, app.commit);
  assert.deepEqual(served.checkout.dirtyPaths, []);
  // The client and worker builds: every file under .output/public/assets, plus the page.
  assert.deepEqual(served.checkout.files, [
    "/",
    "/assets/app-1.js",
    "/assets/removal-worker-1.js",
    "/version.json",
  ]);
  assert.match(served.checkout.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await servedBuild(app.url, options), served);

  // A server answering with other worker bytes than its checkout built.
  app.state.served.set("/assets/removal-worker-1.js", "postMessage(2);\n");
  await assert.rejects(
    servedBuild(app.url, options),
    /\/assets\/removal-worker-1\.js \(bytes differ\)/,
  );
  app.state.served.clear();
  // A built file the server does not serve.
  await writeFile(join(app.publicDir, "assets/lazy-2.js"), "export {};\n");
  app.state.served.set("/assets/lazy-2.js", null);
  await assert.rejects(servedBuild(app.url, options), /\/assets\/lazy-2\.js \(HTTP 404\)/);
  await rm(join(app.publicDir, "assets/lazy-2.js"));
  app.state.served.clear();
  // Precompressed siblings are the same bytes in another encoding, not separate files.
  await writeFile(join(app.publicDir, "assets/app-1.js.br"), "not served by name");
  assert.deepEqual((await servedBuild(app.url, options)).checkout.files, served.checkout.files);

  // The checkout must be the named commit, and clean unless dirt is allowed (then recorded).
  await assert.rejects(
    servedBuild(app.url, { ...options, expectedCommit: "f".repeat(40) }),
    /HEAD .* is not f{40}/,
  );
  await writeFile(join(app.dir, "stray.txt"), "edit\n");
  await assert.rejects(servedBuild(app.url, options), /checkout .* is dirty: \?\? stray\.txt/);
  const dirty = await servedBuild(app.url, { ...options, allowDirty: true });
  assert.deepEqual(dirty.checkout.dirtyPaths, ["?? stray.txt"]);

  // Without a checkout only /version.json and the page are fingerprinted, and compared later.
  const bare = await servedBuild(app.url, { timeoutMs: 5_000 });
  assert.equal(bare.checkout, null);
  app.state.served.set("/version.json", JSON.stringify({ version: "0.2.0", commit: app.commit }));
  assert.deepEqual(servedBuildChanges(bare, await servedBuild(app.url, { timeoutMs: 5_000 })), [
    "/version.json",
  ]);
});

test("a lane verifies served bytes against each checkout, and fails if a server changes before it ends (C54)", async (t) => {
  const corpus = await fakeCorpus(t);
  const baseline = await fakeApp(t, "baseline");
  const candidate = await fakeApp(t, "candidate");
  const lane = await runLane(t, {
    baseline,
    candidate,
    corpus,
    cwd: baseline.dir,
    allowDirty: false,
    extra: ["--baseline-dir", baseline.dir, "--candidate-dir", candidate.dir],
  });
  assert.equal(lane.code, 0, lane.stderr);
  assert.equal(lane.manifest.sources.servedBytesVerified, true);
  assert.equal(lane.manifest.sources.releaseEligible, true);
  assert.deepEqual(lane.manifest.sources.releaseIneligibleReasons, []);
  for (const variant of ["baseline", "candidate"]) {
    const served = lane.manifest.sources[variant].served;
    assert.equal(served.checkout.head, variant === "baseline" ? baseline.commit : candidate.commit);
    assert.equal(served.checkout.files.length, 4);
    assert.equal(served.recheckedAtLaneEnd, true);
  }

  // Task B as written (no checkout flags): a candidate server whose page changes after its
  // block has started fails the lane at the end, with every row kept.
  const swapped = await runLane(t, {
    baseline: await fakeApp(t, "baseline"),
    candidate: await fakeApp(t, "candidate", {
      swap: { atBlock: 1, served: { "/": "<!doctype html>other build" } },
    }),
    corpus,
  });
  assert.equal(swapped.code, 1);
  assert.match(
    swapped.stderr,
    /candidate \(lane end\): the served build changed during the lane: \//,
  );
  assert.deepEqual(swapped.failure.error.run, { variant: "candidate", phase: "lane end" });
  assert.equal(swapped.rows.length, 6);
  assert.equal(swapped.failure.sources.servedBytesVerified, false);
  assert.equal(swapped.failure.sources.releaseEligible, false);

  // A mistyped flag fails instead of silently skipping the check.
  const typo = await run(process.execPath, [
    benchmarkScript,
    "--candidate-dirs",
    candidate.dir,
  ]).catch((error) => error);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /Unknown option --candidate-dirs/);
});

for (const allowDirty of [false, true]) {
  test(`runner package-lock dirt introduced mid-lane blocks release eligibility${allowDirty ? " with --allow-dirty" : ""} (C54)`, async (t) => {
    const corpus = await fakeCorpus(t);
    const runner = await fakeCheckout(t, "runner");
    const baseline = await fakeApp(t, "baseline");
    const candidate = await fakeApp(t, "candidate", {
      onBlock: () => writeFile(join(runner.dir, "package-lock.json"), "{}\n"),
    });
    const lane = await runLane(t, {
      baseline,
      candidate,
      corpus,
      cwd: runner.dir,
      allowDirty,
      extra: ["--baseline-dir", baseline.dir, "--candidate-dir", candidate.dir],
    });
    assert.equal(lane.code, 0, lane.stderr);
    assert.equal(lane.manifest.status, "completed");
    assert.equal(lane.rows.length, 6);
    assert.deepEqual(lane.manifest.sources.dirtyPaths, []);
    assert.equal(lane.manifest.sources.servedBytesVerified, true);
    assert.match(await git(runner.dir, "status", "--porcelain=v1"), /M package-lock\.json/);
    assert.equal(lane.manifest.sources.releaseEligible, false);
    assert.deepEqual(lane.manifest.sources.releaseIneligibleReasons, ["runner-checkout-dirty"]);
    assert.deepEqual(lane.manifest.sources.dirtyPathsAtLaneEnd, ["M package-lock.json"]);
  });
}

test("a worker-only swap without checkout flags cannot produce a release-eligible lane (C54)", async (t) => {
  const corpus = await fakeCorpus(t);
  const baseline = await fakeApp(t, "baseline");
  const candidate = await fakeApp(t, "candidate", {
    swap: { atBlock: 1, served: { "/assets/removal-worker-1.js": "postMessage(99);\n" } },
  });
  const lane = await runLane(t, {
    baseline,
    candidate,
    corpus,
    pairs: 2,
    cwd: baseline.dir,
    allowDirty: false,
  });
  assert.equal(lane.code, 0, lane.stderr);
  assert.equal(lane.manifest.status, "completed");
  assert.equal(lane.rows.length, 12);
  assert.deepEqual(lane.manifest.sources.dirtyPaths, []);
  assert.equal(lane.manifest.sources.servedBytesVerified, false);
  // The legacy fingerprint misses this swap; full checkout verification detects it.
  for (const variant of ["baseline", "candidate"]) {
    const served = lane.manifest.sources[variant].served;
    assert.equal(served.recheckedAtLaneEnd, true);
    assert.deepEqual(
      servedBuildChanges(
        served,
        await servedBuild(variant === "baseline" ? baseline.url : candidate.url, {
          timeoutMs: 5_000,
        }),
      ),
      [],
    );
  }
  await assert.rejects(
    servedBuild(candidate.url, {
      checkoutDir: candidate.dir,
      expectedCommit: candidate.commit,
      timeoutMs: 5_000,
    }),
    /removal-worker-1\.js \(bytes differ\)/,
  );
  assert.equal(lane.manifest.sources.releaseEligible, false);
  assert.deepEqual(lane.manifest.sources.releaseIneligibleReasons, [
    "baseline-checkout-unverified",
    "candidate-checkout-unverified",
  ]);
});

test("both checkout flags are required for release eligibility (C54)", async (t) => {
  const corpus = await fakeCorpus(t);
  const baseline = await fakeApp(t, "baseline");
  const candidate = await fakeApp(t, "candidate");
  for (const verified of ["baseline", "candidate"]) {
    const app = verified === "baseline" ? baseline : candidate;
    const lane = await runLane(t, {
      baseline,
      candidate,
      corpus,
      cwd: baseline.dir,
      allowDirty: false,
      extra: [`--${verified}-dir`, app.dir],
    });
    assert.equal(lane.code, 0, lane.stderr);
    assert.deepEqual(lane.manifest.sources.dirtyPaths, []);
    assert.equal(lane.manifest.sources.servedBytesVerified, false);
    assert.equal(lane.manifest.sources.releaseEligible, false);
    assert.deepEqual(lane.manifest.sources.releaseIneligibleReasons, [
      `${verified === "baseline" ? "candidate" : "baseline"}-checkout-unverified`,
    ]);
  }
});

test("help documents the checkout flags required for release eligibility (C54)", async () => {
  const { stdout } = await run(process.execPath, [benchmarkScript, "--help"]);
  assert.match(stdout, /Release eligibility requires both --baseline-dir and --candidate-dir/);
  assert.match(stdout, /Without both flags, the lane is runnable but explicitly non-release/);
});

// Quality policies authorize a fixture/path from the pinned corpus, never from row claims.
function qualityPolicyRecord(
  fixtures,
  {
    mode = "maximum",
    manifestSha256 = sha,
    baselineCommit = "b".repeat(40),
    candidateCommit = "c".repeat(40),
  } = {},
) {
  const policy = {
    schemaVersion: 1,
    purpose: "known-alpha-quality-capture",
    corpusManifestSha256: manifestSha256,
    baselineCommit,
    candidateCommit,
    split: "smoke",
    mode,
    requestedProvider: "webgpu",
    expectations: [
      {
        fixtureId: fixtures[0].id,
        method: "model",
        actualProvider: "wasm",
        route: "primary-processing-then-compatibility",
      },
    ],
  };
  const json = JSON.stringify(policy);
  return { json, sha256: hashOf(json) };
}

function qualityBinding(record, fixtures) {
  const policy = JSON.parse(record.json);
  return {
    expectedSha256: record.sha256,
    manifestSha256: sha,
    fixtures,
    split: "smoke",
    mode: "maximum",
    requestedProvider: "webgpu",
    baselineCommit: policy.baselineCommit,
    candidateCommit: policy.candidateCommit,
  };
}

function observedRoute() {
  return {
    source: "worker-messages-v1",
    primaryExecutedProvider: null,
    gpu: { available: true },
    jobs: [
      {
        workerUrl: "http://127.0.0.1/assets/removal-worker.js",
        jobId: 1,
        fileName: "synthetic.png",
        mode: "maximum",
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

const qualityFixtures = [
  { id: "synthetic", evaluation: "known-alpha", input: { path: "input/synthetic.png" } },
];

function qualityRows(record) {
  return pairRows(0, "synthetic", "synthetic", 10, 11).map((row) => ({
    ...row,
    evaluation: "known-alpha",
    removalMode: "maximum",
    requestedProvider: "webgpu",
    actualProvider: "wasm",
    capturePurpose: "quality-only",
    qualityPolicySha256: record.sha256,
    commit: row.variant === "baseline" ? "b".repeat(40) : "c".repeat(40),
    routeEvidence: observedRoute(),
  }));
}

test("explicit pinned quality capture retains a model/WASM compatibility pair without performance eligibility", () => {
  const record = qualityPolicyRecord(qualityFixtures);
  const qualityCapture = qualityCapturePolicy(record, qualityBinding(record, qualityFixtures));
  const rows = qualityRows(record);
  assert.doesNotThrow(() => validateCompletedRuns(rows, ["synthetic"], 1, { qualityCapture }));
  assert.throws(() => pairedLatency(rows), /quality-only/);
  for (const row of rows) assert.throws(() => checkRunRow(row), /quality-only/);
  const unmarked = rows.map(({ capturePurpose: _p, qualityPolicySha256: _h, ...row }) => row);
  assert.throws(
    () => validateCompletedRuns(unmarked, ["synthetic"], 1),
    /requested webgpu.*reported wasm/,
  );
  assert.throws(() => pairedLatency(unmarked), /requested webgpu.*reported wasm/);
});

test("quality authorization rejects real-photo, undeclared, changed binding, malformed policy and row self-authorization", () => {
  const record = qualityPolicyRecord(qualityFixtures);
  const binding = qualityBinding(record, qualityFixtures);
  for (const patch of [
    { expectedSha256: "d".repeat(64) },
    { manifestSha256: "d".repeat(64) },
    { mode: "auto" },
    { requestedProvider: "wasm" },
    { split: "tune" },
    { baselineCommit: "d".repeat(40) },
    { candidateCommit: "d".repeat(40) },
    { fixtures: [{ ...qualityFixtures[0], evaluation: "real-alpha" }] },
    { fixtures: [] },
  ]) {
    assert.throws(() => qualityCapturePolicy(record, { ...binding, ...patch }));
  }
  for (const change of [
    (p) => p.expectations.push(p.expectations[0]),
    (p) => (p.expectations[0].route = "compat"),
    (p) => (p.allowFallback = true),
  ]) {
    const policy = JSON.parse(record.json);
    change(policy);
    const json = JSON.stringify(policy),
      invalid = { json, sha256: hashOf(json) };
    assert.throws(() =>
      qualityCapturePolicy(invalid, { ...binding, expectedSha256: invalid.sha256 }),
    );
  }
  assert.throws(() => qualityCapturePolicy({ ...record, json: record.json + " " }, binding));
  const rows = qualityRows(record);
  assert.throws(
    () => validateCompletedRuns(rows, ["synthetic"], 1, { qualityCapture: record }),
    /unverified quality/,
  );
  const qualityCapture = qualityCapturePolicy(record, binding);
  for (const patch of [
    { fixtureId: "other" },
    { evaluation: "real-alpha" },
    { removalMode: "auto" },
    { method: "illustration" },
    { actualProvider: "webgpu" },
    { requestedProvider: "wasm" },
    { qualityPolicySha256: "d".repeat(64) },
    { capturePurpose: undefined },
  ])
    assert.throws(() => checkRunRow({ ...rows[0], ...patch }, undefined, qualityCapture));
});

test("quality route needs observed ordered primary/compat processing and the matching worker result", () => {
  const record = qualityPolicyRecord(qualityFixtures);
  const context = qualityCapturePolicy(record, qualityBinding(record, qualityFixtures));
  for (const change of [
    (r) => (r.routeEvidence = undefined),
    (r) => (r.routeEvidence.jobs = []),
    (r) => r.routeEvidence.jobs[0].progress.splice(0, 1),
    (r) => r.routeEvidence.jobs[0].progress.pop(),
    (r) =>
      r.routeEvidence.jobs[0].progress.unshift(r.routeEvidence.jobs[0].progress.splice(1, 1)[0]),
    (r) => (r.routeEvidence.jobs[0].noWebgpu = true),
    (r) => (r.routeEvidence.jobs[0].outcome.workerHadGpu = false),
    (r) => (r.routeEvidence.jobs[0].fileName = "other.png"),
    (r) => (r.routeEvidence.jobs[0].mode = "auto"),
    (r) => (r.routeEvidence.jobs[0].outcome.provider = "webgpu"),
    (r) => (r.routeEvidence.gpu.available = false),
    (r) => (r.routeEvidence.primaryExecutedProvider = "webgpu"),
  ]) {
    const row = qualityRows(record)[0];
    change(row);
    assert.throws(() => checkRunRow(row, undefined, context), /route evidence/);
  }
});

async function qualityLane(
  t,
  { candidateFiles = {}, baselineFiles = {}, pairs = 1, extra = [] } = {},
) {
  const corpus = await fakeCorpus(t);
  const files = { "photo-a.png": { compat: true, provider: "wasm" } };
  const baseline = await fakeApp(t, "quality-baseline", {
    provider: "webgpu",
    files: { ...files, ...baselineFiles },
  });
  const candidate = await fakeApp(t, "quality-candidate", {
    provider: "webgpu",
    files: { ...files, ...candidateFiles },
  });
  const record = qualityPolicyRecord([{ id: "photo-a" }], {
    mode: "auto",
    manifestSha256: hashOf(await readFile(corpus.manifestPath)),
    baselineCommit: baseline.commit,
    candidateCommit: candidate.commit,
  });
  const policyPath = join(corpus.dir, "quality-policy.json");
  await writeFile(policyPath, record.json);
  const lane = await runLane(t, {
    baseline,
    candidate,
    corpus,
    pairs,
    cwd: baseline.dir,
    allowDirty: false,
    provider: "webgpu",
    extra: [
      "--baseline-dir",
      baseline.dir,
      "--candidate-dir",
      candidate.dir,
      "--quality-policy",
      policyPath,
      "--quality-policy-sha256",
      record.sha256,
      ...extra,
    ],
  });
  return { ...lane, record, baseline, candidate, corpus, policyPath };
}

test("quality-only CLI/browser/scorer retains a declared compatibility pair and disables all timing eligibility", async (t) => {
  const lane = await qualityLane(t, { pairs: 2 });
  assert.equal(lane.code, 0, lane.stderr);
  assert.equal(lane.rows.length, 12);
  assert.equal(lane.manifest.protocol.purpose, "quality-only");
  assert.equal(lane.manifest.latency, null);
  assert.equal(lane.manifest.performance.eligible, false);
  assert.equal(lane.manifest.sources.releaseEligible, false);
  assert.deepEqual(lane.manifest.sources.releaseIneligibleReasons, [
    "quality-only-no-performance-or-release-eligibility",
  ]);
  assert.equal(lane.manifest.sources.servedBytesVerified, true);
  for (const variant of ["baseline", "candidate"]) {
    const row = lane.rows.find((row) => row.fixtureId === "photo-a" && row.variant === variant);
    assert.equal(row.requestedProvider, "webgpu");
    assert.equal(row.actualProvider, "wasm");
    assert.equal(row.method, "model");
    assert.equal(row.routeEvidence.primaryExecutedProvider, null);
    assert.equal(row.routeEvidence.jobs[0].progress.length, 3);
    assert.equal(row.routeEvidence.jobs[0].outcome.provenance, null); // No fabricated baseline provenance.
  }
  assert.throws(() => pairedLatency(lane.rows), /quality-only/);
  const scored = await scoreLane(lane.output, ["--quality-policy-sha256", lane.record.sha256]);
  assert.equal(scored.code, 0, scored.stderr);
  assert.equal(scored.report.identity.identical, 3);
  assert.equal(scored.report.latency, null);
  assert.equal(scored.report.performance.eligible, false);
  const noPin = await run(process.execPath, [qualityScript, "--benchmark", lane.output]).catch(
    (error) => error,
  );
  assert.equal(noPin.code, 1);
  assert.match(noPin.stderr, /policy SHA-256/);
  const differences = await run(process.execPath, [
    qualityScript,
    "--benchmark",
    lane.output,
    "--quality-policy-sha256",
    lane.record.sha256,
    "--allow-output-differences",
  ]).catch((error) => error);
  assert.equal(differences.code, 1);
  assert.match(differences.stderr, /strict output identity/);
});

test("quality-only capture rejects missing route and wrong method/provider with named saved offending output", async (t) => {
  for (const side of ["baseline", "candidate"]) {
    for (const patch of [
      { missingRoute: true },
      { method: "illustration" },
      { provider: "webgpu" },
    ]) {
      const lane = await qualityLane(t, {
        [`${side}Files`]: { "photo-a.png": { compat: true, provider: "wasm", ...patch } },
      });
      assert.equal(lane.code, 1, lane.stdout);
      assert.deepEqual(lane.failure.error.run, { fixtureId: "photo-a", variant: side, pair: 0 });
      const row = lane.failure.error.offendingRow;
      assert.equal(hashOf(await readFile(join(lane.output, row.outputPath))), row.outputSha256);
      assert.equal(lane.rows.length, side === "baseline" ? 0 : 3);
      assert.match(lane.stderr, /route evidence|declared method\/provider path/);
    }
  }
});

test("quality-only capture keeps undeclared provider flips strict and cross-pair byte changes fatal", async (t) => {
  const undeclared = await qualityLane(t, {
    candidateFiles: { "photo-b.png": { compat: true, provider: "wasm" } },
  });
  assert.equal(undeclared.code, 1);
  assert.match(undeclared.stderr, /photo-b candidate pair 0: .*requested webgpu.*reported wasm/);
  assert.equal(undeclared.rows.length, 4);
  const changed = await qualityLane(t, {
    pairs: 2,
    candidateFiles: {
      "photo-a.png": { compat: true, provider: "wasm", extraByte: true, extraByteFromBlock: 2 },
    },
  });
  assert.equal(changed.code, 1);
  assert.match(changed.stderr, /photo-a candidate pair 1: output sha256.*differs from pair 0/);
  const row = changed.failure.error.offendingRow;
  assert.equal(hashOf(await readFile(join(changed.output, row.outputPath))), row.outputSha256);
  const waived = await qualityLane(t, { extra: ["--allow-nondeterministic-outputs"] });
  assert.equal(waived.code, 1);
  assert.match(waived.stderr, /strict output identity/);
});

test("quality-only CLI/browser/scorer preserves PNG and RGBA mismatch failures with actual saved files", async (t) => {
  for (const changePixels of [false, true]) {
    const pixels = Buffer.alloc(4 * 4 * 4);
    for (let pixel = 0; pixel < 16; pixel += 1)
      pixels.set([0, 20 * pixel, 255 - 10 * pixel, pixel % 4 === 0 ? 0 : 17 * pixel], pixel * 4);
    if (changePixels) pixels[7] = 255;
    const bytes = await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const lane = await qualityLane(t, {
      candidateFiles: {
        "photo-a.png": { compat: true, provider: "wasm", outputBase64: bytes.toString("base64") },
      },
    });
    assert.equal(lane.code, 0, lane.stderr);
    const scored = await scoreLane(lane.output, ["--quality-policy-sha256", lane.record.sha256]);
    assert.equal(scored.code, 1);
    assert.match(scored.stderr, /photo-a.*PNG bytes differ/);
    assert.deepEqual(scored.report.identity.differing, [
      {
        fixtureId: "photo-a",
        problems: changePixels
          ? ["PNG bytes differ", "decoded RGBA differs"]
          : ["PNG bytes differ"],
      },
    ]);
    assert.equal(
      hashOf(await readFile(join(lane.output, "outputs/candidate/photo-a.png"))),
      hashOf(bytes),
    );
  }
});

test("the declared quality path supports each removal mode without accepting another mode", () => {
  for (const mode of ["quick", "auto", "maximum"]) {
    const record = qualityPolicyRecord(qualityFixtures, { mode });
    const context = qualityCapturePolicy(record, {
      ...qualityBinding(record, qualityFixtures),
      mode,
    });
    const rows = qualityRows(record);
    for (const row of rows) {
      row.removalMode = mode;
      row.routeEvidence.jobs[0].mode = mode;
    }
    assert.doesNotThrow(() =>
      validateCompletedRuns(rows, ["synthetic"], 1, { qualityCapture: context }),
    );
    rows[0].removalMode = mode === "auto" ? "quick" : "auto";
    assert.throws(
      () => validateCompletedRuns(rows, ["synthetic"], 1, { qualityCapture: context }),
      /corpus\/lane identity/,
    );
  }
});

test("quality-only authorization keeps real-photo provider failures and completeness/uniqueness/hash checks strict", () => {
  const fixtures = [
    ...qualityFixtures,
    { id: "real-photo", evaluation: "real-alpha", input: { path: "input/real.png" } },
  ];
  const record = qualityPolicyRecord(fixtures);
  const context = qualityCapturePolicy(record, qualityBinding(record, fixtures));
  const rows = qualityRows(record);
  assert.throws(
    () =>
      checkRunRow(
        { ...rows[0], fixtureId: "real-photo", evaluation: "real-alpha" },
        undefined,
        context,
      ),
    /requested webgpu.*reported wasm/,
  );
  const options = { qualityCapture: context };
  assert.throws(
    () => validateCompletedRuns(rows.slice(0, 1), ["synthetic"], 1, options),
    /missing candidate/,
  );
  assert.throws(
    () => validateCompletedRuns([...rows, rows[0]], ["synthetic"], 1, options),
    /duplicate run/,
  );
  assert.throws(
    () =>
      validateCompletedRuns(
        [{ ...rows[0], outputSha256: undefined }, rows[1]],
        ["synthetic"],
        1,
        options,
      ),
    /no outputSha256/,
  );
  assert.throws(
    () =>
      validateCompletedRuns(
        [{ ...rows[0], commit: "d".repeat(40) }, rows[1]],
        ["synthetic"],
        1,
        options,
      ),
    /source commit/,
  );
});
