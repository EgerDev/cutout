import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isTypingTarget } from "@/lib/utils";

export const ZOOM_MIN = 100;
export const ZOOM_MAX = 800;
const STEP = 1.25;

/** CSS width that fits the photo to the viewport height at 100% zoom. */
export function surfaceWidth(zoom: number, width: number, height: number) {
  const ratio = (width || 1) / Math.max(1, height || 1);
  return `min(${zoom}%, calc(var(--brush-fit-height) * ${(ratio * zoom) / 100}))`;
}

type Anchor = { fx: number; fy: number; x: number; y: number };

/**
 * Zoom and pan for an editor canvas inside a scrollable viewport. Every zoom
 * keeps the point under the cursor (or between two fingers) where it was:
 * ⌘/Ctrl-scroll and trackpad pinch zoom at the pointer, the buttons and +/−
 * keys at the centre, 0 fits. Space-drag or middle-drag pans; two fingers pinch
 * and pan. The canvas has `touch-action: none` (one finger paints), so pinch is
 * handled here, in the capture phase, before a stroke can start.
 */
export function useCanvasZoom(
  viewport: RefObject<HTMLElement | null>,
  surface: RefObject<HTMLElement | null>,
  options: {
    readonly enabled: boolean;
    /** Called when a pinch or pan starts, to drop a stroke the first pointer began. */
    readonly onGestureStart?: () => void;
  },
) {
  const [zoom, setZoomState] = useState(ZOOM_MIN);
  // Bumped with every zoom: a pinch can return to the rendered zoom between two fingers'
  // moves, and the scroll it owes (its pan) must still be applied.
  const [moved, setMoved] = useState(0);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const current = useRef(ZOOM_MIN);
  const anchor = useRef<Anchor | null>(null);
  const busy = useRef(false);
  const spaceRef = useRef(false);
  const latest = useRef(options);
  latest.current = options;
  // The dialog mounts its content a render after opening: follow the node, not the first ref.
  const [node, setNode] = useState<HTMLElement | null>(null);
  // Every render, no deps: setNode bails out when the node is unchanged, so it can't loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => setNode(viewport.current));

  /** Scroll so the anchored point of the surface sits under (x, y) again. */
  function place(a: Anchor) {
    const vp = viewport.current,
      s = surface.current;
    if (!vp || !s) return;
    const r = s.getBoundingClientRect();
    vp.scrollLeft += r.left + a.fx * r.width - a.x;
    vp.scrollTop += r.top + a.fy * r.height - a.y;
  }
  function anchorAt(x?: number, y?: number): Anchor | null {
    const vp = viewport.current,
      s = surface.current;
    if (!vp || !s) return null;
    const v = vp.getBoundingClientRect(),
      r = s.getBoundingClientRect();
    const ax = x ?? v.left + v.width / 2,
      ay = y ?? v.top + v.height / 2;
    return {
      fx: (ax - r.left) / Math.max(1, r.width),
      fy: (ay - r.top) / Math.max(1, r.height),
      x: ax,
      y: ay,
    };
  }
  function zoomTo(next: number, at: Anchor | null = anchorAt()) {
    const value = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
    if (value === current.current) {
      if (at) place(at);
      return;
    }
    anchor.current = at;
    current.current = value;
    setZoomState(value);
    setMoved((n) => n + 1);
  }
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    if (a) place(a);
    // place reads refs only; the new zoom's layout is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moved]);

  const controls = {
    zoom,
    zoomIn: () => zoomTo(current.current * STEP),
    zoomOut: () => zoomTo(current.current / STEP),
    fit: () => zoomTo(ZOOM_MIN),
    /** True while pinching, panning or holding Space: the canvas must not paint. */
    isBusy: () => busy.current || spaceRef.current,
    spaceHeld,
  };

  // Back to fit each time the editor opens.
  useEffect(() => {
    if (!options.enabled) return;
    current.current = ZOOM_MIN;
    setZoomState(ZOOM_MIN);
  }, [options.enabled]);

  useEffect(() => {
    if (!node || !options.enabled) return;
    const fingers = new Map<number, { x: number; y: number }>();
    let pinch: { distance: number; zoom: number; fx: number; fy: number } | null = null;
    let pan: { pointer: number; x: number; y: number; left: number; top: number } | null = null;
    // Space pans only with the pointer over the canvas; elsewhere it still presses buttons.
    let over = false;
    const enter = () => (over = true);
    const leave = () => (over = false);
    const middle = () => {
      const [a, b] = Array.from(fingers.values());
      if (!a || !b) return null;
      return {
        distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (fingers.size !== 2) return;
        const g = middle(),
          a = g && anchorAt(g.x, g.y);
        if (!g || !a) return;
        busy.current = true;
        pinch = { distance: g.distance, zoom: current.current, fx: a.fx, fy: a.fy };
        latest.current.onGestureStart?.();
        return;
      }
      if (event.button !== 1 && !(event.button === 0 && spaceRef.current)) return;
      event.preventDefault();
      event.stopPropagation();
      busy.current = true;
      pan = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: node.scrollLeft,
        top: node.scrollTop,
      };
      node.classList.add("is-panning");
      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointers still pan */
      }
      latest.current.onGestureStart?.();
    };
    const move = (event: PointerEvent) => {
      if (pan && event.pointerId === pan.pointer) {
        event.preventDefault();
        node.scrollLeft = pan.left - (event.clientX - pan.x);
        node.scrollTop = pan.top - (event.clientY - pan.y);
        return;
      }
      if (!fingers.has(event.pointerId)) return;
      fingers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const g = middle();
      if (!pinch || !g) return;
      event.preventDefault();
      // The point first pinched stays between the fingers: zoom and pan in one.
      zoomTo((pinch.zoom * g.distance) / pinch.distance, {
        fx: pinch.fx,
        fy: pinch.fy,
        x: g.x,
        y: g.y,
      });
    };
    const up = (event: PointerEvent) => {
      if (pan && event.pointerId === pan.pointer) {
        pan = null;
        busy.current = false;
        node.classList.remove("is-panning");
        return;
      }
      if (!fingers.delete(event.pointerId)) return;
      if (fingers.size < 2) pinch = null;
      // Stay busy until the last finger lifts so a lingering finger does not paint.
      if (fingers.size === 0) busy.current = false;
    };
    const wheel = (event: WheelEvent) => {
      // Trackpad pinch arrives as ⌘/Ctrl + wheel with small deltas: smooth either way.
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      zoomTo(current.current * Math.exp(-delta * 0.002), anchorAt(event.clientX, event.clientY));
    };
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.key === " ") {
        if (event.type === "keydown" ? !over : !spaceRef.current) return;
        // Space pans while held, in place of scrolling the page or pressing a focused button.
        event.preventDefault();
        if (event.type === "keydown" && !spaceRef.current) {
          spaceRef.current = true;
          setSpaceHeld(true);
        } else if (event.type === "keyup") {
          spaceRef.current = false;
          setSpaceHeld(false);
        }
        return;
      }
      if (event.type !== "keydown" || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "+" || event.key === "=") zoomTo(current.current * STEP);
      else if (event.key === "-" || event.key === "_") zoomTo(current.current / STEP);
      else if (event.key === "0") zoomTo(ZOOM_MIN);
      else return;
      event.preventDefault();
    };
    const release = () => {
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    node.addEventListener("pointerdown", down, { capture: true });
    node.addEventListener("pointermove", move, { capture: true, passive: false });
    node.addEventListener("pointerup", up, { capture: true });
    node.addEventListener("pointercancel", up, { capture: true });
    // The whole stage, so ⌘/Ctrl-scroll over the zoom pill zooms the canvas, not the page.
    const stage = node.parentElement ?? node;
    stage.addEventListener("wheel", wheel, { passive: false });
    node.addEventListener("pointerenter", enter);
    node.addEventListener("pointerleave", leave);
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", key);
    window.addEventListener("blur", release);
    return () => {
      node.removeEventListener("pointerdown", down, { capture: true });
      node.removeEventListener("pointermove", move, { capture: true });
      node.removeEventListener("pointerup", up, { capture: true });
      node.removeEventListener("pointercancel", up, { capture: true });
      stage.removeEventListener("wheel", wheel);
      node.removeEventListener("pointerenter", enter);
      node.removeEventListener("pointerleave", leave);
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", key);
      window.removeEventListener("blur", release);
      node.classList.remove("is-panning");
      busy.current = false;
      release();
    };
    // zoomTo/anchorAt read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node, options.enabled]);

  return controls;
}
