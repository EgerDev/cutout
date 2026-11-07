import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { launchChromeContext } from "../chrome.mjs";
import { BenchmarkContractError, checkRunRow, inRun } from "./contract.mjs";
import {
  combinedNetworkSummary,
  observeContextNetwork,
  observeNetwork,
} from "./network-telemetry.mjs";

export function providerLaunchArgs(requestedProvider) {
  return requestedProvider === "webgpu"
    ? ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"]
    : ["--disable-gpu"];
}

async function environment(page, cdp, requestedProvider) {
  const browser = await cdp.send("Browser.getVersion");
  const metrics = await cdp.send("Performance.getMetrics");
  const surface = await page.evaluate(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemoryGiB: navigator.deviceMemory ?? null,
      crossOriginIsolated,
      gpu: adapter
        ? {
            available: true,
            vendor: adapter.info?.vendor ?? null,
            architecture: adapter.info?.architecture ?? null,
          }
        : { available: false, reason: "navigator.gpu or a compatible adapter was unavailable" },
    };
  });
  if (requestedProvider === "webgpu" && !surface.gpu.available)
    throw new BenchmarkContractError("WebGPU was required but no compatible adapter is available");
  return {
    browser: browser.product,
    protocolVersion: browser.protocolVersion,
    ...surface,
    initialJsHeapBytes:
      metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null,
    nativeMemory: {
      value: null,
      reason: "Chrome CDP does not expose process-native peak RSS per removal",
    },
    gpuMemory: { value: null, reason: "WebGPU does not expose portable peak allocation telemetry" },
  };
}

async function poll(page, predicate, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, value)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new BenchmarkContractError(`Browser condition timed out after ${timeoutMs} ms`);
}

// Observe the existing worker protocol before application listeners throttle store progress.
// This forwards every call/message unchanged and records only run metadata/progress/result
// fields. It cannot attest the native provider of the baseline's primary inference.
export async function observeQualityRoute(context) {
  await context.addInitScript(() => {
    window.__benchmarkWorkerJobs = [];
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {
      construct(Target, args) {
        const worker = new Target(...args);
        const jobs = new Map();
        const post = worker.postMessage.bind(worker);
        worker.postMessage = (...messages) => {
          const data = messages[0];
          if (data?.type === "run") {
            const job = {
              workerUrl: String(args[0]),
              jobId: data.id,
              fileName: data.file?.name,
              mode: data.mode,
              noWebgpu: Boolean(data.noWebgpu),
              progress: [],
            };
            jobs.set(data.id, job);
            window.__benchmarkWorkerJobs.push(job);
          }
          return post(...messages);
        };
        worker.addEventListener("message", ({ data }) => {
          const job = jobs.get(data?.id);
          if (!job) return;
          if (data.type === "progress") job.progress.push({ ...data.progress });
          if (data.type === "done" || data.type === "error") {
            job.outcome = {
              type: data.type,
              method: data.result?.method,
              provider: data.result?.provider,
              workerHadGpu: data.result?.workerHadGpu,
              provenance: data.result?.provenance ?? null,
            };
            jobs.delete(data.id);
          }
        });
        return worker;
      },
    });
  });
}

// Derived from actual messages, independently checked by the contract on live and saved rows.
export function qualityCaptureFields(options, fixture, result, gpu) {
  if (!options.qualityCapture) return {};
  const progress = result.workerJobs?.[0]?.progress;
  const switchIndex = Array.isArray(progress)
    ? progress.findIndex(
        (event) =>
          event?.stage === "loading" && event.message === "Switching to compatibility mode",
      )
    : -1;
  const compatibilityObserved =
    switchIndex >= 0 &&
    progress
      .slice(switchIndex + 1)
      .some((event) => event?.stage === "cutting" && event.message === "Finding subject");
  return {
    capturePurpose: "quality-only",
    qualityPolicySha256: options.qualityCapture.sha256,
    variant: options.variant,
    commit: options[`${options.variant}Commit`],
    evaluation: fixture.evaluation,
    removalMode: result.removalMode,
    routeEvidence: {
      source: "worker-messages-v1",
      gpu,
      jobs: result.workerJobs,
      primaryExecutedProvider: null,
      compatibilityProcessing: compatibilityObserved ? "observed" : "not-observed",
      limitation:
        "Worker messages are observations, not native primary-provider attestation; the baseline primary inference provider is unavailable. requestedProvider is the initial process lane." +
        (compatibilityObserved
          ? ""
          : " Post-switch compatibility processing is not observed/unavailable in these worker messages."),
    },
  };
}

async function captureResult(page, fixture, timeoutMs, saveOutput, expectedSha256 = null) {
  const existingIds = await page.evaluate(() =>
    window.__cutoutTest.useWorkspace.getState().items.map((item) => item.id),
  );
  await page.evaluate((previous) => {
    window.__benchmarkStages = [];
    if (window.__benchmarkWorkerJobs) window.__benchmarkWorkerJobs = [];
    window.__benchmarkStarted = performance.now();
    window.__benchmarkCompletedAt = null;
    window.__benchmarkStop?.();
    const initialProgress = window.__cutoutTest.useWorkspace.getState().progress;
    let lastMessage = initialProgress ? `${initialProgress.stage}:${initialProgress.message}` : "";
    window.__benchmarkStop = window.__cutoutTest.useWorkspace.subscribe((state) => {
      const active = state.items.find((entry) => entry.id === state.activeId);
      if (!active || previous.includes(active.id)) return;
      if (active.status === "done" || active.status === "error") {
        if (window.__benchmarkCompletedAt === null)
          window.__benchmarkCompletedAt = performance.now();
        return;
      }
      const progress = state.progress;
      if (!progress || `${progress.stage}:${progress.message}` === lastMessage) return;
      lastMessage = `${progress.stage}:${progress.message}`;
      window.__benchmarkStages.push({
        atMs: performance.now() - window.__benchmarkStarted,
        stage: progress.stage,
        progress: progress.progress,
        message: progress.message,
      });
    });
  }, existingIds);
  await page.getByLabel("Choose files", { exact: true }).setInputFiles(fixture.inputPath);
  await poll(
    page,
    ({ name, previous }) => {
      const item = window.__cutoutTest.useWorkspace
        .getState()
        .items.find((entry) => entry.name === name && !previous.includes(entry.id));
      return Boolean(item && (item.status === "done" || item.status === "error"));
    },
    { name: fixture.input.path.split(/[\\/]/).at(-1), previous: existingIds },
    timeoutMs,
  );
  return page.evaluate(
    async ({ name, includeBytes, expected, previous }) => {
      const state = window.__cutoutTest.useWorkspace.getState();
      const item = state.items.find((entry) => entry.name === name && !previous.includes(entry.id));
      window.__benchmarkStop?.();
      if (!item)
        return {
          status: "error",
          error: "Completed item disappeared",
          stages: window.__benchmarkStages,
        };
      if (item.status === "error")
        return {
          status: "error",
          error: item.error ?? "Removal failed",
          stages: window.__benchmarkStages,
        };
      const completeMs =
        (window.__benchmarkCompletedAt ?? performance.now()) - window.__benchmarkStarted;
      // Every result is hashed here, after completeMs is taken. Its bytes leave the page only
      // to be saved: pair 0's, and any later run whose hash differs from pair 0's (C55).
      let outputSha256 = null;
      let outputBase64 = null;
      if (item.resultBlob) {
        if (!globalThis.crypto?.subtle)
          throw new Error(
            "crypto.subtle is unavailable (not a secure context); the output cannot be hashed",
          );
        const bytes = new Uint8Array(await item.resultBlob.arrayBuffer());
        const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
        outputSha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
        if (includeBytes || (expected !== null && outputSha256 !== expected)) {
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32_768)
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
          outputBase64 = btoa(binary);
        }
      }
      return {
        status: "completed",
        completeMs,
        appDurationMs: item.durationMs,
        removalMode: state.removalMode,
        provider: item.provider,
        method: item.method,
        width: item.width,
        height: item.height,
        diagnostics: item.diagnostics ?? null,
        removalNote: item.removalNote ?? null,
        stages: window.__benchmarkStages,
        outputSha256,
        outputBase64,
        workerJobs: window.__benchmarkWorkerJobs ?? null,
      };
    },
    {
      name: fixture.input.path.split(/[\\/]/).at(-1),
      includeBytes: saveOutput,
      expected: expectedSha256,
      previous: existingIds,
    },
  );
}

/** What a failed removal reported, for failure.json. */
function failedRow(fixture, result) {
  return {
    fixtureId: fixture.id,
    status: result.status,
    error: result.error,
    stages: result.stages,
  };
}

/**
 * One variant's block of one pair. Each measured row is checked as soon as it is complete and
 * handed to options.onRow (the lane appends it to runs.jsonl), so a contract failure later in
 * the block loses nothing that finished; the error names the run and carries its row.
 */
export async function runVariantBlock(options) {
  const args = providerLaunchArgs(options.requestedProvider);
  const context = await launchChromeContext(options.profileDirectory, {
    args,
    viewport: { width: 1350, height: 940 },
  });
  const abort = () => context.close();
  options.signal.addEventListener("abort", abort, { once: true });
  const page = await context.newPage();
  page.on("dialog", (dialog) => void dialog.accept());
  let activeFixture = "startup";
  const block = { variant: options.variant, pair: options.pair };
  let where = { ...block, phase: "startup" };
  const contextTelemetry = observeContextNetwork(context, () => activeFixture);
  let cdp;
  let telemetry;
  try {
    if (options.qualityCapture) await observeQualityRoute(context);
    cdp = await context.newCDPSession(page);
    telemetry = await observeNetwork(cdp, () => activeFixture);
    await page.goto(new URL("/?e2e", options.url).href, {
      waitUntil: "networkidle",
      timeout: options.timeoutMs,
    });
    await poll(page, () => Boolean(window.__cutoutTest?.useWorkspace), null, options.timeoutMs);
    await page.evaluate(
      (mode) => window.__cutoutTest.useWorkspace.getState().setRemovalMode(mode),
      options.mode,
    );
    const browserEnvironment = await environment(page, cdp, options.requestedProvider);
    const qualityFields = (fixture, result) =>
      qualityCaptureFields(options, fixture, result, browserEnvironment.gpu);
    for (let warmup = 0; warmup < options.warmups; warmup += 1) {
      activeFixture = `warmup-${warmup}`;
      const fixture = options.fixtures[warmup % options.fixtures.length];
      where = { fixtureId: fixture.id, ...block, phase: `warmup ${warmup}` };
      const result = await captureResult(page, fixture, options.timeoutMs, false);
      if (result.status !== "completed")
        throw new BenchmarkContractError(
          `Warmup failed: ${result.error}`,
          where,
          failedRow(fixture, result),
        );
      if (result.removalMode !== options.mode)
        throw new BenchmarkContractError(
          `Warmup changed removal mode from ${options.mode} to ${result.removalMode}`,
          where,
        );
      checkRunRow(
        {
          fixtureId: fixture.id,
          method: result.method,
          requestedProvider: options.requestedProvider,
          actualProvider: result.provider,
          removalNote: result.removalNote,
          stages: result.stages,
          ...qualityFields(fixture, result),
        },
        where,
        options.qualityCapture,
      );
      await contextTelemetry.waitForSettled(activeFixture, Math.min(options.timeoutMs, 5_000));
    }
    const rows = [];
    for (const fixture of options.fixtures) {
      options.signal.throwIfAborted();
      activeFixture = fixture.id;
      where = { fixtureId: fixture.id, ...block };
      const result = await captureResult(
        page,
        fixture,
        options.timeoutMs,
        options.saveOutputs,
        options.referenceOutputs?.get(fixture.id) ?? null,
      );
      if (result.status !== "completed")
        throw new BenchmarkContractError(
          `removal failed: ${result.error}`,
          where,
          failedRow(fixture, result),
        );
      await contextTelemetry.waitForSettled(fixture.id, Math.min(options.timeoutMs, 5_000));
      const metrics = await cdp.send("Performance.getMetrics");
      let outputPath = null;
      if (result.outputBase64) {
        // Pair 0 keeps the path the scorer reads; a later pair's differing output sits beside it.
        const directory = join(
          "outputs",
          options.variant,
          ...(options.pair === 0 ? [] : [`pair-${options.pair}`]),
        );
        // outputPath is an artifact identifier inside the bundle, recorded in
        // runs.jsonl/manifest — always POSIX separators, even on Windows.
        outputPath = join(directory, `${fixture.id}.png`).replaceAll(sep, "/");
        const bytes = Buffer.from(result.outputBase64, "base64");
        if (createHash("sha256").update(bytes).digest("hex") !== result.outputSha256)
          throw new BenchmarkContractError(
            "saved output bytes do not match the sha256 the page computed",
            where,
          );
        await mkdir(join(options.outputDirectory, directory), { recursive: true });
        await writeFile(join(options.outputDirectory, outputPath), bytes);
      }
      const row = {
        fixtureId: fixture.id,
        category: fixture.category,
        evaluation: fixture.evaluation,
        status: result.status,
        completeMs: result.completeMs,
        appDurationMs: result.appDurationMs,
        removalMode: result.removalMode,
        requestedProvider: options.requestedProvider,
        actualProvider: result.provider,
        method: result.method,
        dimensions: [result.width, result.height],
        stages: result.stages,
        diagnostics: result.diagnostics,
        removalNote: result.removalNote,
        outputSha256: result.outputSha256,
        requests: combinedNetworkSummary(
          telemetry.entriesFor(fixture.id),
          contextTelemetry.entriesFor(fixture.id),
        ),
        resources: {
          jsHeapBytes:
            metrics.metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? null,
          workerMemory: {
            value: null,
            reason: "Worker heap is not exposed through page CDP metrics",
          },
        },
        outputPath,
        pair: options.pair,
        order: options.order,
        variant: options.variant,
        ...qualityFields(fixture, result),
      };
      if (result.removalMode !== options.mode)
        throw new BenchmarkContractError(
          `changed removal mode from ${options.mode} to ${result.removalMode}`,
          where,
          row,
        );
      checkRunRow(row, where, options.qualityCapture);
      await options.onRow?.(row);
      rows.push(row);
    }
    return { browserEnvironment, rows };
  } catch (error) {
    throw inRun(error, where);
  } finally {
    options.signal.removeEventListener("abort", abort);
    contextTelemetry.stop();
    await telemetry?.stop();
    await cdp?.detach().catch(() => undefined);
    await context.close();
  }
}
