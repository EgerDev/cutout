export type MaskSemantics = "logits" | "probabilities";

export type MaskTensor = {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
  sigmoid(): MaskTensor;
};

/** `cutout-original-matte-v1` consumes the model output as-is (the original engine never
 * applied a sigmoid); provenance records it as the one rendering. */
export type MatteRenderPolicy = "cutout-original-matte-v1";

export function smoothstep(min: number, max: number, value: number) {
  const x = Math.max(0, Math.min(1, (value - min) / (max - min)));
  return x * x * (3 - 2 * x);
}

/** No clamp here: the caller's Uint8ClampedArray store clamps, as the original's byte store did. */
export function matteByte(value: number, quality: "quality" | "fast"): number {
  return Math.round((quality === "quality" ? value : smoothstep(0.08, 0.92, value)) * 255);
}
