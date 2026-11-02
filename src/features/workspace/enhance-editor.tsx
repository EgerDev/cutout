import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { ENHANCE_VARIANTS, countActiveTiles, planEnhance, type EnhanceScale } from "@/lib/enhance";
import { processingLimits } from "@/lib/files";
import { EditorDialog } from "./editor-dialog";
import { onRadioKeyDown } from "./radio-keys";

/** Pixels a side of `cm` needs at 300 dpi, the usual bar for a sharp print. */
const printPx = (cm: number) => Math.round((cm / 2.54) * 300);

/** Print sizes as short × long sides in cm; `px`/`shortPx` are those sides at 300 dpi. */
const PRINT_TARGETS = (
  [
    { value: "", label: "No, just for screens", as: "", cm: [0, 0] },
    {
      value: "10x15",
      label: "4 × 6 in photo (10 × 15 cm)",
      as: "as a 4 × 6 in photo",
      cm: [10, 15],
    },
    {
      value: "13x18",
      label: "5 × 7 in photo (13 × 18 cm)",
      as: "as a 5 × 7 in photo",
      cm: [13, 18],
    },
    { value: "20x25", label: "8 × 10 in print (20 × 25 cm)", as: "at 8 × 10 in", cm: [20, 25] },
    { value: "a4", label: "A4 page", as: "on an A4 page", cm: [21, 29.7] },
    { value: "a3", label: "A3 poster", as: "as an A3 poster", cm: [29.7, 42] },
    {
      value: "30x40",
      label: "12 × 16 in poster (30 × 40 cm)",
      as: "as a 12 × 16 in poster",
      cm: [30, 40],
    },
  ] as const
).map((entry) => ({ ...entry, px: printPx(entry.cm[1]), shortPx: printPx(entry.cm[0]) }));

const SCALE_HINT: Record<EnhanceScale, string> = {
  2: "Sharpens edges and fine detail. Best for images that are already clean.",
  4: "Also cleans up the blocky, smudgy look of low-quality photos. Best for small or compressed images.",
};

function duration(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `About ${Math.max(5, Math.round(s / 5) * 5)} seconds`;
  const m = Math.round(s / 30) / 2;
  return `About ${m % 1 ? `${Math.floor(m)}½` : m} minute${m > 1 ? "s" : ""}`;
}

/** How a print of `longest` px will look at a size that wants `targetPx` for 300 dpi. */
function printQuality(longest: number, targetPx: number) {
  const dpi = (longest / targetPx) * 300;
  if (dpi >= 240) return "sharp";
  if (dpi >= 150) return "fine from arm’s length but a little soft up close";
  return "blurry";
}

export function EnhanceEditor({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const enhancing = useWorkspace((s) => s.enhancing);
  // Primitives, and only while enhancing: removal progress must not re-render this dialog.
  const progressValue = useWorkspace((s) =>
    s.enhancing === null ? 0 : Math.round((s.progress?.progress ?? 0) * 100),
  );
  const progressMessage = useWorkspace((s) =>
    s.enhancing === null ? undefined : s.progress?.message,
  );
  const [picked, setPicked] = useState<EnhanceScale | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [target, setTarget] = useState("");
  const [keepCutout, setKeepCutout] = useState(true);
  const [alpha, setAlpha] = useState<{ data: Uint8Array; width: number; height: number } | null>(
    null,
  );
  const result = item?.resultBlob;
  const itemId = item?.id;
  const itemWidth = item?.width ?? 0;
  const itemHeight = item?.height ?? 0;
  // A new image (or reopening) goes back to the recommended size.
  useEffect(() => {
    setPicked(null);
  }, [open, itemId]);
  useEffect(() => {
    if (!open || !result || !itemWidth || !itemHeight) {
      setAlpha(null);
      return;
    }
    let live = true;
    // A 512 px copy is enough to tell which tiles are empty and costs ~1 ms, not 100.
    const shrink = Math.min(1, 512 / Math.max(itemWidth, itemHeight));
    const aw = Math.max(1, Math.round(itemWidth * shrink)),
      ah = Math.max(1, Math.round(itemHeight * shrink));
    void import("@/lib/editor/alpha").then(({ readAlpha }) =>
      readAlpha(result, aw, ah).then((data) => {
        if (live) setAlpha({ data, width: aw, height: ah });
      }),
    );
    return () => {
      live = false;
    };
  }, [open, result, itemWidth, itemHeight]);
  const printTarget = PRINT_TARGETS.find((entry) => entry.value === target) ?? PRINT_TARGETS[0]!;
  useEffect(() => {
    if (enhancing === null) setCancelling(false);
  }, [enhancing]);
  const [limits, setLimits] = useState(() => ({ side: Infinity, pixels: Infinity }));
  useEffect(() => {
    if (open) setLimits(processingLimits());
  }, [open]);
  const width = item?.width ?? 0;
  const height = item?.height ?? 0;
  const settled = Boolean(item && (item.status === "done" || item.status === "error"));
  const busy = enhancing !== null;
  const targetPx = printTarget.px;
  // Never upscale past the print target: the output is brought down to it.
  const printLimits = targetPx ? { ...limits, side: Math.min(limits.side, targetPx) } : limits;
  const rawPlans = {
    2: planEnhance(width, height, 2, limits),
    4: planEnhance(width, height, 4, limits),
  };
  const plans = {
    2: planEnhance(width, height, 2, printLimits),
    4: planEnhance(width, height, 4, printLimits),
  };
  const sourceLongest = Math.max(width, height);
  // 4× earns its bigger download on small images and on JPEGs, whose blockiness it removes.
  const jpeg = /jpe?g/i.test(item?.source.type ?? "");
  const recommended: EnhanceScale = rawPlans[4].allowed && (sourceLongest <= 600 || jpeg) ? 4 : 2;
  const scale: EnhanceScale = picked ?? recommended;
  const plan = plans[scale];
  const variant = ENHANCE_VARIANTS[scale];
  const neitherFits = !rawPlans[2].allowed && !rawPlans[4].allowed;
  const active = useMemo(
    () =>
      keepCutout && alpha && plan.allowed
        ? countActiveTiles(alpha.data, alpha.width, alpha.height, scale, { width, height })
        : null,
    [keepCutout, alpha, plan.allowed, scale, width, height],
  );
  const estimatedMs = active
    ? (plan.estimatedMs * active.active) / Math.max(1, plan.tiles)
    : plan.estimatedMs;
  const longest = Math.max(rawPlans[scale].finalWidth, rawPlans[scale].finalHeight);
  const targetSide = targetPx && longest > targetPx ? targetPx : undefined;
  const printAs = printTarget.as;
  const fourLongest = Math.max(rawPlans[4].finalWidth, rawPlans[4].finalHeight);
  const quality = printQuality(longest, targetPx);
  const fourQuality = printQuality(fourLongest, targetPx);
  const printNote = !targetPx
    ? null
    : sourceLongest >= targetPx
      ? `Good news: it’s already big enough to print sharp ${printAs}.`
      : longest >= targetPx
        ? `It will print sharp ${printAs}.`
        : scale === 2 && rawPlans[4].allowed && fourQuality !== quality
          ? `Printed ${printAs}, 2× will look ${quality}. Pick 4× and it will look ${fourQuality}.`
          : `Printed ${printAs}, it will look ${quality}. A smaller print will look sharper.`;
  const bothFit = rawPlans[2].allowed && rawPlans[4].allowed;
  // One Tab stop, on the chosen scale unless that one can't run here.
  const offered = ([2, 4] as const).filter((option) => !busy && rawPlans[option].allowed);
  const scaleStop = offered.includes(scale) ? scale : offered[0];
  const hint = `${SCALE_HINT[scale]}${bothFit && scale === recommended ? " Recommended for this image." : ""}`;
  // Every way out (Close, ✕, Escape, a click outside) stops a run: one left going out of
  // sight reads as "Ready" and its unenhanced image could be downloaded as the result.
  const close = (next: boolean) => {
    if (!next) useWorkspace.getState().cancelEnhance();
    onOpenChange(next);
  };
  return (
    <EditorDialog
      open={open}
      onOpenChange={close}
      title="Enhance"
      description="Make a small or blurry image bigger and sharper. It all happens on your device, so nothing is uploaded."
    >
      <div
        className="format-picker enhance-scale"
        role="radiogroup"
        aria-label="How much bigger"
        onKeyDown={onRadioKeyDown}
      >
        {([2, 4] as const).map((option) => (
          <button
            key={option}
            type="button"
            role="radio"
            className="format-option"
            aria-checked={scale === option}
            tabIndex={option === scaleStop ? 0 : -1}
            disabled={busy || !rawPlans[option].allowed}
            onClick={() => setPicked(option)}
          >
            {option}× bigger
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">
        {neitherFits
          ? `This image is already large. Enhance works on images up to ${ENHANCE_VARIANTS[2].maxSide} px on the longest side.`
          : !rawPlans[4].allowed
            ? `${hint} (4× works on images up to ${ENHANCE_VARIANTS[4].maxSide} px.)`
            : scale === 4
              ? `${hint} Needs a one-time download of up to ${variant.downloadMB} MB.`
              : hint}
      </p>
      <label className="edit-label mt-3">
        Printing it?
        <select
          aria-label="Printing it?"
          value={target}
          disabled={busy || neitherFits}
          onChange={(e) => setTarget(e.target.value)}
        >
          {PRINT_TARGETS.map((entry) => (
            <option key={entry.value} value={entry.value}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
      {printNote ? <p className="mt-1 text-xs text-muted">{printNote}</p> : null}
      <label className="edit-check mt-2">
        <input
          type="checkbox"
          checked={keepCutout}
          disabled={busy || !result}
          onChange={(e) => setKeepCutout(e.target.checked)}
        />
        Keep my current cutout
      </label>
      <p className="text-xs text-muted">
        {keepCutout
          ? "Faster. Untick to redo the background on the sharper image. Edges can come out crisper, but it takes longer."
          : "The background will be removed again on the sharper image. Edges can come out crisper, but it takes longer."}
      </p>
      {item && !neitherFits ? (
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Now</dt>
          <dd>
            {width} × {height} px
          </dd>
          <dt className="text-muted">After</dt>
          <dd>
            {plan.finalWidth} × {plan.finalHeight} px
            {plan.capped
              ? targetSide
                ? " (just right for your print)"
                : " (the most this device can handle)"
              : ""}
          </dd>
          <dt className="text-muted">Takes</dt>
          <dd>{duration(estimatedMs)}</dd>
          {targetPx ? (
            <>
              <dt className="text-muted">Print</dt>
              <dd>
                needs{" "}
                {width > height
                  ? `${targetPx} × ${printTarget.shortPx}`
                  : `${printTarget.shortPx} × ${targetPx}`}{" "}
                px to look sharp
              </dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {item?.enhanced && !busy ? (
        <p className="mt-2 text-xs text-muted">
          Already enhanced once. Enhancing again makes it bigger but rarely sharper.
        </p>
      ) : null}
      {busy ? (
        <div className="mt-4">
          <div
            className="status-track"
            role="progressbar"
            aria-label="Enhancing"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progressValue}
          >
            <div className="status-fill" style={{ transform: `scaleX(${progressValue / 100})` }} />
          </div>
          <p role="status" className="mt-2 text-sm">
            {cancelling ? "Stopping…" : (progressMessage ?? "Enhancing…")}
          </p>
        </div>
      ) : null}
      <div className="editor-actions">
        {busy ? (
          <Button
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              useWorkspace.getState().cancelEnhance();
            }}
          >
            {cancelling ? "Stopping…" : "Cancel"}
          </Button>
        ) : (
          <Button
            variant="primary"
            disabled={!settled || !plan.allowed}
            onClick={() =>
              void useWorkspace.getState().enhanceActive({ scale, targetSide, keepCutout })
            }
          >
            {item?.enhanced ? `Enhance again ${scale}×` : `Enhance ${scale}×`}
          </Button>
        )}
        <Button variant="secondary" onClick={() => close(false)}>
          Close
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        {busy
          ? "Closing this window stops enhancing."
          : "Speed depends on your computer. The first time takes longer while the enhancer gets ready."}
      </p>
    </EditorDialog>
  );
}
