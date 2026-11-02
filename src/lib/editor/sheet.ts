import { zipSync, strToU8 } from "fflate";
import { canvas2d, encodeCanvas } from "./canvas.ts";
import { renderCanvas, type RenderInput } from "./render.ts";
import { uniqueNames } from "./model.ts";

export type SheetKind = "contact" | "sprite";
export type SheetOptions = Readonly<{
  kind: SheetKind;
  /** Cell size in px (square). */
  cell: number;
  columns?: number;
  /** Contact sheets print the file name under each image. */
  labels?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}>;
export type SpriteFrame = Readonly<{ x: number; y: number; w: number; h: number }>;

/** Grid geometry shared by the renderer and its tests. */
export function planSheet(count: number, cell: number, columns?: number, labelHeight = 0) {
  const cols = Math.max(1, Math.min(count, columns ?? Math.ceil(Math.sqrt(count))));
  const rows = Math.max(1, Math.ceil(count / cols));
  const gap = Math.max(8, Math.round(cell * 0.04));
  const pitchX = cell + gap,
    pitchY = cell + labelHeight + gap;
  return {
    cols,
    rows,
    gap,
    width: cols * pitchX + gap,
    height: rows * pitchY + gap,
    cellAt: (index: number) => ({
      x: gap + (index % cols) * pitchX,
      y: gap + Math.floor(index / cols) * pitchY,
    }),
  };
}

/**
 * Renders every item into one PNG. A contact sheet centres each cutout on a
 * white cell with its name; a sprite sheet keeps transparency, packs cells
 * top-left and returns a JSON atlas of frame rectangles.
 */
export async function renderSheet(
  items: readonly (RenderInput & { readonly name: string })[],
  options: SheetOptions,
): Promise<{
  blob: Blob;
  atlas: Record<string, SpriteFrame> | null;
  width: number;
  height: number;
}> {
  if (!items.length) throw new Error("Select at least one ready image.");
  const contact = options.kind === "contact";
  const labelHeight = contact && options.labels !== false ? Math.round(options.cell * 0.12) + 8 : 0;
  const grid = planSheet(items.length, options.cell, options.columns, labelHeight);
  if (grid.width > 16384 || grid.height > 16384)
    throw new Error("This sheet is too large. Use fewer images or a smaller cell size.");
  const { canvas, context: ctx } = canvas2d(grid.width, grid.height);
  const atlas: Record<string, SpriteFrame> = {};
  const names = uniqueNames(
    items.map((item) => item.name),
    "png",
  );
  try {
    if (contact) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, grid.width, grid.height);
    }
    for (const [index, item] of items.entries()) {
      options.signal?.throwIfAborted();
      const tile = await renderCanvas(
        {
          ...item,
          settings: {
            ...item.settings,
            // Sheets lay cells out themselves: the subject is always fitted to the cell.
            exportWidth: null,
            exportHeight: null,
            preset: item.settings.preset === "original" ? "trim" : item.settings.preset,
            trimPadding: 0,
            background: contact ? item.settings.background : { type: "transparent" },
            exportFormat: "png",
          },
        },
        { maxSide: options.cell, matteMaxSide: options.cell * 2, signal: options.signal },
      );
      try {
        const at = grid.cellAt(index);
        const scale = Math.min(1, options.cell / Math.max(tile.width, tile.height, 1));
        const w = Math.max(1, Math.round(tile.width * scale)),
          h = Math.max(1, Math.round(tile.height * scale));
        const x = contact ? at.x + Math.round((options.cell - w) / 2) : at.x;
        const y = contact ? at.y + Math.round((options.cell - h) / 2) : at.y;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(tile, x, y, w, h);
        atlas[names[index] ?? `image-${index + 1}.png`] = { x, y, w, h };
        if (labelHeight) {
          ctx.fillStyle = "#333333";
          ctx.font = `${Math.max(10, Math.round(options.cell * 0.07))}px system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(
            fitLabel(ctx, item.name, options.cell),
            at.x + options.cell / 2,
            at.y + options.cell + 6,
          );
        }
      } finally {
        tile.width = 0;
        tile.height = 0;
      }
      options.onProgress?.(index + 1, items.length);
    }
    options.signal?.throwIfAborted();
    const blob = await encodeCanvas(canvas, "image/png");
    return { blob, atlas: contact ? null : atlas, width: grid.width, height: grid.height };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

function fitLabel(ctx: CanvasRenderingContext2D, text: string, width: number) {
  if (ctx.measureText(text).width <= width) return text;
  let label = text;
  while (label.length > 3 && ctx.measureText(`${label}…`).width > width) label = label.slice(0, -1);
  return `${label}…`;
}

/** Sprite sheet download: the PNG plus its atlas as JSON, in one ZIP. */
export function spriteArchive(
  png: Uint8Array,
  atlas: Record<string, SpriteFrame>,
  meta: { width: number; height: number },
) {
  const json = JSON.stringify({ image: "sprites.png", size: meta, frames: atlas }, null, 2);
  return new Blob([zipSync({ "sprites.png": png, "sprites.json": strToU8(json) }, { level: 0 })], {
    type: "application/zip",
  });
}
