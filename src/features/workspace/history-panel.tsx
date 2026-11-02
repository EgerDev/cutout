import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { historyLabel } from "@/lib/editor/model";

function ago(time: number, now: number) {
  const s = Math.max(0, Math.round((now - time) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

/** Named undo steps, newest first; "Back" undoes everything after that step. */
export function HistoryPanel() {
  const past = useWorkspace((s) => s.past);
  const future = useWorkspace((s) => s.future.length);
  const now = Date.now();
  const steps = past
    .map((entry, index) => ({ entry, undoCount: past.length - index }))
    .reverse()
    .slice(0, 20);
  return (
    <details className="edit-section">
      <summary>History</summary>
      {steps.length ? (
        <ol className="history-list" aria-label="Edit history">
          {steps.map(({ entry, undoCount }) => (
            <li key={`${entry.time}-${entry.key}`}>
              <span className="history-label">{historyLabel(entry.key)}</span>
              <span className="history-time">{ago(entry.time, now)}</span>
              <Button
                variant="secondary"
                size="sm"
                aria-label={`Undo ${undoCount} step${undoCount === 1 ? "" : "s"}: back to before ${historyLabel(entry.key)}`}
                onClick={() => useWorkspace.getState().jumpBack(undoCount)}
              >
                {undoCount === 1 ? "Undo" : `Back ${undoCount}`}
              </Button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="edit-note">No edits yet.</p>
      )}
      <div className="editor-actions">
        <Button
          variant="secondary"
          size="sm"
          disabled={!past.length}
          onClick={() => useWorkspace.getState().undo()}
        >
          Undo
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!future}
          onClick={() => useWorkspace.getState().redo()}
        >
          Redo{future ? ` (${future})` : ""}
        </Button>
      </div>
      <p className="edit-note">
        Each step names what changed. “Back” returns to the state before that step; Redo brings the
        steps back one at a time.
      </p>
    </details>
  );
}
