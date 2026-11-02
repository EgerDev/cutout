import { memo, useEffect, useMemo, useState } from "react";
import { Layers, Paintbrush, Redo2, Scan, Sparkles, Undo2 } from "lucide-react";
import { clipboardImagesSupported } from "@/lib/clipboard";
import { useExportCaps } from "./use-export-caps";
import { canShareFiles, resultFilename } from "@/lib/files";
import { Button } from "@/components/ui/button";
import { useWorkspace, type QueueItem } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { passthrough } from "@/lib/editor/export";
import { BatchManager } from "./batch-manager";
import { BatchStrip } from "./batch-strip";
import { BrushEditor } from "./brush-editor";
import { EnhanceEditor } from "./enhance-editor";
import { CheckAreasOverlay } from "./check-areas-overlay";
import { focusNextOnRemove } from "./focus-next";
import { Stage } from "./stage";
import { StatusCapsule } from "./status-capsule";
import { SubjectEditor } from "./subject-editor";
import { Toolbar } from "./toolbar";
import { WorkspacePanels } from "./workspace-panels";
const MemoStage = memo(Stage);
// One element so the memoised stage keeps its props referentially stable.
const checkOverlay = <CheckAreasOverlay />;
const selectItem = (id: string) => useWorkspace.getState().selectItem(id);

export function ActiveWorkspace({ mobile }: { mobile: boolean }) {
  return (
    <>
      <h1 id="workspace-heading" tabIndex={-1} className="sr-only">
        Cutout workspace
      </h1>
      <ImageSummary />
      <EditorActions mobile={mobile} />
      <div className="workspace-main">
        <WorkspaceBatch />
        <WorkspaceStage />
      </div>
      <WorkspaceToolbar mobile={mobile} />
      <WorkspacePanels mobile={mobile} />
    </>
  );
}

function WorkspaceBatch() {
  const items = useWorkspace((state) => state.items);
  const activeId = useWorkspace((state) => state.activeId);
  return <BatchStrip items={items} activeId={activeId} onSelect={selectItem} />;
}

const isPending = (item: QueueItem) => item.status === "queued" || item.status === "working";
const isStopped = (item: QueueItem) => item.status === "error" && item.cancelled === true;

function ImageSummary() {
  const active = useWorkspace((s) => s.items.find((item) => item.id === s.activeId));
  const total = useWorkspace((s) => s.items.length);
  const position = useWorkspace((s) => s.items.findIndex((item) => item.id === s.activeId) + 1);
  const ready = useWorkspace((s) => s.items.filter((item) => item.status === "done").length);
  const stopped = useWorkspace((s) => s.items.filter(isStopped).length);
  if (!active) return null;
  const batch = total > 1;
  return (
    <div className="image-summary" data-batch={batch || undefined}>
      <span className="min-w-0 truncate font-medium" title={active.name}>
        {active.name}
      </span>
      <span className="shrink-0 tabular-nums text-muted">
        {active.width > 0 ? `${active.width} × ${active.height}` : "Preparing image"}
      </span>
      <span className="shrink-0 tabular-nums text-muted" role="status">
        {batch
          ? `${position}/${total} · ${ready} ready${stopped ? ` · ${stopped} stopped` : ""}`
          : active.status === "done"
            ? active.removalNote === "choose"
              ? "Choose the subject"
              : "Ready"
            : active.status === "error"
              ? active.cancelled
                ? "Stopped"
                : "Failed"
              : active.status === "queued"
                ? "Queued"
                : "Processing"}
      </span>
      {batch ? <BatchRun stopped={stopped} /> : null}
    </div>
  );
}

/**
 * False for a moment after `mode` changes. Stop turns into Retry or Resume in place (the same
 * button, so focus stays on it), and the second click of a double-click must not undo the stop.
 */
function useArmed(mode: string) {
  const [armedFor, setArmedFor] = useState<string | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setArmedFor(mode), 500);
    return () => window.clearTimeout(timer);
  }, [mode]);
  return armedFor === mode;
}

/** A batch's Stop sits on its status line; once nothing is left running it offers Resume. */
function BatchRun({ stopped }: { stopped: number }) {
  const pending = useWorkspace((s) => s.items.some(isPending));
  const armed = useArmed(pending ? "stop" : "resume");
  if (!pending && !stopped) return null;
  return (
    <Button
      ref={focusNextOnRemove}
      variant="ghost"
      size="sm"
      className="summary-action"
      aria-label={
        pending
          ? "Stop removing backgrounds"
          : `Resume ${stopped} stopped image${stopped === 1 ? "" : "s"}`
      }
      title={pending ? "Finished cutouts stay. You can resume the rest." : undefined}
      aria-disabled={armed ? undefined : true}
      onClick={() => {
        if (!armed) return;
        const s = useWorkspace.getState();
        if (pending) s.cancelProcessing();
        else for (const item of s.items) if (isStopped(item)) s.retryItem(item.id);
      }}
    >
      {pending ? "Stop" : "Resume"}
    </Button>
  );
}

function WorkspaceStage() {
  const active = useWorkspace((s) => s.items.find((item) => item.id === s.activeId));
  const comparing = useWorkspace((s) => s.comparing);
  const peeking = useWorkspace((s) => s.peeking);
  const previewUrl = useWorkspace((s) => s.previewUrl);
  const previewBitmap = useWorkspace((s) => s.previewBitmap);
  const width = useWorkspace((s) => s.previewWidth),
    height = useWorkspace((s) => s.previewHeight),
    busy = useWorkspace((s) => s.previewBusy);
  const guides = useWorkspace((s) => s.showGuides);
  const masking = useWorkspace((s) => s.inspectMode === "mask");
  const plain = useWorkspace((s) => passthrough(activeSettings(s)));
  const processing = active ? isPending(active) || isStopped(active) : false;
  const exportFile = useMemo(() => {
    if (!plain || active?.status !== "done" || !active.resultBlob) return null;
    return new File([active.resultBlob], resultFilename(active.name, "png"), {
      type: active.resultBlob.type || "image/png",
    });
  }, [plain, active?.status, active?.resultBlob, active?.name]);
  return (
    <div className="workspace-stage">
      <MemoStage
        sourceUrl={active?.sourceUrl}
        preview={active?.preview ?? null}
        resultUrl={previewUrl ?? active?.resultUrl}
        resultBitmap={previewBitmap}
        width={previewUrl || previewBitmap ? width : (active?.width ?? 0)}
        height={previewUrl || previewBitmap ? height : (active?.height ?? 0)}
        comparing={comparing}
        peeking={peeking}
        masking={masking}
        exportFile={exportFile}
      >
        {checkOverlay}
      </MemoStage>
      {guides ? <div className="stage-guides" aria-hidden /> : null}
      {processing ? (
        <LiveStatus />
      ) : busy ? (
        <span className="preview-busy" role="status">
          Updating preview…
        </span>
      ) : null}
    </div>
  );
}

function LiveStatus() {
  const active = useWorkspace((s) => s.items.find((item) => item.id === s.activeId));
  const message = useWorkspace((s) => s.progress.message);
  const progress = useWorkspace((s) => s.progress.progress);
  const single = useWorkspace((s) => s.items.length === 1);
  const stopped = active ? isStopped(active) : false;
  const armed = useArmed(stopped ? "retry" : "stop");
  if (!active) return null;
  const queued = active.status === "queued";
  // One image carries its own Stop; a batch keeps Stop and Resume on its status line.
  const action = stopped ? (
    <CapsuleAction
      label="Retry"
      name={single ? undefined : `Retry ${active.name}`}
      armed={armed}
      onClick={() => useWorkspace.getState().retryItem(active.id)}
    />
  ) : single ? (
    <CapsuleAction
      label="Stop"
      name="Stop removing the background"
      armed={armed}
      onClick={() => useWorkspace.getState().cancelProcessing()}
    />
  ) : undefined;
  return (
    <StatusCapsule
      label={stopped ? "Stopped" : queued ? "Queued" : undefined}
      message={message}
      progress={stopped || queued ? undefined : progress}
      action={action}
    />
  );
}

function CapsuleAction({
  label,
  name,
  armed,
  onClick,
}: {
  label: string;
  name?: string;
  armed: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      ref={focusNextOnRemove}
      variant="ghost"
      size="sm"
      className="status-capsule-action"
      aria-label={name}
      aria-disabled={armed ? undefined : true}
      onClick={() => {
        if (armed) onClick();
      }}
    >
      {label}
    </Button>
  );
}

function WorkspaceToolbar({ mobile }: { mobile: boolean }) {
  const caps = useExportCaps();
  const done = useWorkspace(
    (s) => s.items.find((item) => item.id === s.activeId)?.status === "done",
  );
  const comparing = useWorkspace((s) => s.comparing);
  const copied = useWorkspace((s) => s.copied);
  const saved = useWorkspace((s) => s.saved);
  const phase = useWorkspace((s) => s.phase);
  const inspecting = useWorkspace((s) => s.inspecting);
  const format = useWorkspace((s) => activeSettings(s).exportFormat);
  const exporting = useWorkspace((s) => s.exporting),
    copying = useWorkspace((s) => s.copying);
  const clipboard = clipboardImagesSupported();
  const sharing = canShareFiles();
  if (!done) return null;
  return (
    <div className="workspace-dock">
      <span role="status" className="sr-only">
        {copied ? (!clipboard && sharing ? "Shared" : "Copied to the clipboard") : ""}
      </span>
      <Toolbar
        exporting={exporting}
        copying={copying}
        comparing={comparing}
        copied={copied}
        saved={saved}
        mobile={mobile}
        canCopy={clipboard || sharing}
        share={!clipboard && sharing}
        adjusting={phase === "adjusting"}
        inspecting={inspecting}
        format={format}
        caps={caps}
        onCompare={() => {
          const s = useWorkspace.getState();
          s.setComparing(!s.comparing);
        }}
        onCopy={() => {
          void useWorkspace.getState().copyActive();
        }}
        onDownload={(format) => {
          const s = useWorkspace.getState();
          s.setExportFormat(format);
          void s.downloadActive(format);
        }}
        onVector={() => void useWorkspace.getState().downloadVector()}
        onAdjust={() => {
          const s = useWorkspace.getState();
          if (s.phase === "adjusting") s.closeAdjust();
          else s.openAdjust();
        }}
        onInfo={() => {
          const s = useWorkspace.getState();
          if (s.inspecting) s.closeInfo();
          else s.openInfo();
        }}
      />
    </div>
  );
}

function EditorActions({ mobile }: { mobile: boolean }) {
  const [editor, setEditor] = useState<"brush" | "subject" | "enhance" | "batch" | null>(null);
  // One editor at a time; a dialog closing clears only itself.
  const toggle = (name: NonNullable<typeof editor>) => (open: boolean) =>
    setEditor((current) => (open ? name : current === name ? null : current));
  const done = useWorkspace((s) => s.items.find((i) => i.id === s.activeId)?.status === "done");
  const past = useWorkspace((s) => s.past.length),
    future = useWorkspace((s) => s.future.length),
    count = useWorkspace((s) => s.items.length);
  return (
    <>
      <div
        className="editor-actionbar"
        role="toolbar"
        aria-label="Editing tools"
        data-compact={mobile || undefined}
      >
        <EditTool
          icon={Undo2}
          label="Undo"
          disabled={!past}
          onClick={() => useWorkspace.getState().undo()}
          shortcut="Meta+Z Control+Z"
          hint="Undo (⌘/Ctrl Z)"
        />
        <EditTool
          icon={Redo2}
          label="Redo"
          disabled={!future}
          onClick={() => useWorkspace.getState().redo()}
          shortcut="Meta+Shift+Z Control+Shift+Z"
          hint="Redo (⌘/Ctrl Shift Z)"
        />
        <span className="editor-actionbar-rule" aria-hidden />
        <EditTool
          icon={Paintbrush}
          label="Brush"
          disabled={!done}
          active={editor === "brush"}
          onClick={() => setEditor(editor === "brush" ? null : "brush")}
          hint="Erase or restore by hand"
        />
        <EditTool
          icon={Scan}
          label="Subject"
          disabled={!done}
          active={editor === "subject"}
          onClick={() => setEditor(editor === "subject" ? null : "subject")}
          hint="Keep or remove pieces, re-cut an area"
        />
        <EditTool
          icon={Sparkles}
          label="Enhance"
          disabled={!done}
          active={editor === "enhance"}
          onClick={() => setEditor(editor === "enhance" ? null : "enhance")}
          hint="Make a small image bigger and sharper"
        />
        <EditTool
          icon={Layers}
          label="Batch"
          name={`Batch (${count})`}
          count={count > 1 ? count : undefined}
          active={editor === "batch"}
          onClick={() => setEditor(editor === "batch" ? null : "batch")}
          hint="Apply settings to several images, download a ZIP"
        />
      </div>
      <BrushEditor open={editor === "brush"} onOpenChange={toggle("brush")} />
      <EnhanceEditor open={editor === "enhance"} onOpenChange={toggle("enhance")} />
      <SubjectEditor open={editor === "subject"} onOpenChange={toggle("subject")} />
      <BatchManager open={editor === "batch"} onOpenChange={toggle("batch")} />
    </>
  );
}

function EditTool({
  icon: Icon,
  label,
  name,
  count,
  onClick,
  disabled,
  active,
  shortcut,
  hint,
}: {
  icon: typeof Paintbrush;
  label: string;
  /** Accessible name when it says more than the visible label (it starts with it). */
  name?: string;
  count?: number;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  shortcut?: string;
  hint?: string;
}) {
  return (
    <Button
      variant={active ? "primary" : "ghost"}
      size="sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={name}
      title={hint}
      aria-pressed={active}
      aria-keyshortcuts={shortcut}
    >
      <Icon aria-hidden="true" strokeWidth={2} />
      <span>{label}</span>
      {count ? (
        <span className="tool-count" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </Button>
  );
}
