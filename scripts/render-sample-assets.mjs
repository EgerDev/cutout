/**
 * Builds the sample image, its thumbnail, the share card and the CSP suite's HEIC fixture
 * (public/CREDITS.md records where the photograph comes from).
 *
 *   node scripts/render-sample-assets.mjs --source photo.png   public/sample.jpg (3:4 centre crop)
 *   node scripts/render-sample-assets.mjs --cutout cut.png     public/sample-thumb.webp, public/og.jpg
 *   node scripts/render-sample-assets.mjs --heic               scripts/fixtures/sample.heic (macOS sips)
 *
 * --cutout is Cutout's own result for public/sample.jpg (Download → PNG, Original preset,
 * transparent background), so the share card never shows a mocked cutout. The card has no
 * text: platforms print og:title beside it, and text would tie the output to whichever fonts
 * a machine has installed. Add --out <dir> to write somewhere other than the repository, and
 * --sample <jpg> to build from a sample written there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const outDir = option("--out");
if (outDir) mkdirSync(outDir, { recursive: true });
const at = (repoPath) => (outDir ? join(outDir, repoPath.split("/").pop()) : join(root, repoPath));
// --sample reads a sample written elsewhere (a --out preview) instead of public/sample.jpg.
const samplePath = option("--sample") ?? join(root, "public/sample.jpg");

// Light-theme tokens from src/styles.css.
const PAPER = "#f3f1eb";
const FLOAT = "#fffcf7";
const FG = "#1c1b16";
const ACCENT = "#3d5a73";
const CHECKER = ["#e7e3d8", "#f6f3eb"];

async function writeSample(source) {
  const { width, height } = await sharp(source).metadata();
  // 3:4 centre crop at the generated resolution: never upscaled.
  const cropHeight = Math.min(height, Math.round((width * 4) / 3));
  const cropWidth = Math.round((cropHeight * 3) / 4);
  await sharp(source)
    .extract({
      left: Math.floor((width - cropWidth) / 2),
      top: Math.floor((height - cropHeight) / 2),
      width: cropWidth,
      height: cropHeight,
    })
    .toColourspace("srgb")
    .jpeg({ quality: 84, mozjpeg: true })
    .toFile(at("public/sample.jpg"));
}

/** Bounding box of the opaque subject in the cutout. */
async function subjectBox(cutout) {
  const { data, info } = await sharp(cutout).ensureAlpha().extractChannel(3).raw().toBuffer({
    resolveWithObject: true,
  });
  let left = info.width,
    top = info.height,
    right = -1,
    bottom = -1;
  for (let y = 0; y < info.height; y += 1)
    for (let x = 0; x < info.width; x += 1)
      if (data[y * info.width + x] > 127) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
  if (right < 0) throw new Error("The cutout has no opaque subject.");
  return {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
    imageWidth: info.width,
    imageHeight: info.height,
  };
}

/** A square of `side` around the subject's centre, kept inside the image. */
function squareAround(box, side) {
  const size = Math.min(side, box.imageWidth, box.imageHeight);
  const clamp = (value, max) => Math.max(0, Math.min(max - size, Math.round(value)));
  return {
    left: clamp(box.left + box.width / 2 - size / 2, box.imageWidth),
    top: clamp(box.top + box.height / 2 - size / 2, box.imageHeight),
    width: size,
    height: size,
  };
}

const svg = (width, height, body) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`,
  );

async function writeCard(cutout) {
  const box = await subjectBox(cutout);
  const sample = await sharp(samplePath).metadata();
  if (sample.width !== box.imageWidth || sample.height !== box.imageHeight)
    throw new Error("The cutout must be Cutout's result for public/sample.jpg (same size).");

  // Thumbnail: the whole subject, with a little room, at 2× its 36 px display size.
  await sharp(samplePath)
    .extract(squareAround(box, Math.round(Math.max(box.width, box.height) * 1.12)))
    .resize(72, 72)
    .webp({ quality: 80 })
    .toFile(at("public/sample-thumb.webp"));

  const W = 1200,
    H = 630,
    S = 518,
    R = 12;
  const x = (W - S) / 2,
    y = (H - S) / 2;
  const square = squareAround(box, Math.round(Math.max(box.width, box.height) * 1.3));
  const scale = S / square.width;
  // The wipe sits on the subject's centre line, as Compare starts in the app.
  const split = Math.round((box.left + box.width / 2 - square.left) * scale);
  const photo = await sharp(samplePath).extract(square).resize(S, S).png().toBuffer();
  const cut = await sharp(cutout).extract(square).resize(S, S).png().toBuffer();
  const cell = 14;
  const checker = svg(
    S,
    S,
    `<defs><pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse"><rect width="${cell * 2}" height="${cell * 2}" fill="${CHECKER[1]}"/><rect width="${cell}" height="${cell}" fill="${CHECKER[0]}"/><rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="${CHECKER[0]}"/></pattern></defs><rect width="${S}" height="${S}" fill="url(#c)"/>`,
  );
  const result = await sharp(checker)
    .composite([{ input: cut }])
    .png()
    .toBuffer();
  const right = await sharp(result)
    .extract({ left: split, top: 0, width: S - split, height: S })
    .toBuffer();
  const frame = await sharp(photo)
    .composite([
      { input: right, left: split, top: 0 },
      { input: svg(S, S, `<rect x="${split - 1}" width="2" height="${S}" fill="${ACCENT}"/>`) },
      // Rounded corners: keep only what lies inside the frame's radius.
      {
        input: svg(S, S, `<rect width="${S}" height="${S}" rx="${R}" fill="#fff"/>`),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  const shadow = svg(
    W,
    H,
    `<defs><filter id="s" x="-20%" y="-20%" width="140%" height="160%"><feGaussianBlur stdDeviation="16"/></filter></defs><rect x="${x + 18}" y="${y + 30}" width="${S - 36}" height="${S - 12}" rx="${R}" fill="${FG}" fill-opacity="0.26" filter="url(#s)"/><rect x="${x - 1}" y="${y - 1}" width="${S + 2}" height="${S + 2}" rx="${R + 1}" fill="${FG}" fill-opacity="0.08"/>`,
  );
  const handle = svg(
    W,
    H,
    `<defs><filter id="h" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4"/></filter></defs><circle cx="${x + split}" cy="${y + S / 2 + 3}" r="22" fill="${FG}" fill-opacity="0.22" filter="url(#h)"/><circle cx="${x + split}" cy="${y + S / 2}" r="22" fill="${FLOAT}"/><rect x="${x + split - 1}" y="${y + S / 2 - 10}" width="2" height="20" rx="1" fill="${ACCENT}"/>`,
  );
  // Cutout's mark (public/favicon.svg geometry), top-left.
  const mark = svg(
    W,
    H,
    `<g transform="translate(48 48) scale(1.818)" fill="none"><rect x="1.25" y="1.25" width="19.5" height="19.5" rx="6" stroke="${FG}" stroke-width="1.5"/><path d="M7 15.5h4.2c2.3 0 3.8-1.35 3.8-3.35 0-1.86-1.28-3.05-3.42-3.05H9.2V6.5" stroke="${FG}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16.1" cy="5.9" r="1.15" fill="${ACCENT}"/></g>`,
  );
  await sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
    .composite([
      { input: shadow },
      { input: frame, left: x, top: y },
      { input: handle },
      { input: mark },
    ])
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(at("public/og.jpg"));
}

/** The CSP suite's HEIC: the sample at 320 px wide, encoded by macOS ImageIO (HEVC). */
async function writeHeic() {
  const work = mkdtempSync(join(tmpdir(), "cutout-heic-"));
  try {
    const png = join(work, "sample.png");
    await sharp(samplePath).resize(320).png().toFile(png);
    execFileSync(
      "sips",
      [
        "-s",
        "format",
        "heic",
        "-s",
        "formatOptions",
        "70",
        png,
        "--out",
        at("scripts/fixtures/sample.heic"),
      ],
      { stdio: "pipe" },
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (option("--source")) await writeSample(option("--source"));
if (option("--cutout")) await writeCard(option("--cutout"));
if (args.includes("--heic")) await writeHeic();
if (!option("--source") && !option("--cutout") && !args.includes("--heic"))
  throw new Error("Pass --source <image>, --cutout <png> and/or --heic (see the header).");
