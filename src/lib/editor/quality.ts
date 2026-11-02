import type { EditSettings } from "./model.ts";
import { identityTransform } from "./model.ts";
import { listComponents } from "../removal-diagnostics.ts";

export type QualityIssue = Readonly<{
  id: string;
  severity: "high" | "medium";
  message: string;
  control: "brush" | "feather" | "framing" | "format" | "size" | "subject";
}>;

const EDGE_MARGIN = 2;
const FOREGROUND = 8;

export function inspectQuality(input: {
  readonly alpha: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly settings: EditSettings;
  readonly encoded?: Readonly<{
    width: number;
    height: number;
    metTarget: boolean;
    reduced?: boolean;
  }>;
}): QualityIssue[] {
  const { alpha, width, height, settings } = input;
  const issues: QualityIssue[] = [];
  const pixels = width * height;
  if (width <= 0 || height <= 0 || alpha.length !== pixels) return issues;

  let opaque = 0,
    partial = 0,
    left = width,
    top = height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y += 1)
    for (let x = 0; x < width; x += 1) {
      const a = alpha[y * width + x] ?? 0;
      if (a <= FOREGROUND) continue;
      opaque += 1;
      if (a < 247) partial += 1;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }

  const fraction = opaque / pixels;
  if (fraction < 0.008) {
    issues.push({
      id: "empty",
      severity: "high",
      message: "The cutout looks empty. Choose a subject or restore with the brush.",
      control: "subject",
    });
    return issues;
  }

  if (right >= left) {
    if (
      left <= EDGE_MARGIN ||
      top <= EDGE_MARGIN ||
      right >= width - 1 - EDGE_MARGIN ||
      bottom >= height - 1 - EDGE_MARGIN
    )
      issues.push({
        id: "edge",
        severity: "medium",
        message: "The subject touches an output edge. Add padding or reposition it.",
        control: "framing",
      });
  }

  const components = listComponents(alpha, width, height, Math.max(1, Math.floor(pixels * 0.0004)));
  const islands = components.filter((component) => component.pixels < pixels * 0.0015);
  if (islands.length >= 2)
    issues.push({
      id: "islands",
      severity: "medium",
      message: "Small leftover specks remain. Erase them or contract the edge.",
      control: "brush",
    });

  const holes = enclosedHoles(alpha, width, height);
  if (holes > 0 && holes < pixels * 0.04)
    issues.push({
      id: "holes",
      severity: "medium",
      message:
        "There are transparent holes inside the subject. Restore them if they are accidental.",
      control: "brush",
    });

  if (partial / Math.max(1, opaque) > 0.22 && settings.feather >= 8)
    issues.push({
      id: "feather",
      severity: "medium",
      message: "Feathering is large relative to the subject and may look soft or haloed.",
      control: "feather",
    });

  if (Math.abs(settings.choke) >= 8)
    issues.push({
      id: "choke",
      severity: "medium",
      message: "Expand/contract is extreme and can clip detail or leave a fringe.",
      control: "feather",
    });

  const outW = settings.exportWidth ?? input.sourceWidth;
  const outH = settings.exportHeight ?? input.sourceHeight;
  if (outW > input.sourceWidth * 1.02 || outH > input.sourceHeight * 1.02)
    issues.push({
      id: "upscale",
      severity: "medium",
      message: "Export size is larger than the source and will upsample the cutout.",
      control: "size",
    });

  if (input.encoded && !input.encoded.metTarget)
    issues.push({
      id: "size-target",
      severity: "high",
      message: "The file-size target could not be met. Raise it before downloading.",
      control: "size",
    });
  else if (input.encoded?.reduced)
    issues.push({
      id: "size-target",
      severity: "medium",
      message: "Meeting the file-size target reduced quality or dimensions.",
      control: "size",
    });

  if (settings.exportFormat === "jpeg" && settings.background.type === "transparent")
    issues.push({
      id: "format",
      severity: "medium",
      message: "JPEG cannot keep transparency. Use PNG or add a background.",
      control: "format",
    });

  if (
    settings.exportFormat === "png" &&
    settings.background.type === "transparent" &&
    fraction > 0.992
  )
    issues.push({
      id: "format",
      severity: "medium",
      message: "This PNG has almost no transparent pixels.",
      control: "format",
    });

  if (!identityTransform(settings) && settings.preset === "original" && settings.scale > 100)
    issues.push({
      id: "clip",
      severity: "medium",
      message: "The scaled subject may clip the frame. Switch to a preset or lower scale.",
      control: "framing",
    });

  return issues;
}

function enclosedHoles(alpha: Uint8Array, width: number, height: number) {
  const seen = new Uint8Array(alpha.length);
  const queue = new Int32Array(alpha.length);
  let head = 0,
    tail = 0;
  const push = (index: number) => {
    if (seen[index] || (alpha[index] ?? 0) > FOREGROUND) return;
    seen[index] = 1;
    queue[tail] = index;
    tail += 1;
  };
  for (let x = 0; x < width; x += 1) {
    push(x);
    push((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    push(y * width);
    push(y * width + width - 1);
  }
  while (head < tail) {
    const index = queue[head] ?? 0;
    head += 1;
    const x = index % width,
      y = Math.floor(index / width);
    if (x > 0) push(index - 1);
    if (x + 1 < width) push(index + 1);
    if (y > 0) push(index - width);
    if (y + 1 < height) push(index + width);
  }
  let holes = 0;
  for (let i = 0; i < alpha.length; i += 1)
    if (!seen[i] && (alpha[i] ?? 0) <= FOREGROUND) holes += 1;
  return holes;
}
