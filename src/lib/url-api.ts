import type { Preset } from "./editor/model.ts";
import type { BackgroundMode, ExportFormat } from "./formats.ts";
import { PRESETS } from "./editor/model.ts";
import { sniffRasterType } from "./files.ts";

/**
 * Query parameters that drive the workspace from a link, for Shortcuts,
 * bookmarklets and other tools:
 *   ?src=https://…/photo.jpg   image to load (same-origin or CORS-enabled; https,
 *                              up to 50 MB, not SVG)
 *   &preset=amazon             any preset value
 *   &format=webp               png | webp | avif | heic | jpeg | bmp
 *   &bg=%23ffffff | blur | transparent
 *   &download=1                save the result as soon as it is ready
 *   &name=photo.jpg            file name to use for the download
 * A link is just a URL anyone can send, so an image from another site, or an
 * automatic download, waits for the user to confirm (see needsConfirmation).
 */
export type LaunchPlan = Readonly<{
  src: string | null;
  preset: Preset | null;
  format: ExportFormat | null;
  background: BackgroundMode | null;
  download: boolean;
  name: string | null;
}>;

const FORMATS: readonly ExportFormat[] = ["png", "webp", "avif", "heic", "jpeg", "bmp"];

export function parseLaunchParams(search: string | URLSearchParams): LaunchPlan | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const src = validSource(params.get("src"));
  const presetValue = params.get("preset");
  const preset = PRESETS.find((p) => p.value === presetValue)?.value ?? null;
  const formatValue = (params.get("format") ?? "").toLowerCase().replace("jpg", "jpeg");
  const format = FORMATS.find((f) => f === formatValue) ?? null;
  const background = parseBackground(params.get("bg"));
  const download = params.get("download") === "1" || params.get("download") === "true";
  const name = safeName(params.get("name"));
  if (!src && !preset && !format && !background && !download) return null;
  return { src, preset, format, background, download, name };
}

function validSource(value: string | null) {
  if (!value) return null;
  try {
    const here = typeof location === "undefined" ? null : new URL(location.href);
    const url = new URL(value, here ?? "https://localhost/");
    // Plain http only for this app's own images on a local http server (dev, preview).
    const ownHttp =
      url.protocol === "http:" && here?.protocol === "http:" && url.host === here.host;
    return url.protocol === "https:" || ownHttp ? url.href : null;
  } catch {
    return null;
  }
}

function parseBackground(value: string | null): BackgroundMode | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "transparent" || v === "none") return { type: "transparent" };
  if (v === "blur") return { type: "blur" };
  if (v === "white") return { type: "color", color: "#ffffff" };
  if (v === "black") return { type: "color", color: "#111111" };
  const hex = v.startsWith("#") ? v : `#${v}`;
  return /^#[0-9a-f]{6}$/.test(hex) ? { type: "color", color: hex } : null;
}

function safeName(value: string | null) {
  if (!value) return null;
  const name = value
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 120);
  return name || null;
}

/** File name for a fetched source: the URL's last path segment, or a default. */
export function nameFromUrl(url: string, type: string) {
  let segment = "";
  try {
    segment = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  } catch {
    // A malformed %-sequence: fall back to the default name.
  }
  const ext = type.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
  const base = safeName(segment) ?? "image";
  return /\.[a-z0-9]{2,5}$/i.test(base) ? base : `${base}.${ext}`;
}

/** True when a launch must wait for the user: an image from another site, or any automatic download. */
export function needsConfirmation(plan: LaunchPlan, origin: string) {
  return plan.download || (plan.src !== null && new URL(plan.src).origin !== origin);
}

export const LAUNCH_MAX_BYTES = 50_000_000;
/** A host silent this long (no headers, no new bytes) is given up on; a slow but moving
 *  download of a large image still finishes. */
const LAUNCH_STALL_MS = 30_000;
const TOO_LARGE = "The linked image is larger than 50 MB.";
const TOO_SLOW = "The linked image took too long to load.";
const NOT_IMAGE = "The link is not an image.";
const NO_SVG = "SVG links aren’t supported. Link a PNG, JPG or WebP instead.";
/** Exact types only. A parameter after ";" is fine, but "image/png, text/html", a tab or a
 *  stray byte all passed startsWith("image/"), and the first one became a type Chromium
 *  renders as a page. */
const LAUNCH_TYPES = new Set([
  "image/png",
  "image/x-png",
  "image/apng",
  "image/jpeg",
  "image/jpg",
  "image/pjpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/x-ms-bmp",
  "image/tiff",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/jxl",
]);

/** Fetches the source image for a launch; the server must allow CORS for cross-origin URLs. */
export async function fetchLaunchSource(url: string, name: string | null): Promise<File> {
  // A plain controller and timer: AbortSignal.timeout is missing before Safari 16.
  const controller = new AbortController();
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wait = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, LAUNCH_STALL_MS);
  };
  wait();
  try {
    let response: Response;
    try {
      response = await fetch(url, { mode: "cors", credentials: "omit", signal: controller.signal });
    } catch (error) {
      if (stalled) throw new Error(TOO_SLOW, { cause: error });
      throw new Error(
        "Couldn’t load the linked image. The site hosting it must allow cross-origin access.",
        { cause: error },
      );
    }
    if (!response.ok) throw new Error(`Couldn’t load the linked image (${response.status}).`);
    if (Number(response.headers.get("content-length")) > LAUNCH_MAX_BYTES) {
      void response.body?.cancel();
      throw new Error(TOO_LARGE);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type.includes("svg") || !LAUNCH_TYPES.has(type)) {
      void response.body?.cancel();
      throw new Error(type.includes("svg") ? NO_SVG : NOT_IMAGE);
    }
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    const reader = response.body?.getReader();
    try {
      for (let part = await reader?.read(); part && !part.done; part = await reader?.read()) {
        wait();
        size += part.value.byteLength;
        if (size > LAUNCH_MAX_BYTES) {
          void reader?.cancel();
          throw new Error(TOO_LARGE);
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (stalled) throw new Error(TOO_SLOW, { cause: error });
      throw error;
    }
    return launchFile(chunks, name, url);
  } finally {
    clearTimeout(timer);
  }
}

/** The File's type is the blob: URL's Content-Type, so it comes from the bytes, never the
 *  server: markup can sit behind any padding and any chunk boundary. */
function launchFile(chunks: Uint8Array<ArrayBuffer>[], name: string | null, url: string) {
  const type = sniffRasterType(head(chunks, 64));
  // SVG can carry script; a blob: URL of it would run as this origin.
  if (!type) throw new Error(startsWithMarkup(chunks) ? NO_SVG : NOT_IMAGE);
  return new File(chunks, name ?? nameFromUrl(url, type), { type });
}

/** The first bytes, joined across chunks: a host may send them one at a time. */
function head(chunks: Uint8Array[], length: number) {
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, length - at);
    out.set(part, at);
    at += part.length;
  }
  return out.subarray(0, at);
}

/** Only picks the message: what follows whitespace, control bytes and byte-order marks. */
function startsWithMarkup(chunks: Uint8Array[]) {
  for (const chunk of chunks)
    for (const byte of chunk) {
      if (byte <= 0x20 || byte === 0xef || byte === 0xbb || byte === 0xbf || byte >= 0xfe) continue;
      return byte === 0x3c;
    }
  return false;
}
