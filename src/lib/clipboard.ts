import { readClient } from "./device.ts";
import { encodeCanvas, readPixels } from "./editor/canvas.ts";
import { canShareFiles, shareBlob } from "./sharing.ts";

export function clipboardImagesSupported() {
  if (typeof document === "undefined") return false;
  // iOS Safari cannot write image/png via ClipboardItem in a way Copy can rely on.
  if (readClient().ios) return false;
  if (
    typeof navigator === "undefined" ||
    typeof ClipboardItem === "undefined" ||
    typeof navigator.clipboard?.write !== "function"
  ) {
    return false;
  }
  try {
    if (typeof ClipboardItem.supports === "function" && !ClipboardItem.supports("image/png")) {
      return false;
    }
  } catch {
    // write() is the real gate; a broken supports() must not hide Copy
  }
  return true;
}

async function writePngToClipboard(source: Blob | Promise<Blob>) {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard?.write !== "function" ||
    typeof ClipboardItem === "undefined"
  ) {
    throw new Error("Clipboard is blocked in this browser.");
  }
  // Construct ClipboardItem before awaiting so the user-gesture click stays live.
  // Transparent pixels often still hold the original RGB. Chat apps (WhatsApp)
  // ignore alpha and show that RGB — which looks like the uncut photo.
  const png = Promise.resolve(source).then((blob) => straightenClipboardPng(blob));
  const html = png.then((file) => clipboardHtml(file));
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "image/png": png,
        "text/html": html,
      }),
    ]);
  } catch {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  }
}

/** Write a transparent PNG to the clipboard; if that fails, open the share sheet with the same PNG. */
export async function copyPngOrShare(
  source: Blob | Promise<Blob>,
  filename = "cutout.png",
): Promise<"copied" | "shared" | "downloaded" | "aborted" | "failed"> {
  try {
    await writePngToClipboard(source);
    return "copied";
  } catch {
    // iOS Safari and some embeds reject ClipboardItem image/png.
  }
  try {
    const file = await straightenClipboardPng(await Promise.resolve(source));
    const named = new File([file], filename, { type: "image/png" });
    if (!canShareFiles()) return "failed";
    const result = await shareBlob(named, filename);
    if (result === "shared" || result === "downloaded") return result;
    if (result === "aborted") return "aborted";
  } catch {
    // fall through
  }
  return "failed";
}

async function straightenClipboardPng(blob: Blob): Promise<File> {
  let png = blob.type === "image/png" ? blob : new Blob([blob], { type: "image/png" });
  if (typeof createImageBitmap === "function" && typeof document !== "undefined") {
    try {
      const bitmap = await createImageBitmap(png);
      const read = readPixels(bitmap, bitmap.width, bitmap.height);
      bitmap.close();
      if (read) {
        (await import("./defringe.ts")).zeroRgbIfTransparent(read.image.data);
        read.context.putImageData(read.image, 0, 0);
        png = (await encodeCanvas(read.canvas).catch(() => null)) ?? png;
        read.canvas.width = 0;
        read.canvas.height = 0;
      }
    } catch {
      // Write the original bytes if the round-trip fails.
    }
  }
  return new File([png], "cutout.png", { type: "image/png" });
}

async function clipboardHtml(file: Blob) {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  return new Blob([`<img src="${url}" alt="" />`], { type: "text/html" });
}
