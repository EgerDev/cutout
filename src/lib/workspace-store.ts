import { create } from "zustand";
import { inspectImageMetadata } from "./metadata-client";
import type { WorkspaceState, QueueItem, Phase } from "./workspace-types";
export type { WorkspaceState, QueueItem, Phase } from "./workspace-types";
import { editorActions, editorDefaults, activeSettings } from "./editor/state";
import { backgroundPatch, defaults } from "./editor/model";
import { processable, clearSourceBitmapCache } from "./editor/canvas";
import { installEditorPreview } from "./editor/preview";
import { revoke, closePreview } from "./editor/resources";
import { runtime } from "./workspace-runtime";
import { runQueue, cancelProcessing } from "./workspace-queue";
import { ingestFiles, hydratePreview } from "./workspace-ingest";
import { classifyError } from "./errors";
import { rasterizeSvgFile } from "./files";
import { resetWorkspace, resumeWorkspace as restoreWorkspace } from "./workspace-lifecycle";
import type { SavedSession } from "./editor/session";
import { downloadActions } from "./workspace-downloads";
function resultPhase(items: QueueItem[], phase: Phase): Phase {
  if (items.some((item) => item.status === "done")) return "result";
  return phase;
}

let backgroundPick = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  ...editorDefaults,
  ...editorActions(get, set),
  ...downloadActions(get, set),
  phase: "idle",
  items: [],
  activeId: null,
  comparing: false,
  peeking: false,
  inspecting: false,
  copied: false,
  saved: false,
  exporting: false,
  copying: false,
  dragging: false,
  errorMessage: null,
  progress: { stage: "loading", progress: 0, message: "" },
  inspectMode: "composite",
  showGuides: false,
  removalMode: "auto",
  excludedIds: [],
  metadata: null,

  receiveFiles: (files, signal) => ingestFiles(files, get, set, signal),

  selectItem: (id) => {
    if (!get().items.some((item) => item.id === id)) return;
    if (id !== get().activeId) {
      backgroundPick += 1;
      clearSourceBitmapCache();
    }
    set({
      activeId: id,
      inspecting: false,
      metadata: null,
    });
  },
  setComparing: (comparing) => set({ comparing }),
  setPeeking: (peeking) => set({ peeking }),
  setDragging: (dragging) => {
    if (get().dragging === dragging) return;
    set({ dragging });
  },
  openAdjust: () => set({ phase: "adjusting", inspecting: false }),
  closeAdjust: () => set({ phase: resultPhase(get().items, get().phase) }),
  openInfo: () => {
    const item = get().items.find((entry) => entry.id === get().activeId);
    const phase = get().phase === "adjusting" ? resultPhase(get().items, get().phase) : get().phase;
    set({ inspecting: true, phase });
    if (!item || get().metadata) return;
    void inspectImageMetadata(item.source)
      .then((metadata) => {
        if (
          get().activeId === item.id &&
          get().inspecting &&
          get().items.find((entry) => entry.id === item.id)?.source === item.source
        )
          set({ metadata });
      })
      .catch(() => {
        if (
          get().activeId === item.id &&
          get().inspecting &&
          get().items.find((entry) => entry.id === item.id)?.source === item.source
        )
          set({ errorMessage: "Couldn’t read image information. Close and reopen Info to retry." });
      });
  },
  closeInfo: () => set({ inspecting: false }),
  setExportFormat: (exportFormat) => get().changeEdit({ exportFormat }),
  setExportSize: (width, height) => {
    const item = get().items.find((i) => i.id === get().activeId);
    if (!item) return;
    if (width === null && height === null) {
      get().changeEdit({ exportWidth: null, exportHeight: null });
      return;
    }
    const settings = activeSettings(get());
    // Prefer the established export ratio only when both sides are set; a
    // half-edited pair (or the source image) is the stable fallback.
    const ratio =
      settings.exportWidth !== null &&
      settings.exportHeight !== null &&
      settings.exportWidth >= 1 &&
      settings.exportHeight >= 1
        ? settings.exportWidth / settings.exportHeight
        : item.width > 0 && item.height > 0
          ? item.width / item.height
          : 1;
    const w = Math.round(width ?? (height ?? 1) * ratio),
      h = Math.round(height ?? (width ?? 1) / ratio);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) return;
    const scale = Math.min(1, 4096 / Math.max(w, h));
    get().changeEdit(
      {
        exportWidth: Math.max(1, Math.round(w * scale)),
        exportHeight: Math.max(1, Math.round(h * scale)),
      },
      "size",
    );
  },
  setBackground: (background) =>
    get().changeEdit(backgroundPatch(activeSettings(get()), background)),
  setCustomColor: (customColor) =>
    get().changeEdit({ customColor, background: { type: "color", color: customColor } }, "color"),
  setBackgroundImage: (file) => {
    if (!file.type.startsWith("image/") || file.size > 30_000_000) {
      get().reportError("Choose a background image smaller than 30 MB.");
      return;
    }
    // An SVG background is drawn to PNG first so its object URL can never run script.
    // It belongs to the image it was picked for: if the user moved on meanwhile, drop it.
    const target = get().items.find((item) => item.id === get().activeId);
    const pick = ++backgroundPick,
      job = runtime.job;
    const background = target ? get().settings[target.id]?.background : undefined;
    const current = () =>
      target &&
      pick === backgroundPick &&
      job === runtime.job &&
      get().activeId === target.id &&
      get().items.find((item) => item.id === target.id)?.source === target.source &&
      get().settings[target.id]?.background === background;
    void rasterizeSvgFile(file).then(
      (image) => {
        if (!current()) return;
        const url = URL.createObjectURL(image);
        get().changeEdit({
          backgroundImageUrl: url,
          backgroundBlob: image,
          background: { type: "image", url },
        });
      },
      (error: unknown) => {
        if (current())
          get().reportError(error instanceof Error ? error.message : "Couldn’t use that image.");
      },
    );
  },
  setStripMetadata: (stripMetadata) => get().changeEdit({ stripMetadata }),
  setFeather: (feather) => get().changeEdit({ feather }, "feather"),
  setChoke: (choke) => get().changeEdit({ choke }, "choke"),

  reprocessActive: () => {
    const id = get().activeId;
    if (id) get().reprocessItem(id);
  },
  enhanceActive: async (options = {}) => {
    const scale = options.scale ?? 2;
    const targetSide = options.targetSide;
    const id = get().activeId;
    const item = get().items.find((entry) => entry.id === id);
    if (!id || !item || get().enhancing || (item.status !== "done" && item.status !== "error"))
      return;
    const token = runtime.job;
    const controller = new AbortController();
    runtime.itemAborts.get(id)?.abort();
    runtime.itemAborts.set(id, controller);
    const alive = () =>
      token === runtime.job &&
      get().items.some((entry) => entry.id === id) &&
      !controller.signal.aborted;
    set({
      enhancing: id,
      errorMessage: null,
      phase: "processing",
      progress: { stage: "loading", progress: 0.02, message: "Getting the enhancer ready" },
    });
    try {
      const { enhanceFile } = await import("./enhance.ts");
      const { processingLimits } = await import("./files.ts");
      const { maskWith } = await import("./editor/alpha.ts");
      const keep = options.keepCutout && item.resultBlob ? item.resultBlob : null;
      // The processed source (HEIC decoded, oversize photos already downscaled):
      // the size the cutout was made at.
      const source = await processable(item.source);
      if (!alive()) return;
      const result = await enhanceFile(source, {
        mask: keep ?? undefined,
        limits: targetSide
          ? { ...processingLimits(), side: Math.min(processingLimits().side, targetSide) }
          : processingLimits(),
        scale,
        signal: controller.signal,
        onProgress: (p) => {
          if (!alive()) return;
          const base = p.stage === "loading" ? 0.02 : p.stage === "upscaling" ? 0.15 : 0.9;
          const span = p.stage === "loading" ? 0.13 : p.stage === "upscaling" ? 0.75 : 0.05;
          set({
            progress: { stage: "loading", progress: base + span * p.fraction, message: p.message },
          });
        },
      });
      if (!alive()) return;
      // Keeping the cutout: the enhanced pixels take the old matte, scaled up,
      // instead of going through removal again.
      const kept = keep ? await maskWith(result.file, keep, result.width, result.height) : null;
      if (!alive()) return;
      const previous = get().items.find((entry) => entry.id === id);
      if (!previous) return;
      const sourceUrl = URL.createObjectURL(result.file);
      const resultUrl = kept ? URL.createObjectURL(kept) : null;
      set((state) => ({
        items: state.items.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                source: result.file,
                sourceUrl,
                preview: null,
                width: kept ? result.width : 0,
                height: kept ? result.height : 0,
                ...(kept
                  ? { resultBlob: kept, resultUrl, status: "done" as const, cancelled: undefined }
                  : {}),
                enhanced: { scale: result.scale, model: result.model, device: result.device },
              }
            : entry,
        ),
        metadata: null,
        enhancing: null,
        ...(kept ? { phase: resultPhase(get().items, get().phase) } : {}),
      }));
      revoke(previous.sourceUrl);
      if (kept) revoke(previous.resultUrl);
      closePreview(previous.preview);
      if (runtime.itemAborts.get(id) === controller) runtime.itemAborts.delete(id);
      if (!kept) get().reprocessItem(id);
      void hydratePreview(runtime.job, id, result.file, get, set);
    } catch (error) {
      if (controller.signal.aborted || !alive()) return;
      set({ errorMessage: classifyError(error).message });
    } finally {
      if (token === runtime.job && get().enhancing === id)
        set({ enhancing: null, phase: resultPhase(get().items, get().phase) });
      if (runtime.itemAborts.get(id) === controller) runtime.itemAborts.delete(id);
    }
  },
  cancelEnhance: () => {
    const id = get().enhancing;
    if (id) runtime.itemAborts.get(id)?.abort();
  },
  cancelProcessing: () => cancelProcessing(get, set),
  reprocessItem: (id) => {
    const item = get().items.find((entry) => entry.id === id);
    if (!item || (item.status !== "done" && item.status !== "error")) return;
    runtime.itemAborts.get(id)?.abort();
    revoke(item.resultUrl);
    set({
      items: get().items.map((entry) =>
        entry.id === id
          ? {
              ...entry,
              status: "queued",
              error: undefined,
              cancelled: undefined,
              resultBlob: null,
              resultUrl: null,
              diagnostics: undefined,
              removalNote: undefined,
            }
          : entry,
      ),
      errorMessage: null,
      phase: "processing",
    });
    void runQueue(runtime.job, get, set);
  },
  replaceResult: (blob) => {
    const item = get().items.find((entry) => entry.id === get().activeId);
    if (!item?.resultBlob || item.status !== "done" || item.resultBlob === blob) return;
    const resultUrl = URL.createObjectURL(blob);
    set({
      items: get().items.map((entry) =>
        entry.id === item.id
          ? { ...entry, resultBlob: blob, resultUrl, removalNote: "refined" as const }
          : entry,
      ),
    });
    revoke(item.resultUrl);
  },
  retryItem: (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item || item.status !== "error" || item.retryable === false) return;
    set({
      items: get().items.map((i) =>
        i.id === id ? { ...i, status: "queued", error: undefined, cancelled: undefined } : i,
      ),
      errorMessage: null,
      phase: "processing",
    });
    void runQueue(runtime.job, get, set);
  },
  removeItem: (id) => {
    const item = get().items.find((i) => i.id === id);
    if (!item) return;
    if (get().items.length === 1) {
      get().reset();
      return;
    }
    runtime.itemAborts.get(id)?.abort();
    const items = get().items.filter((i) => i.id !== id);
    const removingActive = get().activeId === id;
    if (removingActive) clearSourceBitmapCache();
    const activeId = get().activeId === id ? (items[0]?.id ?? null) : get().activeId;
    const settings = Object.fromEntries(
      Object.entries(get().settings).filter(([key]) => key !== id),
    );
    const withoutRemoved = (map: typeof settings) =>
      Object.fromEntries(Object.entries(map).filter(([key]) => key !== id));
    const same = (a: typeof settings, b: typeof settings) => {
      const keys = Object.keys(a);
      return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
    };
    let previous = settings;
    const past = get()
      .past.slice()
      .reverse()
      .flatMap((entry) => {
        const next = withoutRemoved(entry.settings);
        if (same(previous, next)) return [];
        previous = next;
        return [{ ...entry, settings: next }];
      })
      .reverse();
    previous = settings;
    const future = get().future.flatMap((entry) => {
      const next = withoutRemoved(entry);
      if (same(previous, next)) return [];
      previous = next;
      return [next];
    });
    set({
      items,
      activeId,
      ...(removingActive ? { metadata: null, inspecting: false } : {}),
      settings,
      past,
      future,
      selectedIds: get().selectedIds.filter((key) => key !== id),
      excludedIds: get().excludedIds.filter((key) => key !== id),
    });
    revoke(item.sourceUrl);
    revoke(item.resultUrl);
    closePreview(item.preview);
  },
  resetAdjust: () => {
    get().changeEdit(defaults);
    set({ inspectMode: "composite" });
  },

  reset: () => resetWorkspace(get, set),

  reportError: (errorMessage) => set({ errorMessage }),
}));

// Browser tests read the store; production pages only expose it when loaded with ?e2e,
// so extensions and injected scripts don't get every image blob by default.
if (
  typeof window !== "undefined" &&
  (import.meta.env.DEV || new URLSearchParams(location.search).has("e2e"))
) {
  (window as unknown as { __cutoutTest?: unknown }).__cutoutTest = { useWorkspace };
}

installEditorPreview(useWorkspace);

// History and batch settings can share background URLs; release only when no snapshot owns them.
useWorkspace.subscribe((state, previous) => {
  function urls(s: WorkspaceState) {
    const maps = [s.settings, ...s.past.map((entry) => entry.settings), ...s.future];
    return new Set(
      maps.flatMap((map) =>
        Object.values(map).flatMap((edit) =>
          edit.backgroundImageUrl ? [edit.backgroundImageUrl] : [],
        ),
      ),
    );
  }
  if (
    state.settings === previous.settings &&
    state.past === previous.past &&
    state.future === previous.future
  )
    return;
  const current = urls(state);
  for (const url of urls(previous)) if (!current.has(url)) URL.revokeObjectURL(url);
});

export function resumeWorkspace(snapshot: SavedSession) {
  return restoreWorkspace(snapshot, useWorkspace);
}
