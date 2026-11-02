import { activeSettings } from "./state.ts";
import type { WorkspaceState } from "../workspace-store.ts";
import type { EditSettings } from "./model.ts";
import { MATTE_PREVIEW_MAX, encodeCanvas } from "./canvas.ts";
import { renderCanvas } from "./render.ts";
import { classifyError } from "../errors.ts";
import { closePreview } from "./resources.ts";

type Store = Readonly<{
  getState: () => WorkspaceState;
  setState: (patch: Partial<WorkspaceState>) => void;
  subscribe: (fn: (next: WorkspaceState, old: WorkspaceState) => void) => () => void;
}>;

function previewLooksSame(a: EditSettings, b: EditSettings) {
  if (a === b) return true;
  for (const key of Object.keys(a) as (keyof EditSettings)[]) {
    if (key === "quality" || key === "targetKB" || key === "stripMetadata") continue;
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function installEditorPreview(store: Store) {
  let timer: ReturnType<typeof setTimeout> | undefined, abort: AbortController | undefined;
  const owned = new Set<string>();
  let ownedBitmap: ImageBitmap | null = null;
  const revoke = () => {
    for (const url of owned) URL.revokeObjectURL(url);
    owned.clear();
    closePreview(ownedBitmap);
    ownedBitmap = null;
  };
  store.subscribe((state, old) => {
    const item = state.items.find((i) => i.id === state.activeId),
      before = old.items.find((i) => i.id === old.activeId);
    const edits = activeSettings(state),
      previous = activeSettings(old);
    if (
      item?.resultBlob === before?.resultBlob &&
      item?.id === before?.id &&
      state.inspectMode === old.inspectMode &&
      previewLooksSame(edits, previous)
    )
      return;
    clearTimeout(timer);
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    if (item?.id !== before?.id || !item?.resultBlob) {
      revoke();
      store.setState({ previewUrl: null, previewBitmap: null, previewBusy: false });
    }
    if (!item?.resultBlob) return;
    const result = item.resultBlob;
    const mode = state.inspectMode;
    timer = setTimeout(() => {
      store.setState({ previewBusy: true });
      void (async () => {
        let url: string | undefined;
        let bitmap: ImageBitmap | undefined;
        try {
          const canvas = await renderCanvas(
            { result, source: item.source, settings: edits },
            { maxSide: 1200, matteMaxSide: MATTE_PREVIEW_MAX, mode, signal },
          );
          let width = 0,
            height = 0;
          try {
            width = canvas.width;
            height = canvas.height;
            // The stage paints bitmaps directly; the mask view's DOM fallback is a
            // CSS mask-image and still needs a URL.
            if (mode === "mask") url = URL.createObjectURL(await encodeCanvas(canvas));
            else bitmap = await createImageBitmap(canvas);
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
          signal.throwIfAborted();
          if (!url && !bitmap) return;
          revoke();
          if (url) owned.add(url);
          ownedBitmap = bitmap ?? null;
          store.setState({
            previewUrl: url ?? null,
            previewBitmap: bitmap ?? null,
            previewWidth: width,
            previewHeight: height,
            previewBusy: false,
          });
        } catch (error) {
          if (url) URL.revokeObjectURL(url);
          closePreview(bitmap);
          if (!signal.aborted)
            store.setState({
              previewBusy: false,
              errorMessage: classifyError(error).message,
            });
        }
      })();
    }, 120);
  });
}
