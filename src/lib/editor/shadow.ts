import type { EditSettings, Rect } from "./model.ts";

export function paintShadow(
  ctx: CanvasRenderingContext2D,
  dest: Rect,
  canvasHeight: number,
  settings: EditSettings,
  silhouette: CanvasImageSource | null,
  silhouetteBounds?: Rect,
) {
  if (!settings.shadow || dest.width <= 0 || dest.height <= 0) return;
  ctx.save();
  ctx.globalAlpha = settings.shadowOpacity / 100;
  if (settings.shadowKind === "cast") {
    paintCast(ctx, dest, canvasHeight, settings, silhouette, silhouetteBounds);
  } else {
    paintContact(ctx, dest, canvasHeight, settings);
  }
  ctx.restore();
}

function paintContact(
  ctx: CanvasRenderingContext2D,
  dest: Rect,
  canvasHeight: number,
  settings: EditSettings,
) {
  const sw = dest.width;
  ctx.filter = `blur(${Math.max(0.5, (settings.shadowSoftness / 100) * sw)}px)`;
  ctx.fillStyle = settings.shadowColor;
  ctx.beginPath();
  ctx.ellipse(
    dest.x + sw / 2,
    dest.y + dest.height + (settings.shadowDistance / 100) * canvasHeight,
    sw * 0.43,
    Math.max(1, sw * 0.035),
    0,
    0,
    Math.PI * 2,
  );
  ctx.fill();
}

function paintCast(
  ctx: CanvasRenderingContext2D,
  dest: Rect,
  canvasHeight: number,
  settings: EditSettings,
  silhouette: CanvasImageSource | null,
  silhouetteBounds?: Rect,
) {
  const angle = ((settings.shadowAngle - 90) * Math.PI) / 180;
  const distance = (settings.shadowDistance / 100) * dest.width + dest.height * 0.02;
  const dx = Math.sin(angle) * distance;
  const dy =
    Math.abs(Math.cos(angle)) * distance * 0.35 +
    (settings.shadowDistance / 100) * canvasHeight * 0.15;
  const blur = Math.max(0.5, (settings.shadowSoftness / 100) * dest.width + settings.shadowSpread);
  const skew = (settings.shadowPerspective / 100) * 0.9;
  ctx.translate(dest.x + dest.width / 2 + dx, dest.y + dest.height + dy);
  ctx.transform(
    1,
    0,
    skew * (dx >= 0 ? 1 : -1),
    0.28 + (1 - settings.shadowPerspective / 100) * 0.22,
    0,
    0,
  );
  ctx.filter = `blur(${blur}px)`;
  ctx.fillStyle = settings.shadowColor;
  if (silhouette && settings.shadowSilhouette) {
    // Tint on an isolated surface: source-in on the output erases its plate,
    // and applying opacity to both the mask and tint squares the chosen amount.
    const mask = document.createElement("canvas");
    mask.width = Math.max(1, Math.ceil(dest.width));
    mask.height = Math.max(1, Math.ceil(dest.height));
    try {
      const maskContext = mask.getContext("2d");
      if (!maskContext) throw new Error("Canvas is unavailable. Try another browser.");
      if (silhouetteBounds) {
        maskContext.drawImage(
          silhouette,
          silhouetteBounds.x,
          silhouetteBounds.y,
          silhouetteBounds.width,
          silhouetteBounds.height,
          0,
          0,
          mask.width,
          mask.height,
        );
      } else maskContext.drawImage(silhouette, 0, 0, mask.width, mask.height);
      maskContext.globalCompositeOperation = "source-in";
      maskContext.fillStyle = settings.shadowColor;
      maskContext.fillRect(0, 0, mask.width, mask.height);
      ctx.drawImage(mask, -dest.width / 2, -dest.height, dest.width, dest.height);
    } finally {
      mask.width = 0;
      mask.height = 0;
    }
  } else {
    ctx.beginPath();
    ctx.ellipse(0, 0, dest.width * 0.48, Math.max(2, dest.width * 0.08), 0, 0, Math.PI * 2);
    ctx.fill();
  }
}
