import { encodeBmp } from "./bmp.ts";
import { CutoutError } from "./errors.ts";
import { concat, muxHeif, type StillItem } from "./heif-mux.ts";

export async function encodeStill(
  canvas: HTMLCanvasElement,
  mime: string,
  quality = 0.92,
): Promise<Blob> {
  if (mime === "image/bmp") return bmpFromCanvas(canvas);
  if (mime === "image/heic") return heifFromCanvas(canvas, "heic", quality);
  if (mime === "image/avif") return heifFromCanvas(canvas, "avif", quality);
  throw new Error("This browser cannot encode the selected format. Choose PNG.");
}

function bmpFromCanvas(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas is unavailable. Try another browser.");
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return encodeBmp(image.data, image.width, image.height);
}

async function heifFromCanvas(canvas: HTMLCanvasElement, kind: "heic" | "avif", quality: number) {
  try {
    const codec = kind === "heic" ? "hvc1.1.6.L93.B0" : "av01.0.04M.08";
    const type = kind === "heic" ? "hvc1" : "av01";
    // Padding plus clap loses AVIF edge pixels in Apple decoders. Require actual-size
    // support (checked by encodeLayer), rather than returning that unsafe fallback.
    // HEVC retains its existing even 4:2:0 route.
    const width = kind === "avif" ? canvas.width : canvas.width + (canvas.width % 2);
    const height = kind === "avif" ? canvas.height : canvas.height + (canvas.height % 2);
    const { samples, opaque, ...color } = await encodeLayer(
      canvas,
      codec,
      width,
      height,
      quality,
      false,
    );
    const size = { width, height, displayWidth: canvas.width, displayHeight: canvas.height };
    const colorItem: StillItem = { type, ...size, ...color, channels: 3 };
    let alphaItem: StillItem | null = null;
    // An actually opaque AVIF needs no auxiliary stream. The unnecessary alpha item
    // was nonconforming and lost odd edges in Apple decoders even on opaque images.
    if (kind === "heic" || !opaque) {
      const { description, data } = await encodeLayer(canvas, codec, width, height, quality, true);
      alphaItem = { type, ...size, description, data, channels: 1 };
    }
    const file = muxHeif(kind, colorItem, alphaItem);
    await verifyStill(file, kind, samples);
    return file;
  } catch (cause) {
    if (cause instanceof CutoutError) throw cause;
    throw new CutoutError(
      "export",
      `This browser couldn’t encode ${kind.toUpperCase()} at ${canvas.width} × ${canvas.height}. Try different export dimensions or choose PNG${kind === "heic" ? " or AVIF" : ""}.`,
      false,
      { cause },
    );
  }
}

export type StillSample = Readonly<{
  x: number;
  y: number;
  rgba: readonly number[];
  colour: boolean;
}>;

const PATCH = 3;

/**
 * Up to one clear, one mid-alpha and one opaque pixel of a `width` x `height` image (rows
 * `stride` px apart) to check the decoded export against. Each is the centre of a 7x7
 * patch of near-equal alpha, which lossy coding keeps; `colour` says the patch's colour
 * is flat too, so the decoded colour can be checked as well. Big images are scanned on a
 * grid of about 250k points.
 */
export function pickSamples(
  data: Uint8ClampedArray,
  stride: number,
  width: number,
  height: number,
): StillSample[] {
  const step = Math.max(1, Math.ceil(Math.sqrt((width * height) / 250_000)));
  const found: (StillSample | undefined)[] = [];
  const settled = (kind: number) => (kind === 0 ? Boolean(found[0]) : Boolean(found[kind]?.colour));
  for (let y = PATCH; y < height - PATCH; y += step) {
    if (settled(0) && settled(1) && settled(2)) break;
    for (let x = PATCH; x < width - PATCH; x += step) {
      const i = (y * stride + x) * 4;
      const a = data[i + 3]!;
      const kind = a === 0 ? 0 : a === 255 ? 2 : a >= 64 && a <= 192 ? 1 : -1;
      if (kind < 0 || settled(kind)) continue;
      const flat = flatness(data, stride, x, y);
      if (!flat || (found[kind] && flat < 2)) continue;
      found[kind] = { x, y, rgba: [...data.subarray(i, i + 4)], colour: kind > 0 && flat === 2 };
    }
  }
  return found.filter((sample) => sample !== undefined);
}

/** 0: the patch's alpha varies; 1: only its alpha is flat; 2: its colour is flat too. */
function flatness(data: Uint8ClampedArray, stride: number, x: number, y: number) {
  const c = (y * stride + x) * 4;
  let colour = true;
  for (let dy = -PATCH; dy <= PATCH; dy += 1)
    for (let dx = -PATCH; dx <= PATCH; dx += 1) {
      const i = ((y + dy) * stride + x + dx) * 4;
      if (Math.abs(data[i + 3]! - data[c + 3]!) > 8) return 0;
      if (
        Math.abs(data[i]! - data[c]!) > 16 ||
        Math.abs(data[i + 1]! - data[c + 1]!) > 16 ||
        Math.abs(data[i + 2]! - data[c + 2]!) > 16
      )
        colour = false;
    }
  return colour ? 2 : 1;
}

/** Why a decoded pixel does not reproduce its sample, allowing for coding noise, or null. */
export function sampleMismatch(sample: StillSample, decoded: ArrayLike<number>) {
  const [r = 0, g = 0, b = 0, a = 0] = sample.rgba;
  const at = `${sample.x},${sample.y}`;
  if (Math.abs(decoded[3]! - a) > 48)
    return `alpha ${decoded[3]} at ${at} where the image has ${a}`;
  if (
    sample.colour &&
    (Math.abs(decoded[0]! - r) > 48 ||
      Math.abs(decoded[1]! - g) > 48 ||
      Math.abs(decoded[2]! - b) > 48)
  )
    return `colour ${decoded[0]},${decoded[1]},${decoded[2]} at ${at} where the image has ${r},${g},${b}`;
  return null;
}

/**
 * `src/lib/fixtures/tiny.heic` (64x48, written by libheif), inlined: a HEIC that any HEIC
 * decoder reads, so a browser that cannot decode it has no HEIC decoder at all.
 */
export const HEIC_PROBE =
  "AAAAHGZ0eXBoZWljAAAAAG1pZjFoZWljbWlhZgAAAX1tZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAA" +
  "AAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAABoQABAAAAAAAAAI4AAAAjaWluZgAAAAAAAQAAABVpbmZlAgAA" +
  "AAABAABodmMxAAAAAA5waXRtAAAAAAABAAAA/WlwcnAAAADdaXBjbwAAAHZodmNDAQNwAAAAAAAAAAAAHvAA/P34" +
  "+AAADwNgAAEAGEABDAH//wNwAAADAJAAAAMAAAMAHroCQGEAAQAqQgEBA3AAAAMAkAAAAwAAAwAeoCCBBZbq5Ka5" +
  "uAhoMCAAAAMDIAAAAwAhYgABAAZEAcFzwIkAAAATY29scm5jbHgAAQANAAaAAAAAFGlzcGUAAAAAAAAAQAAAAEAA" +
  "AAAoY2xhcAAAAEAAAAABAAAAMAAAAAEAAAAAAAAAAv////AAAAACAAAAEHBpeGkAAAAAAwgICAAAABhpcG1hAAAA" +
  "AAAAAAEAAQWBAgMFhAAAAJZtZGF0AAAAiigBrwY4iS58L/ajX///stn9l/kw5KaZf4+hXI/5ViP//4zGpv/ATs0T" +
  "9bJQ1ZyXuwR0xhlteo5eLFSIzQB/A9kJdqtANlHYrs2PVlrKD+BExrceEWBQc6h2fsAGDTLg5qUV1HDk5xqStZ1z" +
  "8JLDjk270qmXo9qTvp6BzVf396AplRBiSls9IaERwA==";

let heicDecoder: Promise<boolean> | undefined;

/** Whether this browser decodes HEIC, learnt once from the probe rather than from an export. */
function decodesHeic() {
  heicDecoder ??= createImageBitmap(
    new Blob([Uint8Array.from(atob(HEIC_PROBE), (char) => char.charCodeAt(0))], {
      type: "image/heic",
    }),
  ).then(
    (bitmap) => {
      bitmap.close();
      return true;
    },
    () => false,
  );
  return heicDecoder;
}

/**
 * Decodes the finished file and compares it with the canvas at the sampled pixels, so a
 * file the browser's own decoder reads wrong is refused instead of saved: WebKit showed
 * some HEIC exports fully transparent, and Chrome once stored AVIF colour premultiplied.
 * Where native HEIC is absent, the bundled libheif decoder checks the same samples.
 * A browser that decodes the HEIC probe but not the export has written a broken file.
 */
async function verifyStill(file: Blob, kind: "heic" | "avif", samples: readonly StillSample[]) {
  if (!samples.length) return;
  // Asked before the export is decoded, so both decodes run at once.
  const decodable = kind === "heic" ? decodesHeic() : true;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (error) {
    if (kind !== "heic" || (await decodable)) throw brokenStill(kind, error);
    try {
      const { heicTo } = await import("heic-to/csp");
      bitmap = await heicTo({ blob: file, type: "bitmap" });
    } catch (cause) {
      throw brokenStill(kind, cause);
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas is unavailable. Try another browser.");
    for (const sample of samples) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.drawImage(bitmap, sample.x, sample.y, 1, 1, 0, 0, 1, 1);
      const mismatch = sampleMismatch(sample, ctx.getImageData(0, 0, 1, 1).data);
      if (mismatch) throw brokenStill(kind, new Error(mismatch));
    }
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

function brokenStill(kind: "heic" | "avif", cause: unknown) {
  const message = `This browser wrote a broken ${kind.toUpperCase()} file. Choose PNG.`;
  return new CutoutError("export", message, false, { cause });
}

async function encodeLayer(
  source: HTMLCanvasElement,
  codec: string,
  width: number,
  height: number,
  quality: number,
  alpha: boolean,
) {
  if (typeof VideoEncoder !== "function")
    throw new Error("This browser cannot encode HEIC or AVIF. Choose PNG.");
  // The 64x64 format probe is not a promise that this output size can be encoded.
  const config = encoderConfig(codec, width, height, quality);
  const supported = await VideoEncoder.isConfigSupported(config);
  if (!supported.supported)
    throw new DOMException(
      "The encoder does not support these output dimensions.",
      "NotSupportedError",
    );
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Canvas is unavailable. Try another browser.");
    ctx.drawImage(source, 0, 0);
    const image = ctx.getImageData(0, 0, width, height);
    // Picked before the loop below flattens alpha: what the decoded file must reproduce.
    const samples = alpha ? [] : pickSamples(image.data, width, source.width, source.height);
    let opaque = true;
    for (let i = 0; i < image.data.length; i += 4) {
      const a = image.data[i + 3] ?? 0;
      // Inspect every source pixel, including tiny axes and the unsampled outer edge.
      // Padding is outside the displayed image and does not require an alpha item.
      if (a !== 255 && (i / 4) % width < source.width && i / 4 < width * source.height)
        opaque = false;
      if (alpha) {
        image.data[i] = a;
        image.data[i + 1] = a;
        image.data[i + 2] = a;
      }
      // Both layers must be opaque. Chrome encodes a canvas's premultiplied colour and
      // drops its alpha, so a colour layer that kept its transparency stored white at
      // alpha 128 as grey: a dark fringe on every soft edge.
      image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return { ...(await encodeVideoFrame(canvas, codec, quality, alpha)), samples, opaque };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function encodeVideoFrame(
  canvas: HTMLCanvasElement,
  codec: string,
  quality: number,
  alpha: boolean,
) {
  return new Promise<{ description: Uint8Array | null; data: Uint8Array }>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let description: Uint8Array | null = null;
    const encoder = new VideoEncoder({
      output(chunk, meta) {
        const bytes = new Uint8Array(chunk.byteLength);
        chunk.copyTo(bytes);
        chunks.push(bytes);
        const config = meta?.decoderConfig?.description;
        if (config && !description)
          description = Uint8Array.from(new Uint8Array(config as ArrayBuffer));
      },
      error(error) {
        reject(error);
      },
    });
    try {
      encoder.configure(encoderConfig(codec, canvas.width, canvas.height, quality));
      let frame: VideoFrame;
      if (alpha) {
        // HEIF reads alpha directly from luma; RGB conversion would compress 0–255 to 16–235.
        // That holds for AVIF too: Chrome's RGB path stored opaque as luma 235 marked
        // limited range, and macOS ImageIO (Preview, Photos) then showed it at alpha 219.
        const pixels = canvas
          .getContext("2d")
          ?.getImageData(0, 0, canvas.width, canvas.height).data;
        if (!pixels) throw new Error("Canvas is unavailable. Try another browser.");
        const luma = canvas.width * canvas.height;
        // Each I420 chroma plane rounds both axes up independently, including 1px axes.
        const chroma = Math.ceil(canvas.width / 2) * Math.ceil(canvas.height / 2);
        const data = new Uint8Array(luma + 2 * chroma);
        data.fill(128, luma);
        for (let p = 0; p < luma; p += 1) data[p] = pixels[p * 4] ?? 0;
        frame = new VideoFrame(data, {
          format: "I420",
          codedWidth: canvas.width,
          codedHeight: canvas.height,
          timestamp: 0,
          colorSpace: {
            primaries: "bt709",
            transfer: "iec61966-2-1",
            matrix: "bt709",
            fullRange: true,
          },
        });
      } else frame = new VideoFrame(canvas, { timestamp: 0 });
      try {
        encoder.encode(frame, { keyFrame: true });
      } finally {
        frame.close();
      }
    } catch (error) {
      // Browsers cap live encoders; one left open per failed export ran them out.
      try {
        encoder.close();
      } catch {
        /* the error callback already closed it */
      }
      throw error;
    }
    void encoder
      .flush()
      .then(() => {
        encoder.close();
        if (!chunks.length) throw new Error("Encoding produced an empty image.");
        resolve({ description, data: concat(chunks) });
      })
      .catch((error) => {
        try {
          encoder.close();
        } catch {
          /* already closed */
        }
        reject(error);
      });
  });
}

function encoderConfig(
  codec: string,
  width: number,
  height: number,
  quality: number,
): VideoEncoderConfig {
  return {
    codec,
    width,
    height,
    bitrate: Math.max(80_000, Math.round(width * height * (0.8 + Math.max(0.15, quality) * 8))),
    framerate: 1,
    latencyMode: "quality",
    hardwareAcceleration: "no-preference",
  };
}

export async function codecSupported(codec: string, width = 64, height = 64, quality = 0.92) {
  if (typeof VideoEncoder !== "function" || typeof VideoEncoder.isConfigSupported !== "function")
    return false;
  try {
    const result = await VideoEncoder.isConfigSupported(
      encoderConfig(codec, width, height, quality),
    );
    return Boolean(result.supported);
  } catch {
    return false;
  }
}
