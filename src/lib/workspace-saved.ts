import type { WorkspaceState } from "./workspace-types.ts";
import { localWorkspaceGeneration, onLocalWorkspaceDeleted } from "./editor/session-events.ts";

const saved = new WeakMap<Blob, unknown>();
let localSaved = new WeakMap<Blob, unknown>();
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};

onLocalWorkspaceDeleted(() => {
  localSaved = new WeakMap();
  changed();
});

/** Records the exact result and settings written, independently of the active item. */
export function markSaved(result: Blob, settings: unknown, localGeneration?: number) {
  if (localGeneration === undefined) saved.set(result, settings);
  else if (localGeneration === localWorkspaceGeneration()) localSaved.set(result, settings);
  changed();
}

/** Detaching storage backing preserves only the provenance of the exact old bytes/edits. */
export function preserveSavedReferences(
  before: Blob,
  after: Blob,
  settings: ReadonlyMap<unknown, unknown>,
) {
  for (const records of [saved, localSaved]) {
    if (!records.has(before)) continue;
    const value = records.get(before);
    records.set(after, settings.get(value) ?? value);
  }
}

export function onSavedChange(listener: () => void) {
  localWorkspaceGeneration();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function hasUnsavedWork(state: Pick<WorkspaceState, "items" | "settings">) {
  return state.items.some(
    (item) =>
      item.status === "done" &&
      item.resultBlob !== null &&
      !(
        (saved.has(item.resultBlob) && saved.get(item.resultBlob) === state.settings[item.id]) ||
        (localSaved.has(item.resultBlob) &&
          localSaved.get(item.resultBlob) === state.settings[item.id])
      ),
  );
}
