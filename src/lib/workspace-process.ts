import type { WorkspaceState, QueueItem } from "./workspace-types";
import { removeBackgroundAuto } from "./removal-client";
import { classifyError, messageFor } from "./errors";
import { processable } from "./editor/canvas";
import { runtime } from "./workspace-runtime";
export async function processQueueItem(
  token: number,
  item: QueueItem,
  get: () => WorkspaceState,
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
) {
  let progressTimer = 0;
  const controller = new AbortController();
  const parent = runtime.runAbort?.signal;
  // ponytail: AbortSignal.any once iOS < 17.4 is dropped.
  const cancel = () => controller.abort();
  parent?.addEventListener("abort", cancel, { once: true });
  if (parent?.aborted) controller.abort();
  const signal = controller.signal;
  runtime.itemAborts.set(item.id, controller);
  // Retry clears the item's stopped flag, but cannot revive this aborted operation.
  const alive = () => {
    if (token !== runtime.job || signal.aborted) return false;
    const entry = get().items.find((entry) => entry.id === item.id);
    return !!entry && !entry.cancelled;
  };
  try {
    const started = performance.now();
    const source = await processable(item.source);
    if (!alive()) return;
    signal.throwIfAborted();
    const result = await removeBackgroundAuto(source, {
      signal,
      mode: get().removalMode,
      onProgress: (progress) => {
        if (!alive()) return;
        if (progressTimer) return;
        progressTimer = window.setTimeout(() => {
          progressTimer = 0;
        }, 80);
        set({ progress });
      },
    });
    if (!alive()) return;
    const resultUrl = URL.createObjectURL(result.blob);
    set((state) => ({
      items: state.items.map((entry) =>
        entry.id === item.id
          ? {
              ...entry,
              status: "done",
              cancelled: undefined,
              resultBlob: result.blob,
              resultUrl,
              width: result.width,
              height: result.height,
              durationMs: Math.round(performance.now() - started),
              provider: result.provider,
              method: result.method,
              model: result.model,
              diagnostics: result.diagnostics,
              removalNote: result.removalNote,
            }
          : entry,
      ),
    }));
  } catch (error) {
    if (!alive()) return;
    const classified = classifyError(error);
    // A model error that merely reads like cancellation while this wait is still live
    // is a failure with Retry; automatically requeuing it caused an endless loop (C05).
    const failure =
      classified.code === "cancelled"
        ? { message: messageFor("sample"), retryable: true }
        : classified;
    set((state) => ({
      items: state.items.map((entry) =>
        entry.id === item.id
          ? { ...entry, status: "error", error: failure.message, retryable: failure.retryable }
          : entry,
      ),
      errorMessage: failure.message,
    }));
  } finally {
    window.clearTimeout(progressTimer);
    parent?.removeEventListener("abort", cancel);
    if (runtime.itemAborts.get(item.id) === controller) runtime.itemAborts.delete(item.id);
  }
}
