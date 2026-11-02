import { cycleInspect, INSPECT_LABELS, INSPECT_MODES, type InspectMode } from "./model.ts";

export { cycleInspect, INSPECT_LABELS, INSPECT_MODES };
export type { InspectMode };

export function inspectFill(mode: InspectMode): string | null {
  if (mode === "white") return "#ffffff";
  if (mode === "black" || mode === "mask" || mode === "edge") return "#000000";
  return null;
}
