import type { WorkspaceState, QueueItem } from "./workspace-types";
import { editorDefaults } from "./editor/state";
import {
  setSessionPreserver,
  updateSessionReferences,
  type SavedSession,
} from "./editor/session.ts";
import { preserveSavedReferences } from "./workspace-saved.ts";
import type { EditSettings, SettingsMap } from "./editor/model.ts";
import { restoreSettings, shareBackgrounds } from "./editor/model";
import { defaults } from "./editor/model";
import { revoke, closePreview } from "./editor/resources";
import { runtime, PREVIEW_CONCURRENCY, cancelWorkspaceJobs } from "./workspace-runtime";
import { runQueue } from "./workspace-queue";
import { hydratePreview } from "./workspace-ingest";
import { runPool } from "./pool";
import { clearSourceBitmapCache } from "./editor/canvas";
import { rasterizeSvgFile } from "./files";

const restoredBlobs = new WeakSet<Blob>();
const detachedBlobs = new WeakMap<Blob, Blob>();
type WorkspaceStore = {
  getState: () => WorkspaceState;
  setState: (
    partial: Partial<WorkspaceState> | ((s: WorkspaceState) => Partial<WorkspaceState>),
  ) => void;
};

async function preserveRestoredWorkspace(store: WorkspaceStore) {
  const state = store.getState();
  const live = new Set(state.items.map((item) => item.id));
  const blobs = new Set<Blob>();
  for (const item of state.items) {
    blobs.add(item.source);
    if (item.resultBlob) blobs.add(item.resultBlob);
  }
  for (const map of [state.settings, ...state.past.map((entry) => entry.settings), ...state.future])
    for (const [id, settings] of Object.entries(map))
      if (live.has(id) && settings.backgroundBlob) blobs.add(settings.backgroundBlob);
  // A resumed snapshot is capped at 250 MB. Copy distinct, still-open backing once,
  // sequentially, so only one additional ArrayBuffer is live at a time.
  for (const blob of blobs) {
    if (!restoredBlobs.has(blob) || detachedBlobs.has(blob)) continue;
    const bytes = await blob.arrayBuffer();
    detachedBlobs.set(
      blob,
      blob instanceof File
        ? new File([bytes], blob.name, { type: blob.type, lastModified: blob.lastModified })
        : new Blob([bytes], { type: blob.type }),
    );
  }
  const current = store.getState();
  const settingsCopies = new Map<EditSettings, EditSettings>();
  const urls = new Map<string, string>();
  const urlFor = (old: string | null, blob: Blob) => {
    if (!old) return null;
    let url = urls.get(old);
    if (!url) urls.set(old, (url = URL.createObjectURL(blob)));
    return url;
  };
  const mapSettings = (map: SettingsMap): SettingsMap => {
    let changed = false;
    const entries = Object.entries(map).map(([id, settings]) => {
      const background = settings.backgroundBlob && detachedBlobs.get(settings.backgroundBlob);
      if (!background) return [id, settings];
      let copy = settingsCopies.get(settings);
      if (!copy) {
        const url = urlFor(settings.backgroundImageUrl, background);
        copy = {
          ...settings,
          backgroundBlob: background,
          backgroundImageUrl: url,
          background:
            settings.background.type === "image" && url
              ? { type: "image", url }
              : settings.background,
        };
        settingsCopies.set(settings, copy);
      }
      changed = true;
      return [id, copy];
    });
    return changed ? Object.fromEntries(entries) : map;
  };
  const settings = mapSettings(current.settings);
  const past = current.past.map((entry) => {
    const settings = mapSettings(entry.settings);
    return settings === entry.settings ? entry : { ...entry, settings };
  });
  const future = current.future.map(mapSettings);
  let changed =
    settings !== current.settings ||
    past.some((entry, i) => entry !== current.past[i]) ||
    future.some((entry, i) => entry !== current.future[i]);
  const items = current.items.map((item) => {
    const source = detachedBlobs.get(item.source) as File | undefined;
    const result = item.resultBlob && detachedBlobs.get(item.resultBlob);
    if (item.resultBlob)
      preserveSavedReferences(item.resultBlob, result || item.resultBlob, settingsCopies);
    if (!source && !result) return item;
    changed = true;
    return {
      ...item,
      source: source ?? item.source,
      sourceUrl: source ? urlFor(item.sourceUrl, source)! : item.sourceUrl,
      resultBlob: result || item.resultBlob,
      resultUrl: result ? urlFor(item.resultUrl, result) : item.resultUrl,
    };
  });
  // Read the current state after copying: an upload/reset/edit may have happened meanwhile.
  if (changed) updateSessionReferences(() => store.setState({ items, settings, past, future }));
  for (const old of urls.keys()) revoke(old);
}
export function resetWorkspace(
  get: () => WorkspaceState,
  set: (partial: Partial<WorkspaceState>) => void,
) {
  runtime.job += 1;
  runtime.queueToken = null;
  cancelWorkspaceJobs();
  clearSourceBitmapCache();
  for (const item of get().items) {
    revoke(item.sourceUrl);
    revoke(item.resultUrl);
    closePreview(item.preview);
  }

  set({
    ...editorDefaults,
    phase: "idle",
    progress: { stage: "loading", progress: 0, message: "" },
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
    metadata: null,
    inspectMode: "composite",
    showGuides: false,
    excludedIds: [],
    removalMode: "auto",
  });
}
export async function resumeWorkspace(snapshot: SavedSession, store: WorkspaceStore) {
  const job = runtime.job;
  const drop = runtime.drop;
  // Workspaces saved before SVG was rasterised at ingest can still hold SVG sources or
  // backgrounds; one that cannot be drawn is dropped rather than exposed, and one bad image
  // must not cost the user the rest of the workspace.
  const [restored, backgrounds] = await Promise.all([
    Promise.all(
      snapshot.items.map(async (saved, index) => {
        const source = await rasterizeSvgFile(
          new File([saved.source], saved.name, { type: saved.source.type }),
        ).catch(() => null);
        return source ? { saved, source, index } : null;
      }),
    ),
    // A background shared by several items comes back as one Blob, as it was before the save.
    shareBackgrounds(
      snapshot.items.map((saved) => saved.settings.backgroundBlob),
      (blob) => rasterizeSvgFile(new File([blob], "background", { type: blob.type })),
    ),
  ]);
  // Validation can outlive a new upload or reset; only the original workspace may be replaced.
  if (runtime.job !== job || runtime.drop !== drop)
    throw new Error("The workspace changed while restoring. Try again from an empty workspace.");
  const kept = restored.filter((entry) => entry !== null);
  if (kept.length === 0) throw new Error("Nothing in this saved workspace could be restored.");
  store.getState().reset();
  const token = runtime.job;
  const items: QueueItem[] = kept.map(({ saved, source }, index) => {
    return {
      id: `${token}-${index}`,
      name: source.name,
      source,
      sourceUrl: URL.createObjectURL(source),
      preview: null,
      resultBlob: saved.result,
      resultUrl: saved.result ? URL.createObjectURL(saved.result) : null,
      width: saved.width,
      height: saved.height,
      status: saved.result ? "done" : "queued",
    };
  });
  const settings = Object.fromEntries(
    items.map((item, index) => [
      item.id,
      restoreSettings({
        ...(kept[index]?.saved.settings ?? defaults),
        backgroundBlob: backgrounds[kept[index]?.index ?? -1] ?? null,
      }),
    ]),
  );
  for (const item of items) {
    restoredBlobs.add(item.source);
    if (item.resultBlob) restoredBlobs.add(item.resultBlob);
    const background = settings[item.id]?.backgroundBlob;
    if (background) restoredBlobs.add(background);
  }
  setSessionPreserver(async (snapshot) => {
    await preserveRestoredWorkspace(store);
    if (!snapshot) return null;
    return {
      ...snapshot,
      items: snapshot.items.map((item) => ({
        ...item,
        source: detachedBlobs.get(item.source) ?? item.source,
        result: item.result && (detachedBlobs.get(item.result) ?? item.result),
        settings: {
          ...item.settings,
          backgroundBlob:
            item.settings.backgroundBlob &&
            (detachedBlobs.get(item.settings.backgroundBlob) ?? item.settings.backgroundBlob),
        },
      })),
    };
  });
  const active = kept.findIndex((entry) => entry.index === snapshot.activeIndex);
  const activeId = items[Math.max(0, active)]?.id ?? null;
  const skipped = snapshot.items.length - kept.length;
  store.setState({
    items,
    settings,
    activeId,
    phase: items.some((i) => i.status === "queued") ? "processing" : "result",
    errorMessage:
      skipped === 0
        ? null
        : skipped === 1
          ? "One saved image couldn’t be restored and was left out."
          : `${skipped} saved images couldn’t be restored and were left out.`,
  });
  runtime.runAbort = new AbortController();
  void runQueue(token, store.getState, store.setState);
  void runPool(items, PREVIEW_CONCURRENCY, (item) =>
    hydratePreview(token, item.id, item.source, store.getState, store.setState),
  );
}
