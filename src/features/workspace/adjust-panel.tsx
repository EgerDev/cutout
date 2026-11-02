import { BackgroundControls } from "./background-controls";
import { ExportFields } from "./export-fields";
import { AdvancedAdjust } from "./advanced-adjust";
import { QualityReport } from "./quality-report";
import { EditSlider } from "./edit-slider";
import { useSheetInert } from "./use-sheet-inert";
import { INSPECT_LABELS, INSPECT_MODES, type InspectMode } from "@/lib/editor/model";
import { useWorkspace } from "@/lib/workspace-store";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activeSettings } from "@/lib/editor/state";
import { cn } from "@/lib/utils";

/**
 * The most used adjustments come first (background, then edges); rarer tools wait in
 * disclosures below; export settings stay pinned to the foot on wider screens.
 */
export function AdjustPanel({ open, mobile }: { open: boolean; mobile: boolean }) {
  const feather = useWorkspace((s) => activeSettings(s).feather);
  const choke = useWorkspace((s) => activeSettings(s).choke);
  const inert = useSheetInert(open);

  return (
    <aside
      id="cutout-adjust"
      aria-hidden={!open}
      aria-labelledby="cutout-adjust-title"
      inert={inert}
      data-side={mobile ? "south" : "east"}
      className={cn(
        "sheet z-30 flex flex-col overflow-hidden border border-line/30 bg-float shadow-[var(--shadow-float)]",
        mobile
          ? "fixed start-0 end-0 bottom-0 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]"
          : "absolute end-4 bottom-[var(--dock-space)] w-[20rem]",
      )}
    >
      <div className="sheet-head">
        <h2 id="cutout-adjust-title" className="sheet-title">
          Adjust
        </h2>
        <Button
          variant="ghost"
          size="sm"
          title="Reset every adjustment on this image (undo brings them back)"
          onClick={() => useWorkspace.getState().resetAdjust()}
        >
          Reset
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => useWorkspace.getState().closeAdjust()}
          aria-label="Close adjust"
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className={mobile ? "sheet-body" : "sheet-body sheet-scroll"}>
        <BackgroundControls />
        <section className="sheet-section" aria-labelledby="adjust-edges">
          <h3 id="adjust-edges" className="sheet-section-title">
            Edges
          </h3>
          <EditSlider
            label="Feather"
            unit="px"
            value={feather}
            min={0}
            max={16}
            onChange={(value) => useWorkspace.getState().setFeather(value)}
          />
          <EditSlider
            label="Expand / contract"
            unit="px"
            value={choke}
            min={-10}
            max={10}
            onChange={(value) => useWorkspace.getState().setChoke(value)}
          />
          <InspectControls />
        </section>
        <AdvancedAdjust />
        <QualityReport open={open} />
        {mobile ? <ExportFields className="sheet-section" /> : null}
      </div>
      {mobile ? null : <ExportFields className="sheet-foot" />}
    </aside>
  );
}

function InspectControls() {
  const mode = useWorkspace((s) => s.inspectMode);
  return (
    <label className="edit-label">
      <span>
        View <kbd className="keycap">M</kbd>
      </span>
      <select
        aria-label="Inspection view"
        value={mode}
        onChange={(e) => useWorkspace.getState().setInspectMode(e.target.value as InspectMode)}
      >
        {INSPECT_MODES.map((value) => (
          <option key={value} value={value}>
            {INSPECT_LABELS[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
