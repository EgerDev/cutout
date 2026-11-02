import { resizeBitmap } from "../bitmap-resize.ts";

// Two bounded slots retain the active source and background; leases own their users.
type PreviewEntry = {
  readonly key: Blob;
  readonly pending: Promise<ImageBitmap>;
  bitmap: ImageBitmap | null;
  retained: boolean;
  users: number;
};
export type SourceBitmap = Readonly<{
  bitmap: ImageBitmap;
  owned: boolean;
  release: () => void;
}>;
type PreviewRequest = Readonly<{
  slot: "source" | "background";
  key: Blob;
  open: () => Promise<Blob>;
  width: number;
  height: number;
  maxSide: number;
}>;
const slots = new Map<PreviewRequest["slot"], PreviewEntry>();

function closeIdle(entry: PreviewEntry) {
  if (!entry.retained && entry.users === 0 && entry.bitmap) {
    entry.bitmap.close();
    entry.bitmap = null;
  }
}

function retire(slot: PreviewRequest["slot"]) {
  const entry = slots.get(slot);
  slots.delete(slot);
  if (entry) {
    entry.retained = false;
    closeIdle(entry);
  }
}

/** Retired bitmaps stay drawable until every concurrent consumer releases them. */
export function clearSourceBitmapCache() {
  retire("source");
  retire("background");
}

function lease(bitmap: ImageBitmap, owned: boolean, dispose: () => void): SourceBitmap {
  let released = false;
  return {
    bitmap,
    owned,
    release() {
      if (released) return;
      released = true;
      dispose();
    },
  };
}

export async function previewSized(request: PreviewRequest): Promise<SourceBitmap> {
  const { slot, key, open, width, height, maxSide } = request;
  if (Math.max(width, height) <= maxSide) {
    let entry = slots.get(slot);
    if (entry?.key !== key) {
      retire(slot);
      const pending = (async () => {
        const full = await createImageBitmap(await open());
        // Cover-fit backgrounds need their short side; fitted sources use the long side.
        const side =
          slot === "background"
            ? Math.min(full.width, full.height)
            : Math.max(full.width, full.height);
        const scale = maxSide / side;
        if (scale >= 1) return full;
        try {
          return await resizeBitmap(full, full.width * scale, full.height * scale, "high");
        } finally {
          full.close();
        }
      })();
      const created: PreviewEntry = { key, pending, bitmap: null, retained: true, users: 0 };
      entry = created;
      slots.set(slot, created);
      void pending.then(
        (bitmap) => {
          created.bitmap = bitmap;
          closeIdle(created);
        },
        () => {
          if (slots.get(slot) === created) retire(slot);
        },
      );
    }
    const current = entry;
    current.users += 1;
    const release = () => {
      current.users -= 1;
      closeIdle(current);
    };
    try {
      const bitmap = await current.pending;
      if (bitmap.width >= Math.round(width) && bitmap.height >= Math.round(height))
        return lease(bitmap, false, release);
    } catch (error) {
      release();
      throw error;
    }
    release();
  }
  const bitmap = await createImageBitmap(await open());
  return lease(bitmap, true, () => bitmap.close());
}
