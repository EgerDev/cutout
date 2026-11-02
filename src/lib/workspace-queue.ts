import type { WorkspaceState, QueueItem } from "./workspace-types";
import { runtime } from "./workspace-runtime";
import { processQueueItem } from "./workspace-process";
function claimQueued(
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
): QueueItem | null {
  let claimed: QueueItem | null = null;
  set((state) => {
    const item = state.items.find((entry) => entry.status === "queued");
    if (!item) return state;
    claimed = item;
    const current = state.items.find((entry) => entry.id === state.activeId);
    const hold = current?.status === "done" && current.id !== item.id;
    return {
      items: state.items.map((entry) =>
        entry.id === item.id ? { ...entry, status: "working" as const } : entry,
      ),
      progress: { stage: "loading", progress: 0, message: "" },
      activeId: hold ? state.activeId : item.id,
      phase: state.phase === "adjusting" ? "adjusting" : "processing",
    };
  });
  return claimed;
}

/** Stop pending removal work without touching finished items. Marks each queued/working
 *  item stopped so the running loop's claim, late success and abort-requeue paths all pass
 *  it by, then aborts only those items' own controllers — never the shared run signal
 *  (downloads listen on it) or another feature's per-item wait (enhancement). */
export function cancelProcessing(
  get: () => WorkspaceState,
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
) {
  const ids = new Set(
    get()
      .items.filter((entry) => entry.status === "queued" || entry.status === "working")
      .map((entry) => entry.id),
  );
  if (ids.size === 0) return;
  set((state) => ({
    items: state.items.map((entry) =>
      ids.has(entry.id) && (entry.status === "queued" || entry.status === "working")
        ? {
            ...entry,
            status: "error" as const,
            error: "Stopped.",
            retryable: true,
            cancelled: true,
          }
        : entry,
    ),
  }));
  for (const id of ids) runtime.itemAborts.get(id)?.abort();
}

export async function runQueue(
  token: number,
  get: () => WorkspaceState,
  set: (
    partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>),
  ) => void,
) {
  if (runtime.queueToken === token) return;
  runtime.queueToken = token;
  // One item at a time; items queued mid-run are claimed too.
  while (token === runtime.job) {
    const item = claimQueued(set);
    if (!item) break;
    await processQueueItem(token, item, get, set);
  }
  if (runtime.queueToken === token) runtime.queueToken = null;
  if (token !== runtime.job) return;
  const latest = get().items;
  const done = latest.find((item) => item.status === "done");
  const active = latest.find((item) => item.id === get().activeId);
  set({
    phase: done ? (get().phase === "adjusting" ? "adjusting" : "result") : "error",
    activeId: active?.status === "done" ? active.id : (done?.id ?? latest[0]?.id ?? null),
  });
}
