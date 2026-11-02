import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { formatHasQuality } from "@/lib/formats";
import { encodeExport, type Encoded } from "@/lib/editor/export";
import { EditSlider } from "./edit-slider";
import { downloadBlob, resultFilename } from "@/lib/files";
import { formatExtension } from "@/lib/formats";
import { stripExportMetadata } from "@/lib/metadata-client";
import { markSaved } from "./use-unsaved-guard";
export function ExportEstimate() {
  const settings = useWorkspace(activeSettings),
    item = useWorkspace((s) => s.items.find((i) => i.id === s.activeId));
  const [result, setResult] = useState<Encoded | null>(null),
    [url, setUrl] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [targetDraft, setTargetDraft] = useState(String(settings.targetKB ?? 500));
  useEffect(() => setTargetDraft(String(settings.targetKB ?? 500)), [settings.targetKB]);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => {
    abort.current?.abort();
    setResult(null);
    setUrl(null);
    setBusy(false);
    setError("");
    return () => abort.current?.abort();
  }, [settings, item?.resultBlob]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  const change = useWorkspace((s) => s.changeEdit);
  const estimate = async () => {
    if (!item?.resultBlob || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setError("");
    try {
      const encoded = await encodeExport(
        { result: item.resultBlob, source: item.source, settings },
        controller.signal,
      );
      const blob = settings.stripMetadata ? await stripExportMetadata(encoded.blob) : encoded.blob;
      if (controller.signal.aborted) return;
      setResult({
        ...encoded,
        blob,
        metTarget: settings.targetKB === null || blob.size <= settings.targetKB * 1000,
      });
      setUrl(URL.createObjectURL(blob));
    } catch (e) {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not encode preview.");
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const savePreview = () => {
    if (!result || !item?.resultBlob || !result.metTarget) return;
    const filename = resultFilename(item.name, formatExtension(settings.exportFormat));
    if (downloadBlob(result.blob, filename)) markSaved(item.resultBlob, settings);
    else setError("Could not download the preview. Try again.");
  };
  return (
    <details className="edit-section">
      <summary>Quality & file size</summary>
      {formatHasQuality(settings.exportFormat) ? (
        <EditSlider
          label="Maximum quality (%)"
          value={settings.quality}
          min={15}
          max={100}
          onChange={(quality) => change({ quality }, "quality")}
        />
      ) : (
        <p className="edit-note">PNG is lossless. A size target may reduce its dimensions.</p>
      )}
      <label className="edit-check">
        <input
          type="checkbox"
          checked={settings.targetKB !== null}
          onChange={(e) => change({ targetKB: e.target.checked ? 500 : null })}
        />
        Target file size
      </label>
      {settings.targetKB !== null ? (
        <>
          <label className="edit-label">
            Maximum size (KB)
            <input
              aria-label="Maximum size (KB)"
              type="number"
              min={10}
              max={20000}
              value={targetDraft}
              onBlur={(e) => {
                const n = e.currentTarget.valueAsNumber;
                if (Number.isFinite(n) && n >= 10 && n <= 20000) {
                  const targetKB = Math.round(n);
                  change({ targetKB }, "target-size-input");
                  setTargetDraft(String(targetKB));
                } else setTargetDraft(String(settings.targetKB ?? 500));
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
              }}
              onChange={(e) => setTargetDraft(e.target.value)}
            />
          </label>
          <p className="edit-note">
            1 KB = 1,000 bytes. Quality is lowered first, then dimensions. Preview checks the exact
            encoded file.
          </p>
        </>
      ) : null}
      <Button
        className="mt-1"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => void estimate()}
      >
        {busy ? "Encoding…" : "Preview export"}
      </Button>
      {result ? (
        <p role="status" className="mt-2 text-[13px] tabular-nums">
          {(result.blob.size / 1000).toFixed(1)} KB · {result.width} × {result.height}
          {result.quality !== null ? ` · ${Math.round(result.quality * 100)}% quality` : ""}
          {settings.targetKB !== null
            ? result.metTarget
              ? " · Target met"
              : " · Target not met; increase the limit"
            : ""}
        </p>
      ) : null}
      {url ? (
        <img src={url} alt="Encoded export preview" className="export-estimate-image" />
      ) : null}
      {result ? (
        <Button
          className="mt-2"
          variant="secondary"
          size="sm"
          disabled={!result.metTarget}
          onClick={savePreview}
        >
          Download preview
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[13px]">
          {error}
        </p>
      ) : null}
    </details>
  );
}
