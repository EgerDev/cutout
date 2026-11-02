import * as Menu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  exportFormats,
  formatLabel,
  formatTrait,
  type ExportCaps,
  type ExportFormat,
} from "@/lib/formats";
import { cn } from "@/lib/utils";

export function DownloadMenu({
  saved,
  mobile,
  caps,
  format,
  onPick,
  onVector,
  busy = false,
}: {
  readonly saved: boolean;
  readonly busy?: boolean;
  readonly mobile: boolean;
  readonly caps: ExportCaps;
  readonly format: ExportFormat;
  readonly onPick: (format: ExportFormat) => void;
  readonly onVector?: () => void;
}) {
  const label = busy ? "Exporting…" : saved ? "Saved" : "Download";
  return (
    <div className="download-split" data-compact={mobile || undefined}>
      <Button
        variant="primary"
        size="sm"
        className="download-main"
        aria-label={`${saved ? "Saved — download" : "Download"} ${formatLabel(format)}`}
        title={`Download ${formatLabel(format)} (⌘/Ctrl S)`}
        aria-keyshortcuts="Meta+S Control+S"
        disabled={busy}
        aria-busy={busy}
        onClick={() => onPick(format)}
      >
        {saved && !busy ? <Check aria-hidden="true" /> : <Download aria-hidden="true" />}
        <span>{label}</span>
        <span className="download-format">{formatLabel(format)}</span>
      </Button>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button
            variant="primary"
            size="sm"
            className="download-more"
            disabled={busy}
            aria-label="Download format"
            title="Choose download format"
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="download-options"
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            aria-label="Download format"
            onEscapeKeyDown={(event) => event.stopPropagation()}
          >
            <Menu.Label className="download-options-label">Download as</Menu.Label>
            {exportFormats(caps).map((value) => (
              <Menu.Item
                key={value}
                className="download-option"
                aria-label={formatLabel(value)}
                onSelect={() => onPick(value)}
              >
                <span className="font-medium">{formatLabel(value)}</span>
                <span className="ms-auto text-xs text-muted">{formatTrait(value)}</span>
                <Check
                  aria-hidden="true"
                  className={cn("size-4", value !== format && "invisible")}
                />
              </Menu.Item>
            ))}
            {onVector ? (
              <Menu.Item className="download-option" aria-label="SVG" onSelect={onVector}>
                <span className="font-medium">SVG</span>
                <span className="ms-auto text-xs text-muted">Vector · flat art</span>
                <Check aria-hidden="true" className="invisible size-4" />
              </Menu.Item>
            ) : null}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
