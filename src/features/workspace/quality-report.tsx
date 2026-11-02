import { useEffect, useState } from "react";
import { classifyError } from "@/lib/errors";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import type { QualityIssue } from "@/lib/editor/quality";
import { Button } from "@/components/ui/button";

const AFTER_SHEET_MS = 280;

export function QualityReport({ open }: { readonly open: boolean }) {
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const settings = useWorkspace(activeSettings);
  const [issues, setIssues] = useState<QualityIssue[]>([]);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open || !item?.resultBlob) return;
    const result = item.resultBlob;
    let live = true;
    let idle = 0;
    const run = () => {
      if (!live) return;
      setError("");
      setIssues([]);
      void import("@/lib/editor/quality-live")
        .then(({ inspectEditedQuality }) =>
          inspectEditedQuality(result, item.source, settings, item.width, item.height).then(
            (next) => {
              if (live) setIssues(next);
            },
          ),
        )
        .catch((error: unknown) => {
          if (live) {
            const failure = classifyError(error);
            setError(
              failure.code === "cancelled"
                ? failure.message
                : `Could not check export quality. ${failure.message}`,
            );
          }
        });
    };
    const start = window.setTimeout(() => {
      if (retry > 0) run();
      else if (typeof requestIdleCallback === "function") idle = requestIdleCallback(run);
      else run();
    }, AFTER_SHEET_MS);
    return () => {
      live = false;
      clearTimeout(start);
      if (idle && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    };
  }, [open, item?.resultBlob, item?.source, item?.width, item?.height, settings, retry]);
  if (!issues.length && !error) return null;
  return (
    <section className="quality-report sheet-section" aria-label="Export quality">
      <h3>Before you export</h3>
      {error ? (
        <div className="editor-actions">
          <p role="alert" className="text-xs text-muted">
            {error}
          </p>
          <Button size="sm" onClick={() => setRetry((value) => value + 1)}>
            Retry quality check
          </Button>
        </div>
      ) : null}
      <ul>
        {issues.map((issue) => (
          <li key={issue.id} data-severity={issue.severity}>
            {issue.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
