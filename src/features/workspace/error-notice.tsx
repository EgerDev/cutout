import { X } from "lucide-react";
import { useWorkspace } from "@/lib/workspace-store";
import { focusNextOnRemove } from "./focus-next";

export function ErrorNotice({ message }: { message: string }) {
  const active = useWorkspace((state) => state.items.find((item) => item.id === state.activeId));
  const retryItem = useWorkspace((state) => state.retryItem);
  return (
    <div
      role="alert"
      className="absolute top-[max(4.75rem,calc(env(safe-area-inset-top)+3.25rem))] left-1/2 z-50 flex w-[min(92vw,24rem)] -translate-x-1/2 items-center gap-2 rounded-[18px] bg-float px-4 py-2 text-sm shadow-[var(--shadow-float)]"
    >
      <p className="min-w-0 flex-1 text-center">{message}</p>
      {active?.status === "error" && active.retryable !== false && active.error === message ? (
        <button
          ref={focusNextOnRemove}
          type="button"
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-full px-3 font-medium hover:bg-fg/8"
          onClick={() => retryItem(active.id)}
        >
          Retry
        </button>
      ) : null}
      <button
        ref={focusNextOnRemove}
        type="button"
        className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-fg/8 hover:text-fg"
        aria-label="Dismiss"
        onClick={() => useWorkspace.setState({ errorMessage: null })}
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
