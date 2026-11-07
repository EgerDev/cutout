/**
 * Fast Guided Filter for edge-preserving alpha matte refinement.
 *
 * Based on:
 * - Kaiming He, Jian Sun, and Xiaoou Tang, "Guided Image Filtering", TPAMI 2013.
 * - Kaiming He and Jian Sun, "Fast Guided Filter", arXiv:1505.00996, 2015.
 *
 * Given a high-resolution RGB guidance image and a coarse alpha matte (e.g. from
 * BiRefNet segmentation), the fast guided filter computes local linear coefficients
 * in a downsampled domain and reconstructs fine anti-aliased edge details (hair strands,
 * fur, whiskers) at full resolution in O(N) time with minimal memory footprint.
 */

export type GuidedFilterOptions = Readonly<{
  /**
   * Filter window radius at full resolution (default: 8).
   */
  radius?: number;

  /**
   * Regularization parameter preventing division by near-zero variance (default: 1e-3).
   */
  eps?: number;

  /**
   * Subsampling ratio s for the fast filter (default: 4, clamped adaptively for small images).
   */
  subsample?: number;
}>;

/**
 * 2D box filter computed via separable 1D sliding accumulation (horizontal then vertical)
 * in O(1) time per pixel, with exact normalization at image boundaries.
 */
export function boxFilter2D(
  src: Float32Array,
  dst: Float32Array,
  scratch: Float32Array,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Number.isFinite(radius) ? Math.max(0, Math.round(radius)) : 0;
  if (r === 0 || width <= 0 || height <= 0) {
    dst.set(src);
    return;
  }

  // Horizontal pass: src -> scratch
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    let sum = 0;
    const initialRight = Math.min(width - 1, r);
    for (let x = 0; x <= initialRight; x += 1) {
      sum += src[rowOffset + x]!;
    }
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - r);
      const right = Math.min(width - 1, x + r);
      scratch[rowOffset + x] = sum / (right - left + 1);

      if (x + r + 1 < width) sum += src[rowOffset + x + r + 1]!;
      if (x - r >= 0) sum -= src[rowOffset + x - r]!;
    }
  }

  // Vertical pass: scratch -> dst
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    const initialBottom = Math.min(height - 1, r);
    for (let y = 0; y <= initialBottom; y += 1) {
      sum += scratch[y * width + x]!;
    }
    for (let y = 0; y < height; y += 1) {
      const top = Math.max(0, y - r);
      const bottom = Math.min(height - 1, y + r);
      dst[y * width + x] = sum / (bottom - top + 1);

      if (y + r + 1 < height) sum += scratch[(y + r + 1) * width + x]!;
      if (y - r >= 0) sum -= scratch[(y - r) * width + x]!;
    }
  }
}

/**
 * Executes Fast Guided Filtering on a guidance image (RGB/RGBA) and input alpha mask.
 * Returns a Uint8ClampedArray of length width * height with the refined alpha matte [0, 255].
 */
export function fastGuidedFilter(
  guidance: Uint8ClampedArray | Uint8Array,
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  options: GuidedFilterOptions = {},
): Uint8ClampedArray {
  if (width <= 0 || height <= 0) return new Uint8ClampedArray(0);
  const guideStride = guidance.length >= width * height * 4 ? 4 : 3;
  const minGuideLen = width * height * guideStride;
  const alphaStride = alpha.length >= width * height * 4 ? 4 : 1;
  const minAlphaLen = width * height * (alphaStride === 4 ? 4 : 1);
  const outAlpha = new Uint8ClampedArray(width * height);
  if (guidance.length < minGuideLen || alpha.length < minAlphaLen) return outAlpha;

  const rawRadius = options.radius ?? 8;
  const radius = Math.max(1, Math.round(Number.isFinite(rawRadius) ? rawRadius : 8));
  const eps =
    typeof options.eps === "number" && Number.isFinite(options.eps) && options.eps > 0
      ? options.eps
      : 1e-3;

  // Adaptive subsampling ratio based on resolution and filter radius
  const rawSubsample = options.subsample;
  let s =
    typeof rawSubsample === "number" && Number.isFinite(rawSubsample) && rawSubsample > 0
      ? Math.round(rawSubsample)
      : 4;
  s = Math.min(s, Math.max(1, radius));
  if (width < 32 || height < 32) s = 1;
  else if (width < 64 || height < 64) s = Math.min(2, s);
  s = Math.max(1, Math.min(4, Math.floor(s)));

  const subW = Math.max(1, Math.floor(width / s));
  const subH = Math.max(1, Math.floor(height / s));
  const subR = Math.max(1, Math.round(radius / s));
  const n = subW * subH;

  const alphaOffset = alphaStride === 4 ? 3 : 0;

  const Ir = new Float32Array(n);
  const Ig = new Float32Array(n);
  const Ib = new Float32Array(n);
  const p = new Float32Array(n);
  const inv255 = 1 / 255;

  // Box-average downsample guidance and alpha
  for (let sy = 0; sy < subH; sy += 1) {
    const y0 = Math.floor((sy * height) / subH);
    const y1 = Math.min(height, Math.floor(((sy + 1) * height) / subH));
    const bh = Math.max(1, y1 - y0);

    for (let sx = 0; sx < subW; sx += 1) {
      const x0 = Math.floor((sx * width) / subW);
      const x1 = Math.min(width, Math.floor(((sx + 1) * width) / subW));
      const bw = Math.max(1, x1 - x0);
      const invBlock = (1 / (bw * bh)) * inv255;

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;

      for (let y = y0; y < y1; y += 1) {
        const rowG = y * width * guideStride;
        const rowA = y * width * alphaStride;
        for (let x = x0; x < x1; x += 1) {
          const gi = rowG + x * guideStride;
          const ai = rowA + x * alphaStride + alphaOffset;
          sr += guidance[gi]!;
          sg += guidance[gi + 1]!;
          sb += guidance[gi + 2]!;
          sa += alpha[ai]!;
        }
      }

      const si = sy * subW + sx;
      Ir[si] = sr * invBlock;
      Ig[si] = sg * invBlock;
      Ib[si] = sb * invBlock;
      p[si] = sa * invBlock;
    }
  }

  const boxScratch = new Float32Array(n);
  const mulScratch = new Float32Array(n);

  const filterTo = (srcArr: Float32Array, dstArr: Float32Array) => {
    boxFilter2D(srcArr, dstArr, boxScratch, subW, subH, subR);
  };
  const filterMulTo = (arrA: Float32Array, arrB: Float32Array, dstArr: Float32Array) => {
    for (let i = 0; i < n; i += 1) mulScratch[i] = arrA[i]! * arrB[i]!;
    boxFilter2D(mulScratch, dstArr, boxScratch, subW, subH, subR);
  };

  const meanIr = new Float32Array(n);
  const meanIg = new Float32Array(n);
  const meanIb = new Float32Array(n);
  const meanP = new Float32Array(n);
  filterTo(Ir, meanIr);
  filterTo(Ig, meanIg);
  filterTo(Ib, meanIb);
  filterTo(p, meanP);

  const meanIpR = new Float32Array(n);
  const meanIpG = new Float32Array(n);
  const meanIpB = new Float32Array(n);
  filterMulTo(Ir, p, meanIpR);
  filterMulTo(Ig, p, meanIpG);
  filterMulTo(Ib, p, meanIpB);

  const varIRR = new Float32Array(n);
  const varIRG = new Float32Array(n);
  const varIRB = new Float32Array(n);
  const varIGG = new Float32Array(n);
  const varIGB = new Float32Array(n);
  const varIBB = new Float32Array(n);
  filterMulTo(Ir, Ir, varIRR);
  filterMulTo(Ir, Ig, varIRG);
  filterMulTo(Ir, Ib, varIRB);
  filterMulTo(Ig, Ig, varIGG);
  filterMulTo(Ig, Ib, varIGB);
  filterMulTo(Ib, Ib, varIBB);

  // Reuse Ir, Ig, Ib, p for aR, aG, aB, b
  const aR = Ir;
  const aG = Ig;
  const aB = Ib;
  const b = p;

  for (let i = 0; i < n; i += 1) {
    const varR = Math.max(0, varIRR[i]! - meanIr[i]! * meanIr[i]!);
    const varG = Math.max(0, varIGG[i]! - meanIg[i]! * meanIg[i]!);
    const varB = Math.max(0, varIBB[i]! - meanIb[i]! * meanIb[i]!);

    const c00 = varR + eps;
    const c11 = varG + eps;
    const c22 = varB + eps;

    // Cauchy-Schwarz covariance clamp ensures positive semi-definite covariance matrix
    const maxC01 = Math.sqrt(varR * varG);
    const rawC01 = varIRG[i]! - meanIr[i]! * meanIg[i]!;
    const c01 = Math.max(-maxC01, Math.min(maxC01, rawC01));

    const maxC02 = Math.sqrt(varR * varB);
    const rawC02 = varIRB[i]! - meanIr[i]! * meanIb[i]!;
    const c02 = Math.max(-maxC02, Math.min(maxC02, rawC02));

    const maxC12 = Math.sqrt(varG * varB);
    const rawC12 = varIGB[i]! - meanIg[i]! * meanIb[i]!;
    const c12 = Math.max(-maxC12, Math.min(maxC12, rawC12));

    const A00 = c11 * c22 - c12 * c12;
    const A01 = c12 * c02 - c01 * c22;
    const A02 = c01 * c12 - c11 * c02;
    const A11 = c00 * c22 - c02 * c02;
    const A12 = c01 * c02 - c00 * c12;
    const A22 = c00 * c11 - c01 * c01;

    const det = c00 * A00 + c01 * A01 + c02 * A02;
    const invDet = det > 1e-15 ? 1 / det : 0;

    const cr = meanIpR[i]! - meanIr[i]! * meanP[i]!;
    const cg = meanIpG[i]! - meanIg[i]! * meanP[i]!;
    const cb = meanIpB[i]! - meanIb[i]! * meanP[i]!;

    const arVal = (A00 * cr + A01 * cg + A02 * cb) * invDet;
    const agVal = (A01 * cr + A11 * cg + A12 * cb) * invDet;
    const abVal = (A02 * cr + A12 * cg + A22 * cb) * invDet;

    aR[i] = arVal;
    aG[i] = agVal;
    aB[i] = abVal;
    b[i] = meanP[i]! - arVal * meanIr[i]! - agVal * meanIg[i]! - abVal * meanIb[i]!;
  }

  // Reuse varIRR, varIRG, varIRB, varIGG for meanAR, meanAG, meanAB, meanB
  const meanAR = varIRR;
  const meanAG = varIRG;
  const meanAB = varIRB;
  const meanB = varIGG;
  filterTo(aR, meanAR);
  filterTo(aG, meanAG);
  filterTo(aB, meanAB);
  filterTo(b, meanB);

  // Precompute horizontal interpolation coordinates and weights
  const x0Arr = new Int32Array(width);
  const x1Arr = new Int32Array(width);
  const fxArr = new Float32Array(width);
  const invWidth = subW / width;
  for (let x = 0; x < width; x += 1) {
    const u = (x + 0.5) * invWidth - 0.5;
    const x0 = Math.max(0, Math.min(subW - 1, Math.floor(u)));
    x0Arr[x] = x0;
    x1Arr[x] = Math.max(0, Math.min(subW - 1, x0 + 1));
    fxArr[x] = Math.max(0, Math.min(1, u - x0));
  }

  // Full-resolution reconstruction pass: q = a * I + b
  const invHeight = subH / height;
  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) * invHeight - 0.5;
    const y0 = Math.max(0, Math.min(subH - 1, Math.floor(v)));
    const y1 = Math.max(0, Math.min(subH - 1, y0 + 1));
    const fy = Math.max(0, Math.min(1, v - y0));
    const oneMinusFy = 1 - fy;

    const row0 = y0 * subW;
    const row1 = y1 * subW;
    const rowOut = y * width;
    const rowGuide = y * width * guideStride;

    for (let x = 0; x < width; x += 1) {
      const x0 = x0Arr[x]!;
      const x1 = x1Arr[x]!;
      const fx = fxArr[x]!;
      const oneMinusFx = 1 - fx;

      const w00 = oneMinusFx * oneMinusFy;
      const w10 = fx * oneMinusFy;
      const w01 = oneMinusFx * fy;
      const w11 = fx * fy;

      const i00 = row0 + x0;
      const i10 = row0 + x1;
      const i01 = row1 + x0;
      const i11 = row1 + x1;

      const ar = w00 * meanAR[i00]! + w10 * meanAR[i10]! + w01 * meanAR[i01]! + w11 * meanAR[i11]!;
      const ag = w00 * meanAG[i00]! + w10 * meanAG[i10]! + w01 * meanAG[i01]! + w11 * meanAG[i11]!;
      const ab = w00 * meanAB[i00]! + w10 * meanAB[i10]! + w01 * meanAB[i01]! + w11 * meanAB[i11]!;
      const bb = w00 * meanB[i00]! + w10 * meanB[i10]! + w01 * meanB[i01]! + w11 * meanB[i11]!;

      const gi = rowGuide + x * guideStride;
      const R = guidance[gi]! * inv255;
      const G = guidance[gi + 1]! * inv255;
      const B = guidance[gi + 2]! * inv255;

      const q = ar * R + ag * G + ab * B + bb;
      const rounded = Math.max(0, Math.min(255, Math.round(q * 255)));
      const alphaVal = rounded < 8 ? 0 : rounded;
      outAlpha[rowOut + x] = alphaVal;
    }
  }

  return outAlpha;
}

/**
 * Refines the alpha channel of an RGBA cutout buffer in-place using the source RGBA
 * guidance image. Pixels with zero alpha have their RGB components zeroed to prevent fringes.
 */
export function fastGuidedFilterRgba(
  cutoutRgba: Uint8ClampedArray,
  sourceRgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: GuidedFilterOptions = {},
): void {
  if (width <= 0 || height <= 0) return;
  if (cutoutRgba.length < width * height * 4 || sourceRgba.length < width * height * 4) return;
  const refinedAlpha = fastGuidedFilter(sourceRgba, cutoutRgba, width, height, options);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * width;
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = (rowOffset + x) * 4;
      const prevAlpha = cutoutRgba[pixelIndex + 3]!;
      const a = refinedAlpha[rowOffset + x]!;
      cutoutRgba[pixelIndex + 3] = a;
      if (a === 0) {
        cutoutRgba[pixelIndex] = 0;
        cutoutRgba[pixelIndex + 1] = 0;
        cutoutRgba[pixelIndex + 2] = 0;
      } else if (prevAlpha === 0 && a > 0) {
        cutoutRgba[pixelIndex] = sourceRgba[pixelIndex]!;
        cutoutRgba[pixelIndex + 1] = sourceRgba[pixelIndex + 1]!;
        cutoutRgba[pixelIndex + 2] = sourceRgba[pixelIndex + 2]!;
      }
    }
  }
}
