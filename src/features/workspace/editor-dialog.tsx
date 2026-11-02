import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
export function EditorDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: string;
  readonly children: ReactNode;
  readonly wide?: boolean;
}) {
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcut-backdrop" />
        <Dialog.Content
          className={`shortcut-dialog editor-dialog${wide ? " brush-dialog" : ""}`}
          onEscapeKeyDown={(e) => {
            e.stopPropagation();
            // Escape closes an open guide popover first, not the dialog (and its draft).
            const popover = document.querySelector<HTMLElement>(".editor-dialog :popover-open");
            if (!popover) return;
            e.preventDefault();
            popover.hidePopover();
          }}
          onOpenAutoFocus={() => {
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={(event) => {
            if (opener.current?.isConnected) {
              event.preventDefault();
              opener.current.focus();
            }
          }}
        >
          <div className="editor-head flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Dialog.Title className="dialog-title">{title}</Dialog.Title>
              <Dialog.Description className="editor-description dialog-description">
                {description}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <Button
                size="icon"
                className="-me-2 -mt-1.5"
                aria-label={`Close ${title.toLowerCase()}`}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
