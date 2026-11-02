import { canvas2d, encodeCanvas } from "./canvas.ts";

/** Alpha channel of a cutout blob, resampled to `width` x `height`. */
export async function readAlpha(blob: Blob, width: number, height: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(blob);
  const { canvas, context } = canvas2d(width, height, { willReadFrequently: true });
  try {
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const alpha = new Uint8Array(canvas.width * canvas.height);
    for (let i = 3, p = 0; i < data.length; i += 4, p += 1) alpha[p] = data[i]!;
    return alpha;
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * The pixels of `image` under the alpha of `matte`, scaled to `width` x
 * `height` with smoothing: an upscaled source keeps its existing cutout.
 */
export async function maskWith(
  image: Blob,
  matte: Blob,
  width: number,
  height: number,
): Promise<Blob> {
  const bitmaps: ImageBitmap[] = [];
  let finished = false;
  const decode = async (blob: Blob) => {
    const bitmap = await createImageBitmap(blob);
    // Promise.all can reject before its sibling finishes decoding.
    if (finished) bitmap.close();
    else bitmaps.push(bitmap);
    return bitmap;
  };
  let canvas: HTMLCanvasElement | undefined;
  try {
    const [picture, mask] = await Promise.all([decode(image), decode(matte)]);
    const made = canvas2d(width, height);
    canvas = made.canvas;
    const { context } = made;
    context.imageSmoothingQuality = "high";
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    context.globalCompositeOperation = "destination-in";
    context.drawImage(mask, 0, 0, canvas.width, canvas.height);
    return await encodeCanvas(canvas);
  } finally {
    finished = true;
    for (const bitmap of bitmaps) bitmap.close();
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
