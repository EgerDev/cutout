// A native delete can succeed after its caller has already rejected on blocked.
// Keep that lifetime in the data layer, independent of mounted workspace controls.
let generation = 0;
const listeners = new Set<() => void>();
// Anonymous, durable fencing token: never contains images or editor settings.
const DELETION_KEY = "cutout:workspace-deleted";
let watching = false;
let observedDeletion: string | null | undefined;

function notifyDeleted() {
  ++generation;
  for (const listener of listeners) listener();
}

function syncDeletion() {
  try {
    const current = localStorage.getItem(DELETION_KEY);
    const changed = observedDeletion !== undefined && current !== observedDeletion;
    observedDeletion = current;
    if (changed) notifyDeleted();
  } catch {
    // IndexedDB can still work when localStorage is unavailable.
  }
}

function watchOtherTabs() {
  if (watching || typeof window === "undefined" || typeof window.addEventListener !== "function")
    return;
  watching = true;
  window.addEventListener("storage", (event) => {
    if (event.key === DELETION_KEY || event.key === null) syncDeletion();
  });
}

export function localWorkspaceGeneration() {
  watchOtherTabs();
  // Storage events can be delayed in a background tab. Fence writes synchronously too.
  syncDeletion();
  return generation;
}

export function onLocalWorkspaceDeleted(listener: () => void) {
  watchOtherTabs();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function localWorkspaceDeleted() {
  try {
    const nonce = crypto.randomUUID();
    localStorage.setItem(DELETION_KEY, nonce);
    observedDeletion = nonce;
  } catch {
    /* Storage may be unavailable. */
  }
  notifyDeleted();
}
