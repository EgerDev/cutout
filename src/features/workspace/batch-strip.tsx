import { memo, useRef } from "react";
import { Check, CircleAlert, LoaderCircle, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QueueItem } from "@/lib/workspace-store";

const labels = { queued: "Queued", working: "Processing", done: "Ready", error: "Failed" } as const;

export function BatchStrip({
  items,
  activeId,
  onSelect,
}: {
  readonly items: QueueItem[];
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  const root = useRef<HTMLElement>(null);
  if (items.length < 2) return null;
  return (
    <aside
      ref={root}
      className="workspace-batch pointer-events-auto z-20 float-widget"
      aria-label="Batch"
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        const buttons = Array.from(root.current?.querySelectorAll("button") ?? []);
        const current = buttons.findIndex((button) => button === document.activeElement);
        if (current < 0) return;
        let next: number;
        switch (event.key) {
          case "ArrowRight":
          case "ArrowDown":
            next = Math.min(current + 1, buttons.length - 1);
            break;
          case "ArrowLeft":
          case "ArrowUp":
            next = Math.max(current - 1, 0);
            break;
          case "Home":
            next = 0;
            break;
          case "End":
            next = buttons.length - 1;
            break;
          default:
            return;
        }
        event.preventDefault();
        buttons[next]?.focus();
        const item = items[next];
        if (item) onSelect(item.id);
      }}
    >
      {items.map((item) => (
        <Thumb key={item.id} item={item} active={item.id === activeId} onSelect={onSelect} />
      ))}
    </aside>
  );
}

const Thumb = memo(function Thumb({
  item,
  active,
  onSelect,
}: {
  readonly item: QueueItem;
  readonly active: boolean;
  readonly onSelect: (id: string) => void;
}) {
  // Stopping is the user's choice, not a failure: it reads "Stopped" with a stop mark.
  const stopped = item.status === "error" && item.cancelled === true;
  const status = stopped ? "Stopped" : labels[item.status];
  return (
    <button
      type="button"
      onClick={() => onSelect(item.id)}
      aria-label={`${item.name} · ${status}`}
      aria-pressed={active}
      title={`${item.name} — ${stopped ? status : item.error || status}`}
      data-status={stopped ? "stopped" : item.status}
      className={cn(
        "batch-thumb relative min-h-11 min-w-11 shrink-0 overflow-hidden",
        active && "is-active",
      )}
    >
      <img
        src={item.resultUrl ?? item.sourceUrl}
        alt=""
        draggable={false}
        decoding="async"
        className={cn("size-full object-cover", item.resultUrl && "checker")}
      />
      <span
        className={cn(
          "batch-status",
          item.status === "done" && "text-ok",
          item.status === "error" && !stopped && "is-error",
        )}
        aria-hidden="true"
      >
        {item.status === "done" ? (
          <Check />
        ) : stopped ? (
          <Square className="batch-stop" />
        ) : item.status === "error" ? (
          <CircleAlert />
        ) : item.status === "working" ? (
          <LoaderCircle className="motion-safe:animate-spin" />
        ) : (
          <span className="size-1.5 rounded-full bg-muted" />
        )}
      </span>
    </button>
  );
});
