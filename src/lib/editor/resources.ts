export function revoke(url: string | null | undefined) {
  if (url) URL.revokeObjectURL(url);
}

const previews = new WeakMap<ImageBitmap, { users: number; retired: boolean }>();

export function liveBitmap<T>(bitmap: T): T | null {
  return typeof ImageBitmap !== "undefined" &&
    bitmap instanceof ImageBitmap &&
    (bitmap.width === 0 || bitmap.height === 0)
    ? null
    : bitmap;
}

/** A mounted painter keeps retired previews alive until its layout cleanup. */
export function retainPreview(bitmap: ImageBitmap | null | undefined) {
  if (!bitmap || !liveBitmap(bitmap)) return () => {};
  const entry = previews.get(bitmap) ?? { users: 0, retired: false };
  previews.set(bitmap, entry);
  entry.users++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.users === 0 && entry.retired) closePreview(bitmap);
  };
}

export function closePreview(bitmap: ImageBitmap | null | undefined) {
  if (!bitmap || !liveBitmap(bitmap)) return;
  const entry = previews.get(bitmap);
  if (entry) {
    entry.retired = true;
    if (entry.users > 0) return;
    previews.delete(bitmap);
  }
  try {
    bitmap.close();
  } catch {
    /* already closed */
  }
}
