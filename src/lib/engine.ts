import { finishCutoutData } from "./defringe.ts";
import { bitmapToPng, canvas2d, encodeCanvas, readPixels } from "./editor/canvas.ts";
import { exceedsProcessingBudget, imageSizeOf, processingScale } from "./files.ts";
import { refineRemoval } from "./background-refine.ts";
import { resizeBitmap } from "./bitmap-resize.ts";
import type { RemovalMode, SubjectBox } from "./editor/model.ts";
import { isRetryableEngineError } from "./errors.ts";
import {
  blurredInk,
  classifyGraphic,
  cutoutByFlood,
  cutoutGraphic,
  looksAlreadyTransparent,
  opaqueFraction,
  skipAlphaProbe,
} from "./graphics.ts";
import { matteByte, type MatteRenderPolicy } from "./model-mask.ts";
import { refinementBudget } from "./removal-budget.ts";
import { removalNote, type RemovalDiagnostics } from "./removal-diagnostics.ts";
import { disposeRemovalResources } from "./removal-model-specs.ts";
import type { PreparedRemovalEngine } from "./removal-model.ts";
import {
  RemovalWebgpuInitError,
  field,
  requiresFreshRemovalContext,
  rememberGpuFailure,
  type RemovalModelKind,
} from "./removal-provider.ts";
import {
  engineErrorFor,
  isGpuSuspectMask,
  maskError,
  removalRuntime,
  type AutomaticRoute,
  type RemovalFaultProvenance,
  type RemovalProvenance,
} from "./removal-runtime.ts";

/**
 * How the cutout was produced. "model": the removal model the outcome's `model` names.
 * "logo": paper keyed out of flat ink-on-paper art. "illustration": paper flooded in
 * from the border of flat colourful art. "flood": recovery after an empty model mask.
 * "passthrough": the file already carried transparency and was returned as-is.
 */
export type RemovalMethod = "model" | "logo" | "illustration" | "flood" | "passthrough";

export type ConsumerProgress = {
  stage: "loading" | "cutting" | "finishing";
  progress: number;
  message: string;
};

const COPY = {
  preparing: "Preparing remover",
  download: "Preparing remover · only needed once",
  subject: "Finding subject",
  edges: "Cleaning edges",
  details: "Refining small details",
  done: "Almost done",
} as const;

/** C1: the transfer the compatibility pass renders with, the one the original requested for it. */
export const COMPAT_TRANSFER: "fast" | "quality" = "fast";
/** The progress the original's compatibility run showed just before its edge cleaning (C1). */
export const COMPAT_EDGES_PROGRESS = 0.92;

/** The one rendering: the model output is consumed as-is. See model-mask.ts. */
const ORIGINAL_POLICY: MatteRenderPolicy = "cutout-original-matte-v1";
const WASM = { model: "birefnet", provider: "wasm" } as const;
/**
 * A tiny subject needs a near-opaque core before and after cleaning: 128 of BiRefNet's 512 x 512
 * cells (about 0.05 %). Weak, diffuse scores must still take empty-mask recovery (E01-O-02).
 */
const SUBJECT_CELLS = 1 / 2048;

type WarmupJob = {
  promise: Promise<void>;
  controller: AbortController;
  listeners: Set<(fraction: number) => void>;
  users: number;
};
let warmup: WarmupJob | null = null;
function cancelWarmup() {
  warmup?.controller.abort();
}

/**
 * E05-03: in a worker, a WebGPU session that would not start fails every later session there too
 * (RemovalWebgpuInitError), so the client retries in a fresh worker without WebGPU instead of a
 * compatibility pass here. The page has no fresh context: it keeps its compatibility pass, which
 * works when an earlier session already started the runtime.
 */
function freshContextFor(error: unknown): unknown {
  const kind = field(error, "failureKind");
  // A device-creation error can name the GPU device before one exists (fp32 route).
  const webgpuInit =
    error === removalRuntime.jobInfo().webgpuLoadFailure &&
    (kind === "provider-init" || (kind === "gpu-device" && field(error, "dtype") === "fp32"));
  return webgpuInit && "WorkerGlobalScope" in globalThis ? new RemovalWebgpuInitError(error) : error;
}

/** Share pending warmups only: idle/pagehide release can invalidate readiness later. */
export function warmupBiRefNet(onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (!warmup) {
    const job: WarmupJob = { promise: Promise.resolve(), controller: new AbortController(), listeners: new Set(), users: 0 };
    warmup = job;
    job.promise = (typeof document === "undefined" ? Promise.resolve() : removalRuntime
      .exclusive(job.controller.signal, async () => removalRuntime.usePrimary(
        await removalRuntime.automaticRoute(),
        { signal: job.controller.signal, onProgress: (fraction) => job.listeners.forEach((listener) => listener(fraction)) },
        () => undefined,
      ).catch((error: unknown) => { throw freshContextFor(error); })))
      .finally(() => { if (warmup === job) warmup = null; });
  }
  const job = warmup;
  job.users++;
  const listener = onProgress && ((fraction: number) => onProgress(fraction));
  if (listener) job.listeners.add(listener);
  if (!signal) {
    const cleanup = () => {
      job.users--;
      if (listener) job.listeners.delete(listener);
    };
    job.promise.then(cleanup, cleanup);
    return job.promise;
  }
  return new Promise<void>((resolve, reject) => {
    let waiting = true;
    const cleanup = () => {
      waiting = false;
      job.users--;
      if (listener) job.listeners.delete(listener);
      signal?.removeEventListener("abort", abort);
    };
    // Each caller owns its cancellation. The shared controller yields the lane only
    // when every caller has left, or a real job preempts it. No AbortSignal.any (Safari <17.4).
    const abort = () => {
      if (!waiting) return;
      cleanup();
      if (job.users === 0 && warmup === job) {
        warmup = null;
        job.controller.abort();
      }
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    job.promise.then(() => {
      if (!waiting) return;
      cleanup();
      resolve();
    }, (error: unknown) => {
      if (!waiting) return;
      cleanup();
      reject(signal?.aborted ? signal.reason : error);
    });
    if (signal?.aborted) abort();
  });
}

function emit(
  stage: ConsumerProgress["stage"],
  progress: number,
  message: string,
): ConsumerProgress {
  return { stage, progress, message };
}

function pickQuality(mode?: RemovalMode): "fast" | "quality" {
  if (mode === "quick") return "fast";
  if (mode === "maximum") return "quality";
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === "number" && memory <= 3) return "fast";
  return "quality";
}

/**
 * Standard PNG/JPEG/WebP inputs skip conversion, so a file that would blow the
 * canvas or memory limits (extreme-resolution photos) is downscaled here, once,
 * with an explicit progress note. Everything already sized within the budget
 * passes through untouched.
 */
async function prepareForInference(
  file: Blob,
  report: (progress: ConsumerProgress) => void,
): Promise<Blob> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  const dims = await imageSizeOf(file);
  if (!dims) return file;
  if (!exceedsProcessingBudget(dims.width, dims.height)) return file;
  const scale = processingScale(dims.width, dims.height);
  const width = Math.max(1, Math.round(dims.width * scale));
  const height = Math.max(1, Math.round(dims.height * scale));
  report(emit("loading", 0.03, `Preparing at ${width}×${height} to fit memory`));
  try {
    const blob = await bitmapToPng(await resizeBitmap(file, width, height, "high"));
    if (!blob) return file;
    return new File([blob], "processing.png", { type: "image/png" });
  } catch {
    return file;
  }
}

type RemovalOutcome = {
  blob: Blob;
  width: number;
  height: number;
  provider: "webgpu" | "wasm" | "fallback";
  method: RemovalMethod;
  /** The removal model that ran: BiRefNet, or ISNet on low-memory devices without WebGPU. */
  model?: RemovalModelKind;
  diagnostics?: RemovalDiagnostics;
  removalNote?: "clean" | "refined" | "choose";
  /** WebGPU gave a flat mask where WASM found a subject (see the compatibility pass below). */
  webgpuBroken?: boolean;
};

/** What the crop passes of one job did; the numbers only feed provenance. */
type CropStats = { budget: number; inferences: number };

export async function removeBackgroundLocal(
  file: Blob,
  options: {
    onProgress?: (progress: ConsumerProgress) => void;
    /** Internal diagnostics handoff: the record belongs to this invocation only. */
    onProvenance?: (record: RemovalProvenance | RemovalFaultProvenance) => void;
    signal?: AbortSignal;
    mode?: RemovalMode;
  } = {},
): Promise<RemovalOutcome> {
  const recordProvenance = (record: RemovalProvenance | RemovalFaultProvenance) => {
    removalRuntime.recordProvenance(record);
    options.onProvenance?.(record);
  };
  let highestProgress = 0;
  const emitProgress = (progress: ConsumerProgress) => {
    if (progress.progress < highestProgress) return;
    highestProgress = progress.progress;
    options.onProgress?.(progress);
  };
  const report = (progress: ConsumerProgress) => {
    options.signal?.throwIfAborted();
    emitProgress(progress);
    options.signal?.throwIfAborted();
  };
  let computeStarted = 0;
  // Model loading is shared across jobs; cancellation must not reject its progress callbacks.
  const onCutting = (progress: number) => {
    if (!computeStarted) computeStarted = performance.now();
    if (!options.signal?.aborted) emitProgress(emit("cutting", Math.min(0.92, progress), COPY.subject));
  };
  const onDownload = (progress: number) => {
    if (!options.signal?.aborted)
      emitProgress(emit("loading", Math.max(0.08, Math.min(0.74, progress)), COPY.download));
  };
  cancelWarmup();
  report(emit("loading", 0.02, COPY.preparing));
  const work = await prepareForInference(file, report);
  report(emit("loading", 0.04, COPY.preparing));
  const probe = await sampleProbe(work);
  options.signal?.throwIfAborted();
  // The probe could not decode the file: one full decode decides now, so a file nothing can read
  // fails as itself before a model is leased (and maybe downloaded) for it (C07).
  if (!probe) await decodeOrThrow(work);
  if (
    probe &&
    !skipAlphaProbe(work.type) &&
    looksAlreadyTransparent(probe.data, probe.width, probe.height)
  ) {
    const transparent = await rasterizeFull(work);
    if (transparent) {
      report(emit("finishing", 1, COPY.done));
      return { ...transparent, provider: "fallback", method: "passthrough", removalNote: "clean" };
    }
  }
  const graphic = await tryGraphic(work, probe);
  if (graphic) {
    report(emit("finishing", 1, COPY.done));
    return { ...graphic, provider: "fallback" };
  }
  const quality = pickQuality(options.mode);
  const signal = options.signal;
  const elapsed = (started: number) => performance.now() - (computeStarted || started);
  const downloadProgress = (fraction: number) => onDownload(0.08 + fraction * 0.58);
  // The whole job holds the per-context lock: route, inference, recovery, edge finishing and
  // every automatic crop use the one model lease(s) taken below.
  return removalRuntime.exclusive(signal, async (): Promise<RemovalOutcome> => {
    const route = await removalRuntime.automaticRoute();
    const stats: CropStats = { budget: 0, inferences: 0 };
    let ranOn: PreparedRemovalEngine["provider"] | undefined;
    const record = (
      engine: PreparedRemovalEngine,
      globalTransfer: "fast" | "quality",
      compat: RemovalProvenance["compat"],
    ) =>
      recordProvenance({
        ...provenanceFor(engine, route, options.mode ?? "auto", stats),
        globalTransfer,
        compat,
      });
    // Edge refinement and the result shared by the primary run and the compatibility pass.
    const finishModel = async (
      cut: ModelCut,
      engine: PreparedRemovalEngine,
      computeMs: number,
      recovered: boolean,
      globalTransfer: "fast" | "quality",
      compat: RemovalProvenance["compat"],
    ) => {
      const finished = await finishPhoto(
        work,
        cut,
        engine,
        report,
        computeMs,
        cut.width * cut.height,
        signal,
        options.mode ?? "auto",
        stats,
        recovered,
      );
      report(emit("finishing", 1, COPY.done));
      record(engine, globalTransfer, compat);
      return {
        blob: finished.blob,
        width: cut.width,
        height: cut.height,
        provider: engine.provider,
        method: finished.method,
        model: engine.identity.model,
        diagnostics: finished.diagnostics,
        removalNote: finished.note,
      };
    };
    // The primary body; also what an absorbed load failure re-runs on WASM.
    const primaryBody = async (engine: PreparedRemovalEngine): Promise<RemovalOutcome> => {
      ranOn = engine.provider;
      signal?.throwIfAborted();
      onCutting(0.7);
      const started = performance.now();
      const cut = await cutoutFromModel(work, engine, quality, { signal });
      report(emit("finishing", 0.94, COPY.edges));
      return finishModel(cut, engine, elapsed(started), false, quality, { attempted: false });
    };
    // The one compatibility attempt: BiRefNet on WASM with the compatibility transfer.
    const compatPass = (primaryError: unknown): Promise<RemovalOutcome> => {
      report(emit("loading", 0.72, "Switching to compatibility mode"));
      // The compatibility model is a second load and run, and its progress restarts from the
      // download band: held to the mark above, every tick of it was dropped and the bar sat at
      // the switch for the whole download, on a cold compatibility route too.
      highestProgress = 0;
      computeStarted = 0;
      const compat = { attempted: true, transfer: COMPAT_TRANSFER } as const;
      // use() releases a differing current model first (awaited, never rejecting).
      return removalRuntime.use(WASM, { signal, onProgress: downloadProgress }, async (engine) => {
        onCutting(0.72);
        const started = performance.now();
        const cut = await cutoutFromModel(work, engine, COMPAT_TRANSFER, { signal });
        report(emit("finishing", COMPAT_EDGES_PROGRESS, COPY.edges));
        report(emit("finishing", 0.94, COPY.edges));
        const computeMs = elapsed(started);
        // WebGPU's mask was flat but WASM finds a subject: this GPU cannot run the model, so
        // stop trying it. Only then: a photo with nothing to cut, or a one-off device loss, is
        // not a broken GPU. Read from the uncleaned cutout's alpha in memory: a full-size encode
        // just for this check could fail and throw away the successful cut.
        // A flat source, or a WASM mask without both background and subject, cannot tell a broken
        // GPU from the image itself (E10-04): no record then.
        const webgpuBroken =
          ranOn === "webgpu" &&
          isGpuSuspectMask(primaryError) &&
          !cut.rawEmpty &&
          !cut.rawLooksEmpty() &&
          cut.rawHasStructure();
        if (webgpuBroken) rememberGpuFailure("gpu-mask");
        const recovered = await recoverIfEmpty(work, cut);
        const { blob, method } = recovered;
        cut.release();
        if (!ranOn) {
          // No primary engine ever ran: keep the successful result instead of risking more
          // inference on refinement.
          report(emit("finishing", 1, COPY.done));
          record(engine, COMPAT_TRANSFER, compat);
          return {
            blob,
            width: cut.width,
            height: cut.height,
            provider: "wasm",
            method,
            model: engine.identity.model,
            removalNote: "clean",
            webgpuBroken,
          };
        }
        return {
          ...(await finishModel({ ...cut, ...recovered }, engine, computeMs, true, COMPAT_TRANSFER, compat)),
          webgpuBroken,
        };
      });
    };
    const graphicOrThrow = async (error: unknown, compatAttempted: boolean): Promise<RemovalOutcome> => {
      if (requiresFreshRemovalContext(error)) throw error;
      const recovered = await tryGraphic(work);
      signal?.throwIfAborted();
      recordProvenance(faultRecord(route, ranOn, compatAttempted, Boolean(recovered)));
      if (recovered) {
        report(emit("finishing", 1, COPY.done));
        return { ...recovered, provider: "fallback" };
      }
      throw error; // the error that ended the primary attempt
    };
    if (route.shape === "compat") {
      // A remembered init-class WebGPU failure keeps later jobs in the compatibility shape.
      try {
        return await compatPass(undefined);
      } catch (error) {
        signal?.throwIfAborted();
        return graphicOrThrow(error, true);
      }
    }
    try {
      return await removalRuntime.usePrimary(
        route,
        {
          signal,
          onProgress: downloadProgress,
          // The WASM download restarts from the download band, as in the compatibility pass:
          // held to the failed download's mark, its ticks below it were dropped (C10).
          onAbsorb: () => {
            highestProgress = 0;
          },
        },
        primaryBody,
      );
    } catch (error) {
      // After an absorbed load failure `error` is the WASM failure, the second consecutive one.
      // Only this job's signal cancels it; an error merely named AbortError is a failure (C05).
      signal?.throwIfAborted();
      if (requiresFreshRemovalContext(error)) throw error;
      const retryable =
        isRetryableEngineError(error) || (error instanceof Error && error.name === "MaskError");
      // The low-memory engine skips compatibility: it would load the model the route avoided.
      if (retryable && !route.lowMemory) {
        const fresh = freshContextFor(error);
        if (fresh !== error) {
          recordProvenance(faultRecord(route, ranOn, false, false));
          throw fresh;
        }
        try {
          return await compatPass(error);
        } catch {
          signal?.throwIfAborted();
        }
        return graphicOrThrow(error, true);
      }
      return graphicOrThrow(error, false);
    }
  });
}

/** Provenance fields every record shares; callers add the per-run ones. */
function provenanceFor(
  engine: PreparedRemovalEngine,
  route: AutomaticRoute,
  mode: string,
  stats: CropStats,
): RemovalProvenance {
  return {
    renderPolicy: ORIGINAL_POLICY,
    rawOutputSemantics: engine.outputImageSemantics,
    model: engine.identity.model,
    modelId: engine.identity.modelId,
    revision: engine.identity.revision,
    provider: engine.provider,
    dtype: engine.identity.dtype,
    onnxFile: engine.identity.onnxFile,
    mode,
    shape: route.shape,
    absorbAttempted: removalRuntime.jobInfo().absorbAttempted,
    globalTransfer: "quality",
    cropTransfer: "quality",
    cropBudget: stats.budget,
    cropInferences: stats.inferences,
    compat: { attempted: false },
  };
}

function faultRecord(
  route: AutomaticRoute,
  ranOn: PreparedRemovalEngine["provider"] | undefined,
  compatAttempted: boolean,
  recovered: boolean,
): RemovalFaultProvenance {
  return {
    outcome: recovered ? "fallback" : "error",
    route: route.primary,
    shape: route.shape,
    renderPolicy: ORIGINAL_POLICY,
    absorbAttempted: removalRuntime.jobInfo().absorbAttempted,
    compat: compatAttempted ? { attempted: true, transfer: COMPAT_TRANSFER } : { attempted: false },
    ranOn,
  };
}

type ModelCut = {
  blob: Blob;
  method?: RemovalMethod;
  width: number;
  height: number;
  /** The model's own mask was (almost) empty before cleaning. */
  rawEmpty: boolean;
  /** The model found a tiny solid subject and its core survived cleaning (E01-O-02). */
  rawSubject: boolean;
  /** Lazily checks the uncleaned alpha for the compatibility decision, without encoding it. */
  rawLooksEmpty: () => boolean;
  /** The source is not flat and the uncleaned alpha has both background and subject. */
  rawHasStructure: () => boolean;
  /** Encodes the uncleaned model cutout, for when cleaning eats everything. */
  raw: (() => Promise<Blob>) | null;
  /** Drops the full-size source pixels and raw alpha `raw` needs; nothing reads them after. */
  release: () => void;
};

/**
 * Decodes the photo once, runs the model on those pixels and cleans the matte in memory,
 * encoding a single PNG at the end: the raw cutout is never written to PNG and read back,
 * which on a 12 MP photo cost two decodes and an encode before edge cleaning even started.
 * The model output is consumed as-is (raw) and the tensors this run received are disposed
 * as soon as their values are read.
 */
async function cutoutFromModel(
  file: Blob,
  engine: PreparedRemovalEngine,
  quality: "fast" | "quality",
  options: { signal?: AbortSignal } = {},
): Promise<ModelCut> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const width = bitmap.width,
    height = bitmap.height;
  const read = readPixels(bitmap, width, height);
  bitmap.close();
  if (!read) throw new Error("Canvas is unavailable");
  const { canvas, context: ctx, image: sourceData } = read;
  const owned: unknown[] = [];
  const disposeOwned = async () => {
    for (const failure of await disposeRemovalResources(owned.splice(0).reverse()))
      removalRuntime.recordCleanupFailure(failure);
  };
  try {
    options.signal?.throwIfAborted();
    const tf = (await import("./transformers.ts")).transformers();
    const input = modelInput(canvas, sourceData, engine);
    const raw = new tf.RawImage(input.data, input.width, input.height, 4);
    let processed: Awaited<ReturnType<PreparedRemovalEngine["processor"]>>;
    try {
      processed = await engine.processor(raw);
    } catch (error) {
      throw engineErrorFor(error, "processor", engine.provider, options.signal);
    }
    owned.push(processed.pixel_values);
    options.signal?.throwIfAborted();
    let output: Awaited<ReturnType<PreparedRemovalEngine["model"]>>;
    try {
      output = await engine.model({ input_image: processed.pixel_values });
    } catch (error) {
      throw engineErrorFor(error, "model", engine.provider, options.signal);
    }
    owned.push(output.output_image);
    const { data: alpha, dims } = output.output_image;
    const maskHeight = dims.at(-2) ?? 0,
      maskWidth = dims.at(-1) ?? 0;
    if (!maskWidth || !maskHeight || alpha.length !== maskWidth * maskHeight)
      throw maskError("The model returned an invalid mask shape");
    // A flat or non-finite mask means the GPU path silently failed: retry on WASM.
    let min = Infinity,
      max = -Infinity,
      solid = 0;
    for (let i = 0; i < alpha.length; i++) {
      const v = Number(alpha[i]);
      if (!Number.isFinite(v))
        throw maskError("The model returned an invalid alpha mask", engine.provider === "webgpu");
      if (v < min) min = v;
      if (v > max) max = v;
      if (v >= 0.9) solid += 1;
    }
    if (engine.provider === "webgpu" && (max < 0.05 || max - min < 0.005))
      // Only an all-but-empty mask points at the GPU; a flat, high one is also what a
      // photo that is subject edge to edge gives.
      throw maskError("WebGPU returned a flat alpha mask", max < 0.05);
    options.signal?.throwIfAborted();

    // Composite on the canvas: source × upsampled mask (destination-in).
    const mask = canvas2d(maskWidth, maskHeight, { willReadFrequently: true });
    try {
      const pixels = mask.context.createImageData(maskWidth, maskHeight);
      for (let i = 0; i < alpha.length; i++) {
        const o = i * 4;
        pixels.data[o] = 255;
        pixels.data[o + 1] = 255;
        pixels.data[o + 2] = 255;
        // The clamped byte store does the clamping.
        pixels.data[o + 3] = matteByte(Number(alpha[i]), quality);
      }
      await disposeOwned();
      mask.context.putImageData(pixels, 0, 0);
      ctx.globalCompositeOperation = "destination-in";
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = quality === "quality" ? "high" : "medium";
      ctx.drawImage(mask.canvas, 0, 0, width, height);
      ctx.globalCompositeOperation = "source-over";
    } finally {
      mask.canvas.width = 0;
      mask.canvas.height = 0;
    }
    const cutoutData = ctx.getImageData(0, 0, width, height);
    canvas.width = 0;
    canvas.height = 0;
    let opaque = 0,
      sampled = 0;
    for (let i = 3; i < cutoutData.data.length; i += 4 * 61) {
      sampled += 1;
      if (cutoutData.data[i]! > 8) opaque += 1;
    }
    options.signal?.throwIfAborted();
    const rawEmpty = opaque / Math.max(1, sampled) < 0.008;
    // The closures below share one context: holding the pixels here, never capturing
    // `sourceData`, lets `release()` free them while the cut itself stays alive (A-01).
    const held: { source: ImageData | null; alpha: Uint8Array | null } = {
      source: sourceData,
      alpha: rawEmpty ? null : alphaOf(cutoutData.data),
    };
    const blob = await finishCutoutData(cutoutData, sourceData, { jpeg: /jpe?g/i.test(file.type) });
    let smallSubject = rawEmpty && solid >= maskWidth * maskHeight * SUBJECT_CELLS;
    if (smallSubject) {
      // Recovery keeps the cleaned blob: a confident raw core that cleaning erased cannot save it.
      const needed = width * height * SUBJECT_CELLS;
      let kept = 0;
      for (let i = 3; i < cutoutData.data.length && kept < needed; i += 4)
        if (cutoutData.data[i]! >= 239) kept += 1;
      smallSubject = kept >= needed;
    }
    return {
      blob,
      width,
      height,
      rawEmpty,
      rawSubject: smallSubject,
      rawLooksEmpty: () => {
        // Keep diagnostic work off the primary clock and optional crops (C03).
        try {
          return !held.alpha || alphaLooksEmpty(held.alpha, width, height);
        } catch {
          // Cannot confirm a subject: keep the successful WASM cut without recording the GPU.
          return true;
        }
      },
      rawHasStructure: () => {
        try {
          return !!held.source && !!held.alpha && hasStructure(held.source.data, held.alpha, width, height);
        } catch {
          return false;
        }
      },
      raw: held.alpha
        ? async () => {
            const { source, alpha } = held;
            if (!source || !alpha) throw new Error("The raw cutout was already released");
            const data = new Uint8ClampedArray(source.data);
            for (let i = 0, p = 0; i < data.length; i += 4, p += 1) data[i + 3] = alpha[p]!;
            return encodeImageData(new ImageData(data, width, height));
          }
        : null,
      release: () => {
        held.source = null;
        held.alpha = null;
      },
    };
  } finally {
    // Also frees what an early exit left behind; never replaces the error or abort reason.
    await disposeOwned();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** The model's input side (512 or 1024), from its pinned input dimensions. */
function modelSide(engine: PreparedRemovalEngine) {
  return engine.identity.inputDims.at(-1) ?? 0;
}

/**
 * The pixels handed to the processor. It resizes to the model's 512-1024 px input, but on
 * the way copies the full image to RGB, clones it and draws it to a full-size canvas:
 * about 170 MB extra at 12 MP, over a gigabyte at the desktop budget. A uniform copy with
 * the short side at twice the input leaves its resize the same work on far fewer pixels.
 */
function modelInput(canvas: HTMLCanvasElement, full: ImageData, engine: PreparedRemovalEngine) {
  const side = modelSide(engine);
  const scale = side ? Math.min(1, (2 * side) / Math.min(full.width, full.height)) : 1;
  if (scale >= 0.9) return full;
  const small = canvas2d(full.width * scale, full.height * scale, { willReadFrequently: true });
  try {
    small.context.imageSmoothingEnabled = true;
    small.context.imageSmoothingQuality = "high";
    small.context.drawImage(canvas, 0, 0, small.canvas.width, small.canvas.height);
    return small.context.getImageData(0, 0, small.canvas.width, small.canvas.height);
  } finally {
    small.canvas.width = 0;
    small.canvas.height = 0;
  }
}

function alphaOf(data: Uint8ClampedArray) {
  const alpha = new Uint8Array(data.length / 4);
  for (let i = 3, p = 0; i < data.length; i += 4, p += 1) alpha[p] = data[i]!;
  return alpha;
}

/** `cutoutLooksEmpty` on an alpha plane: under 0.8 % opaque on a grid of at most 96 × 96. */
function alphaLooksEmpty(alpha: Uint8Array, width: number, height: number) {
  const w = Math.min(96, width),
    h = Math.min(96, height);
  let opaque = 0;
  for (let y = 0; y < h; y += 1) {
    const row = Math.floor(((y + 0.5) * height) / h) * width;
    for (let x = 0; x < w; x += 1)
      if (alpha[row + Math.floor(((x + 0.5) * width) / w)]! > 16) opaque += 1;
  }
  return opaque / (w * h) < 0.008;
}

/**
 * On a grid of at most 96 x 96: some source channel spans more than 8 levels, and the alpha has
 * at least 0.8 % background (<= 16) and 0.8 % subject (>= 239).
 */
function hasStructure(source: Uint8ClampedArray, alpha: Uint8Array, width: number, height: number) {
  const w = Math.min(96, width),
    h = Math.min(96, height);
  const low = [255, 255, 255],
    high = [0, 0, 0];
  let background = 0,
    subject = 0;
  for (let y = 0; y < h; y += 1) {
    const row = Math.floor(((y + 0.5) * height) / h) * width;
    for (let x = 0; x < w; x += 1) {
      const p = row + Math.floor(((x + 0.5) * width) / w);
      if (alpha[p]! <= 16) background += 1;
      if (alpha[p]! >= 239) subject += 1;
      for (let c = 0; c < 3; c += 1) {
        const value = source[p * 4 + c]!;
        if (value < low[c]!) low[c] = value;
        if (value > high[c]!) high[c] = value;
      }
    }
  }
  const samples = w * h;
  return high.some((value, c) => value - low[c]! > 8) && background / samples >= 0.008 && subject / samples >= 0.008;
}

async function encodeImageData(image: ImageData): Promise<Blob> {
  const { canvas, context } = canvas2d(image.width, image.height, { willReadFrequently: true });
  try {
    context.putImageData(image, 0, 0);
    return await encodeCanvas(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

async function finishPhoto(
  source: Blob,
  cut: ModelCut,
  engine: PreparedRemovalEngine,
  report: (progress: ConsumerProgress) => void,
  globalInferenceMs: number,
  sourcePixels: number,
  signal: AbortSignal | undefined,
  mode: RemovalMode,
  stats: CropStats,
  alreadyRecovered = false,
) {
  const recovered = alreadyRecovered ? { blob: cut.blob, method: cut.method ?? "model" } : await recoverIfEmpty(source, cut);
  const { blob: base, method } = recovered;
  // The cut holds the full-size source pixels (4 B/px) and alpha for `raw`; refinement below
  // decodes again, so keeping them alive only raised its peak.
  cut.release();
  signal?.throwIfAborted();
  const memory = Reflect.get(navigator, "deviceMemory");
  const maxCrops = refinementBudget(
    engine.provider,
    typeof memory === "number" ? memory : undefined,
    globalInferenceMs,
    sourcePixels,
    mode,
    engine.identity.dtype,
  );
  stats.budget = maxCrops;
  if (maxCrops === 0) return { blob: base, method, diagnostics: undefined, note: "clean" as const };
  try {
    const refined = await refineRemoval(source, base, {
      maxCrops,
      signal,
      infer: cropInfer(engine, signal, report, stats),
    });
    return {
      blob: refined.blob,
      method,
      diagnostics: refined.diagnostics,
      note: removalNote(refined.diagnostics, refined.refinements),
    };
  } catch (error) {
    signal?.throwIfAborted();
    if (requiresFreshRemovalContext(error)) throw error;
    return { blob: base, method, diagnostics: undefined, note: "clean" as const };
  }
}

/** Cleaning can eat a faint subject; fall back to the raw mask, then to the keying paths. */
async function recoverIfEmpty(file: Blob, cut: ModelCut) {
  if (!(await cutoutLooksEmpty(cut.blob))) return { blob: cut.blob, method: cut.method ?? "model" };
  if (!cut.rawEmpty && cut.raw) return { blob: await cut.raw(), method: "model" as const };
  // Both checks above are fractions of the frame: a small subject on a large photo fails them, and
  // the flood then keeps whatever background it cannot clear (E01-O-02).
  if (cut.rawSubject) return { blob: cut.blob, method: "model" as const };
  return (await keyedCutout(file)) ?? { blob: cut.blob, method: "model" as const };
}

/** The keying paths, flood first, for when the model left nothing. */
async function keyedCutout(file: Blob) {
  const flood = await cutoutByFlood(file);
  return flood ? { ...flood, method: "flood" as const } : await tryGraphic(file);
}

function cropInfer(
  engine: PreparedRemovalEngine,
  signal: AbortSignal | undefined,
  report: ((progress: ConsumerProgress) => void) | undefined,
  stats: CropStats,
) {
  return async (crop: Blob, index: number, total: number) => {
    report?.(emit("finishing", 0.96 + (index / total) * 0.03, COPY.details));
    stats.inferences += 1;
    try {
      // Crops always render with the quality transfer.
      const refined = await cutoutFromModel(crop, engine, "quality", { signal });
      // Only the cleaned blob is used: drop the crop's source pixels and raw alpha, as every cut does.
      refined.release();
      return refined.blob;
    } catch (error) {
      signal?.throwIfAborted();
      if (requiresFreshRemovalContext(error)) throw error;
      // The crop is skipped and nothing is recorded: a zoomed crop that finds nothing is not a
      // broken GPU, and this job's global run on the same engine already succeeded. Only the
      // compatibility pass, with WASM's confirmation, records one.
      return null;
    }
  };
}

export async function refineWithUserCrops(
  source: Blob,
  base: Blob,
  boxes: readonly SubjectBox[],
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: ConsumerProgress) => void;
    /** Internal diagnostics handoff: the record belongs to this invocation only. */
    onProvenance?: (record: RemovalProvenance | RemovalFaultProvenance) => void;
  } = {},
) {
  cancelWarmup();
  const crops = boxes
    .map((box) => {
      const x = Math.min(1, Math.max(0, Number.isFinite(box.x) ? box.x : 0));
      const y = Math.min(1, Math.max(0, Number.isFinite(box.y) ? box.y : 0));
      const rawW = Number.isFinite(box.width) ? box.width : 0.04;
      const rawH = Number.isFinite(box.height) ? box.height : 0.04;
      return {
        x,
        y,
        width: Math.min(1 - x, Math.max(0.04, rawW)),
        height: Math.min(1 - y, Math.max(0.04, rawH)),
      };
    })
    .filter((box) => box.width > 0.03 && box.height > 0.03)
    .slice(0, 4);
  // Nothing to refine: no lock, no route, no model load.
  if (!crops.length) return base;
  const { signal } = options;
  const report = (progress: ConsumerProgress) => {
    signal?.throwIfAborted();
    options.onProgress?.(progress);
    signal?.throwIfAborted();
  };
  const recordProvenance = (record: RemovalProvenance | RemovalFaultProvenance) => {
    removalRuntime.recordProvenance(record);
    options.onProvenance?.(record);
  };
  const stats: CropStats = { budget: crops.length, inferences: 0 };
  return removalRuntime.exclusive(signal, async () => {
    const route = await removalRuntime.automaticRoute();
    // One lease for every crop (plus one same-job WASM lease on an absorbable WebGPU load failure).
    let ranOn: PreparedRemovalEngine["provider"] | undefined;
    try {
      return await removalRuntime.usePrimary(route, {
        signal,
        onProgress: (fraction) => {
          if (!signal?.aborted) report(emit("loading", 0.08 + fraction * 0.58, COPY.download));
        },
      }, async (engine) => {
        ranOn = engine.provider;
        const refined = await refineRemoval(source, base, {
          maxCrops: crops.length,
          crops,
          signal,
          infer: cropInfer(engine, signal, report, stats),
        });
        report(emit("finishing", 1, COPY.done));
        recordProvenance(provenanceFor(engine, route, "manual", stats));
        return refined.blob;
      });
    } catch (error) {
      signal?.throwIfAborted();
      recordProvenance(faultRecord(route, ranOn, false, false));
      throw freshContextFor(error);
    }
  });
}

async function sampleProbe(file: Blob) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let probe: ImageBitmap;
  try {
    probe = await resizeBitmap(file, 96, 96, "low");
  } catch {
    try {
      probe = await createImageBitmap(file);
    } catch {
      return null;
    }
  }
  const read = readPixels(probe, probe.width, probe.height);
  probe.close();
  if (!read) return null;
  read.canvas.width = 0;
  read.canvas.height = 0;
  const { data, width, height } = read.image;
  return { data, width, height };
}

/** Rethrows the decoder's own error for a file that does not decode; without a decoder, nothing. */
async function decodeOrThrow(file: Blob) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return;
  (await createImageBitmap(file, { imageOrientation: "from-image" })).close();
}

async function rasterizeFull(file: Blob) {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return null;
  let full: ImageBitmap;
  try {
    full = await createImageBitmap(file);
  } catch {
    return null;
  }
  const { width, height } = full;
  const blob = await bitmapToPng(full);
  return blob && { blob, width, height };
}

/** Long side of the sharp read. The classifier samples a 48-point grid across the short
 *  side, which this keeps down to an 8:1 aspect; the read stays 0.15 MP for any file. */
const SHARP_PROBE = 384;

/**
 * The file's own pixels on a bounded grid: nearest-neighbour, so every sample is a pixel of
 * the file and never a blend of ink and paper. A file within the bound is read as it is.
 */
async function sharpProbe(file: Blob) {
  const size = await imageSizeOf(file);
  if (!size) return null;
  const scale = Math.min(1, SHARP_PROBE / Math.max(size.width, size.height));
  let bitmap: ImageBitmap;
  try {
    bitmap =
      scale < 1
        ? await resizeBitmap(file, size.width * scale, size.height * scale, "pixelated")
        : await createImageBitmap(file);
  } catch {
    return null;
  }
  const read = readPixels(bitmap, bitmap.width, bitmap.height);
  bitmap.close();
  if (!read) return null;
  read.canvas.width = 0;
  read.canvas.height = 0;
  return read.image;
}

/**
 * The probe decides, except that ink its resample blurred (see blurredInk) is judged again on
 * the file's own pixels. That second look can only find a logo: a sharper read is not a
 * second chance for anything else.
 */
async function graphicKind(file: Blob, probe: NonNullable<Probe>) {
  const kind = classifyGraphic(probe.data, probe.width, probe.height);
  if (kind || !blurredInk(probe.data, probe.width, probe.height)) return kind;
  const sharp = await sharpProbe(file);
  return sharp && classifyGraphic(sharp.data, sharp.width, sharp.height) === "logo" ? "logo" : null;
}

/**
 * Flat art on a uniform field skips the model. "logo": ink keyed off paper.
 * "illustration": paper flooded in from the border so enclosed details survive,
 * with exact anti-aliased edges; the model softens flat edges and stays the
 * fallback when the flood finds nothing.
 */
async function tryGraphic(file: Blob, pending: Probe | Promise<Probe> = sampleProbe(file)) {
  const probe = await pending;
  const kind = probe ? await graphicKind(file, probe) : null;
  if (kind === "logo") {
    const cut = await cutoutGraphic(file);
    return cut ? { ...cut, method: "logo" as const } : null;
  }
  if (kind === "illustration") {
    const cut = await cutoutByFlood(file);
    return cut ? { ...cut, method: "illustration" as const } : null;
  }
  return null;
}

type Probe = Awaited<ReturnType<typeof sampleProbe>>;

async function cutoutLooksEmpty(blob: Blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const read = readPixels(bitmap, Math.min(96, bitmap.width), Math.min(96, bitmap.height));
    bitmap.close();
    if (!read) return false;
    read.canvas.width = 0;
    read.canvas.height = 0;
    return opaqueFraction(read.image.data) < 0.008;
  } catch {
    return false;
  }
}
