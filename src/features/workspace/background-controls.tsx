import { ImagePlus, Pipette } from "lucide-react";
import { cn } from "@/lib/utils";
import { gradientCss, type BackgroundMode } from "@/lib/formats";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import { EditSlider } from "./edit-slider";

const DEFAULT_CUSTOM_COLOR = "#f4f3ef";
const STUDIO_GREY = "#cfcac0";

export function BackgroundControls() {
  const background = useWorkspace((s) => activeSettings(s).background);
  const customColor = useWorkspace((s) => activeSettings(s).customColor);
  const backgroundImageUrl = useWorkspace((s) => activeSettings(s).backgroundImageUrl);
  const onBackground = (value: BackgroundMode) => useWorkspace.getState().setBackground(value);
  const colorActive =
    background.type === "color" && background.color !== "#ffffff" && background.color !== "#111111";
  const blurAmount = useWorkspace((s) => activeSettings(s).blurAmount);
  const blurDepth = useWorkspace((s) => activeSettings(s).blurDepth);
  // The default custom colour is nearly white, which would make a first gradient invisible:
  // start from a studio grey instead until the user has picked a colour of their own.
  const gradient =
    background.type === "gradient"
      ? background
      : {
          from: customColor.toLowerCase() === DEFAULT_CUSTOM_COLOR ? STUDIO_GREY : customColor,
          to: "#ffffff",
          angle: 160,
        };
  const whiteActive = background.type === "color" && background.color === "#ffffff";
  const blackActive = background.type === "color" && background.color === "#111111";

  return (
    <section className="sheet-section" aria-labelledby="adjust-background">
      <h3 id="adjust-background" className="sheet-section-title">
        Background
      </h3>
      <div className="swatch-grid">
        <Chip
          label="None"
          active={background.type === "transparent"}
          className="checker"
          onClick={() => onBackground({ type: "transparent" })}
        />
        <Chip
          label="White"
          active={whiteActive}
          className="bg-white"
          onClick={() => onBackground({ type: "color", color: "#ffffff" })}
        />
        <Chip
          label="Black"
          active={blackActive}
          className="bg-[#111111]"
          onClick={() => onBackground({ type: "color", color: "#111111" })}
        />
        <label className="swatch" data-active={colorActive || undefined}>
          <span className="swatch-face" style={{ background: customColor }}>
            <Pipette className="swatch-icon" aria-hidden="true" />
            <input
              type="color"
              value={customColor}
              aria-label="Custom background colour"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={(event) => useWorkspace.getState().setCustomColor(event.target.value)}
              onClick={() => onBackground({ type: "color", color: customColor })}
            />
          </span>
          <span className="swatch-label">Colour</span>
        </label>
        <Chip
          label="Blur"
          active={background.type === "blur"}
          className="swatch-blur"
          onClick={() => onBackground({ type: "blur" })}
        />
        <Chip
          label="Gradient"
          active={background.type === "gradient"}
          style={{ background: gradientCss(gradient) }}
          onClick={() => onBackground({ type: "gradient", ...gradient })}
        />
        <label
          className="swatch"
          data-active={background.type === "image" || undefined}
          onClick={(event) => {
            if (backgroundImageUrl && background.type !== "image") {
              event.preventDefault();
              onBackground({ type: "image", url: backgroundImageUrl });
            }
          }}
        >
          <span className="swatch-face bg-bg">
            {backgroundImageUrl ? (
              <img
                src={backgroundImageUrl}
                alt=""
                className="absolute inset-0 size-full object-cover"
              />
            ) : (
              <ImagePlus className="swatch-icon text-muted" aria-hidden="true" />
            )}
            <input
              type="file"
              accept="image/*"
              aria-label="Choose background image"
              className="absolute inset-0 cursor-pointer opacity-0"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) useWorkspace.getState().setBackgroundImage(file);
                event.currentTarget.value = "";
              }}
            />
          </span>
          <span className="swatch-label">Image</span>
        </label>
      </div>
      {background.type === "blur" ? (
        <>
          <EditSlider
            label="Blur amount"
            unit="px"
            value={blurAmount}
            min={2}
            max={80}
            onChange={(blurAmount) =>
              useWorkspace.getState().changeEdit({ blurAmount }, "blurAmount")
            }
          />
          <label className="edit-check">
            <input
              type="checkbox"
              checked={blurDepth}
              aria-describedby="depth-blur-note"
              onChange={(e) => useWorkspace.getState().changeEdit({ blurDepth: e.target.checked })}
            />
            Depth-aware: nearby surfaces stay sharper
          </label>
          <p id="depth-blur-note" className="edit-note -mt-1 ps-7">
            Downloads a depth model once: 27–99 MB, depending on the device.
          </p>
        </>
      ) : null}
      {background.type === "gradient" ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <label className="edit-label">
              From
              <input
                type="color"
                aria-label="Gradient start colour"
                value={background.from}
                onChange={(e) => onBackground({ ...background, from: e.target.value })}
              />
            </label>
            <label className="edit-label">
              To
              <input
                type="color"
                aria-label="Gradient end colour"
                value={background.to}
                onChange={(e) => onBackground({ ...background, to: e.target.value })}
              />
            </label>
          </div>
          <EditSlider
            label="Gradient angle"
            unit="°"
            value={background.angle}
            max={360}
            onChange={(angle) => onBackground({ ...background, angle })}
          />
        </>
      ) : null}
    </section>
  );
}

function Chip({
  label,
  active,
  className,
  style,
  onClick,
}: {
  label: string;
  active: boolean;
  className?: string;
  style?: React.CSSProperties;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="swatch"
      data-active={active || undefined}
    >
      <span className={cn("swatch-face", className)} style={style} />
      <span className="swatch-label">{label}</span>
    </button>
  );
}
