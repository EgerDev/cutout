import { bmpSize, gifSize } from "./decode-bitmap.ts";
import { concat } from "./heif-mux.ts";
import { CutoutError } from "./errors.ts";

async function guardTiffBytes(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  if (
    (head[0] === 0x49 && head[1] === 0x49 && (head[2] === 42 || head[2] === 43) && head[3] === 0) ||
    (head[0] === 0x4d && head[1] === 0x4d && head[2] === 0 && (head[3] === 42 || head[3] === 43))
  ) {
    const { assertTiffFileSize } = await import("./tiff.ts");
    assertTiffFileSize(blob.size);
  }
}

export type MetadataGroup = "camera" | "location" | "other" | "provenance";

export type MetadataField = {
  label: string;
  value: string;
  group: MetadataGroup;
};

export type AiDetectionResult = {
  isAi: boolean;
  confidence: "high" | "medium" | "low";
  generator?: string;
  prompt?: string;
  negativePrompt?: string;
  model?: string;
  seed?: string;
  steps?: string;
  sampler?: string;
  cfgScale?: string;
  aspectRatio?: string;
  rawParameters?: string;
  c2pa?: boolean;
  evidence: string[];
};

export type CameraSpecs = {
  make?: string;
  model?: string;
  lens?: string;
  fNumber?: string;
  exposureTime?: string;
  iso?: string;
  focalLength?: string;
  focalLength35mm?: string;
  flash?: string;
  whiteBalance?: string;
  exposureProgram?: string;
  exposureBias?: string;
  exposureMode?: string;
  metering?: string;
  scene?: string;
  dateTaken?: string;
};

export type GpsLocation = {
  latitude: number;
  longitude: number;
  altitude?: number;
  formattedLat: string;
  formattedLng: string;
  mapsUrl: string;
};

export type RawMetadataTag = {
  id: string;
  namespace:
    | "EXIF"
    | "IPTC"
    | "XMP"
    | "PNG"
    | "JFIF"
    | "ICC"
    | "File"
    | "Photoshop"
    | "MakerNotes"
    | "MPF"
    | "Composite"
    | "RIFF"
    | "GIF"
    | "Other";
  tag: string;
  label: string;
  value: string;
};

export type MetadataReport = {
  extras: boolean;
  fields: MetadataField[];
  hash?: string;
  fileType?: string;
  mimeType?: string;
  fileSize?: number;
  modified?: string;
  colorType?: string;
  bitDepth?: string;
  alpha?: string;
  resolutionDpi?: string;
  colorSpace?: string;
  iccProfile?: string;
  subsampling?: string;
  compression?: string;
  interlace?: string;
  filter?: string;
  channels?: string;
  gamma?: string;
  renderingIntent?: string;
  orientation?: string;
  software?: string;
  copyright?: string;
  artist?: string;
  description?: string;
  comment?: string;
  created?: string;
  ai?: AiDetectionResult;
  camera?: CameraSpecs;
  gps?: GpsLocation;
  allTags: RawMetadataTag[];
};

const CHEAP_BYTES = 8 * 1024 * 1024;

const FIELD_LABELS: Record<string, string> = {
  Make: "Make",
  Model: "Model",
  DateTimeOriginal: "Date",
  DateTime: "Date",
  DateTimeDigitized: "Date digitized",
  CreateDate: "Date",
  DateCreated: "Date",
  OffsetTimeOriginal: "Time zone",
  LensModel: "Lens",
  LensMake: "Lens make",
  GPSLatitude: "Latitude",
  GPSLongitude: "Longitude",
  GPSAltitude: "Altitude",
  GPSDateStamp: "GPS date",
  GPSImgDirection: "Direction",
  Software: "Software",
  ProcessingSoftware: "Software",
  CreatorTool: "Software",
  Artist: "Artist",
  Copyright: "Copyright",
  ImageDescription: "Description",
  UserComment: "Comment",
  "Caption/Abstract": "Caption",
  Credit: "Credit",
  Source: "Source",
  Orientation: "Orientation",
  ColorSpace: "Color space",
  ISOSpeedRatings: "ISO",
  ISOSpeed: "ISO",
  PhotographicSensitivity: "ISO",
  ExposureTime: "Exposure",
  FNumber: "F-number",
  FocalLength: "Focal length",
  FocalLengthIn35mmFilm: "Focal length (35mm)",
  ExposureProgram: "Exposure program",
  ExposureBiasValue: "Exposure bias",
  ExposureMode: "Exposure mode",
  Flash: "Flash",
  WhiteBalance: "White balance",
  MeteringMode: "Metering",
  SceneCaptureType: "Scene",
  Subsampling: "Subsampling",
  "Bits Per Sample": "Bit depth",
  "Image Width": "Image width",
  "Image Height": "Image height",
  "Color Components": "Color components",
  "JFIF Version": "JFIF version",
  "Resolution Unit": "Resolution unit",
  XResolution: "X resolution",
  YResolution: "Y resolution",
  Compression: "Compression",
  Interlace: "Interlace",
  Filter: "Filter",
  "Color Type": "Color type",
  Comment: "Comment",
  Keywords: "Keywords",
  Headline: "Headline",
  ObjectName: "Title",
  "By-line": "Artist",
  "Pixels Per Unit X": "Pixels per unit X",
  "Pixels Per Unit Y": "Pixels per unit Y",
  "Pixel Units": "Pixel units",
  "Bit Depth": "Bit depth",
};

const INTERESTING = [
  "Make",
  "Model",
  "DateTimeOriginal",
  "DateTime",
  "CreateDate",
  "DateCreated",
  "LensModel",
  "LensMake",
  "GPSDateStamp",
  "GPSImgDirection",
  "Software",
  "ProcessingSoftware",
  "CreatorTool",
  "Artist",
  "Copyright",
  "ImageDescription",
  "UserComment",
  "Caption/Abstract",
  "Credit",
  "Source",
  "Orientation",
  "ColorSpace",
  "ISOSpeedRatings",
  "ISOSpeed",
  "PhotographicSensitivity",
  "ExposureTime",
  "FNumber",
  "FocalLength",
  "FocalLengthIn35mmFilm",
  "ExposureProgram",
  "ExposureBiasValue",
  "ExposureMode",
  "Flash",
  "WhiteBalance",
  "MeteringMode",
  "SceneCaptureType",
  "Subsampling",
  "JFIF Version",
  "Resolution Unit",
  "XResolution",
  "YResolution",
  "Compression",
  "Interlace",
  "Filter",
  "Color Type",
  "Comment",
  "Keywords",
  "Headline",
  "ObjectName",
  "By-line",
] as const;

type TagLike = { description?: unknown; value?: unknown } | undefined;

type ExpandedLike = {
  file?: Record<string, TagLike>;
  jfif?: Record<string, TagLike>;
  pngFile?: Record<string, TagLike>;
  pngText?: Record<string, TagLike>;
  png?: Record<string, TagLike>;
  exif?: Record<string, TagLike>;
  iptc?: Record<string, TagLike>;
  xmp?: Record<string, unknown> & { _raw?: string };
  icc?: Record<string, TagLike>;
  riff?: Record<string, TagLike>;
  gif?: Record<string, TagLike>;
  photoshop?: Record<string, TagLike>;
  makerNotes?: Record<string, TagLike>;
  mpf?: Record<string, TagLike>;
  composite?: Record<string, TagLike>;
  gps?: { Latitude?: number; Longitude?: number; Altitude?: number };
};

export async function inspectImageMetadata(file: Blob): Promise<MetadataReport> {
  try {
    await guardTiffBytes(file);
    const ExifReader = (await import("exifreader")).default;
    const cheap = file.size <= CHEAP_BYTES;
    let buffer: ArrayBuffer | undefined;
    let tags: ExpandedLike;

    const loadOpts = { expanded: true, includeUnknown: true } as const;
    if (cheap) {
      buffer = await file.arrayBuffer();
      tags = ExifReader.load(buffer, loadOpts) as ExpandedLike;
    } else if (typeof File !== "undefined" && file instanceof File) {
      tags = (await ExifReader.load(file, loadOpts)) as ExpandedLike;
    } else {
      buffer = await file.arrayBuffer();
      tags = ExifReader.load(buffer, loadOpts) as ExpandedLike;
    }

    const flat = flattenTags(tags);
    const blobs = collectStrings([
      tags.xmp,
      tags.pngText,
      tags.exif,
      tags.iptc,
      tags.photoshop,
      flat,
    ]);
    if (tags.xmp?._raw) blobs.push(tags.xmp._raw);
    const haystack = blobs.join("\n");

    const fields: MetadataField[] = [];
    const seen = new Set<string>();
    const push = (label: string, value: string, group: MetadataGroup) => {
      const next = value.trim();
      if (!next || seen.has(label)) return;
      seen.add(label);
      fields.push({ label, value: next, group });
    };

    addGpsFields(tags, flat, push);

    for (const key of INTERESTING) {
      const raw = readTagValue(flat[key]);
      if (!raw) continue;
      const label = FIELD_LABELS[key] ?? humanLabel(key);
      push(label, formatField(key, raw), groupFor(key));
    }

    addProvenance(tags, flat, buffer, haystack, push);

    const hash = buffer && cheap ? await sha256Hex(buffer) : undefined;
    const headBuf = buffer ?? (await file.slice(0, Math.min(file.size, 262_144)).arrayBuffer());
    const headBytes = new Uint8Array(headBuf);
    const header = inspectHeader(headBuf, file);
    const pngExtra = inspectPngAncillary(headBytes);
    const jpegComment = inspectJpegComment(headBytes);
    const fileType = header.fileType || readTagValue(tags.file?.FileType) || undefined;

    const allTags = mergeTags(extractAllTags(tags), pngExtra.tags, jpegComment.tags);
    const ai = detectAiGeneration(tags, flat, haystack, buffer);
    const camera = extractCameraSpecs(flat);
    const gps = extractGpsLocation(tags, flat);
    const resolutionDpi = extractResolutionDpi(flat, tags) || pngExtra.resolutionDpi;
    const colorInfo = extractColorInfo(flat, tags);
    const compression =
      readTagValue(flat.Compression) || header.compression || pngExtra.compression;
    for (const field of pngExtra.fields) push(field.label, field.value, field.group);
    if (jpegComment.comment) push("Comment", jpegComment.comment, "other");

    const created =
      readTagValue(flat.DateTimeOriginal) ||
      readTagValue(flat.CreateDate) ||
      readTagValue(flat.DateCreated) ||
      pngExtra.modified;
    const software =
      readTagValue(flat.Software) ||
      readTagValue(flat.ProcessingSoftware) ||
      readTagValue(flat.CreatorTool);
    const mimeType =
      (typeof File !== "undefined" && file instanceof File && file.type) || file.type || undefined;
    const modified =
      typeof File !== "undefined" && file instanceof File && file.lastModified
        ? new Date(file.lastModified).toISOString()
        : pngExtra.modified;

    return {
      extras: fields.length > 0 || allTags.length > 0 || ai.isAi,
      fields,
      hash,
      fileType,
      mimeType: mimeType || undefined,
      fileSize: file.size,
      modified,
      colorType: readTagValue(flat["Color Type"]) || header.colorType || colorInfo.colorSpace,
      bitDepth:
        header.bitDepth ||
        readTagValue(tags.file?.["Bits Per Sample"]) ||
        readTagValue(flat["Bit Depth"]) ||
        undefined,
      alpha: header.alpha,
      resolutionDpi,
      colorSpace: colorInfo.colorSpace,
      iccProfile: colorInfo.iccProfile || pngExtra.iccProfile,
      subsampling: colorInfo.subsampling,
      compression,
      interlace: readTagValue(flat.Interlace) || header.interlace || pngExtra.interlace,
      filter: readTagValue(flat.Filter) || header.filter,
      channels: readTagValue(tags.file?.["Color Components"]) || header.channels,
      gamma: pngExtra.gamma,
      renderingIntent: pngExtra.renderingIntent,
      orientation: readTagValue(flat.Orientation) || undefined,
      software: software || undefined,
      copyright: readTagValue(flat.Copyright) || undefined,
      artist: readTagValue(flat.Artist) || readTagValue(flat["By-line"]) || undefined,
      description:
        readTagValue(flat.ImageDescription) || readTagValue(flat["Caption/Abstract"]) || undefined,
      comment: readTagValue(flat.UserComment) || readTagValue(flat.Comment) || jpegComment.comment,
      created: created ? formatExifDate(created) : undefined,
      ai,
      camera,
      gps,
      allTags,
    };
  } catch {
    return { extras: false, fields: [], fileSize: file.size, allTags: [] };
  }
}

function inspectHeader(buffer: ArrayBuffer, file: Blob) {
  const bytes = new Uint8Array(buffer);
  const name = file instanceof File ? file.name : "";
  const type = file.type;
  if (bytes.length >= 29 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const bit = bytes[24] ?? 8;
    const color = bytes[25] ?? 6;
    const labels = ["Gray", "Unknown", "RGB", "Indexed", "Gray+alpha", "Unknown", "RGB+alpha"];
    const channels = [1, 0, 3, 1, 2, 0, 4][color] ?? undefined;
    return {
      fileType: "PNG",
      bitDepth: `${bit}-bit`,
      colorType: labels[color] ?? "PNG",
      alpha: color === 4 || color === 6 ? "Yes" : "No",
      compression: bytes[26] === 0 ? "Deflate" : undefined,
      filter: bytes[27] === 0 ? "Adaptive" : undefined,
      interlace: bytes[28] === 1 ? "Adam7" : bytes[28] === 0 ? "None" : undefined,
      channels: channels ? String(channels) : undefined,
    };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    const sof = jpegSof(bytes);
    return {
      fileType: "JPEG",
      bitDepth: sof?.precision ? `${sof.precision}-bit` : "8-bit",
      colorType: sof?.components === 1 ? "Grayscale" : sof?.components === 4 ? "CMYK" : "YCbCr",
      alpha: "No",
      channels: sof?.components ? String(sof.components) : "3",
      compression: "JPEG",
    };
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    return {
      fileType: "WebP",
      bitDepth: "8-bit",
      colorType: "RGB",
      alpha: "Maybe",
      compression: "WebP",
    };
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    const brand = String.fromCharCode(
      bytes[8] ?? 0,
      bytes[9] ?? 0,
      bytes[10] ?? 0,
      bytes[11] ?? 0,
    ).toLowerCase();
    if (brand === "avif" || brand === "avis") {
      return { fileType: "AVIF", bitDepth: "—", colorType: "YUV", alpha: "—" };
    }
    if (/heic|heix|heif|hevc|hevx|heim|heis|mif1|msf1/.test(brand)) {
      return { fileType: "HEIC", bitDepth: "—", colorType: "YUV", alpha: "—" };
    }
  }
  if (/heic|heif|hif/i.test(type) || /\.(heic|heif|heics|hif)$/i.test(name)) {
    return { fileType: "HEIC", bitDepth: "—", colorType: "YUV", alpha: "—" };
  }
  if (/avif/i.test(type) || /\.avif$/i.test(name)) {
    return { fileType: "AVIF", bitDepth: "—", colorType: "YUV", alpha: "—" };
  }
  return {
    fileType: type.split("/")[1]?.toUpperCase(),
    bitDepth: undefined,
    colorType: undefined,
    alpha: undefined,
  };
}

function inspectPngAncillary(bytes: Uint8Array): {
  tags: RawMetadataTag[];
  fields: MetadataField[];
  gamma?: string;
  renderingIntent?: string;
  iccProfile?: string;
  interlace?: string;
  compression?: string;
  resolutionDpi?: string;
  modified?: string;
} {
  const empty = { tags: [] as RawMetadataTag[], fields: [] as MetadataField[] };
  if (bytes.length < 29 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return empty;
  const tags: RawMetadataTag[] = [];
  const fields: MetadataField[] = [];
  const push = (tag: string, label: string, value: string) => {
    if (!value) return;
    tags.push({ id: `PNG:${tag}`, namespace: "PNG", tag, label, value });
    fields.push({ label, value, group: "other" });
  };
  let offset = 8;
  const intents = ["Perceptual", "Relative colorimetric", "Saturation", "Absolute colorimetric"];
  let gamma: string | undefined;
  let renderingIntent: string | undefined;
  let iccProfile: string | undefined;
  let modified: string | undefined;
  let resolutionDpi: string | undefined;
  while (offset + 12 <= bytes.length) {
    const len =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        (bytes[offset + 3] ?? 0)) >>>
      0;
    if (offset + 12 + len > bytes.length) break;
    const type = String.fromCharCode(
      bytes[offset + 4] ?? 0,
      bytes[offset + 5] ?? 0,
      bytes[offset + 6] ?? 0,
      bytes[offset + 7] ?? 0,
    );
    const data = bytes.subarray(offset + 8, offset + 8 + len);
    if (type === "gAMA" && len === 4) {
      const raw = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | (data[3] ?? 0)) >>> 0;
      if (raw > 0) {
        gamma = (100000 / raw).toFixed(3);
        push("Gamma", "Gamma", gamma);
      }
    } else if (type === "sRGB" && len >= 1) {
      renderingIntent = intents[data[0] ?? 9] ?? `Intent ${data[0]}`;
      push("sRGB", "Rendering intent", renderingIntent);
    } else if (type === "iCCP" && len > 2) {
      let end = 0;
      while (end < data.length && data[end] !== 0) end += 1;
      iccProfile = new TextDecoder("latin1").decode(data.subarray(0, end)) || "ICC profile";
      push("iCCP", "ICC profile", iccProfile);
    } else if (type === "tIME" && len === 7) {
      const y = (data[0] << 8) | (data[1] ?? 0);
      modified = `${y}-${String(data[2]).padStart(2, "0")}-${String(data[3]).padStart(2, "0")} ${String(data[4]).padStart(2, "0")}:${String(data[5]).padStart(2, "0")}:${String(data[6]).padStart(2, "0")}`;
      push("tIME", "Modified", modified);
    } else if (type === "acTL" && len >= 4) {
      const frames = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | (data[3] ?? 0)) >>> 0;
      push("acTL", "Animation frames", String(frames));
    } else if (type === "pHYs" && len === 9 && data[8] === 1) {
      const ppm = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | (data[3] ?? 0)) >>> 0;
      if (ppm > 0) resolutionDpi = `${Math.round(ppm * 0.0254)} DPI`;
    } else if (type === "bKGD") {
      push("bKGD", "Background color", "Present");
    } else if (type === "tRNS") {
      push("tRNS", "Transparency chunk", "Present");
    } else if (type === "sBIT") {
      push("sBIT", "Significant bits", Array.from(data).join(", "));
    }
    if (type === "IEND") break;
    offset += 12 + len;
  }
  return { tags, fields, gamma, renderingIntent, iccProfile, resolutionDpi, modified };
}

function inspectJpegComment(bytes: Uint8Array): { comment?: string; tags: RawMetadataTag[] } {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return { tags: [] };
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) break;
    const len = (bytes[offset] << 8) | (bytes[offset + 1] ?? 0);
    if (len < 2 || offset + len > bytes.length) break;
    if (marker === 0xfe) {
      const text = new TextDecoder("utf-8", { fatal: false })
        .decode(bytes.subarray(offset + 2, offset + len))
        .replace(/\0+$/, "")
        .trim();
      if (text)
        return {
          comment: text,
          tags: [
            {
              id: "File:Comment",
              namespace: "File",
              tag: "Comment",
              label: "Comment",
              value: text,
            },
          ],
        };
    }
    offset += len;
  }
  return { tags: [] };
}

function jpegSof(bytes: Uint8Array): { precision?: number; components?: number } | undefined {
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++] ?? 0;
    if (marker === 0xda || marker === 0xd9) break;
    if (offset + 2 > bytes.length) break;
    const len = (bytes[offset] << 8) | (bytes[offset + 1] ?? 0);
    if (len < 2 || offset + len > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { precision: bytes[offset + 2], components: bytes[offset + 7] };
    }
    offset += len;
  }
  return undefined;
}

function mergeTags(...lists: RawMetadataTag[][]): RawMetadataTag[] {
  const seen = new Set<string>();
  const out: RawMetadataTag[] = [];
  for (const list of lists) {
    for (const tag of list) {
      const key = `${tag.namespace}:${tag.tag}`;
      if (seen.has(key) || seen.has(tag.id)) continue;
      seen.add(key);
      seen.add(tag.id);
      out.push(tag);
    }
  }
  return out;
}

function flattenTags(tags: ExpandedLike) {
  const flat: Record<string, TagLike> = {};
  const buckets = [
    tags.exif,
    tags.iptc,
    tags.xmp,
    tags.png,
    tags.pngText,
    tags.icc,
    tags.file,
    tags.jfif,
    tags.gif,
    tags.riff,
    tags.photoshop,
  ];
  for (const bucket of buckets) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [key, value] of Object.entries(bucket)) {
      if (key === "_raw" || key === "Thumbnail" || /IFD Pointer$/i.test(key)) continue;
      if (flat[key] || !value || typeof value !== "object") continue;
      flat[key] = value as TagLike;
    }
  }
  return flat;
}

function extractAllTags(tags: ExpandedLike): RawMetadataTag[] {
  const buckets: Array<{
    name: RawMetadataTag["namespace"];
    obj: Record<string, TagLike> | undefined;
  }> = [
    { name: "EXIF", obj: tags.exif },
    { name: "IPTC", obj: tags.iptc },
    { name: "XMP", obj: tags.xmp as Record<string, TagLike> | undefined },
    {
      name: "PNG",
      obj: tags.pngText ? { ...tags.png, ...tags.pngText } : tags.png || tags.pngFile,
    },
    { name: "JFIF", obj: tags.jfif },
    { name: "ICC", obj: tags.icc },
    { name: "File", obj: tags.file },
    { name: "Photoshop", obj: tags.photoshop },
    { name: "MakerNotes", obj: tags.makerNotes },
    { name: "MPF", obj: tags.mpf },
    { name: "Composite", obj: tags.composite },
    { name: "RIFF", obj: tags.riff },
    { name: "GIF", obj: tags.gif },
  ];

  const result: RawMetadataTag[] = [];
  const seen = new Set<string>();

  for (const { name, obj } of buckets) {
    if (!obj || typeof obj !== "object") continue;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "_raw" || k === "Thumbnail" || /IFD Pointer$/i.test(k)) continue;
      const keyId = `${name}:${k}`;
      if (seen.has(keyId)) continue;
      seen.add(keyId);

      const val =
        v?.description != null
          ? stringifyUnknown(v.description)
          : v?.value != null
            ? stringifyUnknown(v.value)
            : "";
      if (!val || val === "undefined" || val === "[object Object]") continue;
      if (val.length > 4000 && /MakerNote|Thumbnail|ICC|Profile/i.test(k)) continue;

      result.push({
        id: keyId,
        namespace: name,
        tag: k,
        label: FIELD_LABELS[k] ?? humanLabel(k),
        value: val,
      });
    }
  }

  return result;
}

function extractResolutionDpi(
  flat: Record<string, TagLike>,
  tags: ExpandedLike,
): string | undefined {
  const jUnit = readTagValue(tags.jfif?.["Resolution Unit"]);
  const jX = readTagValue(tags.jfif?.XResolution);
  if (jX && jX !== "0" && jX !== "1") {
    if (/inch/i.test(jUnit) || jUnit === "1" || !jUnit || jUnit === "None") return `${jX} DPI`;
    if (/cm|centimeter/i.test(jUnit) || jUnit === "2") {
      const dpi = Math.round(Number(jX) * 2.54);
      return `${dpi} DPI (${jX} dpcm)`;
    }
  }

  const eX = readTagValue(flat.XResolution);
  const eUnit = readTagValue(flat.ResolutionUnit);
  if (eX && eX !== "0" && eX !== "1") {
    if (/cm/i.test(eUnit) || eUnit === "3") {
      const dpi = Math.round(Number(eX) * 2.54);
      return `${dpi} DPI`;
    }
    return `${eX} DPI`;
  }

  const pngX = readTagValue(flat["Pixels Per Unit X"]);
  const pngUnit = readTagValue(flat["Unit Specifier"]);
  if (pngX && pngUnit) {
    if (/meter/i.test(pngUnit)) {
      const dpi = Math.round(Number(pngX) * 0.0254);
      return `${dpi} DPI`;
    }
  }

  return undefined;
}

function extractColorInfo(flat: Record<string, TagLike>, tags: ExpandedLike) {
  const iccDesc =
    readTagValue(tags.icc?.["Profile Description"]) || readTagValue(tags.icc?.ProfileDescription);
  const exifColor = readTagValue(flat.ColorSpace);
  const subsampling = readTagValue(tags.file?.Subsampling);

  let colorSpace = iccDesc || exifColor;
  if (!colorSpace && flat["Color Type"]) {
    colorSpace = readTagValue(flat["Color Type"]);
  }

  return {
    colorSpace: colorSpace || undefined,
    iccProfile: iccDesc || undefined,
    subsampling: subsampling || undefined,
  };
}

function extractCameraSpecs(flat: Record<string, TagLike>): CameraSpecs | undefined {
  const make = readTagValue(flat.Make);
  const model = readTagValue(flat.Model);
  const lens = readTagValue(flat.LensModel) || readTagValue(flat.LensMake);
  const exposureTime = readTagValue(flat.ExposureTime);
  const fNumber = readTagValue(flat.FNumber);
  const iso =
    readTagValue(flat.ISOSpeedRatings) ||
    readTagValue(flat.ISOSpeed) ||
    readTagValue(flat.PhotographicSensitivity);
  const focalLength = readTagValue(flat.FocalLength);
  const focalLength35mm = readTagValue(flat.FocalLengthIn35mmFilm);
  const flash = readTagValue(flat.Flash);
  const whiteBalance = readTagValue(flat.WhiteBalance);
  const exposureProgram = readTagValue(flat.ExposureProgram);
  const exposureBias = readTagValue(flat.ExposureBiasValue);
  const exposureMode = readTagValue(flat.ExposureMode);
  const metering = readTagValue(flat.MeteringMode);
  const scene = readTagValue(flat.SceneCaptureType);
  const dateTaken = readTagValue(flat.DateTimeOriginal) || readTagValue(flat.DateTime);

  if (!make && !model && !lens && !exposureTime && !fNumber && !iso) {
    return undefined;
  }

  return {
    make: make || undefined,
    model: model || undefined,
    lens: lens || undefined,
    fNumber: fNumber ? formatFNumber(fNumber) : undefined,
    exposureTime: exposureTime ? formatExposure(exposureTime) : undefined,
    iso: iso ? `ISO ${iso}` : undefined,
    focalLength: focalLength
      ? focalLength.includes("mm")
        ? focalLength
        : `${focalLength} mm`
      : undefined,
    focalLength35mm: focalLength35mm ? `${focalLength35mm} mm (35mm equiv)` : undefined,
    flash: flash || undefined,
    whiteBalance: whiteBalance || undefined,
    exposureProgram: exposureProgram || undefined,
    exposureBias: exposureBias || undefined,
    exposureMode: exposureMode || undefined,
    metering: metering || undefined,
    scene: scene || undefined,
    dateTaken: dateTaken ? formatExifDate(dateTaken) : undefined,
  };
}

function extractGpsLocation(
  tags: ExpandedLike,
  flat: Record<string, TagLike>,
): GpsLocation | undefined {
  const latitude = signedCoordinate(
    tags.gps?.Latitude,
    flat.GPSLatitude,
    flat.GPSLatitudeRef,
    true,
  );
  const longitude = signedCoordinate(
    tags.gps?.Longitude,
    flat.GPSLongitude,
    flat.GPSLongitudeRef,
    false,
  );
  if (latitude == null || longitude == null) return undefined;

  const altitude =
    typeof tags.gps?.Altitude === "number" ? tags.gps.Altitude : altitudeFromTags(flat);
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;

  return {
    latitude,
    longitude,
    altitude: altitude ?? undefined,
    formattedLat: formatCoordinate(latitude, true),
    formattedLng: formatCoordinate(longitude, false),
    mapsUrl,
  };
}

/** Generator metadata is attacker-controlled JSON: keep strings and finite numbers (as
 *  text) and drop everything else, so an object can never reach React as a child. */
const asText = (value: unknown) =>
  typeof value === "string"
    ? value
    : typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : undefined;

export function detectAiGeneration(
  tags: ExpandedLike,
  flat: Record<string, TagLike>,
  haystack: string,
  buffer?: ArrayBuffer,
): AiDetectionResult {
  const evidence: string[] = [];
  let isAi = false;
  let confidence: "high" | "medium" | "low" = "low";
  let generator: string | undefined;
  let prompt: string | undefined;
  let negativePrompt: string | undefined;
  let model: string | undefined;
  let seed: string | undefined;
  let steps: string | undefined;
  let sampler: string | undefined;
  let cfgScale: string | undefined;
  let aspectRatio: string | undefined;
  let rawParameters: string | undefined;

  const c2paPresent = hasC2pa(haystack, buffer);

  // 1. Check Stable Diffusion / WebUI / Forge / Fooocus / InvokeAI parameters
  const candidateParams = [
    tags.pngText?.parameters,
    tags.pngText?.Parameters,
    flat.parameters,
    tags.exif?.UserComment,
    flat.UserComment,
    flat.ImageDescription,
    tags.pngText?.Description,
    tags.pngText?.Comment,
  ];

  for (const candidate of candidateParams) {
    const text = readTagValue(candidate);
    if (!text || typeof text !== "string") continue;

    if (
      /Steps:\s*\d+/i.test(text) &&
      (/Sampler:\s*[^,]+/i.test(text) || /CFG scale:\s*[\d.]+/i.test(text))
    ) {
      isAi = true;
      confidence = "high";
      generator = generator || (text.includes("Fooocus") ? "Fooocus" : "Stable Diffusion");
      rawParameters = text;
      evidence.push("Found Stable Diffusion generation parameters chunk");

      const negMatch = text.match(/(?:^|\n)Negative prompt:\s*([\s\S]*?)(?=\n(?:Steps|Maker):|$)/i);
      if (negMatch) negativePrompt = negMatch[1].trim();

      const stepsIdx = text.search(/(?:^|\n)Steps:\s*\d+/i);
      if (stepsIdx !== -1) {
        const beforeSteps = text.slice(0, stepsIdx);
        const negIdx = beforeSteps.search(/(?:^|\n)Negative prompt:/i);
        prompt = (negIdx !== -1 ? beforeSteps.slice(0, negIdx) : beforeSteps).trim();

        const paramsText = text.slice(stepsIdx).trim();
        for (const pair of paramsText.split(/,\s*(?=[A-Za-z0-9 _-]+:)/)) {
          const colon = pair.indexOf(":");
          if (colon !== -1) {
            const k = pair.slice(0, colon).trim().toLowerCase();
            const v = pair.slice(colon + 1).trim();
            if (k === "steps") steps = v;
            else if (k === "sampler") sampler = v;
            else if (k === "cfg scale") cfgScale = v;
            else if (k === "seed") seed = v;
            else if (k === "model") model = v;
            else if (k === "size") aspectRatio = v;
            else if (k === "model hash" && !model) model = `Hash: ${v}`;
          }
        }
      }
      break;
    }

    if (text.includes("invokeai_metadata") || text.includes('"generator": "invokeai"')) {
      try {
        const invokeData = JSON.parse(text);
        isAi = true;
        confidence = "high";
        generator = "InvokeAI";
        evidence.push("Found InvokeAI generation metadata");
        prompt = asText(invokeData.prompt) || prompt;
        negativePrompt = asText(invokeData.negative_prompt) || negativePrompt;
        seed = asText(invokeData.seed) ?? seed;
        steps = asText(invokeData.steps) ?? steps;
        model = asText(invokeData.model?.model_name) || model;
        break;
      } catch {
        // Ignore invalid JSON
      }
    }

    if (text.startsWith("{") && (text.includes('"prompt"') || text.includes('"uc"'))) {
      try {
        const naiData = JSON.parse(text);
        if (naiData.prompt || naiData.uc) {
          isAi = true;
          confidence = "high";
          generator = "NovelAI";
          evidence.push("Found NovelAI generation JSON comment");
          prompt = asText(naiData.prompt) || prompt;
          negativePrompt = asText(naiData.uc) || negativePrompt;
          steps = asText(naiData.steps) ?? steps;
          seed = asText(naiData.seed) ?? seed;
          cfgScale = asText(naiData.scale) ?? cfgScale;
          sampler = asText(naiData.sampler) ?? sampler;
          break;
        }
      } catch {
        // Ignore invalid JSON
      }
    }
  }

  // 2. ComfyUI prompt / workflow in PNG chunks
  const comfyPromptRaw = readTagValue(tags.pngText?.prompt);
  const comfyWorkflowRaw = readTagValue(tags.pngText?.workflow);
  if (
    comfyPromptRaw &&
    typeof comfyPromptRaw === "string" &&
    comfyPromptRaw.includes("class_type")
  ) {
    try {
      const data = JSON.parse(comfyPromptRaw) as Record<
        string,
        { class_type?: string; inputs?: Record<string, unknown> }
      >;
      isAi = true;
      confidence = "high";
      generator = generator || "ComfyUI";
      evidence.push("Found ComfyUI generation node graph in PNG metadata");

      for (const node of Object.values(data)) {
        if (!node || typeof node !== "object") continue;
        const cls = node.class_type || "";
        const inputs = node.inputs || {};

        if (/KSampler|SamplerCustom/i.test(cls)) {
          seed = asText(inputs.seed) ?? seed;
          if (!seed) seed = asText(inputs.noise_seed);
          steps = asText(inputs.steps) ?? steps;
          cfgScale = asText(inputs.cfg) ?? cfgScale;
          const samplerName = asText(inputs.sampler_name);
          if (samplerName) {
            const scheduler = asText(inputs.scheduler);
            sampler = scheduler ? `${samplerName} (${scheduler})` : samplerName;
          }
        }
        if (/CheckpointLoader|UNETLoader/i.test(cls)) {
          model =
            asText(inputs.ckpt_name) ||
            asText(inputs.model_name) ||
            asText(inputs.unet_name) ||
            model;
        }
        if (cls === "CLIPTextEncode" && typeof inputs.text === "string" && inputs.text.trim()) {
          const textVal = inputs.text.trim();
          if (!prompt) {
            prompt = textVal;
          } else if (!negativePrompt && textVal !== prompt) {
            negativePrompt = textVal;
          }
        }
      }
    } catch {
      // Ignore invalid JSON
    }
  } else if (
    comfyWorkflowRaw &&
    typeof comfyWorkflowRaw === "string" &&
    comfyWorkflowRaw.includes("nodes")
  ) {
    isAi = true;
    confidence = "high";
    generator = generator || "ComfyUI";
    evidence.push("Found ComfyUI workflow in PNG metadata");
  }

  // 3. Midjourney parameter signatures
  const descCandidates = [
    readTagValue(flat.ImageDescription),
    readTagValue(flat.Description),
    readTagValue(flat.UserComment),
    readTagValue(tags.pngText?.Description),
  ];

  for (const text of descCandidates) {
    if (!text || typeof text !== "string") continue;
    if (
      /--(?:v|ar|s|stylize|chaos|weird|tile|no|iw)\b/i.test(text) ||
      /Midjourney/i.test(haystack)
    ) {
      isAi = true;
      confidence = "high";
      generator = generator || "Midjourney";
      evidence.push("Contains Midjourney prompt parameter flags (--v, --ar, etc.)");

      const promptMatch = text.match(/^([\s\S]*?)(?=\s--[a-z])/i);
      prompt = promptMatch ? promptMatch[1].trim() : text.trim();

      const arMatch = text.match(/--ar\s+([0-9:]+)/i);
      if (arMatch) aspectRatio = arMatch[1];
      const vMatch = text.match(/--v\s+([0-9.]+)/i);
      if (vMatch) model = `Midjourney v${vMatch[1]}`;
      const sMatch = text.match(/--(?:s|stylize)\s+(\d+)/i);
      if (sMatch) cfgScale = `Stylize: ${sMatch[1]}`;
      const seedMatch = text.match(/--seed\s+(\d+)/i);
      if (seedMatch) seed = seedMatch[1];
      break;
    }
  }

  // 4. Software tag checks
  const software = (
    readTagValue(flat.Software) ||
    readTagValue(flat.ProcessingSoftware) ||
    readTagValue(flat.CreatorTool) ||
    ""
  ).toLowerCase();
  if (software.includes("midjourney")) {
    isAi = true;
    confidence = "high";
    generator = generator || "Midjourney";
    evidence.push("Software tag identified Midjourney");
  } else if (software.includes("novelai")) {
    isAi = true;
    confidence = "high";
    generator = generator || "NovelAI";
    evidence.push("Software tag identified NovelAI");
  } else if (software.includes("firefly") || software.includes("adobe firefly")) {
    isAi = true;
    confidence = "high";
    generator = generator || "Adobe Firefly";
    evidence.push("Software tag identified Adobe Firefly");
  } else if (software.includes("comfyui")) {
    isAi = true;
    confidence = "high";
    generator = generator || "ComfyUI";
    evidence.push("Software tag identified ComfyUI");
  } else if (software.includes("fooocus")) {
    isAi = true;
    confidence = "high";
    generator = generator || "Fooocus";
    evidence.push("Software tag identified Fooocus");
  }

  // 5. Standard IPTC digitalSourceType
  if (/trainedAlgorithmicMedia/i.test(haystack)) {
    isAi = true;
    confidence = "high";
    generator = generator || "Generative AI (IPTC Standard)";
    evidence.push("IPTC Digital Source Type: trainedAlgorithmicMedia");
  } else if (/compositeWithTrainedAlgorithmicMedia/i.test(haystack)) {
    isAi = true;
    confidence = "high";
    generator = generator || "Composite AI (IPTC Standard)";
    evidence.push("IPTC Digital Source Type: compositeWithTrainedAlgorithmicMedia");
  }

  // 6. DALL-E / OpenAI checks
  if (/\b(?:DALL[·-]?E|OpenAI)\b/i.test(haystack)) {
    isAi = true;
    confidence = "high";
    generator = generator || "OpenAI DALL·E";
    evidence.push("OpenAI / DALL·E signature detected in metadata");
  }

  // 7. Check for FLUX
  if (model && /flux/i.test(model)) {
    generator = "FLUX";
  }

  return {
    isAi,
    confidence,
    generator: isAi ? generator || "Generative AI" : undefined,
    prompt: prompt || undefined,
    negativePrompt: negativePrompt || undefined,
    model: model || undefined,
    seed: seed || undefined,
    steps: steps || undefined,
    sampler: sampler || undefined,
    cfgScale: cfgScale || undefined,
    aspectRatio: aspectRatio || undefined,
    rawParameters: rawParameters || undefined,
    c2pa: c2paPresent,
    evidence,
  };
}

function addGpsFields(
  tags: ExpandedLike,
  flat: Record<string, TagLike>,
  push: (label: string, value: string, group: MetadataGroup) => void,
) {
  const latitude = signedCoordinate(
    tags.gps?.Latitude,
    flat.GPSLatitude,
    flat.GPSLatitudeRef,
    true,
  );
  const longitude = signedCoordinate(
    tags.gps?.Longitude,
    flat.GPSLongitude,
    flat.GPSLongitudeRef,
    false,
  );
  if (latitude != null) push("Latitude", formatCoordinate(latitude, true), "location");
  if (longitude != null) push("Longitude", formatCoordinate(longitude, false), "location");

  const altitude =
    typeof tags.gps?.Altitude === "number" ? tags.gps.Altitude : altitudeFromTags(flat);
  if (altitude != null) push("Altitude", `${trimNumber(altitude)} m`, "location");
}

function signedCoordinate(computed: number | undefined, tag: TagLike, ref: TagLike, lat: boolean) {
  if (typeof computed === "number" && Number.isFinite(computed)) return computed;
  const unsigned = decimalFromTag(tag);
  if (unsigned == null) return undefined;
  const refText = stringifyUnknown(ref?.value) || stringifyUnknown(ref?.description);
  const southOrWest = lat ? /S/i.test(refText) : /W/i.test(refText);
  return southOrWest ? -Math.abs(unsigned) : unsigned;
}

function decimalFromTag(tag: TagLike) {
  if (!tag) return undefined;
  if (typeof tag.description === "number" && Number.isFinite(tag.description))
    return tag.description;
  const numeric = Number(tag.description);
  if (Number.isFinite(numeric) && String(tag.description).trim() !== "") return numeric;
  const value = tag.value;
  if (!Array.isArray(value) || value.length < 3) return undefined;
  const parts = value.map((part) => {
    if (Array.isArray(part) && part.length >= 2 && Number(part[1]))
      return Number(part[0]) / Number(part[1]);
    return Number(part);
  });
  if (parts.some((part) => !Number.isFinite(part))) return undefined;
  return parts[0] + parts[1] / 60 + parts[2] / 3600;
}

function altitudeFromTags(flat: Record<string, TagLike>) {
  const fromTag = decimalFromTag(flat.GPSAltitude);
  const ref = stringifyUnknown(flat.GPSAltitudeRef?.value) || readTagValue(flat.GPSAltitudeRef);
  const below = /^(?:1|sea level reference)/i.test(ref);
  if (fromTag != null) return below ? -Math.abs(fromTag) : fromTag;
  const raw = readTagValue(flat.GPSAltitude);
  if (!raw) return undefined;
  const meters = Number(raw.replace(/[^\d.+-]+/g, ""));
  if (!Number.isFinite(meters) || raw.replace(/[^\d.+-]+/g, "") === "") return undefined;
  return below ? -Math.abs(meters) : meters;
}

function formatCoordinate(decimal: number, lat: boolean) {
  const hemi = lat ? (decimal < 0 ? "S" : "N") : decimal < 0 ? "W" : "E";
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = (minFloat - min) * 60;
  const dms = `${deg}° ${min}′ ${sec.toFixed(2)}″ ${hemi}`;
  return `${abs.toFixed(6)}° ${hemi} (${dms})`;
}

function formatField(key: string, value: string) {
  if (/Date|Time/i.test(key) && /^\d{4}:\d{2}:\d{2}/.test(value)) return formatExifDate(value);
  if (key === "ExposureTime") return formatExposure(value);
  if (key === "FNumber") return formatFNumber(value);
  if (key === "FocalLength" || key === "FocalLengthIn35mmFilm")
    return /mm/i.test(value) ? value : `${value} mm`;
  if (/ISO/i.test(key) && /^\d+(\.\d+)?$/.test(value)) return value;
  return value;
}

function formatExifDate(value: string) {
  const match = value.match(/^(\d{4}):(\d{2}):(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return value;
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[Number(match[2]) - 1];
  if (!month) return value;
  const date = `${Number(match[3])} ${month} ${match[1]}`;
  if (!match[4]) return date;
  return `${date}, ${match[4]}:${match[5]}${match[6] ? `:${match[6]}` : ""}`;
}

function formatExposure(value: string) {
  if (/s$/i.test(value)) return value;
  if (/^(?:\d+(?:\.\d+)?|1\/\d+)$/.test(value)) return `${value} s`;
  return value;
}

function formatFNumber(value: string) {
  if (/^f\/?/i.test(value)) return value.replace(/^f\/?/i, "f/");
  if (/^\d+(\.\d+)?$/.test(value)) return `f/${value}`;
  return value;
}

function addProvenance(
  tags: ExpandedLike,
  flat: Record<string, TagLike>,
  buffer: ArrayBuffer | undefined,
  haystack: string,
  push: (label: string, value: string, group: MetadataGroup) => void,
) {
  if (hasC2pa(haystack, buffer)) push("C2PA", "Present (Content Credentials)", "provenance");

  if (/trainedAlgorithmicMedia/i.test(haystack)) {
    push("Digital source", "Trained algorithmic media", "provenance");
  }

  const generator = detectGenerator(haystack);
  if (generator) push("Generator", generator, "provenance");
}

function detectGenerator(text: string) {
  if (/\bfirefly\b/i.test(text)) return "Adobe Firefly";
  if (/\bcomfy[\s-]?ui\b/i.test(text)) return "ComfyUI";
  if (
    /stable[\s-]?diffusion/i.test(text) ||
    /\bsdxl\b/i.test(text) ||
    /\bsd[\s-]?webui\b/i.test(text)
  )
    return "Stable Diffusion";
  if (/\bmidjourney\b/i.test(text)) return "Midjourney";
  if (/\bnovelai\b/i.test(text)) return "NovelAI";
  if (/\bdall[·-]?e\b/i.test(text)) return "OpenAI DALL·E";
  return "";
}

function hasC2pa(text: string, buffer?: ArrayBuffer) {
  if (/c2pa\.org|content ?credentials/i.test(text)) return true;
  if (!buffer) return false;
  return containsAscii(new Uint8Array(buffer), "c2pa.org");
}

function containsAscii(bytes: Uint8Array, needle: string) {
  const n = needle.length;
  outer: for (let i = 0; i <= bytes.length - n; i += 1) {
    for (let j = 0; j < n; j += 1) {
      if (bytes[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return true;
  }
  return false;
}

function collectStrings(nodes: unknown[], out: string[] = [], depth = 0) {
  if (depth > 6) return out;
  for (const node of nodes) {
    if (node == null) continue;
    if (typeof node === "string") {
      if (node && node.length < 8000) out.push(node);
      continue;
    }
    if (typeof node !== "object") continue;
    if (Array.isArray(node)) {
      collectStrings(node, out, depth + 1);
      continue;
    }
    collectStrings(Object.values(node as Record<string, unknown>), out, depth + 1);
  }
  return out;
}

function readTagValue(tag: TagLike) {
  if (!tag) return "";
  const raw = tag.description ?? tag.value;
  const value = stringifyUnknown(raw);
  if (!value) return "";
  if (value === "Unknown" || value === "Undefined" || value === "None") return "";
  if (value.startsWith("[") && value.endsWith("]")) return "";
  return value;
}

function stringifyUnknown(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "boolean") return raw ? "Yes" : "No";
  if (Array.isArray(raw)) {
    if (raw.length === 0) return "";
    if (raw.every((part) => typeof part === "number") && raw.length > 48)
      return `${raw.length} values`;
    const parts = raw.map((part) => stringifyUnknown(part)).filter(Boolean);
    if (!parts.length) return "";
    const joined = parts.join("");
    if (/^[NSWE]$/i.test(joined)) return joined;
    return parts.join(", ");
  }
  if (typeof raw === "object") {
    try {
      const json = JSON.stringify(raw);
      if (json && json !== "{}" && json !== "[]" && json.length < 2000) return json;
    } catch {
      return "";
    }
  }
  return "";
}

function groupFor(key: string): MetadataGroup {
  if (/GPS|Latitude|Longitude|Altitude/i.test(key)) return "location";
  if (
    /Make|Model|Lens|Date|Time|ISO|Exposure|FNumber|Focal|Flash|WhiteBalance|Metering|Scene/i.test(
      key,
    )
  )
    return "camera";
  return "other";
}

function humanLabel(key: string) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\bGps\b/gi, "GPS")
    .replace(/\bIso\b/gi, "ISO")
    .replace(/\bJfif\b/gi, "JFIF");
}

function trimNumber(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

async function sha256Hex(buffer: ArrayBuffer) {
  if (typeof crypto === "undefined" || !crypto.subtle) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const cannotClean = (cause?: unknown) =>
  new CutoutError(
    "export",
    "Couldn’t remove the metadata from this file. Nothing was saved.",
    false,
    { cause },
  );

/** PNG, JPEG and WebP strip losslessly; picked by signature, never by the claimed type. */
function stripLossless(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
  if (isPngSignature(bytes)) return { bytes: stripPngMetadata(bytes), mime: "image/png" };
  if (isJpegSignature(bytes)) return { bytes: stripJpegMetadata(bytes), mime: "image/jpeg" };
  if (isWebpSignature(bytes)) return { bytes: stripWebpMetadata(bytes), mime: "image/webp" };
  return null;
}

function verifiedClean(lossless: { bytes: Uint8Array; mime: string } | null): Blob {
  if (!lossless || hasEmbeddedMetadata(lossless.bytes)) throw cannotClean();
  return toBlobFromBytes(lossless.bytes, lossless.mime);
}

/** Originals: lossless for PNG/JPEG/WebP, otherwise re-encoded to PNG through the app's
 *  decoders. Never returns the input bytes unchanged when they carry metadata; throws when
 *  it cannot clean, because a "cleaned" file that still holds GPS is worse than an error. */
export async function stripOriginalMetadata(blob: Blob): Promise<Blob> {
  await guardTiffBytes(blob);
  const lossless = stripLossless(new Uint8Array(await blob.arrayBuffer()));
  if (lossless) return verifiedClean(lossless);
  let png: File;
  try {
    const { toProcessableFile } = await import("./files.ts");
    const name = blob instanceof File ? blob.name : "original";
    png = await toProcessableFile(new File([blob], name, { type: blob.type }));
  } catch (error) {
    throw cannotClean(error);
  }
  return verifiedClean(stripLossless(new Uint8Array(await png.arrayBuffer())));
}

/** Re-encoding goes through the processing budget, so a large HEIC/TIFF original can come
 *  back smaller on a phone. Say so instead of handing over fewer pixels silently — but only
 *  when that budget applied: header extents can exceed the picture (a HEIF 'clap' crop). */
export async function downscaleNotice(original: Blob, cleaned: Blob): Promise<string | null> {
  const bytes = new Uint8Array(await cleaned.slice(0, 24).arrayBuffer());
  if (!isPngSignature(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  const source = await sourceSize(original);
  if (!source || width * height >= source.width * source.height) return null;
  const { exceedsProcessingBudget } = await import("./files.ts");
  if (!exceedsProcessingBudget(source.width, source.height)) return null;
  return (
    `Saved without metadata as a PNG at ${width}×${height}. ` +
    "The original is larger than this device can re-encode."
  );
}

type Size = { width: number; height: number };
const sized = (width: number, height: number): Size | null =>
  width > 0 && height > 0 ? { width, height } : null;

/** Dimensions from the headers of formats that are re-encoded; null when unknown. */
async function sourceSize(blob: Blob): Promise<Size | null> {
  const head = new Uint8Array(await blob.slice(0, 64).arrayBuffer());
  const ascii = (at: number, text: string) =>
    String.fromCharCode(...head.subarray(at, at + text.length)) === text;
  if (ascii(0, "GIF8")) return gifSize(blob);
  if (ascii(0, "BM")) return bmpSize(head);
  if (ascii(0, "II*\0") || ascii(0, "MM\0*")) {
    // Reads the directories only (they can sit anywhere in the file); pixels stay undecoded.
    const { tiffDimensions, assertTiffFileSize } = await import("./tiff.ts");
    assertTiffFileSize(blob.size);
    return tiffDimensions(await blob.arrayBuffer());
  }
  if (ascii(4, "ftyp")) return heifSize(blob);
  return null;
}

/** HEIF item properties sit at the front of the file; past this, stop rather than walk pixels. */
const HEIF_PROPERTIES_WITHIN = 4_000_000;

/** HEIC/AVIF: walk meta → iprp → ipco and take the largest 'ispe' (the full image; the others
 *  are tiles or thumbnails). Reads only box headers and those small boxes, never 'mdat'. */
async function heifSize(blob: Blob): Promise<Size | null> {
  const read = async (start: number, end: number) =>
    new DataView(await blob.slice(start, end).arrayBuffer());
  async function children(start: number, end: number) {
    const boxes: { type: string; start: number; end: number }[] = [];
    for (let at = start; at + 8 <= end && at < HEIF_PROPERTIES_WITHIN;) {
      const head = await read(at, at + 16);
      let size = head.getUint32(0),
        header = 8;
      if (size === 1 && head.byteLength >= 16) {
        size = Number(head.getBigUint64(8));
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end) break;
      const type = String.fromCharCode(...[4, 5, 6, 7].map((i) => head.getUint8(i)));
      boxes.push({ type, start: at + header, end: at + size });
      at += size;
    }
    return boxes;
  }
  const child = async (start: number, end: number, type: string) =>
    (await children(start, end)).find((box) => box.type === type);
  const meta = await child(0, blob.size, "meta");
  // 'meta' is a full box: 4 bytes of version and flags come before its children.
  const iprp = meta && (await child(meta.start + 4, meta.end, "iprp"));
  const ipco = iprp && (await child(iprp.start, iprp.end, "ipco"));
  if (!ipco) return null;
  let largest: Size | null = null;
  for (const box of await children(ipco.start, ipco.end)) {
    if (box.type !== "ispe" || box.end - box.start < 12) continue;
    const extent = await read(box.start + 4, box.start + 12);
    const size = sized(extent.getUint32(0), extent.getUint32(4));
    if (size && (!largest || size.width * size.height > largest.width * largest.height))
      largest = size;
  }
  return largest;
}

/** Exports the app encoded itself: lossless strip for PNG/JPEG/WebP (defence in depth),
 *  returned unchanged for BMP/AVIF/HEIC, which our encoders write without metadata. */
export async function stripExportMetadata(blob: Blob): Promise<Blob> {
  const lossless = stripLossless(new Uint8Array(await blob.arrayBuffer()));
  return lossless ? verifiedClean(lossless) : blob;
}

/** True when a PNG/JPEG/WebP still carries EXIF, XMP, IPTC, text or C2PA blocks. Structure
 *  it cannot walk counts as metadata too, so callers fail closed. Other formats: false. */
export function hasEmbeddedMetadata(bytes: Uint8Array): boolean {
  if (isPngSignature(bytes)) return pngHasMetadata(bytes);
  if (isJpegSignature(bytes)) return jpegHasMetadata(bytes);
  if (isWebpSignature(bytes)) return webpHasMetadata(bytes);
  return false;
}

function pngHasMetadata(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (end > bytes.length || !PNG_KEEP.has(type)) return true;
    if (type === "IEND") return end !== bytes.length;
    offset = end;
  }
  return true;
}

/** Walk marker boundaries only; entropy bytes are copied, never decoded or re-encoded.
 * T.81 B.1: stuffing/restarts carry no length. TEM/SOI cannot start a scan segment.
 * A malformed/truncated stream must not be certified as a cleaned original. */
function* jpegSegments(bytes: Uint8Array) {
  let offset = 2;
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) throw cannotClean();
    while (bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) throw cannotClean();
    const marker = bytes[offset++]!;
    if (marker === 0xd9) {
      if (offset !== bytes.length) throw cannotClean();
      yield { marker, start, end: offset, data: bytes.subarray(offset, offset) };
      return;
    }
    if (marker === 0 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) throw cannotClean();
    // TEM is standalone between headers, never a length-bearing segment.
    if (marker === 0x01) {
      yield { marker, start, end: offset, data: bytes.subarray(offset, offset) };
      continue;
    }
    if (offset + 2 > bytes.length) throw cannotClean();
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const end = offset + length;
    if (length < 2 || end > bytes.length) throw cannotClean();
    const data = bytes.subarray(offset + 2, end);
    offset = end;
    if (marker === 0xda) {
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const boundary = offset++;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === undefined || next === 0x01 || next === 0xd8) throw cannotClean();
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) {
          if (next === 0 && offset !== boundary + 1) throw cannotClean();
          offset++;
          continue;
        }
        offset = boundary;
        break;
      }
    }
    yield { marker, start, end: offset, data };
  }
  throw cannotClean(); // EOI is required, even when a browser can display a partial scan.
}

function jpegHasMetadata(bytes: Uint8Array) {
  try {
    for (const { marker, data } of jpegSegments(bytes)) {
      if (isJpegMetadataSegment(marker, data)) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function webpHasMetadata(bytes: Uint8Array) {
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) return true;
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    offset += 8 + size + (size % 2);
    if (offset > bytes.length + 1 || !WEBP_KEEP.has(id)) return true;
  }
  return false;
}

/** Only chunks needed to draw the image and its colours survive; anything else — text,
 *  EXIF, XMP, C2PA, timestamps, private chunks — is dropped. */
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "tRNS",
  "IDAT",
  "IEND",
  "gAMA",
  "cHRM",
  "sRGB",
  "iCCP",
  "cICP",
  "sBIT",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);

/** APP1 (EXIF/XMP), APP13 (IPTC), COM, APP3–APP15 except APP14 (Adobe colour transform),
 *  and APP2 unless it is an ICC profile. */
function isJpegMetadataSegment(marker: number, data: Uint8Array) {
  // JFXX can embed a second JPEG, complete with EXIF/GPS. Keep only the JFIF header.
  if (marker === 0xe0) return !startsWithAscii(data, "JFIF\0");
  if (marker === 0xe1) return !isOrientationOnly(data);
  if (marker === 0xed || marker === 0xfe) return true;
  if (marker >= 0xe3 && marker <= 0xef) return marker !== 0xee;
  return marker === 0xe2 && !startsWithAscii(data, "ICC_PROFILE\0");
}

/** EXIF Orientation (1–8) from an APP1 payload, or 0 when absent or unreadable. */
function exifOrientation(data: Uint8Array): number {
  if (!startsWithAscii(data, "Exif\0\0") || data.length < 16) return 0;
  const tiff = data.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return 0;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > tiff.length) return 0;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > tiff.length) return 0;
    if (view.getUint16(at, little) !== 0x0112) continue;
    const value = view.getUint16(at + 8, little);
    return value >= 1 && value <= 8 ? value : 0;
  }
  return 0;
}

/** APP1 payload holding only IFD0 Orientation: what a viewer needs to show a photo upright. */
function orientationExif(value: number): Uint8Array {
  // "Exif\0\0", little-endian TIFF header, one IFD entry (0x0112, SHORT, 1, value), no next IFD.
  return Uint8Array.from([
    0x45,
    0x78,
    0x69,
    0x66,
    0,
    0,
    0x49,
    0x49,
    0x2a,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    0x12,
    0x01,
    3,
    0,
    1,
    0,
    0,
    0,
    value,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}

function isOrientationOnly(data: Uint8Array) {
  const value = exifOrientation(data);
  if (!value) return false;
  const only = orientationExif(value);
  return data.length === only.length && only.every((byte, i) => data[i] === byte);
}

function startsWithAscii(data: Uint8Array, text: string) {
  if (data.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (data[i] !== text.charCodeAt(i)) return false;
  return true;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (!isPngSignature(bytes)) return bytes;

  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  const len = bytes.length;

  while (offset + 8 <= len) {
    const dataLength =
      ((bytes[offset] << 24) |
        (bytes[offset + 1] << 16) |
        (bytes[offset + 2] << 8) |
        bytes[offset + 3]) >>>
      0;
    const chunkType = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const totalChunkLength = 12 + dataLength;

    if (offset + totalChunkLength > len) {
      chunks.push(bytes.subarray(offset));
      break;
    }

    if (PNG_KEEP.has(chunkType)) {
      chunks.push(bytes.subarray(offset, offset + totalChunkLength));
    }

    offset += totalChunkLength;
    if (chunkType === "IEND") break;
  }

  return concat(chunks);
}

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpegSignature(bytes)) return bytes;

  const chunks: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI (0xFF 0xD8)
  // EXIF goes, but a phone photo stored sideways must not come back sideways.
  let orientation = 0;
  for (const { marker, start, end, data } of jpegSegments(bytes)) {
    if (marker === 0xe1) orientation ||= exifOrientation(data);
    // Walk every scan/header: inter-scan metadata must not be copied with entropy.
    if (marker !== 0xe1 && !isJpegMetadataSegment(marker, data))
      chunks.push(bytes.subarray(start, end));
  }

  if (orientation > 1) {
    const payload = orientationExif(orientation);
    const segment = concat([Uint8Array.from([0xff, 0xe1, 0, payload.length + 2]), payload]);
    // After JFIF's APP0 when present: JFIF requires APP0 to follow SOI directly.
    const afterApp0 = chunks[1]?.[0] === 0xff && chunks[1]?.[1] === 0xe0 ? 2 : 1;
    chunks.splice(afterApp0, 0, segment);
  }
  return concat(chunks);
}

export function stripWebpMetadata(bytes: Uint8Array): Uint8Array {
  if (!isWebpSignature(bytes)) return bytes;

  const chunks: Array<{ id: string; data: Uint8Array }> = [];
  let vp8xIndex = -1;
  let offset = 12;
  const len = bytes.length;

  while (offset + 8 <= len) {
    const chunkId = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3],
    );
    const payloadLen =
      (bytes[offset + 4] |
        (bytes[offset + 5] << 8) |
        (bytes[offset + 6] << 16) |
        (bytes[offset + 7] << 24)) >>>
      0;
    const paddedLen = payloadLen + (payloadLen % 2);
    const totalChunkLen = 8 + paddedLen;

    if (offset + totalChunkLen > len + 1) break;

    if (WEBP_KEEP.has(chunkId)) {
      if (chunkId === "VP8X") {
        vp8xIndex = chunks.length;
      }
      chunks.push({
        id: chunkId,
        data: bytes.subarray(offset, Math.min(len, offset + totalChunkLen)),
      });
    }
    offset += totalChunkLen;
  }

  if (vp8xIndex !== -1 && chunks[vp8xIndex]) {
    const vp8xData = new Uint8Array(chunks[vp8xIndex].data);
    vp8xData[8] = vp8xData[8] & ~0x0c; // Clear EXIF (bit 2) and XMP (bit 3) flags
    chunks[vp8xIndex].data = vp8xData;
  }

  let payloadTotal = 4; // 'WEBP'
  for (const chunk of chunks) {
    payloadTotal += chunk.data.length;
  }

  const result = new Uint8Array(8 + payloadTotal);
  result.set(bytes.subarray(0, 4), 0); // 'RIFF'
  result[4] = payloadTotal & 0xff;
  result[5] = (payloadTotal >> 8) & 0xff;
  result[6] = (payloadTotal >> 16) & 0xff;
  result[7] = (payloadTotal >> 24) & 0xff;
  result.set(bytes.subarray(8, 12), 8); // 'WEBP'

  let pos = 12;
  for (const chunk of chunks) {
    result.set(chunk.data, pos);
    pos += chunk.data.length;
  }

  return result;
}

function isPngSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  );
}

function isJpegSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

function isWebpSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  );
}

function toBlobFromBytes(bytes: Uint8Array, mime: string): Blob {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([buf], { type: mime });
}
