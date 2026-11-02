import { EditorDialog } from "./editor-dialog";
import { ModelsPanel } from "./models-panel";

export function ModelsDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <EditorDialog
      open={open}
      onOpenChange={onOpenChange}
      title="On-device models"
      description="Everything runs in your browser. Download models ahead of time, for example on Wi-Fi, so features start without waiting, or clear them to free space."
    >
      <ModelsPanel />
    </EditorDialog>
  );
}
