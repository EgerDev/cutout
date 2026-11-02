import type { BackgroundMode, ExportFormat } from "../formats.ts";

export type Point = Readonly<{ x: number; y: number }>;
export type Stroke = Readonly<{
  mode: "restore" | "erase";
  size: number;
  points: readonly Point[];
  hardness?: number;
  flow?: number;
  preserveDetails?: boolean;
}>;
export type Hint = Readonly<{
  kind: "keep" | "remove";
  size: number;
  points: readonly Point[];
  /**
   * Per point: the picked piece's share of the image. A point only acts on a piece of
   * about that size, so a removed speck that later merges into the subject can't take it.
   */
  areas?: readonly number[];
}>;
export type SubjectBox = Readonly<{ x: number; y: number; width: number; height: number }>;
/** Swap `from` for `to` in the cutout; `to: null` knocks the colour out. */
export type Recolor = Readonly<{ from: string; to: string | null }>;
export type Preset =
  | "original"
  | "trim"
  | "square"
  | "portrait"
  | "landscape"
  | "story"
  | "passport"
  | "product"
  | "profile"
  | "asset"
  | "amazon"
  | "etsy"
  | "ebay";
export const PRESETS: readonly { value: Preset; label: string }[] = [
  { value: "original", label: "Original size" },
  { value: "trim", label: "Trim to subject + padding" },
  { value: "square", label: "Square · 1:1" },
  { value: "portrait", label: "Portrait · 4:5" },
  { value: "landscape", label: "Landscape · 16:9" },
  { value: "story", label: "Story · 9:16" },
  { value: "passport", label: "Passport photo · 35×45 mm" },
  { value: "product", label: "Product · 1600 square" },
  { value: "profile", label: "Profile · 512 square" },
  { value: "asset", label: "Transparent asset · 1024 square" },
  { value: "amazon", label: "Amazon · 2000 square" },
  { value: "etsy", label: "Etsy · 2000 square" },
  { value: "ebay", label: "eBay · 1600 square" },
];
export type InspectMode = "composite" | "checker" | "white" | "black" | "overlay" | "mask" | "edge";
export const INSPECT_MODES: readonly InspectMode[] = [
  "composite",
  "checker",
  "white",
  "black",
  "overlay",
  "mask",
  "edge",
];
export const INSPECT_LABELS: Readonly<Record<InspectMode, string>> = {
  composite: "Composite",
  checker: "Transparency grid",
  white: "On white",
  black: "On black",
  overlay: "Red overlay",
  mask: "Grayscale mask",
  edge: "Edge band",
};
export type RemovalMode = "auto" | "quick" | "maximum";
export type DecontaminateMode = "off" | "auto" | "manual";
export type ShadowKind = "contact" | "cast";
export type EditSettings = Readonly<{
  exportFormat: ExportFormat;
  exportWidth: number | null;
  exportHeight: number | null;
  background: BackgroundMode;
  customColor: string;
  backgroundImageUrl: string | null;
  backgroundBlob: Blob | null;
  /** Blur radius for the blurred-original background, in px at a 1000 px canvas. */
  blurAmount: number;
  /** Blur less where the original is near the camera (Depth Anything on device). */
  blurDepth: boolean;
  /** Pixels kept around the subject by the trim preset. */
  trimPadding: number;
  stripMetadata: boolean;
  feather: number;
  choke: number;
  strokes: readonly Stroke[];
  hints: readonly Hint[];
  recolors: readonly Recolor[];
  /** RGB distance (0-255) within which a colour counts as `from`. */
  recolorTolerance: number;
  preset: Preset;
  padding: number;
  positionX: number;
  positionY: number;
  scale: number;
  rotate: number;
  flipX: boolean;
  shadow: boolean;
  shadowKind: ShadowKind;
  shadowOpacity: number;
  shadowSoftness: number;
  shadowDistance: number;
  shadowAngle: number;
  shadowSpread: number;
  shadowColor: string;
  shadowPerspective: number;
  shadowSilhouette: boolean;
  decontaminate: DecontaminateMode;
  decontaminateAmount: number;
  decontaminateWidth: number;
  decontaminateColor: string | null;
  matchBackground: boolean;
  matchStrength: number;
  quality: number;
  targetKB: number | null;
}>;
export const defaults: EditSettings = {
  exportFormat: "png",
  exportWidth: null,
  exportHeight: null,
  background: { type: "transparent" },
  customColor: "#f4f3ef",
  backgroundImageUrl: null,
  backgroundBlob: null,
  blurAmount: 28,
  blurDepth: false,
  trimPadding: 24,
  stripMetadata: false,
  feather: 0,
  choke: 0,
  strokes: [],
  hints: [],
  recolors: [],
  recolorTolerance: 24,
  preset: "original",
  padding: 10,
  positionX: 50,
  positionY: 50,
  scale: 100,
  rotate: 0,
  flipX: false,
  shadow: false,
  shadowKind: "contact",
  shadowOpacity: 25,
  shadowSoftness: 15,
  shadowDistance: 2,
  shadowAngle: 90,
  shadowSpread: 8,
  shadowColor: "#000000",
  shadowPerspective: 35,
  shadowSilhouette: true,
  decontaminate: "off",
  decontaminateAmount: 50,
  decontaminateWidth: 4,
  decontaminateColor: null,
  matchBackground: false,
  matchStrength: 50,
  quality: 92,
  targetKB: null,
};
export function backgroundPatch(settings: EditSettings, background: BackgroundMode) {
  return {
    background,
    exportFormat: background.type === "transparent" && settings.exportFormat === "jpeg"
      ? "png" as const : settings.exportFormat,
  };
}

export const FRAMING_KEYS = [
  "preset",
  "padding",
  "positionX",
  "positionY",
  "scale",
  "rotate",
  "flipX",
  "exportWidth",
  "exportHeight",
] as const satisfies readonly (keyof EditSettings)[];
export type SettingsMap = Readonly<Record<string, EditSettings>>;
export type HistoryEntry = Readonly<{ settings: SettingsMap; key: string; time: number }>;
const HISTORY_LABELS: Readonly<Record<string, string>> = {
  strokes: "Brush stroke",
  hints: "Subject mark",
  recolors: "Colour edit",
  recolorTolerance: "Colour tolerance",
  feather: "Feather",
  choke: "Expand / contract",
  background: "Background",
  customColor: "Background colour",
  "backgroundImageUrl,backgroundBlob,background": "Background image",
  blurAmount: "Blur amount",
  blurDepth: "Depth-aware blur",
  exportFormat: "Format",
  "exportWidth,exportHeight": "Export size",
  stripMetadata: "Strip metadata",
  padding: "Padding",
  trimPadding: "Trim padding",
  positionX: "Horizontal position",
  positionY: "Vertical position",
  scale: "Scale",
  rotate: "Rotate",
  flipX: "Flip",
  "scale,rotate,flipX": "Reset transform",
  shadow: "Shadow",
  shadowKind: "Shadow kind",
  shadowOpacity: "Shadow opacity",
  shadowSoftness: "Shadow softness",
  shadowDistance: "Shadow distance",
  shadowAngle: "Shadow direction",
  shadowSpread: "Shadow spread",
  shadowPerspective: "Shadow perspective",
  shadowSilhouette: "Shadow silhouette",
  decontaminate: "Edge colour",
  decontaminateAmount: "Edge colour amount",
  decontaminateWidth: "Edge width",
  decontaminateColor: "Edge colour sample",
  matchBackground: "Match background",
  matchStrength: "Match strength",
  quality: "Quality",
  targetKB: "Target file size",
  batch: "Batch settings",
  framing: "Match framing",
  "preset-batch": "Batch preset",
  redo: "Redo",
};
/** What a history entry changed, from its key (`item:group` or a batch name). */
export function historyLabel(key: string): string {
  const group = key.includes(":") ? key.slice(key.indexOf(":") + 1) : key;
  if (HISTORY_LABELS[group]) return HISTORY_LABELS[group]!;
  const keys = group.split(",");
  if (keys.includes("preset")) return "Preset";
  const first = keys[0] ?? group;
  return (
    HISTORY_LABELS[first] ?? first.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())
  );
}
export function recordHistory(
  history: readonly HistoryEntry[],
  settings: SettingsMap,
  key: string,
  time: number,
  coalesce = true,
): readonly HistoryEntry[] {
  const last = history.at(-1);
  if (coalesce && last?.key === key && time - last.time < 500)
    return [...history.slice(0, -1), { ...last, time }];
  const next = [...history.slice(-39), { settings, key, time }];
  // The newest entry stays even when it alone is over budget: dropping it leaves no undo at all.
  while (next.length > 1 && historyBytes(next.map((entry) => entry.settings)) > 64_000_000)
    next.shift();
  return next;
}
const ASPECTS: Partial<Record<Preset, number>> = {
  square: 1,
  portrait: 4 / 5,
  landscape: 16 / 9,
  story: 9 / 16,
};
/**
 * Canvas for an aspect preset: the source's longest side (512–2048 px) on the
 * preset's long edge, so a phone photo keeps its detail and a thumbnail stays
 * small; the subject is then fitted with padding like the fixed presets.
 */
export function aspectCanvas(
  preset: Preset,
  source?: { width: number; height: number },
): { width: number; height: number } | null {
  const aspect = ASPECTS[preset];
  if (!aspect) return null;
  const longest = Math.round(
    Math.min(2048, Math.max(512, Math.max(source?.width ?? 0, source?.height ?? 0) || 1600)),
  );
  return aspect >= 1
    ? { width: longest, height: Math.max(1, Math.round(longest / aspect)) }
    : { width: Math.max(1, Math.round(longest * aspect)), height: longest };
}
export function presetPatch(
  preset: Preset,
  source?: { width: number; height: number },
): Partial<EditSettings> {
  if (preset === "original")
    return { preset, exportWidth: null, exportHeight: null, scale: 100, rotate: 0, flipX: false };
  if (preset === "trim")
    return { preset, exportWidth: null, exportHeight: null, scale: 100, rotate: 0, flipX: false };
  const aspect = aspectCanvas(preset, source);
  if (aspect)
    return {
      preset,
      exportWidth: aspect.width,
      exportHeight: aspect.height,
      padding: 8,
      positionX: 50,
      positionY: 50,
      scale: 100,
      rotate: 0,
      flipX: false,
    };
  if (preset === "passport")
    // 35 x 45 mm at 300 dpi; head centred with room above, on plain white.
    return {
      preset,
      exportWidth: 413,
      exportHeight: 531,
      padding: 6,
      positionX: 50,
      positionY: 60,
      scale: 100,
      rotate: 0,
      flipX: false,
      background: { type: "color", color: "#ffffff" },
      exportFormat: "jpeg",
    };
  const size =
    preset === "profile"
      ? 512
      : preset === "asset"
        ? 1024
        : preset === "product" || preset === "ebay"
          ? 1600
          : 2000;
  const marketplace = preset === "amazon" || preset === "etsy" || preset === "ebay";
  return {
    preset,
    exportWidth: size,
    exportHeight: size,
    padding: preset === "profile" ? 16 : marketplace ? 8 : 10,
    positionX: 50,
    positionY: 50,
    scale: 100,
    rotate: 0,
    flipX: false,
    background:
      preset === "product" || marketplace
        ? { type: "color", color: "#ffffff" }
        : { type: "transparent" },
    exportFormat: "png",
  };
}
export function framingPatch(
  source: EditSettings,
): Pick<EditSettings, (typeof FRAMING_KEYS)[number]> {
  return {
    preset: source.preset,
    padding: source.padding,
    positionX: source.positionX,
    positionY: source.positionY,
    scale: source.scale,
    rotate: source.rotate,
    flipX: source.flipX,
    exportWidth: source.exportWidth,
    exportHeight: source.exportHeight,
  };
}
export function cycleInspect(mode: InspectMode): InspectMode {
  const index = INSPECT_MODES.indexOf(mode);
  return INSPECT_MODES[(index + 1) % INSPECT_MODES.length] ?? "composite";
}
export function identityTransform(settings: EditSettings) {
  return settings.scale === 100 && settings.rotate === 0 && !settings.flipX;
}
export type Rect = Readonly<{ x: number; y: number; width: number; height: number }>;
export function placement(
  bounds: Rect,
  width: number,
  height: number,
  settings: EditSettings,
): Rect {
  if (settings.preset === "original")
    return scaleRect({ x: 0, y: 0, width, height }, settings.scale);
  if (settings.preset === "trim") {
    const pad = trimPad(settings);
    return scaleRect(
      { x: pad, y: pad, width: bounds.width, height: bounds.height },
      settings.scale,
    );
  }
  const inset = (Math.min(width, height) * settings.padding) / 100;
  const scale = Math.min(
    (width - 2 * inset) / Math.max(1, bounds.width),
    (height - 2 * inset) / Math.max(1, bounds.height),
  );
  const w = bounds.width * scale,
    h = bounds.height * scale;
  const sized = {
    x: inset + ((width - 2 * inset - w) * settings.positionX) / 100,
    y: inset + ((height - 2 * inset - h) * settings.positionY) / 100,
    width: w,
    height: h,
  };
  return scaleRect(sized, settings.scale);
}
export function trimPad(settings: Pick<EditSettings, "trimPadding">) {
  return Math.max(0, Math.round(settings.trimPadding));
}
/** Output size of the trim preset: the subject's bounds plus padding on each side. */
export function trimCanvas(bounds: Rect, settings: Pick<EditSettings, "trimPadding">) {
  const pad = trimPad(settings);
  return { width: bounds.width + 2 * pad, height: bounds.height + 2 * pad };
}
export function scaleRect(rect: Rect, percent: number): Rect {
  const factor = percent / 100;
  if (factor === 1) return rect;
  const cx = rect.x + rect.width / 2,
    cy = rect.y + rect.height / 2;
  const width = rect.width * factor,
    height = rect.height * factor;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
}
export function uniqueNames(names: readonly string[], extension: string): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base =
      name
        .normalize("NFC")
        .replace(/\.[^.]*$/, "")
        .replace(/[^\p{L}\p{N}\p{M}_ -]/gu, "")
        .trim()
        .slice(0, 100) || "image";
    let candidate = `${base}-cutout.${extension}`,
      suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${base}-cutout-${suffix++}.${extension}`;
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function historyBytes(maps: readonly SettingsMap[]): number {
  const blobs = new Set<Blob>();
  for (const map of maps)
    for (const settings of Object.values(map))
      if (settings.backgroundBlob) blobs.add(settings.backgroundBlob);
  return [...blobs].reduce((total, blob) => total + blob.size, 0);
}
export function boundFuture(maps: readonly SettingsMap[]): readonly SettingsMap[] {
  const next = maps.slice(0, 40);
  while (next.length > 1 && historyBytes(next) > 64_000_000) next.pop();
  return next;
}
/**
 * Each distinct background converted once and the result shared, so items that shared one
 * background before a save share one Blob after resume: history and its byte budget count a
 * Blob once. A store can hand back one copy per item (WebKit's IndexedDB does), so blobs of
 * the same type and size are also compared by content. A failed conversion gives null.
 */
export async function shareBackgrounds<T>(
  blobs: readonly (Blob | null | undefined)[],
  convert: (blob: Blob) => Promise<T>,
): Promise<(T | null)[]> {
  const digests = new Map<Blob, Promise<string | null>>();
  const digest = (blob: Blob) => {
    let pending = digests.get(blob);
    if (!pending) {
      pending = globalThis.crypto?.subtle
        ? blob
            .arrayBuffer()
            .then((bytes) => crypto.subtle.digest("SHA-256", bytes))
            .then((hash) => Array.from(new Uint8Array(hash), (b) => b.toString(16)).join(","))
            .catch(() => null)
        : Promise.resolve(null);
      digests.set(blob, pending);
    }
    return pending;
  };
  const owners = new Map<Blob, Promise<T | null>>();
  const out: Promise<T | null>[] = [];
  for (const blob of blobs) {
    if (!blob) {
      out.push(Promise.resolve(null));
      continue;
    }
    let owner = owners.get(blob);
    for (const [seen, result] of owners) {
      if (owner) break;
      if (seen.size !== blob.size || seen.type !== blob.type) continue;
      const [a, b] = await Promise.all([digest(seen), digest(blob)]);
      if (a !== null && a === b) owner = result;
    }
    if (!owner) owners.set(blob, (owner = convert(blob).catch(() => null)));
    out.push(owner);
  }
  return Promise.all(out);
}
export function restoreSettings(settings: EditSettings): EditSettings {
  if (!settings.backgroundBlob)
    return {
      ...settings,
      backgroundImageUrl: null,
      background:
        settings.background.type === "image" ? { type: "transparent" } : settings.background,
    };
  const url = URL.createObjectURL(settings.backgroundBlob);
  return {
    ...settings,
    backgroundImageUrl: url,
    background: settings.background.type === "image" ? { type: "image", url } : settings.background,
  };
}
