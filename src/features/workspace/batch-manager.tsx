import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspace, type WorkspaceState } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { defaults, PRESETS, type Preset, type EditSettings } from "@/lib/editor/model";
import { downloadBlob } from "@/lib/files";
import { formatLabel } from "@/lib/formats";
import { EditorDialog } from "./editor-dialog";
import { markSaved } from "./use-unsaved-guard";

type QualityInput = {
  result: Blob;
  source: File;
  settings: EditSettings;
  width: number;
  height: number;
};
type QualityEntry = {
  input: QualityInput;
  status: "pending" | "checking" | "done";
  warnings?: number;
  error?: string;
};

function sameQualityInput(a: QualityInput, b: QualityInput) {
  return (
    a.result === b.result &&
    a.source === b.source &&
    a.settings === b.settings &&
    a.width === b.width &&
    a.height === b.height
  );
}

function exportSnapshots(
  state: WorkspaceState,
  selected: readonly string[],
  onlySelected: boolean,
) {
  return state.items.flatMap((item) =>
    item.resultBlob &&
    item.status === "done" &&
    (!onlySelected || selected.includes(item.id)) &&
    !state.excludedIds.includes(item.id)
      ? [
          {
            id: item.id,
            name: item.name,
            result: item.resultBlob,
            source: item.source,
            settings: state.settings[item.id] ?? defaults,
          },
        ]
      : [],
  );
}

export function BatchManager({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const items = useWorkspace((s) => s.items),
    selected = useWorkspace((s) => s.selectedIds),
    activeId = useWorkspace((s) => s.activeId);
  const format = useWorkspace((s) => activeSettings(s).exportFormat);
  const [progress, setProgress] = useState<string | null>(null),
    [message, setMessage] = useState("");
  const [skipWarned, setSkipWarned] = useState(false);
  const [warnings, setWarnings] = useState<Record<string, number>>({});
  const [qualityErrors, setQualityErrors] = useState<Record<string, string>>({});
  const [qualityRetry, setQualityRetry] = useState(0);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [preset, setPreset] = useState<Preset>("product");
  const excluded = useWorkspace((s) => s.excludedIds);
  const abort = useRef<AbortController | null>(null);
  const qualityWork = useRef({
    entries: new Map<string, QualityEntry>(),
    running: false,
    retry: 0,
    wake: null as (() => void) | null,
  });
  useEffect(() => {
    const work = qualityWork.current;
    return () => {
      abort.current?.abort();
      work.entries.clear();
      work.wake = null;
    };
  }, []);
  useEffect(() => {
    const work = qualityWork.current;
    if (!open) {
      work.entries.clear();
      setWarnings({});
      setQualityErrors({});
      setQualityBusy(false);
      return;
    }
    let live = true;
    let retryErrors = work.retry !== qualityRetry;
    work.retry = qualityRetry;
    const publish = () => {
      if (!live) return;
      const warnings: Record<string, number> = {};
      const errors: Record<string, string> = {};
      let busy = false;
      for (const [id, entry] of work.entries) {
        if (entry.status !== "done") busy = true;
        if (entry.warnings) warnings[id] = entry.warnings;
        if (entry.error) errors[id] = entry.error;
      }
      setWarnings(warnings);
      setQualityErrors(errors);
      setQualityBusy(busy);
    };
    const pump = () => {
      if (!live || work.running) return;
      const entry = [...work.entries.values()].find((entry) => entry.status === "pending");
      if (!entry) return;
      work.running = true;
      entry.status = "checking";
      const { result, source, settings, width, height } = entry.input;
      void import("@/lib/editor/quality-live")
        .then(({ inspectEditedQuality }) =>
          inspectEditedQuality(result, source, settings, width, height),
        )
        .then((issues) => {
          entry.warnings = issues.length;
        })
        .catch((error: unknown) => {
          entry.error = error instanceof Error ? error.message : "The quality check failed.";
        })
        .finally(() => {
          entry.status = "done";
          work.running = false;
          publish();
          // Closing/reopening or retrying joins the one in-flight inspection. An
          // obsolete entry may finish, but only the current map can publish it.
          work.wake?.();
        });
    };
    const sync = () => {
      const state = useWorkspace.getState();
      const next = new Map<string, QualityEntry>();
      for (const item of state.items) {
        if (!item.resultBlob || item.status !== "done") continue;
        const input = {
          result: item.resultBlob,
          source: item.source,
          settings: state.settings[item.id] ?? defaults,
          width: item.width,
          height: item.height,
        };
        const previous = work.entries.get(item.id);
        next.set(
          item.id,
          previous && sameQualityInput(previous.input, input) && !(retryErrors && previous.error)
            ? previous
            : { input, status: "pending" },
        );
      }
      retryErrors = false;
      work.entries = next;
      publish();
      pump();
    };
    work.wake = () => {
      publish();
      pump();
    };
    const unsubscribe = useWorkspace.subscribe((state, previous) => {
      if (state.items !== previous.items || state.settings !== previous.settings) sync();
    });
    sync();
    return () => {
      live = false;
      work.wake = null;
      unsubscribe();
    };
  }, [open, qualityRetry]);
  const download = async (onlySelected: boolean) => {
    if (abort.current) return;
    if (skipWarned && qualityBusy) {
      setMessage("Quality checks are still running. Wait before exporting a filtered ZIP.");
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setMessage("");
    setProgress("Preparing ZIP…");
    const state = useWorkspace.getState();
    const snapshots = exportSnapshots(state, selected, onlySelected).filter(
      (item) => !(skipWarned && (warnings[item.id] || qualityErrors[item.id])),
    );
    try {
      const { createArchive } = await import("@/lib/editor/archive");
      const blob = await createArchive(snapshots, format, controller.signal, (done, total) =>
        setProgress(`Exporting ${done} of ${total}…`),
      );
      controller.signal.throwIfAborted();
      if (!downloadBlob(blob, "cutout-images.zip"))
        throw new Error("Download could not start. Please try again.");
      for (const s of snapshots) markSaved(s.result, s.settings);
      setMessage(`Downloaded ${snapshots.length} images as ${formatLabel(format)}.`);
    } catch (error) {
      setMessage(
        controller.signal.aborted
          ? "ZIP export cancelled."
          : error instanceof Error
            ? error.message
            : "ZIP export failed.",
      );
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };
  const sheet = async (kind: "contact" | "sprite", onlySelected: boolean) => {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setMessage("");
    setProgress(kind === "contact" ? "Rendering contact sheet…" : "Rendering sprite sheet…");
    const state = useWorkspace.getState();
    const snapshots = exportSnapshots(state, selected, onlySelected);
    try {
      const { renderSheet, spriteArchive } = await import("@/lib/editor/sheet");
      const cell = kind === "contact" ? 320 : 256;
      const rendered = await renderSheet(snapshots, {
        kind,
        cell,
        signal: controller.signal,
        onProgress: (done, total) => setProgress(`Rendering ${done} of ${total}…`),
      });
      controller.signal.throwIfAborted();
      const ok =
        kind === "contact" || !rendered.atlas
          ? downloadBlob(rendered.blob, "contact-sheet.png")
          : downloadBlob(
              spriteArchive(new Uint8Array(await rendered.blob.arrayBuffer()), rendered.atlas, {
                width: rendered.width,
                height: rendered.height,
              }),
              "sprites.zip",
            );
      if (!ok) throw new Error("Download could not start. Please try again.");
      for (const s of snapshots) markSaved(s.result, s.settings);
      setMessage(
        kind === "contact"
          ? `Contact sheet: ${snapshots.length} images, ${rendered.width} × ${rendered.height} px.`
          : `Sprite sheet: ${snapshots.length} frames with a JSON atlas, ${rendered.width} × ${rendered.height} px.`,
      );
    } catch (error) {
      setMessage(
        controller.signal.aborted
          ? "Sheet export cancelled."
          : error instanceof Error
            ? error.message
            : "Sheet export failed.",
      );
    } finally {
      abort.current = null;
      setProgress(null);
    }
  };
  const ready = items.filter((i) => i.status === "done").length,
    selectedReady = items.filter((i) => i.status === "done" && selected.includes(i.id)).length;
  return (
    <EditorDialog
      open={open}
      onOpenChange={(value) => {
        if (!value) abort.current?.abort();
        onOpenChange(value);
      }}
      title="Batch images"
      description="Select images, apply this image’s settings, or download a ZIP."
    >
      <div className="editor-actions">
        <Button variant="secondary" onClick={() => useWorkspace.getState().selectAll()}>
          {selected.length === items.length ? "Deselect all" : "Select all"}
        </Button>
        <span className="text-sm text-muted">
          {selected.length} selected · {ready} ready
        </span>
      </div>
      {Object.keys(qualityErrors).length ? (
        <div className="editor-actions">
          <p role="alert" className="text-xs text-muted">
            Some images could not be checked for quality. Retry before using quality-based ZIP
            filtering.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setQualityRetry((value) => value + 1)}
          >
            Retry batch quality checks
          </Button>
        </div>
      ) : null}
      <ul className="batch-list">
        {items.map((item) => (
          <li key={item.id}>
            <label className="batch-select">
              <input
                type="checkbox"
                aria-label={`Select ${item.name}`}
                checked={selected.includes(item.id)}
                onChange={() => useWorkspace.getState().toggleSelected(item.id)}
              />
            </label>
            <button
              className="batch-name"
              onClick={() => useWorkspace.getState().selectItem(item.id)}
              aria-current={activeId === item.id ? "true" : undefined}
            >
              <span>{item.name}</span>
              <small>
                {item.status === "done"
                  ? qualityBusy
                    ? "Checking quality…"
                    : qualityErrors[item.id]
                      ? "Quality check unavailable"
                      : warnings[item.id]
                        ? `${warnings[item.id]} warning${warnings[item.id] === 1 ? "" : "s"}`
                        : "Ready"
                  : item.status === "error"
                    ? item.cancelled
                      ? "Stopped"
                      : (item.error ?? "Failed")
                    : item.status === "working"
                      ? "Processing"
                      : "Queued"}
              </small>
            </button>
            {/* One group, so the actions wrap under the name together on a narrow screen. */}
            <span className="batch-actions">
              {item.status === "error" ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={item.retryable === false}
                  onClick={() => useWorkspace.getState().retryItem(item.id)}
                  aria-label={`Retry ${item.name}`}
                >
                  Retry
                </Button>
              ) : null}
              {/* A toggle keeps its label; pressed means the image is left out of the ZIP. */}
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={excluded.includes(item.id)}
                aria-label={`Skip ZIP for ${item.name}`}
                onClick={() => useWorkspace.getState().toggleExcluded(item.id)}
              >
                Skip ZIP
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      `Remove “${item.name}” from this workspace? This also clears undo history and cannot be undone.`,
                    )
                  )
                    useWorkspace.getState().removeItem(item.id);
                }}
                aria-label={`Remove ${item.name}`}
              >
                Remove
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="editor-actions">
        <Button
          variant="secondary"
          disabled={!selected.some((id) => id !== activeId) || Boolean(progress)}
          onClick={() => {
            useWorkspace.getState().applySelected();
            setMessage(
              "Applied settings. Each image keeps its own brush strokes. Undo reverses this batch edit.",
            );
          }}
        >
          Apply settings to selected
        </Button>
        <Button
          variant="secondary"
          disabled={!selected.some((id) => id !== activeId) || Boolean(progress)}
          onClick={() => {
            useWorkspace.getState().matchFraming();
            setMessage("Matched framing on the selection. Undo reverses this batch edit.");
          }}
        >
          Match framing
        </Button>
      </div>
      <p className="text-xs text-muted">
        Copies background, edges, framing, shadow and export settings. Brush strokes and keep/remove
        marks stay with their image. Removing an image clears undo history.
      </p>
      <div className="editor-actions">
        <label className="edit-label" style={{ flex: "1 1 12rem", margin: 0 }}>
          Preset for selected
          <select
            aria-label="Batch preset"
            value={preset}
            onChange={(e) => setPreset(e.target.value as Preset)}
          >
            {PRESETS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="secondary"
          disabled={!selected.length || Boolean(progress)}
          onClick={() => {
            useWorkspace.getState().applyPresetSelected(preset);
            setMessage(
              `Applied the ${PRESETS.find((p) => p.value === preset)?.label ?? preset} preset to ${selected.length} image${selected.length === 1 ? "" : "s"}: same canvas, subject centred with padding. Undo reverses it.`,
            );
          }}
        >
          Apply preset
        </Button>
      </div>
      <label className="edit-check">
        <input
          type="checkbox"
          checked={skipWarned}
          onChange={(e) => setSkipWarned(e.target.checked)}
        />
        Skip images with quality warnings in ZIP
      </label>
      <div className="editor-actions">
        <Button
          variant="primary"
          disabled={!ready || Boolean(progress) || (skipWarned && qualityBusy)}
          onClick={() => void download(false)}
        >
          Download all ZIP
        </Button>
        <Button
          variant="secondary"
          disabled={!selectedReady || Boolean(progress) || (skipWarned && qualityBusy)}
          onClick={() => void download(true)}
        >
          Selected ZIP
        </Button>
      </div>
      <p className="text-xs text-muted">
        Ready images only · {formatLabel(format)} · 200 MB maximum archive. Change format in Adjust.
      </p>
      <div className="editor-actions">
        <Button
          variant="secondary"
          disabled={!ready || Boolean(progress)}
          onClick={() => void sheet("contact", false)}
        >
          Contact sheet
        </Button>
        <Button
          variant="secondary"
          disabled={!ready || Boolean(progress)}
          onClick={() => void sheet("sprite", false)}
        >
          Sprite sheet + JSON
        </Button>
        <Button
          variant="secondary"
          disabled={!selectedReady || Boolean(progress)}
          onClick={() => void sheet("sprite", true)}
        >
          Selected sprites
        </Button>
      </div>
      <p className="text-xs text-muted">
        A contact sheet is one PNG with every cutout labelled. A sprite sheet is a transparent PNG
        plus a JSON atlas of frame positions, for games and CSS sprites.
      </p>
      {progress ? (
        <div className="editor-actions">
          <span role="status">{progress}</span>
          <Button variant="secondary" onClick={() => abort.current?.abort()}>
            Cancel export
          </Button>
        </div>
      ) : null}
      <p role="status" className="mt-3 text-sm">
        {message}
      </p>
    </EditorDialog>
  );
}
