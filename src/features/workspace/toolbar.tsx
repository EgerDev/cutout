import { Check, Columns2, Copy, Info, Share, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { type ExportCaps, type ExportFormat } from "@/lib/formats";
import { cn } from "@/lib/utils";
import { DownloadMenu } from "./download-menu";

export function Toolbar({
  exporting = false,
  copying = false,
  comparing,
  copied,
  saved,
  canCopy,
  share,
  adjusting,
  inspecting,
  onCompare,
  onCopy,
  onDownload,
  onVector,
  onAdjust,
  onInfo,
  mobile,
  caps,
  format,
}: {
  exporting?: boolean;
  copying?: boolean;
  comparing: boolean;
  copied: boolean;
  saved: boolean;
  canCopy: boolean;
  share?: boolean;
  adjusting?: boolean;
  inspecting?: boolean;
  onCompare: () => void;
  onCopy: () => void;
  onDownload: (format: ExportFormat) => void;
  onVector?: () => void;
  onAdjust: () => void;
  onInfo: () => void;
  mobile: boolean;
  caps: ExportCaps;
  format: ExportFormat;
}) {
  const items = [
    { key: "compare", label: "Compare", icon: Columns2, onClick: onCompare, active: comparing },
    share
      ? {
          key: "share",
          label: copied ? "Shared" : "Share",
          icon: copied ? Check : Share,
          onClick: onCopy,
          flash: copied,
          disabled: copying,
        }
      : {
          key: "copy",
          label: copied ? "Copied" : "Copy",
          icon: copied ? Check : Copy,
          onClick: onCopy,
          disabled: !canCopy || copying,
          flash: copied,
        },
    {
      key: "adjust",
      label: "Adjust",
      icon: SlidersHorizontal,
      onClick: onAdjust,
      active: Boolean(adjusting),
    },
    {
      key: "info",
      label: "Info",
      icon: Info,
      onClick: onInfo,
      active: Boolean(inspecting),
    },
  ];

  return (
    <div
      role="toolbar"
      aria-label="Image actions"
      data-compact={mobile || undefined}
      className="toolbar-dock float-widget z-30 bg-float shadow-[var(--shadow-float)]"
    >
      {items.slice(0, 2).map((item) => (
        <ToolButton key={item.key} item={item} mobile={mobile} />
      ))}
      <DownloadMenu
        busy={exporting}
        format={format}
        saved={saved}
        mobile={mobile}
        caps={caps}
        onPick={onDownload}
        onVector={onVector}
      />
      {items.slice(2).map((item) => (
        <ToolButton key={item.key} item={item} mobile={mobile} />
      ))}
    </div>
  );
}

function ToolButton({
  item,
  mobile,
}: {
  item: {
    key: string;
    label: string;
    icon: typeof Columns2;
    onClick: () => void;
    active?: boolean;
    flash?: boolean;
    disabled?: boolean;
  };
  mobile: boolean;
}) {
  return (
    <Button
      variant={item.active ? "primary" : "ghost"}
      size="sm"
      className={cn("dock-tool", item.flash && "is-flash")}
      onClick={item.onClick}
      disabled={Boolean(item.disabled)}
      aria-pressed={item.active}
      data-compact={mobile || undefined}
    >
      <item.icon aria-hidden="true" />
      <span>{item.label}</span>
    </Button>
  );
}
