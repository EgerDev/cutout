import { createDisplayPreview, planIngest, rasterizeSvgFile } from "./files.ts";
import { runPool } from "./pool.ts";
import type { WorkspaceState, QueueItem, IngestReceipt } from "./workspace-types.ts";
import { editorDefaults } from "./editor/state.ts";
import { defaults } from "./editor/model.ts";
import { revoke, closePreview } from "./editor/resources.ts";
import { runtime, PREVIEW_CONCURRENCY, cancelWorkspaceJobs } from "./workspace-runtime.ts";
import { runQueue } from "./workspace-queue.ts";
import { clearSourceBitmapCache } from "./editor/canvas.ts";
import { classifyError } from "./errors.ts";
export async function ingestFiles(
  files: File[],
  get: () => WorkspaceState,
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
  signal?: AbortSignal,
): Promise<IngestReceipt | null> {
  if (signal?.aborted) return null;
  // A stray unsupported file must not veto the whole drop: process the valid
  // images and only explain when nothing usable arrived.
  const plan = planIngest(files);
  if (plan.images.length === 0) {
    set({ errorMessage: plan.errorMessage });
    return null;
  }
  // SVG becomes PNG before anything gets an object URL; one that cannot be drawn is dropped.
  // The drop number is taken before that wait so the latest drop wins, not the fastest;
  // runtime.job still catches a reset in between.
  const drop = ++runtime.drop,
    job = runtime.job,
    phase = get().phase;
  set({ phase: "processing", progress: { stage: "loading", progress: 0, message: "" } });
  // Two at a time, like previews: each SVG rasterises to a full-budget canvas and bitmap.
  const settled: PromiseSettledResult<File>[] = [];
  await runPool([...plan.images.keys()], PREVIEW_CONCURRENCY, async (index) => {
    [settled[index]] = await Promise.allSettled([rasterizeSvgFile(plan.images[index]!)]);
  });
  if (drop !== runtime.drop || job !== runtime.job) return null;
  if (signal?.aborted) {
    // The linked intent lost ownership while its source was being validated. Keep the
    // user's existing items/selection; only undo our own still-pending loading phase.
    if (get().phase === "processing") set({ phase });
    return null;
  }
  const images = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const failed = settled.find((result) => result.status === "rejected");
  const errorMessage =
    failed && failed.reason instanceof Error
      ? classifyError(failed.reason).message
      : plan.errorMessage;
  if (images.length === 0) {
    set({ errorMessage, phase });
    return null;
  }
  const token = ++runtime.job;
  runtime.queueToken = null;
  cancelWorkspaceJobs();
  clearSourceBitmapCache();
  runtime.runAbort = new AbortController();
  for (const item of get().items) {
    revoke(item.sourceUrl);
    revoke(item.resultUrl);
    closePreview(item.preview);
  }
  const items: QueueItem[] = images.map((file, index) => ({
    id: `${token}-${index}`,
    name: file.name || "image",
    source: file,
    sourceUrl: URL.createObjectURL(file),
    preview: null,
    resultBlob: null,
    resultUrl: null,
    width: 0,
    height: 0,
    status: "queued",
  }));
  set({
    ...editorDefaults,
    settings: Object.fromEntries(items.map((item) => [item.id, defaults])),
    items,
    activeId: items[0]?.id ?? null,
    phase: "processing",
    comparing: false,
    peeking: false,
    inspecting: false,
    copied: false,
    saved: false,
    exporting: false,
    copying: false,
    dragging: false,
    errorMessage,
    metadata: null,
    inspectMode: "composite",
    showGuides: false,
    excludedIds: [],
    removalMode: get().removalMode,
  });
  void runQueue(token, get, set);
  void runPool(
    images.map((file, index) => ({ file, id: `${token}-${index}` })),
    PREVIEW_CONCURRENCY,
    ({ file, id }) => hydratePreview(token, id, file, get, set),
  );
  return { job: token, drop, items: items.map(({ id, source }) => ({ id, source })) };
}

export async function hydratePreview(
  token: number,
  id: string,
  source: File,
  get: () => WorkspaceState,
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
) {
  // A newer drop replaced this one: skip decoding a file nobody will see.
  if (token !== runtime.job) return;
  const preview = await createDisplayPreview(source, () => token !== runtime.job);
  if (token !== runtime.job || !get().items.some((item) => item.id === id)) {
    closePreview(preview.bitmap);
    revoke(preview.url);
    return;
  }
  const itemW = preview.width || preview.bitmap?.width || 0;
  const itemH = preview.height || preview.bitmap?.height || 0;
  set((state) => ({
    items: state.items.map((item) => {
      if (item.id !== id) return item;
      const newSourceUrl = preview.url || item.sourceUrl;
      if (preview.url && preview.url !== item.sourceUrl) {
        revoke(item.sourceUrl);
      }
      if (preview.bitmap && item.preview && item.preview !== preview.bitmap)
        closePreview(item.preview);
      return {
        ...item,
        preview: preview.bitmap ?? item.preview,
        sourceUrl: newSourceUrl,
        width: item.resultBlob ? item.width : itemW || item.width,
        height: item.resultBlob ? item.height : itemH || item.height,
      };
    }),
  }));
}
