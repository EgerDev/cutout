import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { Redo2, Undo2 } from "lucide-react";
import { classifyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/lib/workspace-store";
import { activeSettings } from "@/lib/editor/state";
import {
  keepLargest,
  labelPieces,
  pieceAt,
  removedPieces,
  setPieces,
  type Pieces,
} from "@/lib/editor/hints";
import { processable } from "@/lib/editor/canvas";
import { refineCropsAuto } from "@/lib/removal-client";
import { isTypingTarget } from "@/lib/utils";
import type { Hint, Point, SubjectBox } from "@/lib/editor/model";
import { EditorDialog } from "./editor-dialog";
import { EditorGuide } from "./editor-guide";
import { surfaceWidth, useCanvasZoom } from "./use-canvas-zoom";
import { ZoomControls } from "./zoom-controls";

type Tool = "pick" | "fix";
/** What this dialog edits: nothing reaches the workspace until Apply. */
type Draft = Readonly<{ blob: Blob; hints: readonly Hint[] }>;
type History = Readonly<{
  /** The image the dialog opened on: Apply writes nothing once another is active. */
  id: string | null;
  /** The workspace's state when the dialog opened: Apply is live once `now` differs. */
  start: Draft | null;
  past: readonly Draft[];
  now: Draft | null;
  future: readonly Draft[];
}>;
type Plate = Readonly<{ blob: Blob; image: ImageData; pieces: Pieces }>;
type Gesture = {
  pointer: number;
  tool: Tool;
  start: Point;
  last: Point;
  /** Pick drags: remove the touched pieces, or bring them back; the first piece decides. */
  remove: boolean | null;
  picks: Map<number, Point>;
};

const EMPTY: History = { id: null, start: null, past: [], now: null, future: [] };
const MAX_HINTS = 80;
/** A click this close (CSS px) to a piece still picks it: specks are hard to hit. */
const REACH = 12;

export function SubjectEditor({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const result = item?.resultBlob;
  const [history, setHistory] = useState<History>(EMPTY);
  const [tool, setTool] = useState<Tool>("pick");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [original, setOriginal] = useState(false);
  const [plate, setPlate] = useState<Plate | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const [decodeRetry, setDecodeRetry] = useState(0);
  const work = useRef<AbortController | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<Gesture | null>(null);
  const hover = useRef(0);
  const now = history.now;
  const ready = Boolean(now && plate && plate.blob === now.blob);

  // A fresh draft from the workspace each time the dialog opens; closing discards it.
  useEffect(() => {
    if (!open || !result) return;
    const state = useWorkspace.getState();
    const draft = { blob: result, hints: activeSettings(state).hints };
    setHistory({ id: state.activeId, start: draft, past: [], now: draft, future: [] });
    setOriginal(false);
    setTool("pick");
    setNote("");
    setDecodeError("");
    return () => {
      work.current?.abort();
      work.current = null;
      drag.current = null;
      setBusy(null);
      setHistory(EMPTY);
      setPlate(null);
    };
  }, [open, result]);

  const blob = now?.blob;
  useEffect(() => {
    if (!blob) return;
    let cancelled = false;
    setDecodeError("");
    setPlate(null);
    if (canvas.current) canvas.current.width = 0;
    void createImageBitmap(blob)
      .then((bitmap) => {
        if (cancelled) {
          bitmap.close();
          return;
        }
        const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(1, Math.round(bitmap.width * scale)),
          height = Math.max(1, Math.round(bitmap.height * scale));
        const scratch = document.createElement("canvas");
        scratch.width = width;
        scratch.height = height;
        try {
          const ctx = scratch.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("Canvas is unavailable. Try another browser.");
          ctx.drawImage(bitmap, 0, 0, width, height);
          const image = ctx.getImageData(0, 0, width, height);
          const alpha = new Uint8Array(width * height);
          for (let p = 0; p < alpha.length; p += 1) alpha[p] = image.data[p * 4 + 3] ?? 0;
          setPlate({ blob, image, pieces: labelPieces(alpha, width, height) });
        } finally {
          bitmap.close();
          scratch.width = 0;
          scratch.height = 0;
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setDecodeError(error instanceof Error ? error.message : "The image could not be read.");
      });
    return () => {
      cancelled = true;
    };
  }, [blob, decodeRetry]);

  const { start } = history;
  // By value: removing a piece and clicking it back is no change to apply.
  const dirty = useMemo(
    () =>
      Boolean(
        now &&
        start &&
        (now.blob !== start.blob || JSON.stringify(now.hints) !== JSON.stringify(start.hints)),
      ),
    [now, start],
  );
  const hints = now?.hints;
  const view = useMemo(() => {
    if (!plate || !hints) return null;
    const removed = removedPieces(plate.pieces, hints);
    return { plate, removed, base: ghost(plate, removed) };
  }, [plate, hints]);
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
    paint();
  }, [view]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (isTypingTarget(event.target)) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      if (key === "y" || event.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function push(next: Draft) {
    setHistory((h) =>
      h.now ? { ...h, past: [...h.past, h.now].slice(-50), now: next, future: [] } : h,
    );
  }
  function undo() {
    if (work.current) return;
    setHistory((h) => {
      const previous = h.past.at(-1);
      if (!previous || !h.now) return h;
      return { ...h, past: h.past.slice(0, -1), now: previous, future: [h.now, ...h.future] };
    });
  }
  function redo() {
    if (work.current) return;
    setHistory((h) => {
      const [next, ...future] = h.future;
      if (!next || !h.now) return h;
      return { ...h, past: [...h.past, h.now], now: next, future };
    });
  }
  function changeHints(next: readonly Hint[]) {
    if (!now || next === now.hints) return;
    if (next.length > MAX_HINTS) {
      setNote(`That’s ${MAX_HINTS} changes, the most one image keeps. Undo some first.`);
      return;
    }
    setNote("");
    push({ blob: now.blob, hints: next });
  }

  /** Paint the draft, then what the gesture or hover would change. */
  function paint() {
    const node = canvas.current,
      v = viewRef.current,
      p = v?.plate;
    if (!node || !v || !p) return;
    if (node.width !== p.image.width || node.height !== p.image.height) {
      node.width = p.image.width;
      node.height = p.image.height;
    }
    const ctx = node.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.putImageData(v.base, 0, 0);
    const g = drag.current;
    const box = g?.tool === "fix" ? rectOf(g.start, g.last) : pendingBox.current;
    if (box) drawBox(ctx, box);
    else if (g) for (const label of g.picks.keys()) tint(ctx, p, label, g.remove ?? true);
    else if (hover.current) tint(ctx, p, hover.current, !v.removed[hover.current - 1]);
  }
  /** The box being re-cut stays on screen until the re-cut lands. */
  const pendingBox = useRef<SubjectBox | null>(null);
  /** The piece just clicked: no hover preview on it until the pointer leaves it. */
  const settled = useRef(0);

  function canvasPoint(e: PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
      y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    return { point: { x, y }, pxPerCss: e.currentTarget.width / Math.max(1, r.width) };
  }
  function pieceUnder(e: PointerEvent<HTMLCanvasElement>) {
    const p = viewRef.current?.plate;
    if (!p) return null;
    const { point, pxPerCss } = canvasPoint(e);
    return pieceAt(p.pieces, point.x * p.image.width, point.y * p.image.height, REACH * pxPerCss);
  }
  function setHover(label: number) {
    if (hover.current === label) return;
    hover.current = label;
    const node = canvas.current;
    if (node) node.style.cursor = tool === "fix" ? "crosshair" : label ? "pointer" : "default";
    paint();
  }
  function chooseTool(next: Tool) {
    setHover(0);
    setTool(next);
  }
  /** Drop the pick or box in progress without recording it (a second finger means pinch). */
  function cancelGesture() {
    const g = drag.current;
    if (!g) return;
    drag.current = null;
    try {
      canvas.current?.releasePointerCapture(g.pointer);
    } catch {
      /* already released */
    }
    paint();
  }
  const surface = useRef<HTMLDivElement>(null);
  const zoomer = useCanvasZoom(viewport, surface, { enabled: open, onGestureStart: cancelGesture });
  const { zoom } = zoomer;
  const locked = !ready || Boolean(busy) || original;

  function down(e: PointerEvent<HTMLCanvasElement>) {
    if (locked || e.button !== 0 || zoomer.isBusy() || !view) return;
    const { point } = canvasPoint(e);
    const g: Gesture = {
      pointer: e.pointerId,
      tool,
      start: point,
      last: point,
      remove: null,
      picks: new Map(),
    };
    const hit = tool === "pick" ? pieceUnder(e) : null;
    if (hit) {
      g.remove = !view.removed[hit.label - 1];
      g.picks.set(hit.label, hit.point);
    }
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic / lost pointers still record the gesture */
    }
    drag.current = g;
    paint();
  }
  function move(e: PointerEvent<HTMLCanvasElement>) {
    const g = drag.current;
    if (!g) {
      if (locked || tool !== "pick") return;
      const label = pieceUnder(e)?.label ?? 0;
      if (label !== settled.current) settled.current = 0;
      setHover(settled.current ? 0 : label);
      return;
    }
    if (g.pointer !== e.pointerId) return;
    const oldBox = g.tool === "fix" ? rectOf(g.start, g.last) : null;
    g.last = canvasPoint(e).point;
    if (g.tool === "pick") {
      const hit = pieceUnder(e);
      if (!hit || g.picks.has(hit.label)) return;
      const removed = viewRef.current?.removed[hit.label - 1] ?? false;
      g.remove ??= !removed;
      // Only pieces the drag would change: dragging to remove skips removed ones.
      if (removed === g.remove) return;
      g.picks.set(hit.label, hit.point);
      const ctx = canvas.current?.getContext("2d", { willReadFrequently: true });
      const p = viewRef.current?.plate;
      if (ctx && p) tint(ctx, p, hit.label, g.remove);
    } else if (oldBox) {
      const ctx = canvas.current?.getContext("2d", { willReadFrequently: true });
      const v = viewRef.current;
      if (!ctx || !v) return;
      const { width, height } = ctx.canvas;
      const pad = Math.ceil(Math.max(2, width / 400));
      const x = Math.floor(oldBox.x * width) - pad,
        y = Math.floor(oldBox.y * height) - pad;
      const right = Math.ceil((oldBox.x + oldBox.width) * width) + pad;
      const bottom = Math.ceil((oldBox.y + oldBox.height) * height) + pad;
      ctx.putImageData(v.base, 0, 0, x, y, right - x, bottom - y);
      drawBox(ctx, rectOf(g.start, g.last));
    }
  }
  function end(e: PointerEvent<HTMLCanvasElement>, cancel = false) {
    const g = drag.current;
    if (!g || g.pointer !== e.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    if (cancel || !now || !plate) {
      paint();
      return;
    }
    if (g.tool === "pick") {
      const picks = [...g.picks].map(([label, point]) => ({ label, point }));
      if (picks.length && g.remove !== null)
        changeHints(setPieces(plate.pieces, now.hints, picks, g.remove));
      settled.current = pieceUnder(e)?.label ?? 0;
      hover.current = 0;
      paint();
      return;
    }
    const box = rectOf(g.start, g.last);
    if (box.width < 0.02 || box.height < 0.02) {
      paint();
      setNote("Drag a box around the area to fix.");
      return;
    }
    pendingBox.current = box;
    paint();
    void recut([box], "that area");
  }

  /** Cut the boxes again at full detail, on top of the current draft. */
  async function recut(boxes: SubjectBox[], what: string) {
    const state = useWorkspace.getState();
    const current = state.items.find((entry) => entry.id === state.activeId);
    const base = now;
    if (!current || !base) return;
    const controller = new AbortController();
    work.current?.abort();
    work.current = controller;
    setBusy(`Re-cutting ${what}…`);
    try {
      const source = await processable(current.source);
      const blob = await refineCropsAuto(source, base.blob, boxes, { signal: controller.signal });
      if (controller.signal.aborted) return;
      push({ blob, hints: base.hints });
      setNote(
        `Re-cut ${what}. Undo here if it looks worse: once applied, only Reprocess brings back the first cut.`,
      );
    } catch (error) {
      if (!controller.signal.aborted) setNote(classifyError(error).message);
    } finally {
      if (work.current === controller) {
        work.current = null;
        pendingBox.current = null;
        setBusy(null);
        paint();
      }
    }
  }

  function onlyLargest() {
    if (plate) changeHints(keepLargest(plate.pieces));
  }

  function apply() {
    const state = useWorkspace.getState();
    // replaceResult and changeEdit write to the active image, which must still be this one.
    if (now && start && dirty && state.activeId === history.id) {
      if (now.blob !== start.blob) state.replaceResult(now.blob);
      if (now.hints !== start.hints) state.changeEdit({ hints: now.hints });
    }
    onOpenChange(false);
  }

  const count = plate?.pieces.components.length ?? 0;
  const removedCount = view?.removed.filter(Boolean).length ?? 0;
  const status = busy
    ? busy
    : !ready
      ? decodeError
        ? "Subject preview unavailable."
        : "Preparing…"
      : count === 0
        ? "Nothing is cut out yet."
        : count === 1
          ? removedCount
            ? "The only piece is removed. Click it to bring it back."
            : "The cutout is one piece, so there is nothing to pick apart. Use Fix area to re-cut part of it, or the Brush to erase it."
          : `${count - removedCount} of ${count} pieces kept${removedCount ? ` · ${removedCount} removed` : ""}`;

  return (
    <EditorDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Choose subject"
      description="Click the pieces you don’t want, or fix an area the cutout got wrong. Nothing changes until you apply."
      wide
    >
      <div className="editor-actions">
        <div role="group" aria-label="Tool" className="editor-tools">
          <Button aria-pressed={tool === "pick"} onClick={() => chooseTool("pick")}>
            Pick pieces
          </Button>
          <Button aria-pressed={tool === "fix"} onClick={() => chooseTool("fix")}>
            Fix area
          </Button>
        </div>
        <Button disabled={locked || count < 2} onClick={onlyLargest}>
          Keep largest
        </Button>
        <span className="editor-spacer" />
        <Button
          size="icon"
          aria-label="Undo"
          title="Undo (Ctrl+Z)"
          disabled={!history.past.length || Boolean(busy)}
          onClick={undo}
        >
          <Undo2 className="size-4" />
        </Button>
        <Button
          size="icon"
          aria-label="Redo"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!history.future.length || Boolean(busy)}
          onClick={redo}
        >
          <Redo2 className="size-4" />
        </Button>
        <Button
          aria-pressed={original}
          onClick={() => setOriginal((value) => !value)}
          aria-label="Show original"
        >
          <span className="label-full">Show original</span>
          <span className="label-short">Original</span>
        </Button>
        <Button popoverTarget="subject-guide">Guide</Button>
      </div>
      <EditorGuide id="subject-guide" title="How Choose subject works" items={SUBJECT_GUIDE} />
      <div className="editor-meta">
        {decodeError ? (
          <div className="editor-actions">
            <p role="alert" className="text-xs text-muted">
              Could not prepare the subject preview. {decodeError}
            </p>
            <Button size="sm" onClick={() => setDecodeRetry((value) => value + 1)}>
              Retry subject preview
            </Button>
          </div>
        ) : null}
        <p role="status" className="text-xs text-muted">
          {note ||
            (tool === "pick"
              ? "Click a piece to remove it; red, faded pieces are removed, click one to bring it back. Drag across specks to do several at once."
              : "Drag a box around a part the cutout got wrong. That area is cut again at full detail.")}
        </p>
      </div>
      <div className="canvas-stage">
        <div
          ref={viewport}
          className={`brush-viewport stage-viewport${zoomer.spaceHeld ? " space-pan" : ""}`}
          tabIndex={0}
          aria-label="Scrollable subject canvas"
        >
          <div
            ref={surface}
            className="brush-surface stage-surface"
            style={{ width: surfaceWidth(zoom, item?.width ?? 1, item?.height ?? 1) }}
          >
            <canvas
              ref={canvas}
              aria-label="Choose subject canvas"
              onPointerDown={down}
              onPointerMove={move}
              onPointerUp={(e) => end(e)}
              onPointerCancel={(e) => end(e, true)}
              onPointerLeave={() => setHover(0)}
              onLostPointerCapture={(e) => end(e, true)}
              style={{
                visibility: original ? "hidden" : "visible",
                cursor: tool === "fix" ? "crosshair" : "default",
                // Sharp pixels when zoomed in, so a speck can be told from its neighbour.
                imageRendering: zoom >= 200 ? "pixelated" : "auto",
              }}
            />
            {original ? (
              <img src={item?.sourceUrl} alt="Original image" className="brush-original" />
            ) : null}
          </div>
        </div>
        <ZoomControls {...zoomer} />
        {busy ? (
          <p className="stage-busy" aria-hidden="true">
            {busy}
          </p>
        ) : null}
      </div>
      <div className="editor-footer">
        <p role="status" aria-live="polite" className="text-sm">
          {status}
        </p>
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!dirty || Boolean(busy)} onClick={apply}>
          Apply
        </Button>
      </div>
    </EditorDialog>
  );
}

function rectOf(a: Point, b: Point): SubjectBox {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function drawBox(ctx: CanvasRenderingContext2D, r: SubjectBox) {
  const { width, height } = ctx.canvas;
  ctx.save();
  ctx.lineWidth = Math.max(2, width / 400);
  ctx.setLineDash([ctx.lineWidth * 4, ctx.lineWidth * 3]);
  for (const [color, offset] of [
    ["#000", 0],
    ["#fff", 3.5],
  ] as const) {
    ctx.strokeStyle = color;
    ctx.lineDashOffset = ctx.lineWidth * offset;
    ctx.strokeRect(r.x * width, r.y * height, r.width * width, r.height * height);
  }
  ctx.restore();
}

/** The plate with removed pieces faded and reddened, so they stay visible and clickable. */
function ghost(plate: Plate, removed: readonly boolean[]): ImageData {
  const { image, pieces } = plate;
  const out = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  if (!removed.some(Boolean)) return out;
  for (let p = 0; p < pieces.labels.length; p += 1) {
    const label = pieces.labels[p] ?? 0;
    if (!label || !removed[label - 1]) continue;
    const o = p * 4;
    out.data[o] = (out.data[o] ?? 0) * 0.5 + 120;
    out.data[o + 1] = (out.data[o + 1] ?? 0) * 0.5 + 30;
    out.data[o + 2] = (out.data[o + 2] ?? 0) * 0.5 + 30;
    out.data[o + 3] = Math.max(70, (out.data[o + 3] ?? 0) * 0.35);
  }
  return out;
}

/** Tint one piece: red for "this goes", green for "this comes back". */
function tint(ctx: CanvasRenderingContext2D, plate: Plate, label: number, remove: boolean) {
  const c = plate.pieces.components[label - 1];
  if (!c) return;
  const { labels, width } = plate.pieces;
  const src = plate.image.data;
  const w = c.right - c.left + 1,
    h = c.bottom - c.top + 1;
  const patch = ctx.getImageData(c.left, c.top, w, h);
  const [r, g, b, mix] = remove ? [239, 68, 68, 0.7] : [34, 197, 94, 0.55];
  for (let y = 0; y < h; y += 1)
    for (let x = 0; x < w; x += 1) {
      const i = (c.top + y) * width + c.left + x;
      if (labels[i] !== label) continue;
      const s = i * 4,
        o = (y * w + x) * 4;
      patch.data[o] = (src[s] ?? 0) * (1 - mix) + r * mix;
      patch.data[o + 1] = (src[s + 1] ?? 0) * (1 - mix) + g * mix;
      patch.data[o + 2] = (src[s + 2] ?? 0) * (1 - mix) + b * mix;
      patch.data[o + 3] = Math.max(160, src[s + 3] ?? 0);
    }
  ctx.putImageData(patch, c.left, c.top);
}

const SUBJECT_GUIDE = [
  [
    "Pieces",
    "The cutout is made of separate pieces: anything that doesn’t touch the rest, like a stray speck, a second object or a detached shadow.",
  ],
  [
    "Pick pieces",
    "Click a piece to remove it. It turns faded red so you can still see it; click it again to bring it back. Drag across specks to clean up several at once. Keep largest keeps only the biggest piece.",
  ],
  [
    "Fix area",
    "If the cutout got an edge or a part wrong, drag a box around it. That area is cut again at full detail.",
  ],
  [
    "Only one piece?",
    "Then there’s nothing to pick apart. Use Fix area, or the Brush to erase part of it.",
  ],
  [
    "Undo, Cancel, Apply",
    "Undo and Redo (Ctrl+Z, Ctrl+Shift+Z) step through your changes in this window. Nothing touches your image until Apply; Cancel throws the changes away. A Fix area re-cut can’t be undone after Apply, only by Reprocess.",
  ],
  [
    "Zoom and move",
    "⌘/Ctrl-scroll or pinch zooms where you point; + and − zoom, 0 fits. Hold Space and drag (or drag with the middle button) to move around. Show original shows the photo.",
  ],
] as const;
