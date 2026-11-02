/** Brush sizes are a share of the image's short side: 0.2% is a few pixels on a phone photo. */
export const MIN_SIZE = 0.002;
export const MAX_SIZE = 0.3;

export function penStrokeSize(base: number, pointerType: string, pressure: number) {
  if (pointerType !== "pen") return base;
  const next = base * (pressure > 0 ? pressure : 0.5);
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, next));
}
