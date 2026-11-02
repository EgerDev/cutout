/**
 * Renders the PNG icons from public/favicon.svg: the Apple touch icon (180), the
 * manifest's 192 and 512 (Chrome offers to install only with both), and a maskable 512
 * whose artwork sits in the central safe zone on a full-bleed background.
 * Usage: node scripts/render-icon.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");
const icons = [
  { file: "icon-180.png", size: 180, maskable: false },
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
];
const browser = await chromium.launch();
for (const { file, size, maskable } of icons) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  // Maskable: the platform crops to a circle or squircle; keep the art within 80%.
  const art = maskable ? Math.round(size * 0.8) : size;
  await page.setContent(
    `<style>html,body{margin:0;background:${maskable ? "#111111" : "transparent"}}` +
      `body{display:grid;place-items:center;width:${size}px;height:${size}px}` +
      `svg{display:block;width:${art}px;height:${art}px}</style>${svg}`,
  );
  await page.screenshot({
    path: fileURLToPath(new URL(`../public/${file}`, import.meta.url)),
    omitBackground: !maskable,
  });
  await page.close();
}
await browser.close();
