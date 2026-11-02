import { useEffect, useState } from "react";
import { classifyError } from "@/lib/errors";
import { Pipette } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import type { PaletteEntry } from "@/lib/editor/palette";
import type { Recolor } from "@/lib/editor/model";
import { EditSlider } from "./edit-slider";

type EyeDropperApi = { open: (options?: { signal?: AbortSignal }) => Promise<{ sRGBHex: string }> };

function eyeDropper(): EyeDropperApi | null {
  const ctor = (globalThis as { EyeDropper?: new () => EyeDropperApi }).EyeDropper;
  return ctor ? new ctor() : null;
}

/**
 * Colours of the cutout as swatches: recolour one, knock it out (a leftover
 * backdrop, a second colour in a logo), or pick any colour on screen to key.
 */
export function ColorControls() {
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const recolors = useWorkspace((s) => activeSettings(s).recolors);
  const tolerance = useWorkspace((s) => activeSettings(s).recolorTolerance);
  // Mounted with the closed Adjust sheet too; only quantize while it is open.
  const adjusting = useWorkspace((s) => s.phase === "adjusting" && !s.inspecting);
  const [palette, setPalette] = useState<{ of: Blob; entries: PaletteEntry[] } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const result = item?.resultBlob;
  const computed = palette?.of === result;
  const entries = computed ? (palette?.entries ?? []) : [];
  useEffect(() => {
    if (!result || !adjusting || computed) return;
    let live = true;
    setError("");
    void import("@/lib/editor/palette")
      .then(({ paletteOf }) =>
        paletteOf(result, 12).then((entries) => {
          if (live) setPalette({ of: result, entries });
        }),
      )
      .catch((error: unknown) => {
        if (live) setError(classifyError(error).message);
      });
    return () => {
      live = false;
    };
  }, [result, adjusting, computed, retry]);
  const change = (next: readonly Recolor[]) =>
    useWorkspace.getState().changeEdit({ recolors: next });
  const ruleFor = (hex: string) => recolors.find((rule) => rule.from.toLowerCase() === hex);
  const setRule = (from: string, to: string | null | undefined) => {
    const rest = recolors.filter((rule) => rule.from.toLowerCase() !== from);
    if (to !== undefined && rest.length >= 24) {
      setError(
        "Up to 24 colour changes can be saved. Remove a colour change before adding another.",
      );
      return;
    }
    setError("");
    change(to === undefined ? rest : [...rest, { from, to }]);
  };
  const pick = async () => {
    const dropper = eyeDropper();
    if (!dropper) return;
    try {
      const { sRGBHex } = await dropper.open();
      setPicked(sRGBHex.toLowerCase());
    } catch {
      /* cancelled */
    }
  };
  const swatches = [
    ...entries.map((p) => p.hex),
    ...(picked && !entries.some((p) => p.hex === picked) ? [picked] : []),
  ];
  const reading = Boolean(result && adjusting && !computed && !error);
  return (
    <details className="edit-section">
      <summary>Colours</summary>
      {error ? (
        <div className="editor-actions">
          <p role="alert" className="edit-note m-0">
            {error}
          </p>
          <Button size="sm" variant="secondary" onClick={() => setRetry((value) => value + 1)}>
            Retry colours
          </Button>
        </div>
      ) : null}
      {swatches.length ? (
        <ul className="color-swatches" aria-label="Cutout colours">
          {swatches.map((hex) => {
            const rule = ruleFor(hex);
            return (
              <li key={hex}>
                <span
                  className="color-swatch"
                  style={{
                    background: rule?.to ?? hex,
                    opacity: rule && rule.to === null ? 0.25 : 1,
                  }}
                  title={hex}
                />
                <input
                  type="color"
                  aria-label={`Replace ${hex}`}
                  value={rule?.to ?? hex}
                  onChange={(e) => setRule(hex, e.target.value.toLowerCase())}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  aria-pressed={rule?.to === null}
                  aria-label={`${rule?.to === null ? "Restore" : "Remove"} ${hex}`}
                  onClick={() => setRule(hex, rule?.to === null ? undefined : null)}
                >
                  {rule?.to === null ? "Restore" : "Remove"}
                </Button>
                {rule && rule.to !== null ? (
                  <Button
                    size="sm"
                    aria-label={`Reset ${hex}`}
                    onClick={() => setRule(hex, undefined)}
                  >
                    Reset
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : reading ? (
        <p className="edit-note" role="status">
          Finding the cutout’s main colours…
        </p>
      ) : !error ? (
        <p className="edit-note">No distinct colours found in this cutout.</p>
      ) : null}
      <div className="editor-actions">
        {eyeDropper() ? (
          <Button size="sm" variant="secondary" onClick={() => void pick()}>
            <Pipette className="size-4" aria-hidden="true" /> Pick a colour to key
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="secondary"
          disabled={!recolors.length}
          onClick={() => change([])}
        >
          Clear colour edits
        </Button>
      </div>
      <EditSlider
        label="Colour tolerance"
        value={tolerance}
        min={4}
        max={96}
        onChange={(recolorTolerance) =>
          useWorkspace.getState().changeEdit({ recolorTolerance }, "recolorTolerance")
        }
      />
      <p className="edit-note">
        Recolour a swatch with its colour well, or remove it to key that colour out. Edges that mix
        two colours follow the change. Flat art exports as SVG from the Download menu.
      </p>
    </details>
  );
}
