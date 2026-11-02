import type { ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** A "Guide" popover for an editor dialog; open it with `<Button popoverTarget={id}>`. */
export function EditorGuide({
  id,
  title,
  items,
}: {
  readonly id: string;
  readonly title: string;
  readonly items: readonly (readonly [string, ReactNode])[];
}) {
  return (
    <div id={id} popover="auto" className="editor-guide" aria-label={title}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold">{title}</h3>
        <Button size="icon" popoverTarget={id} popoverTargetAction="hide" aria-label="Close guide">
          <X className="size-4" />
        </Button>
      </div>
      <dl>
        {items.map(([term, text]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd>{text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
