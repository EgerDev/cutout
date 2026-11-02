import { memo } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { PRESETS, type RemovalMode, type ShadowKind } from "@/lib/editor/model";
import { ExportEstimate } from "./export-estimate";
import { EditSlider } from "./edit-slider";
import { ColorControls } from "./color-controls";
import { HistoryPanel } from "./history-panel";

const modes: readonly { value: RemovalMode; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "quick", label: "Quick" },
  { value: "maximum", label: "Maximum detail" },
];

/** The rarer tools, one disclosure each, most used first. */
export const AdvancedAdjust = memo(function AdvancedAdjust() {
  const settings = useWorkspace(activeSettings);
  const change = useWorkspace((s) => s.changeEdit);
  const removalMode = useWorkspace((s) => s.removalMode);
  const showGuides = useWorkspace((s) => s.showGuides);
  const showCheckAreas = useWorkspace((s) => s.showCheckAreas);
  return (
    <div className="edit-sections">
      <details className="edit-section">
        <summary>Framing & presets</summary>
        <label className="edit-label">
          Preset
          <select
            aria-label="Export preset"
            value={settings.preset}
            onChange={(e) => {
              const preset = PRESETS.find((p) => p.value === e.target.value);
              if (preset) useWorkspace.getState().setPreset(preset.value);
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        {settings.preset === "trim" ? (
          <>
            <EditSlider
              label="Padding"
              unit="px"
              value={settings.trimPadding}
              max={400}
              onChange={(trimPadding) => change({ trimPadding }, "trimPadding")}
            />
            <p className="edit-note">
              Crops to the subject at its original scale and keeps this much room around it.
            </p>
          </>
        ) : settings.preset !== "original" ? (
          <>
            <EditSlider
              label="Padding"
              unit="%"
              value={settings.padding}
              max={40}
              onChange={(padding) => change({ padding }, "padding")}
            />
            <EditSlider
              label="Horizontal position"
              unit="%"
              value={settings.positionX}
              onChange={(positionX) => change({ positionX }, "positionX")}
            />
            <EditSlider
              label="Vertical position"
              unit="%"
              value={settings.positionY}
              onChange={(positionY) => change({ positionY }, "positionY")}
            />
          </>
        ) : (
          <p className="edit-note">Choose a preset to fit the subject with adjustable padding.</p>
        )}
        <EditSlider
          label="Scale"
          unit="%"
          value={settings.scale}
          min={50}
          max={200}
          onChange={(scale) => change({ scale }, "scale")}
        />
        <EditSlider
          label="Rotate"
          unit="°"
          value={settings.rotate}
          min={-180}
          max={180}
          onChange={(rotate) => change({ rotate }, "rotate")}
        />
        <div className="editor-actions">
          <Button
            size="sm"
            variant="secondary"
            aria-pressed={settings.flipX}
            onClick={() => change({ flipX: !settings.flipX })}
          >
            Flip horizontal
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => change({ scale: 100, rotate: 0, flipX: false })}
          >
            Reset transform
          </Button>
        </div>
        <label className="edit-check">
          <input
            type="checkbox"
            checked={showGuides}
            onChange={(e) => useWorkspace.getState().setShowGuides(e.target.checked)}
          />
          Show centre and thirds guides
        </label>
      </details>
      <details className="edit-section">
        <summary>Shadow</summary>
        <label className="edit-check">
          <input
            type="checkbox"
            checked={settings.shadow}
            onChange={(e) => change({ shadow: e.target.checked })}
          />
          Add a shadow
        </label>
        {settings.shadow ? (
          <>
            <label className="edit-label">
              Kind
              <select
                aria-label="Shadow kind"
                value={settings.shadowKind}
                onChange={(e) => change({ shadowKind: e.target.value as ShadowKind })}
              >
                <option value="contact">Contact</option>
                <option value="cast">Cast</option>
              </select>
            </label>
            <EditSlider
              label="Shadow opacity"
              unit="%"
              value={settings.shadowOpacity}
              max={80}
              onChange={(shadowOpacity) => change({ shadowOpacity }, "shadowOpacity")}
            />
            <EditSlider
              label="Shadow softness"
              value={settings.shadowSoftness}
              min={1}
              max={30}
              onChange={(shadowSoftness) => change({ shadowSoftness }, "shadowSoftness")}
            />
            <EditSlider
              label="Shadow distance"
              value={settings.shadowDistance}
              min={-5}
              max={10}
              onChange={(shadowDistance) => change({ shadowDistance }, "shadowDistance")}
            />
            {settings.shadowKind === "cast" ? (
              <>
                <EditSlider
                  label="Direction"
                  unit="°"
                  value={settings.shadowAngle}
                  max={360}
                  onChange={(shadowAngle) => change({ shadowAngle }, "shadowAngle")}
                />
                <EditSlider
                  label="Spread"
                  value={settings.shadowSpread}
                  max={40}
                  onChange={(shadowSpread) => change({ shadowSpread }, "shadowSpread")}
                />
                <EditSlider
                  label="Perspective"
                  value={settings.shadowPerspective}
                  max={80}
                  onChange={(shadowPerspective) =>
                    change({ shadowPerspective }, "shadowPerspective")
                  }
                />
                <label className="edit-check">
                  <input
                    type="checkbox"
                    checked={settings.shadowSilhouette}
                    onChange={(e) => change({ shadowSilhouette: e.target.checked })}
                  />
                  Use subject silhouette
                </label>
              </>
            ) : null}
          </>
        ) : null}
      </details>
      <ColorControls />
      <details className="edit-section">
        <summary>Edge colour</summary>
        <p className="edit-note">
          Removes the old background’s colour from the rim of the subject, for example a green
          fringe after a green wall.
        </p>
        <label className="edit-label">
          Decontaminate
          <select
            aria-label="Decontaminate edge colour"
            value={settings.decontaminate}
            onChange={(e) =>
              change({ decontaminate: e.target.value as typeof settings.decontaminate })
            }
          >
            <option value="off">Off</option>
            <option value="auto">Auto</option>
            <option value="manual">Manual</option>
          </select>
        </label>
        {settings.decontaminate !== "off" ? (
          <>
            <EditSlider
              label="Amount"
              unit="%"
              value={settings.decontaminateAmount}
              onChange={(decontaminateAmount) =>
                change({ decontaminateAmount }, "decontaminateAmount")
              }
            />
            <EditSlider
              label="Edge width"
              unit="px"
              value={settings.decontaminateWidth}
              min={1}
              max={24}
              onChange={(decontaminateWidth) =>
                change({ decontaminateWidth }, "decontaminateWidth")
              }
            />
            {settings.decontaminate === "manual" ? (
              <label className="edit-label">
                Sampled background
                <input
                  aria-label="Decontaminate colour"
                  type="color"
                  value={settings.decontaminateColor ?? "#ffffff"}
                  onChange={(e) =>
                    change({ decontaminateColor: e.target.value }, "decontaminateColor")
                  }
                />
              </label>
            ) : null}
          </>
        ) : null}
      </details>
      <details className="edit-section">
        <summary>Match background</summary>
        <label className="edit-check">
          <input
            type="checkbox"
            checked={settings.matchBackground}
            onChange={(e) => change({ matchBackground: e.target.checked })}
          />
          Match subject colour to the background
        </label>
        {settings.matchBackground ? (
          <EditSlider
            label="Strength"
            unit="%"
            value={settings.matchStrength}
            onChange={(matchStrength) => change({ matchStrength }, "matchStrength")}
          />
        ) : null}
      </details>
      <ExportEstimate />
      <details className="edit-section">
        <summary>Removal</summary>
        <label className="edit-label">
          Detail
          <select
            aria-label="Removal detail"
            value={removalMode}
            onChange={(e) => useWorkspace.getState().setRemovalMode(e.target.value as RemovalMode)}
          >
            {modes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <p className="edit-note">
          Quick is one pass. Auto refines small subjects. Maximum uses extra crops. Reprocess to
          apply a new detail level to this image.
        </p>
        <div className="editor-actions">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => useWorkspace.getState().reprocessActive()}
          >
            Reprocess this image
          </Button>
        </div>
        <label className="edit-check">
          <input
            type="checkbox"
            checked={showCheckAreas}
            onChange={(e) => useWorkspace.getState().setShowCheckAreas(e.target.checked)}
          />
          Show areas to check (specks, holes, soft edges)
        </label>
      </details>
      <HistoryPanel />
    </div>
  );
});
