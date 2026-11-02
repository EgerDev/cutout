import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ZOOM_MAX, ZOOM_MIN, type useCanvasZoom } from "./use-canvas-zoom";

/** Floating − 100% + over the canvas; the percentage fits the view again. */
export function ZoomControls({
  zoom,
  zoomIn,
  zoomOut,
  fit,
}: Pick<ReturnType<typeof useCanvasZoom>, "zoom" | "zoomIn" | "zoomOut" | "fit">) {
  return (
    <div className="zoom-pill" role="group" aria-label="Zoom">
      <Button
        size="icon"
        aria-label="Zoom out"
        title="Zoom out (−)"
        disabled={zoom <= ZOOM_MIN}
        onClick={zoomOut}
      >
        <Minus className="size-4" />
      </Button>
      <button
        type="button"
        className="zoom-value"
        aria-label="Fit to view"
        title="Fit (0)"
        onClick={fit}
      >
        {zoom}%
      </button>
      <Button
        size="icon"
        aria-label="Zoom in"
        title="Zoom in (+)"
        disabled={zoom >= ZOOM_MAX}
        onClick={zoomIn}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
}
