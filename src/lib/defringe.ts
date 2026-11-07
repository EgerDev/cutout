import { canvas2d, encodeCanvas, readPixels } from "./editor/canvas.ts";
import {
  colorToAlpha,
  dist2 as dist2rgb,
  hasContinuousTonalShading,
  sampleBorder,
  stripPaper,
  tonalConcentration,
  unblendRgb,
} from "./graphics.ts";
import { unblendMatteGpu } from "./gpu-matte.ts";
import { boxFilter2D, fastGuidedFilterRgba } from "./guided-filter.ts";

type EdgeRect = { x: number; y: number; width: number; height: number };

export type EdgeResult = Readonly<{
  /** The input, untouched, when no edge op ran. */
  blob: Blob | null;
  /** The edited pixels, ready to draw; a PNG is only made on `encode()`. */
  bitmap: ImageBitmap | null;
  encode: () => Promise<Blob>;
  width: number;
  height: number;
  bounds: EdgeRect | null;
  empty: boolean;
}>;

const REFINE_PIXEL_CAP = 2_500_000;
const GRID = 16;

type Rgb = { r: number; g: number; b: number };

export type Scene = {
  field: Rgb;
  jpeg: boolean;
  isGraphic: boolean;
  hasBlankField: boolean;
  maskWorked: boolean;
  exactTol2: number;
  nearTol2: number;
};

/**
 * Applies feather/choke and returns the encoded blob together with the alpha
 * bounds read from the pixel data this function already holds, so callers
 * avoid a second full decode + per-pixel scan.
 */
export async function applyEdgeDetailed(
  blob: Blob,
  feather: number,
  choke: number,
): Promise<EdgeResult> {
  const passthrough = (): EdgeResult => ({
    blob,
    bitmap: null,
    encode: async () => blob,
    width: 0,
    height: 0,
    bounds: null,
    empty: false,
  });
  if (!feather && !choke) return passthrough();
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  const read = readPixels(bitmap, width, height);
  bitmap.close();
  if (!read) return passthrough();
  const { image } = read;
  // Pixels are in `image` now; free the readback canvas before the choke/blur buffers exist.
  read.canvas.width = 0;
  read.canvas.height = 0;
  const data = image.data;
  if (choke) shiftAlpha(data, width, height, choke);
  if (feather) blurAlpha(data, width, height, feather);
  zeroRgbIfTransparent(data);
  const probed = alphaBounds(data, width, height);
  // Live previews draw the bitmap straight away; exports encode it once when
  // asked. Taken from the canvas rather than the ImageData so the bitmap is
  // GPU-backed: one made from raw pixels drew about ten times slower.
  // This canvas is not marked for readback, so the bitmap lands in GPU memory.
  const upload = canvas2d(width, height);
  upload.context.putImageData(image, 0, 0);
  const edited = await createImageBitmap(upload.canvas);
  upload.canvas.width = 0;
  upload.canvas.height = 0;
  let encoded: Promise<Blob> | null = null;
  const encode = () =>
    (encoded ??= (async () => {
      const out = canvas2d(width, height);
      out.context.drawImage(edited, 0, 0);
      try {
        return await encodeCanvas(out.canvas);
      } finally {
        out.canvas.width = 0;
        out.canvas.height = 0;
      }
    })());
  return { blob: null, bitmap: edited, encode, width, height, ...probed };
}

/** The box around every pixel with alpha over 8; the full frame, `empty`, when there is none. */
export function alphaBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { bounds: EdgeRect; empty: boolean } {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if ((data[(row + x) * 4 + 3] ?? 0) > 8) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
    }
  }
  if (right < left) return { bounds: { x: 0, y: 0, width, height }, empty: true };
  return {
    bounds: { x: left, y: top, width: right - left + 1, height: bottom - top + 1 },
    empty: false,
  };
}

function shiftAlpha(data: Uint8ClampedArray, width: number, height: number, amount: number) {
  const radius = Math.abs(Math.round(amount));
  if (!radius) return;
  const grow = amount > 0;
  const src = new Uint8Array(width * height);
  for (let p = 0, i = 3; p < src.length; p += 1, i += 4) src[p] = data[i]!;
  const tmp = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const x0 = x - radius < 0 ? 0 : x - radius;
      const x1 = x + radius >= width ? width - 1 : x + radius;
      let extreme = grow ? 0 : 255;
      for (let nx = x0; nx <= x1; nx += 1) {
        const a = src[row + nx]!;
        extreme = grow ? (a > extreme ? a : extreme) : a < extreme ? a : extreme;
      }
      tmp[row + x] = extreme;
    }
  }
  for (let y = 0; y < height; y += 1) {
    const y0 = y - radius < 0 ? 0 : y - radius;
    const y1 = y + radius >= height ? height - 1 : y + radius;
    for (let x = 0; x < width; x += 1) {
      let extreme = grow ? 0 : 255;
      for (let ny = y0; ny <= y1; ny += 1) {
        const a = tmp[ny * width + x]!;
        extreme = grow ? (a > extreme ? a : extreme) : a < extreme ? a : extreme;
      }
      const p = y * width + x;
      const i = p * 4;
      data[i + 3] = extreme;
      if (grow && src[p]! === 0 && extreme > 0) {
        fillRgbFromOpaque(data, src, width, height, x, y, radius + 2);
      }
    }
  }
}

/**
 * Colors a newly-grown pixel with the average of the nearest ring of opaque
 * pixels. Searching ring by ring exits after ~8 checks for pixels adjacent to
 * the subject, instead of always scanning the full (2r+2)^2 window, which
 * previously froze the tab on masks with many interior holes.
 */
function fillRgbFromOpaque(
  data: Uint8ClampedArray,
  originalAlpha: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
) {
  for (let ring = 1; ring <= radius; ring += 1) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let dy = -ring; dy <= ring; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -ring; dx <= ring; dx += 1) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const p = ny * width + nx;
        if (!originalAlpha[p]) continue;
        const i = p * 4;
        r += data[i]!;
        g += data[i + 1]!;
        b += data[i + 2]!;
        n += 1;
      }
    }
    if (n) {
      const i = (y * width + x) * 4;
      data[i] = r / n;
      data[i + 1] = g / n;
      data[i + 2] = b / n;
      return;
    }
  }
}

function blurAlpha(data: Uint8ClampedArray, width: number, height: number, radius: number) {
  const src = new Float32Array(width * height);
  for (let p = 0, i = 3; p < src.length; p += 1, i += 4) src[p] = data[i]!;
  const scratch = new Float32Array(width * height);
  boxFilter2D(src, src, scratch, width, height, Math.max(1, Math.round(radius)));
  for (let p = 0, i = 3; p < src.length; p += 1, i += 4) data[i] = src[p]!;
}

/** E01-01: a cutout is never more opaque than its source. The identity on an opaque source. */
export function capToSourceAlpha(dst: Uint8ClampedArray, src: Uint8ClampedArray) {
  for (let i = 3; i < dst.length; i += 4) if (dst[i]! > src[i]!) dst[i] = src[i]!;
}

export function zeroRgbIfTransparent(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) if (!data[i + 3]) data.fill(0, i, i + 3);
}

/**
 * Cleans a matte already in memory and encodes it: the model path hands its
 * pixels straight here, so a 12 MP photo is never written to PNG and read
 * back between inference and edge cleaning. Mutates `cutoutData`.
 */
export async function finishCutoutData(
  cutoutData: ImageData,
  sourceData: ImageData,
  options: { jpeg: boolean },
): Promise<Blob> {
  const { width, height } = cutoutData;
  const scene = processCutout(cutoutData.data, sourceData.data, width, height, {
    refine: true,
    jpeg: options.jpeg,
    skipUnblend: true,
  });
  if (scene.hasBlankField) {
    const grid = buildBackdropGrid(cutoutData.data, sourceData.data, width, height, scene.field);
    const gpu = await unblendMatteGpu(cutoutData, sourceData, scene, grid);
    if (!gpu) unblendSpill(cutoutData.data, sourceData.data, width, height, grid, scene);
  }
  // Edge refinement and unblending may raise alpha; never above what the source carried.
  capToSourceAlpha(cutoutData.data, sourceData.data);
  zeroRgbIfTransparent(cutoutData.data);
  const { canvas, context } = canvas2d(width, height, { willReadFrequently: true });
  try {
    context.putImageData(cutoutData, 0, 0);
    return await encodeCanvas(canvas);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function processCutout(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  options: { refine: boolean; jpeg: boolean; skipUnblend?: boolean },
) {
  for (let i = 0; i < dst.length; i += 4) {
    dst[i] = src[i]!;
    dst[i + 1] = src[i + 1]!;
    dst[i + 2] = src[i + 2]!;
    const a = Math.min(dst[i + 3]!, src[i + 3]!);
    dst[i + 3] = a < 8 ? 0 : a;
  }
  const scene = analyzeScene(src, dst, width, height, options.jpeg);
  if (scene.isGraphic) {
    for (let i = 3; i < dst.length; i += 4) {
      if (dst[i]! < 20) dst[i] = 0;
    }
  }
  if (options.refine) {
    if (scene.isGraphic) {
      refineTwoStage(dst, src, width, height, scene);
    } else {
      fastGuidedFilterRgba(dst, src, width, height);
    }
  }
  if (scene.isGraphic) stripPaper(dst, width, height, scene.field, { jpeg: scene.jpeg });
  const artifactGrid = buildBackdropGrid(dst, src, width, height, scene.field);
  // Photos only: a scan's faint ink is also a uniform darkening of the page —
  // attenuating it would erase legitimate marks.
  if (!scene.isGraphic) suppressContactShadow(dst, src, width, height, artifactGrid);
  if (!options.skipUnblend && scene.hasBlankField) {
    unblendSpill(dst, src, width, height, artifactGrid, scene);
  }
  return scene;
}

/** Shadows multiply the backdrop's colour; bleed mixes the subject's. A matte
 *  pixel whose colour is a near-uniform darkening of the local backdrop in a
 *  locally flat area is a contact-shadow remnant — attenuate it. The
 *  per-channel ratio must agree (hair and fur blend two hues and fail it) and
 *  the 5×5 neighbourhood must be smooth: real subject edges live at textured
 *  boundaries, floor shadows under chairs and wheels are smooth gradients.
 *  Only pixels that touch the transparent exterior qualify: a shadow clings to
 *  the matte's outer fringe, while a dark translucent subject (a tinted pane,
 *  sunglass lenses) is a partial-alpha mass whose interior never does —
 *  without this gate that interior is indistinguishable from shadow. */
export function suppressContactShadow(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  grid: BackdropGrid,
) {
  for (let y = 2; y < height - 2; y += 1) {
    const row = y * width;
    for (let x = 2; x < width - 2; x += 1) {
      const i = (row + x) * 4;
      const a = dst[i + 3]!;
      if (a <= 8 || a >= 235) continue;
      const bg = grid.lookup(x, y);
      let kMin = 1;
      let kMax = 0;
      let valid = 0;
      for (let c = 0; c < 3; c += 1) {
        const base = c === 0 ? bg.r : c === 1 ? bg.g : bg.b;
        if (base <= 16) continue;
        valid += 1;
        const k = src[i + c]! / base;
        if (k < 0.3 || k > 0.96) {
          kMin = -1;
          break;
        }
        if (k < kMin) kMin = k;
        if (k > kMax) kMax = k;
      }
      if (valid < 2 || kMin < 0 || kMax - kMin > 0.12) continue;
      let sum = 0;
      let sumSq = 0;
      let touchesClear = false;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const j = ((y + dy) * width + x + dx) * 4;
          const l = 0.2126 * src[j]! + 0.7152 * src[j + 1]! + 0.0722 * src[j + 2]!;
          sum += l;
          sumSq += l * l;
          if (dst[j + 3]! <= 8) touchesClear = true;
        }
      }
      const variance = sumSq / 25 - (sum / 25) * (sum / 25);
      if (!touchesClear || variance > 64) continue;
      const attenuated = (a * 0.12) | 0;
      dst[i + 3] = attenuated < 8 ? 0 : attenuated;
    }
  }
}

function analyzeScene(
  src: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  jpeg: boolean,
): Scene {
  const field = sampleBorder(src, width, height);
  let transparent = 0;
  let opaque = 0;
  let fieldHits = 0;
  let fgN = 0;
  let chromaticFg = 0;
  const seen = new Uint8Array(4096);
  let unique = 0;
  const fgTones = new Uint32Array(16);
  const fineTones = new Uint32Array(256);
  const near = jpeg ? 40 : 28;
  const near2 = near * near;
  const pixels = src.length / 4;
  for (let p = 0; p < pixels; p += 4) {
    // Vary the sampling phase by row; a fixed stride aliases narrow grayscale gradients.
    const i = Math.min(p + (Math.floor(p / width) % 4), pixels - 1) * 4;
    const r = src[i]!;
    const g = src[i + 1]!;
    const b = src[i + 2]!;
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    if (!seen[key]) {
      seen[key] = 1;
      unique += 1;
    }
    const a = mask[i + 3]!;
    if (a < 24) transparent += 1;
    else if (a > 200) opaque += 1;
    if (dist2rgb(r, g, b, field) <= near2) fieldHits += 1;
    if (a > 200 && dist2rgb(r, g, b, field) > near2) {
      fgN += 1;
      const tone = Math.round(luma(r, g, b));
      fgTones[tone >> 4] += 1;
      fineTones[tone] += 1;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      if (chroma > 18) chromaticFg += 1;
    }
  }
  const samples = Math.max(1, (src.length / 16) | 0);
  const transparentFrac = transparent / samples;
  const fieldFrac = fieldHits / samples;
  const hasBlankField = field.coverage >= 0.5 && field.std <= (jpeg ? 26 : 16) && fieldFrac > 0.08;
  const chromaticFrac = chromaticFg / Math.max(1, fgN);
  const fieldChroma = Math.max(field.r, field.g, field.b) - Math.min(field.r, field.g, field.b);
  const fieldY = 0.2126 * field.r + 0.7152 * field.g + 0.0722 * field.b;
  // Greys all share one colour bucket, so the unique count alone reads a black-and-white
  // photo as a logo; the tonal gate asks whether the subject is flat ink or shaded.
  const isGraphic =
    hasBlankField &&
    fieldY >= 200 &&
    fieldChroma <= 22 &&
    unique <= 48 &&
    chromaticFrac <= 0.08 &&
    tonalConcentration(fgTones, fgN) >= 0.9 &&
    !hasContinuousTonalShading(fineTones, fgN);
  const exact = jpeg ? 16 : 9;
  return {
    field: { r: field.r, g: field.g, b: field.b },
    jpeg,
    isGraphic,
    hasBlankField,
    maskWorked: transparentFrac > 0.06 && opaque > samples * 0.02,
    exactTol2: exact * exact,
    nearTol2: near2,
  };
}

/** Graphics only: `processCutout` calls it for `scene.isGraphic`, which implies a blank
 *  field for edgeSnap to snap to. */
export function refineTwoStage(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scene: Scene,
  cap = REFINE_PIXEL_CAP,
) {
  if (width * height <= cap) {
    knockField(dst, src, width, height, scene);
    recoverMarks(dst, src, width, height, scene);
    edgeSnap(dst, src, width, height, scene);
    return;
  }
  const scale = Math.sqrt(cap / (width * height));
  const smallW = Math.min(width, Math.max(Math.min(64, width), Math.round(width * scale)));
  const smallH = Math.min(height, Math.max(Math.min(64, height), Math.round(height * scale)));
  const smallSrc = downsampleRgba(src, width, height, smallW, smallH);
  const smallDst = downsampleRgba(dst, width, height, smallW, smallH);
  knockField(smallDst, smallSrc, smallW, smallH, scene);
  recoverMarks(smallDst, smallSrc, smallW, smallH, scene);
  stripPaper(smallDst, smallW, smallH, scene.field, { jpeg: scene.jpeg });
  edgeSnap(smallDst, smallSrc, smallW, smallH, scene);
  upsampleAlpha(smallDst, smallW, smallH, dst, width, height);
}

export function downsampleRgba(
  src: Uint8ClampedArray,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
) {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return new Uint8ClampedArray(0);
  const dst = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y += 1) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / dh));
    for (let x = 0; x < dw; x += 1) {
      const sx = Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / dw));
      const si = (sy * sw + sx) * 4;
      const di = (y * dw + x) * 4;
      dst[di] = src[si]!;
      dst[di + 1] = src[si + 1]!;
      dst[di + 2] = src[si + 2]!;
      dst[di + 3] = src[si + 3]!;
    }
  }
  return dst;
}

export function upsampleAlpha(
  small: Uint8ClampedArray,
  sw: number,
  sh: number,
  dest: Uint8ClampedArray,
  dw: number,
  dh: number,
) {
  if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
  for (let y = 0; y < dh; y += 1) {
    const fy = ((y + 0.5) * sh) / dh - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1));
    const ty = fy - y0;
    for (let x = 0; x < dw; x += 1) {
      const fx = ((x + 0.5) * sw) / dw - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1));
      const tx = fx - x0;
      const a00 = small[(y0 * sw + x0) * 4 + 3]!;
      const a10 = small[(y0 * sw + x1) * 4 + 3]!;
      const a01 = small[(y1 * sw + x0) * 4 + 3]!;
      const a11 = small[(y1 * sw + x1) * 4 + 3]!;
      const a =
        a00 * (1 - tx) * (1 - ty) + a10 * tx * (1 - ty) + a01 * (1 - tx) * ty + a11 * tx * ty;
      dest[(y * dw + x) * 4 + 3] = a;
    }
  }
}

/** Knock leftover paper color off a graphic's mask.
 *  Seeds from the frame and from already-clear holes, then walks (8-connected)
 *  every pixel that still matches the sampled paper, so letter holes survive.
 */
function knockField(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scene: Scene,
) {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  let top = 0;
  const push = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = y * width + x;
    if (visited[p]) return;
    const i = p * 4;
    if (dist2rgb(src[i]!, src[i + 1]!, src[i + 2]!, scene.field) > scene.nearTol2) return;
    visited[p] = 1;
    stack[top++] = p;
  };
  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }
  for (let p = 0, i = 3; p < visited.length; p += 1, i += 4) {
    if (dst[i]! < 24) push(p % width, (p / width) | 0);
  }
  while (top > 0) {
    const p = stack[--top]!;
    const x = p % width;
    const y = (p / width) | 0;
    dst.fill(0, p * 4, p * 4 + 4);
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
    push(x - 1, y - 1);
    push(x + 1, y - 1);
    push(x - 1, y + 1);
    push(x + 1, y + 1);
  }
  for (let i = 0; i < dst.length; i += 4) {
    if (dst[i + 3]! === 0) continue;
    if (dist2rgb(src[i]!, src[i + 1]!, src[i + 2]!, scene.field) > scene.nearTol2) continue;
    const alpha = colorToAlpha(src[i]!, src[i + 1]!, src[i + 2]!, scene.field);
    if (alpha.a < 18) {
      dst.fill(0, i, i + 4);
    } else {
      dst[i] = alpha.r;
      dst[i + 1] = alpha.g;
      dst[i + 2] = alpha.b;
      dst[i + 3] = alpha.a;
    }
  }
}

function recoverMarks(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scene: Scene,
) {
  const recover2 = Math.max(scene.nearTol2 * 1.6, 40 * 40);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (dst[i + 3]!) continue;
      if (dist2rgb(src[i]!, src[i + 1]!, src[i + 2]!, scene.field) < recover2) continue;
      if (colorToAlpha(src[i]!, src[i + 1]!, src[i + 2]!, scene.field).a < 200) continue;
      let support = 0;
      for (let oy = -1; oy <= 1; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -1; ox <= 1; ox += 1) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const ni = (ny * width + nx) * 4;
          if (dst[ni + 3]! > 160) support += 2;
          else if (dist2rgb(src[ni]!, src[ni + 1]!, src[ni + 2]!, scene.field) >= recover2)
            support += 1;
        }
      }
      if (support < 2) continue;
      dst[i] = src[i]!;
      dst[i + 1] = src[i + 1]!;
      dst[i + 2] = src[i + 2]!;
      dst[i + 3] = 255;
    }
  }
}

function edgeSnap(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  scene: Scene,
) {
  const copy = new Uint8ClampedArray(dst);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = copy[i + 3]!;
      if (a === 0) continue;
      let bgR = 0;
      let bgG = 0;
      let bgB = 0;
      let bgN = 0;
      let fgR = 0;
      let fgG = 0;
      let fgB = 0;
      let fgN = 0;
      let low = 0;
      for (let oy = -2; oy <= 2; oy += 1) {
        const ny = y + oy;
        if (ny < 0 || ny >= height) continue;
        for (let ox = -2; ox <= 2; ox += 1) {
          if (!ox && !oy) continue;
          const nx = x + ox;
          if (nx < 0 || nx >= width) continue;
          const ni = (ny * width + nx) * 4;
          const na = copy[ni + 3]!;
          if (na < 40) {
            low += 1;
            bgR += src[ni]!;
            bgG += src[ni + 1]!;
            bgB += src[ni + 2]!;
            bgN += 1;
          } else if (
            na > 220 &&
            dist2rgb(copy[ni]!, copy[ni + 1]!, copy[ni + 2]!, scene.field) > scene.exactTol2
          ) {
            fgR += copy[ni]!;
            fgG += copy[ni + 1]!;
            fgB += copy[ni + 2]!;
            fgN += 1;
          }
        }
      }
      if (!low) continue;
      const sr = src[i]!;
      const sg = src[i + 1]!;
      const sb = src[i + 2]!;
      const bR = bgN ? bgR / bgN : scene.field.r;
      const bG = bgN ? bgG / bgN : scene.field.g;
      const bB = bgN ? bgB / bgN : scene.field.b;
      const dB = dist2rgb(sr, sg, sb, { r: bR, g: bG, b: bB });
      if (fgN) {
        const fR = fgR / fgN;
        const fG = fgG / fgN;
        const fB = fgB / fgN;
        const dF = dist2rgb(sr, sg, sb, { r: fR, g: fG, b: fB });
        if (dB + 80 < dF || (dB <= scene.exactTol2 && dB <= dF)) {
          if (!scene.maskWorked || a < 220) {
            dst.fill(0, i, i + 4);
            continue;
          }
        }
        const mix = mixAmount(sr, sg, sb, fR, fG, fB, bR, bG, bB);
        if (mix < 0.07) {
          if (!scene.maskWorked || a < 220) {
            dst.fill(0, i, i + 4);
            continue;
          }
        }
        if (mix < 0.97) {
          const un = unblendRgb(sr, sg, sb, bR, bG, bB, mix);
          dst[i] = un.r;
          dst[i + 1] = un.g;
          dst[i + 2] = un.b;
          dst[i + 3] = mix * 255;
          continue;
        }
        dst[i] = sr;
        dst[i + 1] = sg;
        dst[i + 2] = sb;
        dst[i + 3] = 255;
        continue;
      }
      if (dB <= scene.nearTol2) {
        const cta = colorToAlpha(sr, sg, sb, { r: bR, g: bG, b: bB });
        if (cta.a < 20) {
          if (!scene.maskWorked || a < 220) dst.fill(0, i, i + 4);
        } else if (cta.a < a) {
          dst[i] = cta.r;
          dst[i + 1] = cta.g;
          dst[i + 2] = cta.b;
          dst[i + 3] = cta.a;
        }
      }
    }
  }
}

export function unblendSpill(
  dst: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  grid: BackdropGrid,
  scene: Scene,
) {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const a = dst[i + 3]!;
      if (a === 0) {
        dst.fill(0, i, i + 3);
        continue;
      }
      const sr = src[i]!;
      const sg = src[i + 1]!;
      const sb = src[i + 2]!;
      const bg = grid.lookup(x, y);
      if (a >= 250) {
        if (scene.isGraphic) {
          const cta = colorToAlpha(sr, sg, sb, bg);
          if (cta.a < 40) {
            dst.fill(0, i, i + 4);
            continue;
          }
          if (cta.a < 250) {
            dst[i] = cta.r;
            dst[i + 1] = cta.g;
            dst[i + 2] = cta.b;
            dst[i + 3] = cta.a;
            continue;
          }
        }
        dst[i] = sr;
        dst[i + 1] = sg;
        dst[i + 2] = sb;
        dst[i + 3] = 255;
        continue;
      }
      const dB = dist2rgb(sr, sg, sb, bg);
      if ((scene.isGraphic || scene.hasBlankField) && dB <= scene.exactTol2) {
        if (!scene.maskWorked || a < 220) {
          dst.fill(0, i, i + 4);
          continue;
        }
      }
      const t = a / 255;
      const un = unblendRgb(sr, sg, sb, bg.r, bg.g, bg.b, t);
      dst[i] = un.r;
      dst[i + 1] = un.g;
      dst[i + 2] = un.b;
    }
  }
}

export type BackdropGrid = {
  lookup: (x: number, y: number) => Rgb;
  /** Cell size in pixels. */
  cell: number;
  gridW: number;
  gridH: number;
  /** Interleaved r, g, b per cell, row-major, in 0..255. */
  cells: Float32Array<ArrayBuffer>;
};

export function buildBackdropGrid(
  mask: Uint8ClampedArray,
  src: Uint8ClampedArray,
  width: number,
  height: number,
  fallback: Rgb,
): BackdropGrid {
  const gridW = Math.ceil(width / GRID);
  const gridH = Math.ceil(height / GRID);
  const r = new Float32Array(gridW * gridH);
  const g = new Float32Array(gridW * gridH);
  const b = new Float32Array(gridW * gridH);
  const n = new Uint32Array(gridW * gridH);
  for (let y = 0; y < height; y += 1) {
    const cy = (y / GRID) | 0;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (mask[i + 3]! > 32) continue;
      const c = cy * gridW + ((x / GRID) | 0);
      r[c] += src[i]!;
      g[c] += src[i + 1]!;
      b[c] += src[i + 2]!;
      n[c] += 1;
    }
  }
  for (let c = 0; c < n.length; c += 1) {
    const count = n[c]!;
    if (!count) continue;
    r[c] /= count;
    g[c] /= count;
    b[c] /= count;
  }
  const filled = new Uint8Array(n.length);
  const queue = new Int32Array(n.length);
  let qh = 0;
  let qt = 0;
  for (let c = 0; c < n.length; c += 1) {
    if (!n[c]) continue;
    filled[c] = 1;
    queue[qt++] = c;
  }
  if (!qt) {
    r.fill(fallback.r);
    g.fill(fallback.g);
    b.fill(fallback.b);
  } else {
    while (qh < qt) {
      const c = queue[qh++]!;
      const cx = c % gridW;
      const cy = (c / gridW) | 0;
      const spread = (nx: number, ny: number) => {
        if (nx < 0 || ny < 0 || nx >= gridW || ny >= gridH) return;
        const ni = ny * gridW + nx;
        if (filled[ni]) return;
        filled[ni] = 1;
        r[ni] = r[c]!;
        g[ni] = g[c]!;
        b[ni] = b[c]!;
        queue[qt++] = ni;
      };
      spread(cx - 1, cy);
      spread(cx + 1, cy);
      spread(cx, cy - 1);
      spread(cx, cy + 1);
    }
  }
  const cells = new Float32Array(n.length * 3);
  for (let c = 0; c < n.length; c += 1) {
    cells[c * 3] = r[c]!;
    cells[c * 3 + 1] = g[c]!;
    cells[c * 3 + 2] = b[c]!;
  }
  return {
    lookup(x: number, y: number) {
      const c = Math.min(gridH - 1, (y / GRID) | 0) * gridW + Math.min(gridW - 1, (x / GRID) | 0);
      return { r: r[c]!, g: g[c]!, b: b[c]! };
    },
    cell: GRID,
    gridW,
    gridH,
    cells,
  };
}

function mixAmount(
  sr: number,
  sg: number,
  sb: number,
  fr: number,
  fg: number,
  fb: number,
  br: number,
  bg: number,
  bb: number,
) {
  const fbr = fr - br;
  const fbg = fg - bg;
  const fbb = fb - bb;
  const denom = fbr * fbr + fbg * fbg + fbb * fbb;
  if (denom < 1) return dist2rgb(sr, sg, sb, { r: br, g: bg, b: bb }) > 36 ? 1 : 0;
  const t = ((sr - br) * fbr + (sg - bg) * fbg + (sb - bb) * fbb) / denom;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t;
}

function luma(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
