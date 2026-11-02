export type DropPointerEvent = {
  target: unknown;
  relatedTarget: unknown;
  clientX: number;
  clientY: number;
};

export function isDragLeavingWindow(
  event: { relatedTarget: unknown; clientX: number; clientY: number },
  viewport: { width: number; height: number },
  isInside: (related: unknown) => boolean,
) {
  if (event.relatedTarget != null && isInside(event.relatedTarget)) return false;
  const x = event.clientX;
  const y = event.clientY;
  return x <= 0 || y <= 0 || x >= viewport.width || y >= viewport.height;
}

export function createDropSession() {
  let targets: unknown[] = [];
  let hasPointer = false;

  return {
    get active() {
      return targets.length > 0;
    },
    enter(target: unknown) {
      if (target != null) targets.push(target);
    },
    leave(
      event: DropPointerEvent,
      viewport: { width: number; height: number },
      isInside: (related: unknown) => boolean,
    ) {
      if (event.target != null) targets = targets.filter((node) => node !== event.target);
      if (targets.length > 0) return false;
      return isDragLeavingWindow(event, viewport, isInside);
    },
    reset() {
      targets = [];
      hasPointer = false;
    },
    acceptCoords(x: number, y: number) {
      if (!hasPointer && x === 0 && y === 0) return false;
      hasPointer = true;
      return true;
    },
  };
}
