import { forwardRef } from "react";
import { cn } from "@/lib/utils";

export const DropLayer = forwardRef<
  HTMLDivElement,
  { open: boolean; replacing: boolean }
>(function DropLayer({ open, replacing }, ref) {
  return (
    <div ref={ref} className={cn("drop-veil", open && "is-open")} aria-hidden={!open}>
      <div className="drop-card">
        <span className="drop-card-title">{replacing ? "Drop to replace" : "Release to remove"}</span>
        <span className="drop-card-copy">Up to 15 · stays on this device</span>
      </div>
    </div>
  );
});
