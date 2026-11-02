// Profiles the workspace: ingest → preview → result timings, engine stage
// breakdown, and main-thread responsiveness (long tasks, frame gaps) while
// opening sheets and dragging sliders. Run against a devtools-free server:
//   npx vite --port 8082 & APP_URL=http://127.0.0.1:8082 node scripts/perf-profile.mjs
import { chromium } from "playwright";
import { tmpdir } from "node:os";
import { join } from "node:path";
const url = process.env.APP_URL ?? "http://127.0.0.1:8082";
// A persistent profile keeps the model weights cached between runs.
const profileDir = process.env.PERF_PROFILE_DIR ?? join(tmpdir(), "cutout-perf-profile");
const browser = await chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: true, viewport: { width: 1280, height: 800 }, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-features=Vulkan"] });
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error") console.log("console.error:", m.text().slice(0, 160)); });
// A fresh Vite server discovers dependencies on the first load and reloads once.
await page.goto(new URL("/?e2e", url).href);
await page.waitForTimeout(4000);
await page.goto(new URL("/?e2e", url).href);
await page.waitForFunction(() => window.__cutoutTest?.useWorkspace);
await page.waitForTimeout(1500);
console.log("GPU", JSON.stringify(await page.evaluate(async () => { if (!navigator.gpu) return null; const a = await navigator.gpu.requestAdapter(); return a ? { vendor: a.info?.vendor, arch: a.info?.architecture } : "no adapter"; })));
page.on("console", (m) => { if (m.text().startsWith("STAGE")) console.log(m.text()); });

const makePhoto = async (w, h, name) => page.evaluate(async ([w, h, name]) => {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d");
  const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, "#8fa9c6"); gr.addColorStop(1, "#3b4a5c"); g.fillStyle = gr; g.fillRect(0, 0, w, h);
  const img = g.getImageData(0, 0, w, h); const d = img.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 40; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  g.fillStyle = "#b5623a"; g.beginPath(); g.ellipse(w * 0.5, h * 0.55, w * 0.18, h * 0.3, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = "#e9c3a2"; g.beginPath(); g.arc(w * 0.5, h * 0.3, w * 0.09, 0, Math.PI * 2); g.fill();
  const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  window.__photo = new File([blob], name, { type: "image/jpeg" });
  return blob.size;
}, [w, h, name]);

const instrument = () => page.evaluate(() => {
  window.__long = []; window.__frames = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
  let last = performance.now();
  const tick = () => { const now = performance.now(); window.__frames.push(Math.round(now - last)); last = now; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const summarize = (label) => page.evaluate((label) => {
  const frames = window.__frames.slice(1); const long = window.__long;
  const dropped = frames.filter((f) => f > 34).length; const worst = Math.max(0, ...frames);
  const out = { label, frames: frames.length, droppedFrames: dropped, worstGapMs: worst, longTasks: long.length, longTotalMs: long.reduce((a, b) => a + b, 0), longWorstMs: Math.max(0, ...long) };
  window.__frames = []; window.__long = [];
  return out;
}, label);

// 1. Ingest + processing timeline for a 12 MP photo.
const bytes = await makePhoto(4000, 3000, "photo-12mp.jpg");
await instrument();
const timeline = await page.evaluate(async () => {
  const S = window.__cutoutTest.useWorkspace; const t0 = performance.now(); const marks = { t0 };
  const stages = []; let lastMsg = "";
  const stop = S.subscribe((s) => {
    const item = s.items[0];
    if (item?.sourceUrl && !marks.sourceUrl) marks.sourceUrl = performance.now() - t0;
    if (item?.preview && !marks.preview) marks.preview = performance.now() - t0;
    if (s.progress?.message && s.progress.message !== lastMsg) { lastMsg = s.progress.message; stages.push([Math.round(performance.now() - t0), s.progress.stage, lastMsg]); console.log("STAGE", Math.round(performance.now() - t0), s.progress.stage, lastMsg); }
    if (item?.status === "done" && !marks.done) marks.done = performance.now() - t0;
  });
  S.getState().receiveFiles([window.__photo]);
  await new Promise((r) => { const check = () => (S.getState().items[0]?.status === "done" || S.getState().items[0]?.status === "error") ? r() : setTimeout(check, 50); check(); });
  stop();
  const item = S.getState().items[0];
  return { bytes: window.__photo.size, marks: Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, Math.round(v)])), stages, size: [item.width, item.height], provider: item.provider, method: item.method, durationMs: item.durationMs, note: item.removalNote };
});
console.log("INGEST", JSON.stringify({ bytes, ...timeline }));
console.log("RESP", JSON.stringify(await summarize("during processing")));

// 2. Second image (warm model): processing only.
await makePhoto(3000, 2000, "photo-6mp.jpg");
const warm = await page.evaluate(async () => {
  const S = window.__cutoutTest.useWorkspace; const t0 = performance.now();
  S.getState().receiveFiles([window.__photo]);
  // Receiving on the result screen replaces the current image.
  await new Promise((r) => setTimeout(r, 200));
  await new Promise((r) => { const check = () => { const it = S.getState().items[0]; if ((it && it.name === "photo-6mp.jpg" && (it.status === "done" || it.status === "error")) || performance.now() - t0 > 120000) r(); else setTimeout(check, 50); }; check(); });
  const it = S.getState().items[0];
  return { ms: Math.round(performance.now() - t0), status: it?.status, durationMs: it?.durationMs, error: it?.error ?? null };
});
console.log("WARM", JSON.stringify(warm));
console.log("RESP", JSON.stringify(await summarize("during warm processing")));

// 3. UI responsiveness: sheets, sliders, item switching.
const act = async (label, fn) => { await instrument(); await fn(); await page.waitForTimeout(600); console.log("RESP", JSON.stringify(await summarize(label))); };
await act("open Adjust", async () => { await page.getByRole("button", { name: "Adjust", exact: true }).click(); await page.waitForTimeout(400); });
await act("feather slider x6", async () => { for (const v of [2, 4, 6, 8, 6, 3]) { await page.evaluate((v) => window.__cutoutTest.useWorkspace.getState().setFeather(v), v); await page.waitForTimeout(120); } await page.waitForFunction(() => !window.__cutoutTest.useWorkspace.getState().previewBusy); });
await act("background chips", async () => { for (const bg of [{ type: "color", color: "#ffffff" }, { type: "blur" }, { type: "gradient", from: "#ff0000", to: "#0000ff", angle: 90 }, { type: "transparent" }]) { await page.evaluate((bg) => window.__cutoutTest.useWorkspace.getState().setBackground(bg), bg); await page.waitForTimeout(250); } await page.waitForFunction(() => !window.__cutoutTest.useWorkspace.getState().previewBusy); });
await act("close Adjust, open Enhance", async () => { await page.getByRole("button", { name: "Close adjust", exact: true }).click(); await page.getByRole("button", { name: "Enhance", exact: true }).click(); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape"); });
await act("open Batch", async () => { await page.getByRole("button", { name: "Batch (1)", exact: true }).click(); await page.getByRole("dialog").waitFor(); await page.keyboard.press("Escape"); });
await act("open Subject", async () => { await page.getByRole("button", { name: "Subject", exact: true }).click(); await page.getByRole("dialog").waitFor(); await page.waitForTimeout(800); await page.keyboard.press("Escape"); });
await act("compare toggle + info", async () => { await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setComparing(true)); await page.waitForTimeout(300); await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().setComparing(false)); await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().openInfo()); await page.waitForTimeout(500); await page.evaluate(() => window.__cutoutTest.useWorkspace.getState().closeInfo()); });
await browser.close();
