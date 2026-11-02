import { useEffect } from "react";
import { useWorkspace } from "@/lib/workspace-store";
import type { WorkspaceState } from "@/lib/workspace-types";
import { hasUnsavedWork, onSavedChange } from "../../lib/workspace-saved.ts";
export { markSaved } from "../../lib/workspace-saved.ts";

function warn(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = ""; // Safari < 17 and older Chrome ignore preventDefault alone
}

let installed = false;

/**
 * Asks before a reload, close or back navigation throws away cutouts that were never
 * saved. The listener exists only while there is such work: an idle beforeunload
 * handler would keep the page out of the back/forward cache.
 *
 * Installed once and never removed: the work lives in the store, which outlasts the
 * workspace page (the header's Guide link leaves it with every image still in memory).
 */
export function useUnsavedGuard() {
  useEffect(() => {
    if (installed) return;
    installed = true;
    let listening = false;
    const update = (state: WorkspaceState) => {
      const dirty = hasUnsavedWork(state);
      if (dirty === listening) return;
      listening = dirty;
      if (dirty) window.addEventListener("beforeunload", warn);
      else window.removeEventListener("beforeunload", warn);
    };
    onSavedChange(() => update(useWorkspace.getState()));
    useWorkspace.subscribe(update);
    update(useWorkspace.getState());
  }, []);
}
