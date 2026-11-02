import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The real shortcuts, grouped by task; keep in step with use-workspace-shortcuts.ts. */
const GROUPS = [
  {
    title: "Files",
    rows: [
      ["Choose images", "⌘/Ctrl O"],
      ["Paste an image", "⌘/Ctrl V"],
      ["Copy the cutout", "⌘/Ctrl C"],
      ["Download in the current format", "⌘/Ctrl S"],
    ],
  },
  {
    title: "Editing",
    rows: [
      ["Undo", "⌘/Ctrl Z"],
      ["Redo", "⌘/Ctrl Shift Z"],
    ],
  },
  {
    title: "Viewing",
    rows: [
      ["See the original while held", "Space"],
      ["Next view (white, black, mask…)", "M"],
      ["Centre and thirds guides", "G"],
      ["Image information", "I"],
    ],
  },
  {
    title: "Moving around",
    rows: [
      ["Previous or next image", "← → ↑ ↓"],
      ["Close the open panel", "Esc"],
      ["Show these shortcuts", "?"],
    ],
  },
] as const;

const keysId = (title: string) => `keys-${title.toLowerCase().replace(/\W+/g, "-")}`;

export function ShortcutHelp({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcut-backdrop" />
        <Dialog.Content
          className="shortcut-dialog"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            document.getElementById("shortcut-help-trigger")?.focus();
          }}
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <Dialog.Title className="dialog-title">Keyboard shortcuts</Dialog.Title>
              <Dialog.Description className="dialog-description">
                They pause while you type in a field. Brush and Subject list their own under Guide.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button size="icon" aria-label="Close shortcuts">
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          <div className="shortcut-groups">
            {GROUPS.map((group) => (
              <section key={group.title} aria-labelledby={keysId(group.title)}>
                <h3 id={keysId(group.title)} className="sheet-section-title">
                  {group.title}
                </h3>
                <dl className="divide-y divide-line">
                  {group.rows.map(([label, key]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between gap-4 py-2 text-[13px]"
                    >
                      <dt>{label}</dt>
                      <dd className="shrink-0">
                        <kbd className="keycap">{key}</kbd>
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
