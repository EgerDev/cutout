import DxfParser, {
  type IArcEntity,
  type ICircleEntity,
  type IDimensionEntity,
  type IDxf,
  type IEllipseEntity,
  type IEntity,
  type IInsertEntity,
  type ILineEntity,
  type ILwpolylineEntity,
  type IMtextEntity,
  type IPoint,
  type IPointEntity,
  type IPolylineEntity,
  type ISolidEntity,
  type ISplineEntity,
  type ITextEntity,
} from "dxf-parser";
import { Unzlib } from "fflate";
import { encodeCanvas } from "./editor/canvas.ts";
import { CutoutError } from "./errors.ts";

/** Local rasterization for PDF / DXF / DWG / SKP. No network. */

/*
 * These parsers run on the main thread over untrusted files, so every loop is linear
 * in the file and every expansion is capped: a few KB must not become gigabytes.
 */
/** Checked in toProcessableFile before the bytes are read. */
export const CAD_MAX_BYTES = 50_000_000;
/** DXF is text: dxf-parser and the legacy parser each split it into lines, which costs
 *  roughly 10–40× the file size in memory, so DXF gets a lower cap. */
export const CAD_MAX_DXF_BYTES = 20_000_000;
/** Points kept across a whole drawing; each entity visited also costs one. The raster is
 *  1600 px, so more vertices add no detail, and at about 150 bytes per point while parsing
 *  this keeps a hostile drawing near 150 MB. */
export const CAD_MAX_POINTS = 1_000_000;
/** Block expansions (INSERT, DIMENSION) across a whole drawing. */
export const CAD_MAX_INSERTS = 100_000;
/** Bytes inflated across all FlateDecode images of one PDF. */
export const PDF_MAX_INFLATE = 256_000_000;

export async function rasterizeCad(file: File, bytes: Uint8Array): Promise<File | null> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return extractPdfImage(bytes, file.name);
  if (name.endsWith(".dxf") || file.type.includes("dxf")) return rasterizeDxf(bytes, file.name);
  if (name.endsWith(".dwg") || file.type.includes("dwg")) return extractDibPreview(bytes, file.name);
  if (name.endsWith(".skp") || file.type.includes("sketchup")) return extractEmbeddedRaster(bytes, file.name);
  return extractEmbeddedRaster(bytes, file.name);
}

async function extractPdfImage(bytes: Uint8Array, name: string) {
  const jpeg = extractPdfJpeg(bytes, name);
  const flate = await extractPdfFlateRgb(bytes, name);
  const embedded = extractEmbeddedRaster(bytes, name);
  return pickLargest([jpeg, flate, embedded]);
}

function pickLargest(files: Array<File | null>) {
  let best: File | null = null;
  for (const file of files) {
    if (file && (!best || file.size > best.size)) best = file;
  }
  return best;
}

/** RGB FlateDecode images, largest declared size first. Each is inflated only as far as its
 *  pixels need, and all of them within PDF_MAX_INFLATE, so a zlib bomb costs nothing extra. */
async function extractPdfFlateRgb(bytes: Uint8Array, name: string) {
  const text = new TextDecoder("latin1").decode(bytes);
  const images: Array<{ start: number; end: number; width: number; height: number }> = [];
  let from = 0;
  let end = -1;
  while (from < text.length) {
    const marker = text.indexOf("/Subtype", from);
    if (marker < 0) break;
    from = marker + 8;
    const kind = text.slice(marker, marker + 40);
    if (!kind.includes("Image")) continue;
    const dictEnd = indexWithin(text, "stream", marker, 1200);
    if (dictEnd < 0) continue;
    const dict = text.slice(marker, dictEnd);
    if (!dict.includes("FlateDecode") || dict.includes("DCTDecode")) continue;
    const width = pdfNumber(dict, "/Width");
    const height = pdfNumber(dict, "/Height");
    const bits = pdfNumber(dict, "/BitsPerComponent") || 8;
    if (!width || !height || bits !== 8 || width > 4096 || height > 4096) continue;
    if (!dict.includes("DeviceRGB") && !dict.includes("/RGB")) continue;
    let start = dictEnd + 6;
    if (text.charCodeAt(start) === 13) start += 1;
    if (text.charCodeAt(start) === 10) start += 1;
    // Stream starts only move forward, so the next endstream is reused until passed.
    if (end < start) end = text.indexOf("endstream", start);
    if (end < 0) break;
    images.push({ start, end: trimStream(text, start, end), width, height });
  }
  images.sort((a, b) => b.width * b.height - a.width * a.height);
  let budget = PDF_MAX_INFLATE;
  for (const image of images) {
    const need = image.width * image.height * 3;
    if (need > budget) continue;
    budget -= need;
    let raw: Uint8Array;
    try {
      raw = inflateUpTo(bytes.subarray(image.start, image.end), need);
    } catch {
      continue;
    }
    if (raw.byteLength < need) continue;
    const file = await rgbToPng(raw, image.width, image.height, name);
    if (file) return file;
  }
  return null;
}

/** `indexOf` that looks at most `span` characters past `from`, keeping marker loops linear. */
function indexWithin(text: string, needle: string, from: number, span: number) {
  const at = text.slice(from, from + span + needle.length).indexOf(needle);
  return at < 0 ? -1 : from + at;
}

function pdfNumber(dict: string, key: string) {
  const i = dict.indexOf(key);
  if (i < 0) return 0;
  const m = dict.slice(i + key.length).match(/^\s+(\d+)/);
  return m ? Number(m[1]) : 0;
}

function trimStream(text: string, start: number, end: number) {
  let last = end;
  if (text.charCodeAt(last - 1) === 10) last -= 1;
  if (text.charCodeAt(last - 1) === 13) last -= 1;
  return last;
}

const INFLATE_CHUNK = 16 * 1024;

/** zlib-inflates until `limit` bytes are out, then stops feeding input. Small input chunks
 *  keep one push of a bomb (about 1000:1) to a few MB. */
function inflateUpTo(bytes: Uint8Array, limit: number) {
  const out = new Uint8Array(limit);
  let size = 0;
  const unzlib = new Unzlib((chunk) => {
    const take = Math.min(chunk.length, limit - size);
    out.set(chunk.subarray(0, take), size);
    size += take;
  });
  for (let at = 0; at < bytes.length && size < limit; at += INFLATE_CHUNK) {
    unzlib.push(bytes.subarray(at, at + INFLATE_CHUNK), at + INFLATE_CHUNK >= bytes.length);
  }
  return out.subarray(0, size);
}

function rgbToPng(rgb: Uint8Array, width: number, height: number, name: string) {
  if (typeof document === "undefined") return Promise.resolve(null);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const need = width * height * 3;
  if (rgb.byteLength < need) return Promise.resolve(null);
  for (let p = 0, i = 0; i < need; p += 4, i += 3) {
    data[p] = rgb[i]!;
    data[p + 1] = rgb[i + 1]!;
    data[p + 2] = rgb[i + 2]!;
    data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvasToFile(canvas, name.replace(/\.[^.]+$/, "") + ".png");
}

async function canvasToFile(canvas: HTMLCanvasElement, filename: string) {
  const blob = await encodeCanvas(canvas).catch(() => null);
  canvas.width = 0;
  canvas.height = 0;
  return blob && new File([blob], filename, { type: "image/png" });
}

function extractPdfJpeg(bytes: Uint8Array, name = "page.jpg") {
  const text = new TextDecoder("latin1").decode(bytes);
  let best: Uint8Array | null = null;
  let from = 0;
  let end = -1;
  while (from < text.length) {
    const marker = text.indexOf("DCTDecode", from);
    if (marker < 0) break;
    const streamAt = indexWithin(text, "stream", marker, 500);
    from = marker + 9;
    if (streamAt < 0) continue;
    let start = streamAt + 6;
    if (text.charCodeAt(start) === 13) start += 1;
    if (text.charCodeAt(start) === 10) start += 1;
    if (end < start) end = text.indexOf("endstream", start);
    if (end < 0) break;
    let slice = bytes.subarray(start, end);
    if (slice.length >= 2 && slice[slice.length - 1] === 10) slice = slice.subarray(0, slice.length - 1);
    if (slice.length >= 1 && slice[slice.length - 1] === 13) slice = slice.subarray(0, slice.length - 1);
    if (slice.length < 32 || slice[0] !== 0xff || slice[1] !== 0xd8) continue;
    if (!best || slice.byteLength > best.byteLength) best = slice;
  }
  if (!best) return null;
  const base = name.replace(/\.[^.]+$/, "") || "page";
  return new File([new Blob([best.slice()])], `${base}.jpg`, { type: "image/jpeg" });
}

function extractEmbeddedRaster(bytes: Uint8Array, name: string) {
  const png = sliceSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  const jpeg = sliceJpeg(bytes);
  const pick = png && jpeg ? (png.byteLength >= jpeg.byteLength ? png : jpeg) : (png ?? jpeg);
  if (!pick || pick.byteLength < 64) return null;
  const type = pick[0] === 0x89 ? "image/png" : "image/jpeg";
  const ext = type === "image/png" ? "png" : "jpg";
  const base = name.replace(/\.[^.]+$/, "") || "drawing";
  return new File([new Blob([pick.slice()])], `${base}.${ext}`, { type });
}

function sliceSignature(bytes: Uint8Array, start: number[], end: number[]) {
  const from = indexOfBytes(bytes, start);
  if (from < 0) return null;
  const until = indexOfBytes(bytes, end, from + start.length);
  if (until < 0) return bytes.slice(from);
  return bytes.slice(from, until + end.length);
}

/** Longest SOI…EOI run, pairing each start marker with the next end marker in one pass. */
function sliceJpeg(bytes: Uint8Array) {
  let bestStart = 0;
  let bestEnd = 0;
  let soi = -1;
  for (let i = 0; i < bytes.length - 1; i += 1) {
    if (bytes[i] !== 0xff) continue;
    if (soi < 0 && bytes[i + 1] === 0xd8) {
      soi = i;
      i += 1;
    } else if (soi >= 0 && bytes[i + 1] === 0xd9) {
      if (i + 2 - soi > bestEnd - bestStart) {
        bestStart = soi;
        bestEnd = i + 2;
      }
      soi = -1;
      i += 1;
    }
  }
  return bestEnd > bestStart ? bytes.slice(bestStart, bestEnd) : null;
}

function indexOfBytes(haystack: Uint8Array, needle: number[], from = 0) {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function readI32(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
  return view.getInt32(0, true);
}

function readU16(bytes: Uint8Array, offset: number) {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
  return view.getUint16(0, true);
}

function extractDibPreview(bytes: Uint8Array, name: string) {
  let best: Uint8Array | null = null;
  for (let i = 0; i < bytes.length - 40; i += 1) {
    if (bytes[i] !== 0x28 || bytes[i + 1] || bytes[i + 2] || bytes[i + 3]) continue;
    const width = readI32(bytes, i + 4);
    const height = Math.abs(readI32(bytes, i + 8));
    const planes = readU16(bytes, i + 12);
    const bits = readU16(bytes, i + 14);
    if (planes !== 1 || width < 16 || height < 16 || width > 4096 || height > 4096) continue;
    if (![1, 4, 8, 16, 24, 32].includes(bits)) continue;
    const palette = bits <= 8 ? 4 * (1 << bits) : 0;
    const row = (((bits * width + 31) >> 5) << 2);
    const pixels = row * height;
    const dib = 40 + palette + pixels;
    if (i + dib > bytes.length) continue;
    const fileSize = 14 + dib;
    const bmp = new Uint8Array(fileSize);
    bmp[0] = 0x42;
    bmp[1] = 0x4d;
    bmp[2] = fileSize & 255;
    bmp[3] = (fileSize >> 8) & 255;
    bmp[4] = (fileSize >> 16) & 255;
    bmp[5] = (fileSize >> 24) & 255;
    const off = 14 + 40 + palette;
    bmp[10] = off & 255;
    bmp[11] = (off >> 8) & 255;
    bmp.set(bytes.subarray(i, i + dib), 14);
    if (!best || bmp.byteLength > best.byteLength) best = bmp;
    i += dib - 1;
  }
  if (!best) return extractEmbeddedRaster(bytes, name);
  const base = name.replace(/\.[^.]+$/, "") || "drawing";
  return new File([new Blob([best.slice()])], `${base}.bmp`, { type: "image/bmp" });
}

async function rasterizeDxf(bytes: Uint8Array, name: string) {
  const text = new TextDecoder("latin1").decode(bytes);
  const parsed = pathsFromDxfParser(text);
  if (parsed) return paintDrawing(parsed, name, bytes);
  return rasterizeDxfLegacy(bytes, name, text);
}

type Point = { x: number; y: number };
type Mark = { x: number; y: number; height: number; rotation: number; text: string };

/** Paths collected from one drawing, charged against CAD_MAX_POINTS / CAD_MAX_INSERTS. */
class Drawing {
  strokes: Point[][] = [];
  fills: Point[][] = [];
  texts: Mark[] = [];
  points = 0;
  inserts = 0;
  stroke(points: Point[]) {
    this.spend(points.length);
    this.strokes.push(points);
  }
  fill(points: Point[]) {
    this.spend(points.length);
    this.fills.push(points);
  }
  text(mark: Mark) {
    this.spend(1);
    this.texts.push(mark);
  }
  enterBlock() {
    this.inserts += 1;
    if (this.inserts > CAD_MAX_INSERTS) throw tooComplex();
  }
  spend(count: number) {
    this.points += count;
    if (this.points > CAD_MAX_POINTS) throw tooComplex();
  }
}

const tooComplex = () =>
  new CutoutError(
    "drawing",
    "This drawing is too complex to open here. Export a PNG or PDF from your CAD app.",
  );

function pathsFromDxfParser(text: string) {
  try {
    const dxf = new DxfParser().parseSync(text);
    if (!dxf?.entities?.length) return null;
    const drawing = new Drawing();
    walkEntities(dxf, dxf.entities, drawing, identity());
    if (drawing.strokes.length + drawing.fills.length + drawing.texts.length === 0) return null;
    return drawing;
  } catch (error) {
    // Over budget is final; the legacy parser would only redo the same work.
    if (error instanceof CutoutError) throw error;
    return null;
  }
}

type Xform = Readonly<{ x: number; y: number; a: number; b: number; c: number; d: number }>;

function identity(): Xform {
  return { x: 0, y: 0, a: 1, b: 0, c: 0, d: 1 };
}

function apply(xform: Xform, point: { x: number; y: number }) {
  return {
    x: xform.x + point.x * xform.a + point.y * xform.c,
    y: xform.y + point.x * xform.b + point.y * xform.d,
  };
}

function insertTransform(parent: Xform, insert: IInsertEntity, origin: IPoint): Xform {
  const angle = ((insert.rotation ?? 0) * Math.PI) / 180;
  const a = Math.cos(angle) * (insert.xScale ?? 1);
  const b = Math.sin(angle) * (insert.xScale ?? 1);
  const c = -Math.sin(angle) * (insert.yScale ?? 1);
  const d = Math.cos(angle) * (insert.yScale ?? 1);
  const translation = apply(parent, {
    x: insert.position.x - a * origin.x - c * origin.y,
    y: insert.position.y - b * origin.x - d * origin.y,
  });
  return {
    ...translation,
    a: parent.a * a + parent.c * b,
    b: parent.b * a + parent.d * b,
    c: parent.a * c + parent.c * d,
    d: parent.b * c + parent.d * d,
  };
}

function walkEntities(
  dxf: IDxf,
  entities: IEntity[],
  drawing: Drawing,
  xform: Xform,
  depth = 0,
) {
  if (depth > 8) return;
  const layers = dxf.tables?.layer?.layers;
  for (const entity of entities) {
    // Visiting costs one point, so blocks of skipped entities cannot loop for free.
    drawing.spend(1);
    if (entity.visible === false) continue;
    const layer = layers?.[entity.layer];
    if (layer && (layer.frozen || layer.visible === false)) continue;
    const type = entity.type;
    if (type === "LINE") {
      const line = entity as ILineEntity;
      const verts = line.vertices ?? [];
      if (verts.length >= 2) drawing.stroke(verts.slice(0, 2).map((p) => apply(xform, p)));
    } else if (type === "CIRCLE") {
      const circleEntity = entity as ICircleEntity;
      drawing.stroke(circle(circleEntity.center.x, circleEntity.center.y, circleEntity.radius).map((p) => apply(xform, p)));
    } else if (type === "ARC") {
      const arcEntity = entity as IArcEntity;
      drawing.stroke(
        arcRad(arcEntity.center.x, arcEntity.center.y, arcEntity.radius, arcEntity.startAngle, arcEntity.endAngle).map((p) =>
          apply(xform, p),
        ),
      );
    } else if (type === "ELLIPSE") {
      const ellipseEntity = entity as IEllipseEntity;
      drawing.stroke(
        ellipse(
          ellipseEntity.center.x,
          ellipseEntity.center.y,
          ellipseEntity.majorAxisEndPoint.x,
          ellipseEntity.majorAxisEndPoint.y,
          ellipseEntity.axisRatio,
          ellipseEntity.startAngle,
          ellipseEntity.endAngle,
        ).map((p) => apply(xform, p)),
      );
    } else if (type === "LWPOLYLINE" || type === "POLYLINE") {
      const poly = entity as ILwpolylineEntity | IPolylineEntity;
      const closed = Boolean("shape" in poly && poly.shape);
      for (const stroke of polylineWithBulge(poly.vertices ?? [], closed, xform)) {
        drawing.stroke(stroke);
      }
    } else if (type === "SPLINE") {
      const spline = entity as ISplineEntity;
      const pts = spline.fitPoints?.length ? spline.fitPoints : spline.controlPoints;
      if (pts && pts.length >= 2) drawing.stroke(pts.map((p) => apply(xform, p)));
    } else if (type === "SOLID" || type === "TRACE" || type === "3DFACE") {
      const solid = entity as ISolidEntity & { vertices?: IPoint[] };
      const pts = solid.points ?? solid.vertices ?? [];
      if (pts.length >= 3) drawing.fill(pts.map((p) => apply(xform, p)));
    } else if (type === "POINT") {
      const point = entity as IPointEntity;
      const s = 0.35;
      const p = apply(xform, point.position);
      drawing.stroke([
        { x: p.x - s, y: p.y },
        { x: p.x + s, y: p.y },
      ]);
      drawing.stroke([
        { x: p.x, y: p.y - s },
        { x: p.x, y: p.y + s },
      ]);
    } else if (type === "TEXT" || type === "ATTDEF") {
      const text = entity as ITextEntity;
      if (!text.text?.trim()) continue;
      const p = apply(xform, text.startPoint);
      drawing.text({
        x: p.x,
        y: p.y,
        height: Math.abs(text.textHeight || 1) * Math.hypot(xform.c, xform.d),
        rotation: Math.atan2(xform.b, xform.a) + ((text.rotation || 0) * Math.PI) / 180,
        text: text.text,
      });
    } else if (type === "MTEXT") {
      const mtext = entity as IMtextEntity;
      const raw = stripMtext(mtext.text);
      if (!raw) continue;
      const p = apply(xform, mtext.position);
      drawing.text({
        x: p.x,
        y: p.y,
        height: Math.abs(mtext.height || 1) * Math.hypot(xform.c, xform.d),
        rotation: Math.atan2(xform.b, xform.a) + ((mtext.rotation || 0) * Math.PI) / 180,
        text: raw,
      });
    } else if (type === "DIMENSION") {
      const dim = entity as IDimensionEntity;
      const block = dim.block ? dxf.blocks?.[dim.block] : undefined;
      if (!block?.entities?.length) continue;
      drawing.enterBlock();
      walkEntities(dxf, block.entities, drawing, xform, depth + 1);
    } else if (type === "INSERT") {
      const insert = entity as IInsertEntity;
      const block = dxf.blocks?.[insert.name];
      if (!block?.entities?.length) continue;
      drawing.enterBlock();
      const nested = insertTransform(xform, insert, block.position ?? { x: 0, y: 0, z: 0 });
      walkEntities(dxf, block.entities, drawing, nested, depth + 1);
    }
  }
}

function stripMtext(value: string | undefined) {
  if (!value) return "";
  return value
    .replace(/\\P/g, " ")
    .replace(/\{\\[^;]+;/g, "")
    .replace(/\}/g, "")
    .replace(/\\[A-Za-z][^;]*;/g, "")
    .trim();
}

function polylineWithBulge(vertices: Array<IPoint & { bulge?: number }>, closed: boolean, xform: Xform) {
  const strokes: Array<{ x: number; y: number }[]> = [];
  if (vertices.length < 2) return strokes;
  const count = closed ? vertices.length : vertices.length - 1;
  let current: { x: number; y: number }[] = [];
  const pushPoint = (point: { x: number; y: number }) => {
    const mapped = apply(xform, point);
    const last = current[current.length - 1];
    if (!last || last.x !== mapped.x || last.y !== mapped.y) current.push(mapped);
  };
  for (let i = 0; i < count; i += 1) {
    const a = vertices[i]!;
    const b = vertices[(i + 1) % vertices.length]!;
    const bulge = a.bulge ?? 0;
    if (Math.abs(bulge) < 1e-6) {
      pushPoint(a);
      pushPoint(b);
    } else {
      if (current.length) {
        strokes.push(current);
        current = [];
      }
      strokes.push(bulgeArc(a, b, bulge).map((p) => apply(xform, p)));
    }
  }
  if (current.length >= 2) strokes.push(current);
  return strokes;
}

function bulgeArc(a: IPoint, b: IPoint, bulge: number) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const chord = Math.hypot(dx, dy) || 1;
  const angle = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(angle / 2));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const d = Math.sqrt(Math.max(0, radius * radius - (chord / 2) * (chord / 2)));
  const sign = bulge > 0 ? 1 : -1;
  const cx = mx + sign * d * (-dy / chord);
  const cy = my + sign * d * (dx / chord);
  const start = Math.atan2(a.y - cy, a.x - cx);
  const steps = Math.max(8, Math.round(Math.abs(angle) / (Math.PI / 16)));
  const r = Math.abs(radius);
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = start + (angle * i) / steps;
    points.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
  }
  return points;
}

async function paintDrawing(
  { strokes, fills, texts }: Drawing,
  name: string,
  bytes: Uint8Array,
  center = false,
) {
  const points = [...strokes.flat(), ...fills.flat(), ...texts];
  if (points.length < 1 || typeof document === "undefined") return extractEmbeddedRaster(bytes, name);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX)) return extractEmbeddedRaster(bytes, name);
  const span = Math.max(maxX - minX, maxY - minY, 1);
  const size = 1600;
  const pad = 60;
  const scale = (size - pad * 2) / span;
  // The legacy parser centres its drawing; parsed drawings sit on the bottom-left margin.
  const ox = center ? (size - (maxX - minX) * scale) / 2 : pad;
  const oy = center ? (size - (maxY - minY) * scale) / 2 : pad;
  const mapX = (value: number) => ox + (value - minX) * scale;
  const mapY = (value: number) => size - (oy + (value - minY) * scale);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) return extractEmbeddedRaster(bytes, name);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#111111";
  for (const fill of fills) {
    if (fill.length < 3) continue;
    ctx.beginPath();
    ctx.moveTo(mapX(fill[0]!.x), mapY(fill[0]!.y));
    for (let i = 1; i < fill.length; i += 1) ctx.lineTo(mapX(fill[i]!.x), mapY(fill[i]!.y));
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 4.4; // matches the retired WebGL stroke width
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of strokes) {
    if (stroke.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(mapX(stroke[0]!.x), mapY(stroke[0]!.y));
    for (let i = 1; i < stroke.length; i += 1) ctx.lineTo(mapX(stroke[i]!.x), mapY(stroke[i]!.y));
    ctx.stroke();
  }
  ctx.textBaseline = "bottom";
  for (const mark of texts) {
    ctx.font = `${Math.round(Math.max(8, mark.height * scale))}px ui-sans-serif, system-ui, sans-serif`;
    ctx.save();
    ctx.translate(mapX(mark.x), mapY(mark.y));
    ctx.rotate(-mark.rotation);
    ctx.fillText(mark.text, 0, 0);
    ctx.restore();
  }
  const file = await canvasToFile(canvas, name.replace(/\.dxf$/i, ".png"));
  return file ?? extractEmbeddedRaster(bytes, name);
}

async function rasterizeDxfLegacy(bytes: Uint8Array, name: string, text: string) {
  const lines = text.split(/\r?\n/);
  const drawing = new Drawing();
  let entity = "";
  let x = 0;
  let y = 0;
  let x2 = 0;
  let y2 = 0;
  let cx = 0;
  let cy = 0;
  let mx = 0;
  let my = 0;
  let radius = 0;
  let ratio = 1;
  let start = 0;
  let end = 0;
  let closed = false;
  let poly: Array<{ x: number; y: number }> = [];

  const flushPoly = () => {
    if (poly.length >= 2) {
      if (closed) poly.push(poly[0]!);
      drawing.strokes.push(poly); // vertices were charged as they arrived
    }
    poly = [];
    closed = false;
  };

  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim();
    const value = lines[i + 1]!.trim();
    if (code === "0") {
      if (entity === "LINE") drawing.stroke([{ x, y }, { x: x2, y: y2 }]);
      if (entity === "CIRCLE") drawing.stroke(circle(cx, cy, radius));
      if (entity === "ARC") drawing.stroke(arc(cx, cy, radius, start, end));
      if (entity === "ELLIPSE") drawing.stroke(ellipse(cx, cy, mx, my, ratio, start, end));
      if (entity === "SPLINE") flushPoly();
      if (entity === "SOLID" || entity === "TRACE" || entity === "3DFACE") {
        if (poly.length >= 3) drawing.fills.push(poly);
        poly = [];
      }
      if (entity === "LWPOLYLINE" || entity === "POLYLINE") flushPoly();
      entity = value;
      continue;
    }
    if (entity === "LINE") {
      if (code === "10") x = Number(value);
      if (code === "20") y = Number(value);
      if (code === "11") x2 = Number(value);
      if (code === "21") y2 = Number(value);
    }
    if (entity === "CIRCLE" || entity === "ARC") {
      if (code === "10") cx = Number(value);
      if (code === "20") cy = Number(value);
      if (code === "40") radius = Number(value);
      if (code === "50") start = Number(value);
      if (code === "51") end = Number(value);
    }
    if (entity === "ELLIPSE") {
      if (code === "10") cx = Number(value);
      if (code === "20") cy = Number(value);
      if (code === "11") mx = Number(value);
      if (code === "21") my = Number(value);
      if (code === "40") ratio = Number(value) || 1;
      if (code === "41") start = Number(value);
      if (code === "42") end = Number(value);
    }
    if (entity === "LWPOLYLINE" || entity === "POLYLINE" || entity === "VERTEX" || entity === "SPLINE" || entity === "SOLID" || entity === "TRACE" || entity === "3DFACE") {
      if (code === "70") closed = (Number(value) & 1) === 1;
      if (code === "10") x = Number(value);
      if (code === "20") {
        y = Number(value);
        // Charged per vertex: one polyline can hold millions before it is flushed.
        drawing.spend(1);
        poly.push({ x, y });
      }
    }
  }
  if (entity === "LINE") drawing.stroke([{ x, y }, { x: x2, y: y2 }]);
  if (entity === "CIRCLE") drawing.stroke(circle(cx, cy, radius));
  if (entity === "ARC") drawing.stroke(arc(cx, cy, radius, start, end));
  if (entity === "ELLIPSE") drawing.stroke(ellipse(cx, cy, mx, my, ratio, start, end));
  if (entity === "SOLID" || entity === "TRACE" || entity === "3DFACE") {
    if (poly.length >= 3) drawing.fills.push(poly);
    poly = [];
  }
  flushPoly();

  return paintDrawing(drawing, name, bytes, true);
}

function circle(cx: number, cy: number, radius: number) {
  const points: Array<{ x: number; y: number }> = [];
  const steps = 64;
  for (let i = 0; i <= steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return points;
}

function ellipse(cx: number, cy: number, mx: number, my: number, ratio: number, startParam: number, endParam: number) {
  const major = Math.hypot(mx, my) || 1;
  const angle = Math.atan2(my, mx);
  const start = Number.isFinite(startParam) ? startParam : 0;
  let end = Number.isFinite(endParam) && endParam !== 0 ? endParam : Math.PI * 2;
  if (end < start) end += Math.PI * 2;
  const steps = 64;
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = start + ((end - start) * i) / steps;
    const lx = Math.cos(t) * major;
    const ly = Math.sin(t) * major * (ratio || 1);
    points.push({
      x: cx + lx * Math.cos(angle) - ly * Math.sin(angle),
      y: cy + lx * Math.sin(angle) + ly * Math.cos(angle),
    });
  }
  return points;
}

function arc(cx: number, cy: number, radius: number, startDeg: number, endDeg: number) {
  return arcRad(cx, cy, radius, (startDeg * Math.PI) / 180, (endDeg * Math.PI) / 180);
}

function arcRad(cx: number, cy: number, radius: number, start: number, end: number) {
  let sweep = end - start;
  if (sweep < 0) sweep += Math.PI * 2;
  // Past one full turn an arc draws nothing new; the step count comes from the file,
  // so without this clamp an end angle of 1e8° asks for millions of points.
  sweep = Math.min(sweep, Math.PI * 2);
  const steps = Math.max(8, Math.round((sweep / (Math.PI * 2)) * 64));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i += 1) {
    const a = start + (sweep * i) / steps;
    points.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return points;
}
