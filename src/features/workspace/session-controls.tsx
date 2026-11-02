import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { useWorkspace, resumeWorkspace } from "@/lib/workspace-store";
import {
  deleteSavedWorkspace,
  hasSavedWorkspace,
  loadSession,
  prepareSessionMutation,
  saveSession,
  sessionInputsChanged,
  shouldOpenStore,
  snapshotSession,
  type SavedSession,
} from "@/lib/editor/session";
import { EditorDialog } from "./editor-dialog";
import { markSaved } from "./use-unsaved-guard";
import { localWorkspaceGeneration, onLocalWorkspaceDeleted } from "@/lib/editor/session-events";

// Autosave belongs to the work in memory, not to this button: the header's Guide link
// unmounts the workspace page while the store keeps every image, so the choice, the
// pending save and the last status live here and carry on until the user comes back.
const useAutosave = create<{
  enabled: boolean;
  saved: SavedSession | null;
  status: string;
  dirty: boolean;
}>(() => ({ enabled: false, saved: null, status: "", dirty: false }));
/** Saving is on; off for the length of a resume, which must not save itself. */
let active = false;
let revision = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let watching = false;
const setStatus = (status: string) => useAutosave.setState({ status });

function watchWorkspace() {
  if (watching) return;
  watching = true;
  onLocalWorkspaceDeleted(() => {
    active = false;
    cancelPending();
    useAutosave.setState({
      enabled: false,
      saved: null,
      status: "Saved workspace deleted. Autosave is off.",
      dirty: false,
    });
  });
  useWorkspace.subscribe((next, old) => {
    if (!sessionInputsChanged(next, old)) return;
    if (!active) return;
    if (next.items.length === 0) {
      cancelPending();
      useAutosave.setState({ status: "", dirty: false });
      return;
    }
    const token = ++revision;
    clearTimeout(timer);
    useAutosave.setState({ status: "Unsaved changes…", dirty: true });
    timer = setTimeout(() => {
      timer = undefined;
      void persist(token);
    }, 600);
  });
}
/** Drops the save waiting out its pause, if any. */
function cancelPending() {
  ++revision;
  clearTimeout(timer);
  timer = undefined;
}
/** Writes the save waiting out its pause now: the workspace page is going away. */
function flushPending() {
  if (timer === undefined) return;
  clearTimeout(timer);
  timer = undefined;
  void persist(revision);
}
async function persist(token: number) {
  const expectedGeneration = localWorkspaceGeneration();
  if (!active || token !== revision) return;
  try {
    await prepareSessionMutation();
    if (!active || token !== revision || expectedGeneration !== localWorkspaceGeneration()) return;
    const state = useWorkspace.getState();
    const snapshot = snapshotSession(state);
    setStatus("Saving on this device…");
    const generation = await saveSession(snapshot, expectedGeneration);
    // A reload no longer loses these results; an edit made since makes them unsaved again.
    for (const item of state.items)
      if (item.resultBlob) markSaved(item.resultBlob, state.settings[item.id], generation);
    if (active && token === revision && generation === localWorkspaceGeneration())
      useAutosave.setState({ saved: snapshot, status: "Saved on this device.", dirty: false });
  } catch (e) {
    if (token === revision)
      useAutosave.setState({
        dirty: true,
        status:
          e instanceof Error &&
          /^(This workspace|Image settings|Close other Cutout tabs)/.test(e.message)
            ? `Not saved: ${e.message}`
            : "Not saved. Browser storage may be full or unavailable. Your open images and edits are still available.",
      });
  }
}

export function SessionControls() {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [mounted, setMounted] = useState(false),
    [loading, setLoading] = useState(true);
  const { enabled, saved, status, dirty } = useAutosave();
  const alive = useRef(true);
  const count = useWorkspace((s) => s.items.length);
  useEffect(() => {
    alive.current = true;
    setMounted(true);
    watchWorkspace();
    const readRevision = revision;
    const generation = localWorkspaceGeneration();
    // Opening IndexedDB creates it; a visit that never saved must not leave a database behind.
    void hasSavedWorkspace()
      .then((hasSaveFlag) =>
        shouldOpenStore({ hasSaveFlag, autosave: active }) ? loadSession() : null,
      )
      .then((data) => {
        if (revision === readRevision && generation === localWorkspaceGeneration())
          useAutosave.setState({ saved: data });
      })
      .catch((e) => {
        if (alive.current)
          setStatus(e instanceof Error ? e.message : "Local saving is unavailable.");
      })
      .finally(() => {
        if (alive.current) setLoading(false);
      });
    return () => {
      alive.current = false;
      flushPending();
    };
  }, []);
  async function enable() {
    localWorkspaceGeneration();
    active = true;
    useAutosave.setState({ enabled: true });
    await persist(++revision);
  }
  async function clear() {
    if (
      saved &&
      !window.confirm(
        "Delete the saved workspace from this device? This cannot be undone. The open workspace will stay available.",
      )
    )
      return;
    active = false;
    useAutosave.setState({ enabled: false });
    cancelPending();
    setBusy(true);
    try {
      await deleteSavedWorkspace();
      useAutosave.setState({
        saved: null,
        status: "Saved workspace deleted. Autosave is off.",
        dirty: false,
      });
    } catch {
      setStatus(
        "Could not delete the saved workspace. Try again or clear this site’s browser data.",
      );
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!mounted}
        aria-busy={!mounted}
        onClick={() => setOpen(true)}
      >
        <span className="header-label-full">
          {saved && !dirty ? "Saved workspace" : "Save workspace"}
        </span>
        <span className="header-label-short">{saved && !dirty ? "Saved" : "Save"}</span>
      </Button>
      <EditorDialog
        open={open}
        onOpenChange={setOpen}
        title="Saved workspace"
        description="Optionally keep one workspace in this browser on this device."
      >
        <p className="mt-4 text-sm text-muted">
          Saving includes original images, results and current adjustments. It does not include undo
          history. Browser data can be cleared or evicted; keep downloaded copies of important work.
        </p>
        <div className="editor-actions">
          <Button
            variant="primary"
            disabled={!count || busy || loading}
            onClick={() => void enable()}
          >
            {enabled ? "Save now" : "Enable local autosave"}
          </Button>
          {enabled ? (
            <Button
              variant="secondary"
              onClick={() => {
                active = false;
                useAutosave.setState({ enabled: false });
                cancelPending();
                setStatus("Autosave paused. The saved copy remains.");
              }}
            >
              Pause autosave
            </Button>
          ) : null}
        </div>
        {saved ? (
          <>
            <p className="text-sm">
              {saved.items.length} images · saved {new Date(saved.savedAt).toLocaleString()}
            </p>
            <div className="editor-actions">
              <Button
                variant="secondary"
                disabled={busy || count > 0}
                onClick={() => {
                  // Resuming keeps the user's autosave choice instead of turning it on.
                  const generation = localWorkspaceGeneration();
                  if (useAutosave.getState().saved !== saved) return;
                  const autosave = active;
                  active = false;
                  setBusy(true);
                  void resumeWorkspace(saved)
                    .then(() => {
                      if (generation !== localWorkspaceGeneration()) return;
                      // What was just restored is already stored; only later edits are unsaved.
                      const state = useWorkspace.getState();
                      for (const item of state.items)
                        if (item.resultBlob)
                          markSaved(item.resultBlob, state.settings[item.id], generation);
                      setStatus(
                        autosave
                          ? "Workspace restored. Autosave is on."
                          : "Workspace restored. Autosave is off.",
                      );
                      setOpen(false);
                    })
                    .catch(() => {
                      if (generation === localWorkspaceGeneration())
                        setStatus("This saved workspace could not be restored.");
                    })
                    .finally(() => {
                      active = autosave && generation === localWorkspaceGeneration();
                      setBusy(false);
                    });
                }}
              >
                Resume saved workspace
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => void clear()}>
                Delete saved workspace
              </Button>
            </div>
            {count > 0 ? (
              <p className="text-xs text-muted">
                Start a new empty workspace with the Cutout logo before resuming the saved copy.
              </p>
            ) : null}
          </>
        ) : (
          <Button variant="secondary" disabled={busy} onClick={() => void clear()}>
            Clear local workspace data
          </Button>
        )}
        <p role="status" className="mt-4 text-sm">
          {loading ? "Checking for a saved workspace…" : status || "Local autosave is off."}
        </p>
        <p className="mt-3 text-xs text-muted">
          Up to 15 images and 250 MB per workspace. This is not cloud storage or synchronization.
          Only enable it on a device you trust.
        </p>
      </EditorDialog>
    </>
  );
}
