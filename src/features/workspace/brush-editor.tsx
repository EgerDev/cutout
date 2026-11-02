import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import {
  MATTE_PREVIEW_MAX,
  brushBlob,
  canvas2d,
  matteInputFor,
  paintStroke,
  sourceBitmap,
} from "@/lib/editor/canvas";
import { StrokeMask, compositeMask } from "@/lib/editor/soft-stroke";
import { MAX_SIZE, MIN_SIZE, penStrokeSize } from "@/lib/brush-pressure";
import { isTypingTarget } from "@/lib/utils";
import type { Point, Stroke } from "@/lib/editor/model";
import { EditorDialog } from "./editor-dialog";
import { EditorGuide } from "./editor-guide";
import { surfaceWidth, useCanvasZoom } from "./use-canvas-zoom";
import { ZoomControls } from "./zoom-controls";

type Mode = Stroke["mode"];
type Gesture = {
  pointer: number;
  mode: Mode;
  size: number;
  hardness: number;
  points: Point[];
  /** Earlier parts of a stroke too long for one (4096 points each), saved as strokes of their own. */
  done: Point[][];
  /** Soft strokes paint through one mask for the whole stroke, so overlaps never build up. */
  mask: StrokeMask | null;
};
/** What this dialog edits: nothing reaches the workspace until Apply. */
type Draft = Readonly<{
  /** The image the dialog opened on, which Apply writes to even if another becomes active. */
  id: string;
  start: readonly Stroke[];
  strokes: readonly Stroke[];
  redo: readonly Stroke[];
}>;

const MAX_STROKES = 500;
const SIZE_STEPS = 1000;
/** Size slider is logarithmic: fine control for small brushes, still reaching 30%. */
const sizeAt = (step: number) => MIN_SIZE * (MAX_SIZE / MIN_SIZE) ** (step / SIZE_STEPS);
const stepOf = (size: number) =>
  Math.round((Math.log(size / MIN_SIZE) / Math.log(MAX_SIZE / MIN_SIZE)) * SIZE_STEPS);
const clampSize = (size: number) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, size));

export function BrushEditor({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const item = useWorkspace((s) => s.items.find((i) => i.id === (draft?.id ?? s.activeId)));
  const [mode, setMode] = useState<Mode>("erase"),
    [size, setSize] = useState(0.05),
    [softness, setSoftness] = useState(0),
    [original, setOriginal] = useState(false),
    [note, setNote] = useState("");
  const hardness = 100 - softness;
  const [loaded, setLoaded] = useState<{ result: Blob; strokes: readonly Stroke[] } | null>(null),
    [error, setError] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    ghost = useRef<HTMLCanvasElement>(null),
    source = useRef<HTMLCanvasElement | null>(null),
    base = useRef<ImageBitmap | null>(null),
    gesture = useRef<Gesture | null>(null),
    cursorRef = useRef<HTMLDivElement>(null),
    innerCursorRef = useRef<HTMLDivElement>(null),
    viewport = useRef<HTMLDivElement>(null),
    surface = useRef<HTMLDivElement>(null),
    flash = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceFile = item?.source,
    result = item?.resultBlob,
    strokes = draft?.strokes;
  const ready = Boolean(strokes && loaded?.result === result && loaded?.strokes === strokes);

  // A fresh draft from the workspace each time the dialog opens; closing discards it.
  useEffect(() => {
    const state = useWorkspace.getState();
    if (!open || !state.activeId) return;
    const start = activeSettings(state).strokes;
    setDraft({ id: state.activeId, start, strokes: start, redo: [] });
    setMode("erase");
    setOriginal(false);
    setNote("");
    return () => setDraft(null);
  }, [open]);

  /** The soft stroke just painted live, which the canvas already shows as it will render. */
  const live = useRef<Stroke | null>(null);
  // What `base` currently shows, so an appended stroke can be painted on top instead of rebuilt.
  const painted = useRef<{ result: Blob; strokes: readonly Stroke[] } | null>(null);
  useEffect(() => {
    if (!open) return;
    return () => {
      gesture.current = null;
      painted.current = null;
      base.current?.close();
      base.current = null;
      if (source.current) {
        source.current.width = 0;
        source.current.height = 0;
        source.current = null;
      }
    };
  }, [open, result, sourceFile]);
  useEffect(() => {
    if (!open || !sourceFile || !result || !strokes) return;
    let cancelled = false;
    const last = painted.current,
      target = canvas.current,
      stroke = strokes.at(-1);
    if (
      last?.result === result &&
      stroke &&
      strokes.length === last.strokes.length + 1 &&
      last.strokes.every((s, i) => s === strokes[i]) &&
      target &&
      base.current &&
      source.current
    ) {
      // One new stroke (drawn or redone): replay it on the snapshot, no full-size re-render.
      const ctx = target.getContext("2d");
      if (ctx) {
        if (live.current === stroke) live.current = null;
        else {
          ctx.clearRect(0, 0, target.width, target.height);
          ctx.drawImage(base.current, 0, 0);
          paintStroke(ctx, stroke, source.current, target.width, target.height);
        }
        void createImageBitmap(target).then((next) => {
          if (cancelled) return next.close();
          base.current?.close();
          base.current = next;
          painted.current = { result, strokes };
          setLoaded(painted.current);
        });
        return () => {
          cancelled = true;
        };
      }
    }
    setLoaded(null);
    setError("");
    gesture.current = null;
    void (async () => {
      let bitmap: ImageBitmap | undefined,
        plate: Awaited<ReturnType<typeof sourceBitmap>> | undefined;
      try {
        // The editor shows at most MATTE_PREVIEW_MAX, so replay strokes on the cached preview copy.
        const work = await matteInputFor(result, MATTE_PREVIEW_MAX);
        bitmap = await createImageBitmap(await brushBlob(work.blob, sourceFile, strokes));
        plate = await sourceBitmap(sourceFile, bitmap.width, bitmap.height);
        if (cancelled) return;
        const target = canvas.current;
        if (!target) return;
        const scale = Math.min(1, MATTE_PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
        target.width = Math.round(bitmap.width * scale);
        target.height = Math.round(bitmap.height * scale);
        const ctx = target.getContext("2d");
        if (!ctx) throw new Error("Canvas is unavailable");
        const layer = canvas2d(target.width, target.height);
        layer.context.drawImage(plate.bitmap, 0, 0, target.width, target.height);
        ctx.drawImage(bitmap, 0, 0, target.width, target.height);
        // The photo under the cutout: Show original, and the faded guide in Restore.
        const under = ghost.current;
        if (under) {
          under.width = target.width;
          under.height = target.height;
          under.getContext("2d")?.drawImage(layer.canvas, 0, 0);
        }
        const nextBase = await createImageBitmap(target);
        if (cancelled) {
          nextBase.close();
          layer.canvas.width = 0;
          layer.canvas.height = 0;
          return;
        }
        if (source.current) {
          source.current.width = 0;
          source.current.height = 0;
        }
        source.current = layer.canvas;
        base.current?.close();
        base.current = nextBase;
        painted.current = { result, strokes };
        setLoaded(painted.current);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Could not open the brush.");
      } finally {
        bitmap?.close();
        plate?.release();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, result, sourceFile, strokes]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (document.querySelector(".editor-dialog :popover-open")) return;
      const key = event.key.toLowerCase();
      if (event.metaKey || event.ctrlKey) {
        if (event.repeat || (key !== "z" && key !== "y")) return;
        event.preventDefault();
        if (key === "y" || event.shiftKey) redo();
        else undo();
        return;
      }
      if (key === "[" || key === "]") {
        event.preventDefault();
        setSize((value) => clampSize(value * (key === "]" ? 1.2 : 1 / 1.2)));
        showSize();
        return;
      }
      if (event.repeat) return;
      if (key === "e") setMode("erase");
      else if (key === "r") setMode("restore");
      else if (key === "x") setMode((value) => (value === "erase" ? "restore" : "erase"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // undo/redo/showSize use functional updates and refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  useEffect(
    () => () => {
      if (flash.current) clearTimeout(flash.current);
    },
    [],
  );

  function addStrokes(made: readonly Stroke[]) {
    if ((strokes?.length ?? 0) + made.length > MAX_STROKES) {
      setNote(`That’s ${MAX_STROKES} strokes, the most one image keeps. Undo some first.`);
      live.current = null;
      redraw();
      return;
    }
    setNote("");
    setDraft((d) => d && { ...d, strokes: [...d.strokes, ...made], redo: [] });
  }
  function undo() {
    if (gesture.current) return;
    setDraft((d) => {
      const last = d?.strokes.at(-1);
      if (!d || !last) return d;
      return { ...d, strokes: d.strokes.slice(0, -1), redo: [last, ...d.redo] };
    });
  }
  function redo() {
    if (gesture.current) return;
    setDraft((d) => {
      const [next, ...rest] = d?.redo ?? [];
      if (!d || !next) return d;
      return { ...d, strokes: [...d.strokes, next], redo: rest };
    });
  }
  const dirty = Boolean(
    draft &&
    (draft.strokes.length !== draft.start.length ||
      draft.strokes.some((s, i) => s !== draft.start[i])),
  );
  function apply() {
    if (draft && dirty)
      useWorkspace.getState().changeEdit({ strokes: draft.strokes }, undefined, draft.id);
    onOpenChange(false);
  }

  function redraw() {
    const c = canvas.current,
      ctx = c?.getContext("2d");
    if (c && ctx && base.current) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(base.current, 0, 0);
    }
  }
  /** Drop the stroke in progress without recording it (a pinch or a pan started). */
  function cancelGesture() {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    try {
      canvas.current?.releasePointerCapture(g.pointer);
    } catch {
      /* already released */
    }
    redraw();
  }
  const zoomer = useCanvasZoom(viewport, surface, { enabled: open, onGestureStart: cancelGesture });
  const { zoom } = zoomer;

  function point(e: PointerEvent<HTMLCanvasElement>): Point {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
    };
  }
  function paintLive(points: readonly Point[], g: Gesture) {
    const c = canvas.current,
      ctx = c?.getContext("2d");
    if (!c || !ctx || !source.current) return;
    if (!g.mask) {
      paintStroke(ctx, { mode: g.mode, size: g.size, points }, source.current, c.width, c.height);
      return;
    }
    const [a, b = a] = points.map((p) => ({ x: p.x * c.width, y: p.y * c.height }));
    const rect = a && b ? g.mask.add(a, b) : null;
    if (!rect || !base.current) return;
    // Repaint the touched area from the snapshot through the whole stroke's mask.
    ctx.clearRect(rect.x, rect.y, rect.width, rect.height);
    ctx.drawImage(
      base.current,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      rect.x,
      rect.y,
      rect.width,
      rect.height,
    );
    compositeMask(ctx, g.mask, rect, g.mode, source.current);
  }
  function ring(x: number, y: number, fraction: number) {
    const c = canvas.current,
      outer = cursorRef.current;
    if (!c || !outer) return;
    const r = c.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return;
    const diameter = Math.max(4, Math.round(fraction * Math.min(r.width, r.height)));
    outer.style.width = `${diameter}px`;
    outer.style.height = `${diameter}px`;
    outer.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`;
    outer.style.display = "block";
    const inner = innerCursorRef.current;
    if (inner) {
      const core = Math.max(2, Math.round((diameter * hardness) / 100));
      inner.style.width = `${core}px`;
      inner.style.height = `${core}px`;
      inner.style.display = hardness < 100 ? "block" : "none";
    }
  }
  function updateCursor(e: PointerEvent<HTMLCanvasElement>) {
    if (original || zoomer.spaceHeld) return hideCursor();
    const r = e.currentTarget.getBoundingClientRect();
    pointerAt.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    ring(
      e.clientX - r.left,
      e.clientY - r.top,
      gesture.current?.size ?? penStrokeSize(size, e.pointerType, e.pressure),
    );
  }
  function hideCursor() {
    if (cursorRef.current) cursorRef.current.style.display = "none";
  }
  /** Show the brush at its new size: under the pointer, or mid-view for a moment. */
  function showSize(next?: number) {
    const c = canvas.current,
      vp = viewport.current,
      at = pointerAt.current;
    if (at && !original) {
      requestAnimationFrame(() => ring(at.x, at.y, next ?? sizeRef.current));
      return;
    }
    if (!c || !vp) return;
    const r = c.getBoundingClientRect(),
      v = vp.getBoundingClientRect();
    requestAnimationFrame(() =>
      ring(v.left + v.width / 2 - r.left, v.top + v.height / 2 - r.top, next ?? sizeRef.current),
    );
    if (flash.current) clearTimeout(flash.current);
    flash.current = setTimeout(hideCursor, 800);
  }
  /** Where the pointer is over the canvas (canvas-relative CSS px), or null off it. */
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const sizeRef = useRef(size);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

  function down(e: PointerEvent<HTMLCanvasElement>) {
    updateCursor(e);
    if (!ready || original || gesture.current || e.button !== 0 || zoomer.isBusy()) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / lost pointers still record the stroke */
    }
    const c = e.currentTarget;
    const strokeSize = penStrokeSize(size, e.pointerType, e.pressure);
    const radius = Math.max(0.5, (strokeSize * Math.min(c.width, c.height)) / 2);
    const g: Gesture = {
      pointer: e.pointerId,
      mode,
      size: strokeSize,
      hardness,
      points: [point(e)],
      done: [],
      mask:
        hardness < 100
          ? new StrokeMask(0, 0, c.width, c.height, radius, (radius * hardness) / 100)
          : null,
    };
    gesture.current = g;
    paintLive(g.points, g);
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    updateCursor(e);
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    const p = point(e),
      last = g.points.at(-1);
    if (!last) return;
    // Points closer than a tenth of the brush add nothing but length.
    if (Math.hypot(p.x - last.x, p.y - last.y) < Math.max(0.001, g.size * 0.1)) return;
    if (g.points.length >= 4096) {
      g.done.push(g.points);
      g.points = [last];
    }
    g.points.push(p);
    paintLive([last, p], g);
  }
  function end(e: PointerEvent<HTMLCanvasElement>, cancel = false) {
    const g = gesture.current;
    if (!g || g.pointer !== e.pointerId) return;
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (cancel) {
      redraw();
      return;
    }
    const made = [...g.done, g.points].map((points): Stroke => ({
      mode: g.mode,
      size: g.size,
      points,
      ...(g.hardness < 100 ? { hardness: g.hardness } : {}),
    }));
    // A soft stroke already sits on the canvas exactly as it renders: keep it, don't redraw it.
    if (g.mask && made.length === 1) live.current = made[0] ?? null;
    addStrokes(made);
  }

  const count = strokes?.length ?? 0;
  const shortSide = Math.min(item?.width ?? 0, item?.height ?? 0);
  const sizeLabel = shortSide
    ? `${Math.max(1, Math.round(size * shortSide))} px`
    : `${(size * 100).toFixed(1)}%`;
  const status =
    error ||
    (!ready
      ? "Preparing brush…"
      : `${count} ${count === 1 ? "stroke" : "strokes"} · ${mode === "erase" ? "Erase" : "Restore"}`);

  return (
    <EditorDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Brush"
      description="Paint away what shouldn’t be there, or restore what the cutout lost. Nothing changes until you apply."
      wide
    >
      <div className="editor-actions">
        <div role="group" aria-label="Brush mode" className="editor-tools">
          <Button
            aria-pressed={mode === "erase"}
            title="Erase (E)"
            onClick={() => setMode("erase")}
          >
            Erase
          </Button>
          <Button
            aria-pressed={mode === "restore"}
            title="Restore (R)"
            onClick={() => setMode("restore")}
          >
            Restore
          </Button>
        </div>
        <span className="editor-spacer" />
        <Button
          size="icon"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!count}
          onClick={undo}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          size="icon"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!draft?.redo.length}
          onClick={redo}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button
          aria-pressed={original}
          onClick={() => setOriginal(!original)}
          aria-label="Show original"
        >
          <span className="label-full">Show original</span>
          <span className="label-short">Original</span>
        </Button>
        <Button popoverTarget="brush-guide">Guide</Button>
      </div>
      <EditorGuide id="brush-guide" title="How the brush works" items={BRUSH_GUIDE} />
      <div className="brush-tip-row">
        <span
          className="brush-tip"
          aria-hidden="true"
          style={{
            background: `radial-gradient(circle closest-side, var(--color-fg) ${hardness}%, transparent 100%)`,
          }}
        />
        <label className="brush-slider">
          <span>
            Size <output>{sizeLabel}</output>
          </span>
          <input
            aria-label="Brush size"
            type="range"
            min="0"
            max={SIZE_STEPS}
            value={stepOf(size)}
            onChange={(e) => {
              const next = sizeAt(Number(e.target.value));
              setSize(next);
              showSize(next);
            }}
          />
        </label>
        <label className="brush-slider">
          <span>
            Edge <output>{softness ? `Soft ${softness}%` : "Hard"}</output>
          </span>
          <input
            aria-label="Edge softness"
            type="range"
            min="0"
            max="100"
            value={softness}
            onChange={(e) => setSoftness(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="editor-meta">
        <p role="status" className="text-xs text-muted">
          {note ||
            (mode === "erase"
              ? "Paint over what shouldn’t be there. A soft edge blends into hair and fur."
              : "The faded photo shows what you can bring back: paint over it to restore.")}
        </p>
      </div>
      <div className="canvas-stage">
        <div
          ref={viewport}
          className={`brush-viewport stage-viewport${zoomer.spaceHeld ? " space-pan" : ""}`}
          tabIndex={0}
          aria-label="Scrollable brush canvas"
        >
          <div
            ref={surface}
            className="brush-surface stage-surface"
            style={{ width: surfaceWidth(zoom, item?.width ?? 1, item?.height ?? 1) }}
          >
            <canvas
              ref={ghost}
              className="brush-ghost"
              aria-hidden="true"
              style={{ opacity: original ? 1 : mode === "restore" ? 0.3 : 0 }}
            />
            <canvas
              ref={canvas}
              aria-label={`${mode === "erase" ? "Erase" : "Restore"} brush canvas`}
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={(e) => end(e)}
              onPointerCancel={(e) => end(e, true)}
              onPointerEnter={updateCursor}
              onPointerLeave={() => {
                pointerAt.current = null;
                hideCursor();
              }}
              onLostPointerCapture={(e) => {
                hideCursor();
                end(e, true);
              }}
              style={{
                visibility: original ? "hidden" : "visible",
                cursor: original ? "default" : "none",
                imageRendering: zoom >= 200 ? "pixelated" : "auto",
              }}
            />
            <div ref={cursorRef} className="brush-cursor-ring" aria-hidden="true">
              <div ref={innerCursorRef} className="brush-cursor-inner" />
              <div className={`brush-cursor-dot ${mode}`} />
            </div>
          </div>
        </div>
        <ZoomControls {...zoomer} />
      </div>
      <div className="editor-footer">
        <p role="status" aria-live="polite" className="text-sm">
          {status}
        </p>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!dirty} onClick={apply}>
          Apply
        </Button>
      </div>
    </EditorDialog>
  );
}

const BRUSH_GUIDE = [
  [
    "Erase",
    "Paint over anything the cutout kept by mistake: background, a shadow, a stray object. Press E.",
  ],
  [
    "Restore",
    "Brings back pixels from your photo where the cutout cut too much. The photo shows faded under the cutout so you can see what you’ll get back. Press R, or X to switch between the two.",
  ],
  [
    "Size",
    "Shown in pixels of your image. [ and ] make the brush smaller or bigger; with a stylus, a light touch starts a thinner stroke.",
  ],
  [
    "Edge",
    "Hard paints a crisp edge. Soft fades out towards the rim, so erasing around hair, fur or glass blends instead of leaving a cut line. The inner ring on the cursor is where it stops being full strength.",
  ],
  [
    "Zoom and move",
    "⌘/Ctrl-scroll or pinch zooms where you point; + and − zoom, 0 fits. Hold Space and drag (or drag with the middle button) to move around.",
  ],
  [
    "Undo, Cancel, Apply",
    "Undo and Redo (Ctrl+Z, Ctrl+Shift+Z) step through strokes, including ones you applied before. Nothing touches your image until Apply; Cancel throws this session’s strokes away.",
  ],
] as const;
