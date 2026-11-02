import { useEffect, useState } from "react";
import { classifyError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { CHECK_LABELS, type CheckArea } from "@/lib/editor/check-areas";
import { Button } from "@/components/ui/button";

/**
 * Boxes over the stage marking specks, holes and soft edges of the current
 * cutout (see findCheckAreas). Sized in percentages so they follow the frame.
 */
export function CheckAreasOverlay() {
  const show = useWorkspace((s) => s.showCheckAreas);
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const settings = useWorkspace(activeSettings);
  const [areas, setAreas] = useState<CheckArea[]>([]);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const result = item?.resultBlob;
  const source = item?.source;
  useEffect(() => {
    if (!show || !result || !source) {
      setAreas([]);
      setError("");
      setChecking(false);
      return;
    }
    let live = true;
    setError("");
    setAreas([]);
    setChecking(true);
    const timer = window.setTimeout(() => {
      void import("@/lib/editor/quality-live")
        .then(({ inspectCheckAreas }) =>
          inspectCheckAreas(result, source, settings).then((next) => {
            if (live) setAreas(next);
          }),
        )
        .catch((error: unknown) => {
          if (live) {
            const failure = classifyError(error);
            setError(
              failure.code === "cancelled"
                ? failure.message
                : `Could not check areas. ${failure.message}`,
            );
          }
        })
        .finally(() => {
          if (live) setChecking(false);
        });
    }, 200);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [show, result, source, settings, retry]);
  if (!show) return null;
  return (
    <div
      className="stage-check pointer-events-none absolute inset-0"
      style={{ zIndex: 25 }}
      aria-label="Areas to check"
    >
      {areas.map((area, index) => (
        <div
          key={`${area.kind}-${index}`}
          className="stage-check-box"
          data-kind={area.kind}
          data-label={area.y < 0.08 ? "below" : "above"}
          style={{
            left: `${area.x * 100}%`,
            top: `${area.y * 100}%`,
            width: `${area.width * 100}%`,
            height: `${area.height * 100}%`,
          }}
        >
          <span>{CHECK_LABELS[area.kind]}</span>
        </div>
      ))}
      {error ? (
        <div className="absolute top-3 left-1/2 flex w-[min(92%,24rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-[12px] border border-line bg-float px-3 py-2 text-xs text-fg shadow-[var(--shadow-float)]">
          <span role="alert">{error}</span>
          <Button
            className="pointer-events-auto"
            variant="primary"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry area check
          </Button>
        </div>
      ) : checking ? (
        <span className="stage-check-empty">Checking…</span>
      ) : areas.length === 0 ? (
        <span className="stage-check-empty">Nothing to check</span>
      ) : null}
    </div>
  );
}
