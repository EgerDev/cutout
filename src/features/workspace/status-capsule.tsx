import type { ReactNode } from "react";

function statusLabel(message: string) {
  const clean = message.trim().toLowerCase();
  if (!clean) return "Preparing";
  if (clean.includes("download") || clean.includes("preparing") || clean.includes("loading"))
    return "Preparing";
  if (clean.includes("compatibility")) return "Compatibility mode";
  if (clean.includes("subject") || clean.includes("finding") || clean.includes("cutting"))
    return "Finding subject";
  if (clean.includes("edge") || clean.includes("clean") || clean.includes("finishing"))
    return "Cleaning edges";
  if (clean.includes("done") || clean.includes("almost")) return "Almost done";
  return "Removing";
}

/**
 * The removal status over the stage: the stage named by the engine's `message`, or a fixed
 * `label` ("Queued", "Stopped"). `progress` (0–1) draws the bar. `action` is its one control,
 * an end cap kept outside the live region so an update announces the status, not the button.
 */
export function StatusCapsule({
  label: fixed,
  message = "",
  progress,
  action,
}: {
  label?: string;
  message?: string;
  progress?: number;
  action?: ReactNode;
}) {
  const label = fixed ?? statusLabel(message);
  const percent =
    progress === undefined ? null : Math.max(0, Math.min(100, Math.round(progress * 100)));
  return (
    <div className="status-capsule">
      <div className="status-capsule-card" data-action={action ? "" : undefined}>
        <div role="status" aria-live="polite" aria-label={label} className="status-capsule-status">
          <p key={label} className="status-copy">
            {label}
          </p>
          {percent === null ? null : (
            <>
              <div
                className="status-track"
                role="progressbar"
                aria-label={label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
              >
                <div className="status-fill" style={{ transform: `scaleX(${percent / 100})` }} />
              </div>
              <span className="text-xs tabular-nums text-muted" aria-hidden="true">
                {percent}%
              </span>
            </>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}
