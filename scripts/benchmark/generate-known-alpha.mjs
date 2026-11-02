#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

const categories = [
  "portrait-hair",
  "pets-fur",
  "plants",
  "products",
  "low-contrast",
  "groups-small-subjects",
  "glass-partial-alpha",
  "logo-scan-illustration",
  "existing-transparency",
  "extreme-aspect-ratio",
];
const formats = ["png", "jpeg", "webp", "tiff", "heic"];
const boundarySizes = [
  [1, 1],
  [12, 1],
  [1, 12],
  [64, 1024],
  [1024, 64],
  [512, 512],
  [864, 1152],
  [1600, 900],
  [3000, 2000],
  [4000, 3000],
  [4000, 4000],
  [6000, 4000],
];

function dimensions(index) {
  if (index < boundarySizes.length) return boundarySizes[index];
  return [640 + (index % 5) * 96, 480 + (index % 7) * 80];
}

function maskSvg(width, height, category, index) {
  const stroke = Math.max(1, Math.round(Math.min(width, height) / 90));
  if (width === 1 || height === 1)
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="${index % 2 ? "#fff" : "#888"}"/></svg>`;
  if (category === "portrait-hair" || category === "pets-fur") {
    const lines = Array.from({ length: 17 }, (_, line) => {
      const x = Math.round(width * (0.32 + line * 0.022));
      return `<path d="M${x} ${height * 0.2} Q${x + (line % 3 - 1) * width * 0.08} ${height * 0.5} ${x} ${height * 0.86}" stroke="#${line % 2 ? "c0c0c0" : "ffffff"}" stroke-width="${stroke}" fill="none"/>`;
    }).join("");
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><ellipse cx="50%" cy="56%" rx="22%" ry="33%" fill="#fff"/>${lines}</svg>`;
  }
  if (category === "glass-partial-alpha")
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><rect x="25%" y="12%" width="50%" height="76%" rx="12%" fill="#606060" stroke="#e0e0e0" stroke-width="${stroke * 3}"/><ellipse cx="50%" cy="22%" rx="22%" ry="8%" fill="#909090"/></svg>`;
  if (category === "plants") {
    const leaves = Array.from({ length: 9 }, (_, leaf) => `<ellipse cx="${35 + (leaf % 3) * 15}%" cy="${20 + leaf * 7}%" rx="12%" ry="5%" transform="rotate(${leaf % 2 ? 28 : -28} ${width / 2} ${height / 2})" fill="#fff"/>`).join("");
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><rect x="49%" y="15%" width="2%" height="78%" fill="#fff"/>${leaves}</svg>`;
  }
  if (category === "groups-small-subjects") {
    const dots = Array.from({ length: 12 }, (_, dot) => `<circle cx="${10 + (dot % 4) * 26}%" cy="${20 + Math.floor(dot / 4) * 30}%" r="${3 + (dot % 3)}%" fill="#fff"/>`).join("");
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/>${dots}</svg>`;
  }
  return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><path d="M${width * 0.15} ${height * 0.82} L${width * 0.34} ${height * 0.18} Q${width * 0.5} ${height * 0.06} ${width * 0.66} ${height * 0.18} L${width * 0.86} ${height * 0.82} Z" fill="#fff"/></svg>`;
}

async function encode(image, format, path) {
  if (format === "jpeg") return image.jpeg({ quality: 94 }).toFile(path);
  if (format === "webp") return image.webp({ quality: 94 }).toFile(path);
  if (format === "tiff") return image.tiff({ compression: "lzw" }).toFile(path);
  if (format === "heic") {
    const intermediate = `${path}.source.png`;
    await image.png({ compressionLevel: 9 }).toFile(intermediate);
    try {
      return await run("heif-enc", ["--hevc", "--quality", "90", "--output", path, intermediate]);
    } finally {
      await rm(intermediate, { force: true });
    }
  }
  return image.png({ compressionLevel: 9 }).toFile(path);
}

export async function generateKnownAlpha(outputDirectory) {
  const inputDirectory = join(outputDirectory, "input");
  const alphaDirectory = join(outputDirectory, "alpha");
  await mkdir(inputDirectory, { recursive: true });
  await mkdir(alphaDirectory, { recursive: true });
  for (let index = 0; index < 40; index += 1) {
    const category = categories[index % categories.length];
    const [width, height] = dimensions(index);
    const mask = await sharp(Buffer.from(maskSvg(width, height, category, index)))
      .greyscale()
      .png({ compressionLevel: 9 })
      .toBuffer();
    const identifier = `known-${String(index + 1).padStart(2, "0")}`;
    await sharp(mask).toFile(join(alphaDirectory, `${identifier}.png`));
    const background = category === "low-contrast" ? "#7c8588" : index % 2 ? "#d9e1e8" : "#25313d";
    const subject = category === "low-contrast" ? "#858d90" : index % 3 ? "#c56542" : "#66a37a";
    const foreground = await sharp({ create: { width, height, channels: 3, background: subject } })
      .joinChannel(mask)
      .png()
      .toBuffer();
    const image = category === "existing-transparency"
      ? sharp(foreground)
      : sharp({ create: { width, height, channels: 3, background } }).composite([{ input: foreground }]);
    const format = formats[index % formats.length];
    await encode(image, format, join(inputDirectory, `${identifier}.${format}`));
  }
  await generateEdgeCases(inputDirectory, alphaDirectory);
}

// Fixtures 41+: edge-case categories with ground truth that the flat corpus can't
// express — interior gaps ("background from the middle"), contact shadows at the
// matte boundary, and partial translucency. Each repeats across three formats.
// Exported so build-corpus-manifest.mjs labels these fixtures identically.
export const edgeCases = ["interior-gaps", "shadow-halo", "soft-translucency"];
export const edgeSizes = [
  [900, 700],
  [1200, 900],
  [640, 960],
];

// A contact shadow multiplies the backdrop by a fixed factor, so the
// darkening ratio a suppression test sees is identical on light and dark
// fields; what changes is where the values land relative to the absolute
// cutoffs in suppressContactShadow — the base <= 16 channel cutoff and the
// luma-variance bound. Covering one light and one dark field exercises the
// predicate both far from and near those thresholds.
export function shadowHaloBackdrop(i) {
  return i % 2 ? [217, 225, 232] : [37, 49, 61];
}

function edgeMaskSvg(width, height, category) {
  const stroke = Math.max(2, Math.round(Math.min(width, height) / 80));
  if (category === "interior-gaps") {
    // A chair-like frame: solid seat/legs, back panel punched with five slat holes.
    const slats = Array.from({ length: 5 }, (_, i) => {
      const x = width * (0.30 + i * 0.10);
      return `<rect x="${x}" y="${height * 0.18}" width="${width * 0.045}" height="${height * 0.44}" rx="${stroke}"/>`;
    }).join("");
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><rect x="${width * 0.22}" y="${height * 0.12}" width="${width * 0.56}" height="${height * 0.50}" fill="#fff"/><rect x="${width * 0.24}" y="${height * 0.62}" width="${width * 0.52}" height="${height * 0.10}" fill="#fff"/><rect x="${width * 0.28}" y="${height * 0.72}" width="${width * 0.05}" height="${height * 0.22}" fill="#fff"/><rect x="${width * 0.67}" y="${height * 0.72}" width="${width * 0.05}" height="${height * 0.22}" fill="#fff"/><g fill="#000">${slats}</g></svg>`;
  }
  if (category === "shadow-halo")
    return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><ellipse cx="50%" cy="38%" rx="26%" ry="30%" fill="#fff"/><rect x="46%" y="60%" width="8%" height="30%" fill="#fff"/></svg>`;
  // soft-translucency: opaque core + two mid-alpha zones (40% and 70%).
  return `<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="#000"/><rect x="30%" y="20%" width="40%" height="60%" fill="#fff"/><rect x="34%" y="24%" width="32%" height="26%" fill="#666666"/><rect x="34%" y="52%" width="32%" height="24%" fill="#b3b3b3"/></svg>`;
}

async function generateEdgeCases(inputDirectory, alphaDirectory) {
  const formats = ["png", "jpeg", "webp"];
  for (let i = 0; i < edgeCases.length * edgeSizes.length; i += 1) {
    const category = edgeCases[i % edgeCases.length];
    const [width, height] = edgeSizes[Math.floor(i / edgeCases.length) % edgeSizes.length];
    const identifier = `known-${String(41 + i).padStart(2, "0")}`;
    const mask = await sharp(Buffer.from(edgeMaskSvg(width, height, category)))
      .greyscale()
      .png({ compressionLevel: 9 })
      .toBuffer();
    await sharp(mask).toFile(join(alphaDirectory, `${identifier}.png`));
    const background = i % 2 ? "#d9e1e8" : "#25313d";
    const subject = i % 3 ? "#c56542" : "#66a37a";
    const foreground = await sharp({ create: { width, height, channels: 3, background: subject } })
      .joinChannel(mask)
      .png()
      .toBuffer();
    let image;
    if (category === "shadow-halo") {
      // Contact shadow: the backdrop darkened to ~55% near the silhouette, fading
      // to full brightness with distance — like a floor shadow under a chair. The
      // variants alternate light and dark fields, matching `background` above.
      const glow = await sharp(mask)
        .blur(Math.max(3, Math.min(width, height) * 0.02))
        .extractChannel(0)
        .raw()
        .toBuffer();
      const bg = shadowHaloBackdrop(i);
      const shadow = Buffer.alloc(width * height * 3);
      for (let p = 0; p < width * height; p += 1) {
        const k = 1 - 0.45 * (glow[p] / 255);
        for (let c = 0; c < 3; c += 1) shadow[p * 3 + c] = Math.round(bg[c] * k);
      }
      image = sharp(shadow, { raw: { width, height, channels: 3 } }).composite([{ input: foreground }]);
    } else {
      image = sharp({ create: { width, height, channels: 3, background } }).composite([{ input: foreground }]);
    }
    const format = formats[i % formats.length];
    await encode(image, format, join(inputDirectory, `${identifier}.${format}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateKnownAlpha(resolve(process.argv[2] ?? ".omo/benchmarks/cutout-owned-engine/corpus/known-alpha")).catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    process.exitCode = 1;
  });
}
