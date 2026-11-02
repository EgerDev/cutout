import { useEffect, useState } from "react";
import { useWorkspace } from "@/lib/workspace-store";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { exportFormats, formatLabel } from "@/lib/formats";
import { activeSettings } from "@/lib/editor/state";
import { useExportCaps } from "./use-export-caps";
import { onRadioKeyDown } from "./radio-keys";
import { cn } from "@/lib/utils";

const STRIP_NOTE =
  "Removes EXIF, location and similar data from downloads, and offers the original without it.";

export function ExportFields({ className }: { className?: string }) {
  const exporting = useWorkspace((s) => s.exporting);
  const saved = useWorkspace((s) => s.saved);
  const background = useWorkspace((s) => activeSettings(s).background);
  const exportFormat = useWorkspace((s) => activeSettings(s).exportFormat);
  const stripMetadata = useWorkspace((s) => activeSettings(s).stripMetadata);
  const width = useWorkspace(
    (s) => activeSettings(s).exportWidth ?? s.items.find((i) => i.id === s.activeId)?.width ?? 0,
  );
  const height = useWorkspace(
    (s) => activeSettings(s).exportHeight ?? s.items.find((i) => i.id === s.activeId)?.height ?? 0,
  );
  const hasExtras = useWorkspace((s) => Boolean(s.metadata?.extras));
  const caps = useExportCaps();
  const formats = exportFormats(caps);
  // A restored or linked format this browser can't encode (HEIC, AVIF) stays the setting until
  // the user picks another; meanwhile the first offered format keeps the group's one Tab stop.
  const tabStop = formats.includes(exportFormat) ? exportFormat : formats[0];
  return (
    <div className={cn("export-fields", className)}>
      <div
        role="radiogroup"
        aria-label="Export format"
        className="format-picker"
        onKeyDown={onRadioKeyDown}
      >
        {formats.map((format) => (
          <button
            key={format}
            type="button"
            role="radio"
            aria-checked={exportFormat === format}
            tabIndex={format === tabStop ? 0 : -1}
            onClick={() => useWorkspace.getState().setExportFormat(format)}
            className="format-option"
          >
            {formatLabel(format)}
          </button>
        ))}
      </div>
      {exportFormat === "jpeg" && background.type === "transparent" ? (
        <p className="edit-note">JPG has no transparency, so the background becomes white.</p>
      ) : null}
      <SizeInputs
        width={width}
        height={height}
        onSize={(w, h) => useWorkspace.getState().setExportSize(w, h)}
      />
      <Button
        disabled={exporting}
        aria-busy={exporting}
        variant="primary"
        className="mt-2 w-full"
        onClick={() => void useWorkspace.getState().downloadActive(exportFormat)}
      >
        {exporting ? "Exporting…" : saved ? "Saved" : `Download ${formatLabel(exportFormat)}`}
      </Button>
      <label className="edit-check export-strip" title={STRIP_NOTE}>
        <input
          type="checkbox"
          checked={stripMetadata}
          aria-describedby="strip-metadata-note"
          onChange={(event) => useWorkspace.getState().setStripMetadata(event.target.checked)}
        />
        Strip metadata
      </label>
      <span id="strip-metadata-note" className="sr-only">
        {STRIP_NOTE}
      </span>
      {stripMetadata && hasExtras ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-1 w-full"
          onClick={() => void useWorkspace.getState().downloadOriginal()}
        >
          <ShieldCheck className="size-4" aria-hidden="true" />
          Download original, cleaned
        </Button>
      ) : null}
    </div>
  );
}

/**
 * The number inputs must not commit on every keystroke: each intermediate
 * value ("1", "16", "160") used to overwrite both dimensions and collapse the
 * aspect ratio. Drafts commit on blur or Enter instead.
 */
function SizeInputs({
  width,
  height,
  onSize,
}: {
  width: number;
  height: number;
  onSize: (width: number | null, height: number | null) => void;
}) {
  const [widthDraft, setWidthDraft] = useState(() => (width ? String(width) : ""));
  const [heightDraft, setHeightDraft] = useState(() => (height ? String(height) : ""));
  useEffect(() => setWidthDraft(width ? String(width) : ""), [width]);
  useEffect(() => setHeightDraft(height ? String(height) : ""), [height]);

  const commit = (draft: string, reset: string, axis: "width" | "height") => {
    const text = draft.trim();
    const value = Number(text);
    if (text !== "" && Number.isFinite(value) && value >= 1) {
      const size = Math.round(value);
      if (axis === "width") onSize(size, null);
      else onSize(null, size);
      return;
    }
    if (axis === "width") setWidthDraft(reset);
    else setHeightDraft(reset);
  };

  return (
    <div className="export-size">
      <label className="size-field">
        Width
        <input
          type="number"
          min={1}
          max={4096}
          inputMode="numeric"
          value={widthDraft}
          onChange={(event) => setWidthDraft(event.target.value)}
          onBlur={() => commit(widthDraft, width ? String(width) : "", "width")}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
      <label className="size-field">
        Height
        <input
          type="number"
          min={1}
          max={4096}
          inputMode="numeric"
          value={heightDraft}
          onChange={(event) => setHeightDraft(event.target.value)}
          onBlur={() => commit(heightDraft, height ? String(height) : "", "height")}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      </label>
    </div>
  );
}
