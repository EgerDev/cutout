import * as Dialog from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import type { LaunchPlan } from "@/lib/url-api";

/**
 * Asks before a link loads an image from another site or saves a file on its own:
 * nothing is fetched, and no model download starts, until "Load image" is clicked.
 */
export function LaunchConfirm({
  plan,
  onConfirm,
  onCancel,
}: {
  readonly plan: LaunchPlan;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const host = plan.src ? new URL(plan.src).host : null;
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="shortcut-backdrop" />
        <Dialog.Content
          className="shortcut-dialog editor-dialog"
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <Dialog.Title className="dialog-title">
            {host ? (
              <>
                Load an image from <strong className="break-all">{host}</strong>?
              </>
            ) : (
              "Download the result when it’s ready?"
            )}
          </Dialog.Title>
          <Dialog.Description className="editor-description dialog-description">
            {host
              ? "A link asked Cutout to open this image. Nothing is fetched until you choose Load, and the image is then processed on your device."
              : "A link asked Cutout to save the next result automatically."}
            {host && plan.download ? " The result is then saved to your downloads." : ""}
          </Dialog.Description>
          <div className="editor-actions justify-end">
            <Button variant="secondary" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onConfirm}>
              {host ? (plan.download ? "Load and download" : "Load image") : "Download when ready"}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
