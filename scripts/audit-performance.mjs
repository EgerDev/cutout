import { launchChromeContext } from "./chrome.mjs";
import { playAudit } from "playwright-lighthouse";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

// Reserve an available port rather than competing with another audit on 9337.
async function debugPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === "string") throw new Error("Could not allocate audit port");
  return address.port;
}

const url = process.env.APP_URL || "http://127.0.0.1:8081/";
const directory = process.env.AUDIT_DIR || join(tmpdir(), "cutout-performance");
const profiles = (process.env.AUDIT_PROFILES || "cold,warm")
  .split(",")
  .map((value) => value.trim());
if (!profiles.length || profiles.some((profile) => profile !== "cold" && profile !== "warm"))
  throw new Error("AUDIT_PROFILES must contain cold, warm, or cold,warm");
const runCount = Number(process.env.AUDIT_RUNS || 3);
if (!Number.isInteger(runCount) || runCount < 1)
  throw new Error("AUDIT_RUNS must be a positive integer");
await mkdir(directory, { recursive: true });
const results = [];
for (const formFactor of ["mobile", "desktop"]) {
  for (const cacheProfile of profiles) {
    for (let run = 1; run <= runCount; run++) {
      const profileDirectory = await mkdtemp(join(tmpdir(), "cutout-lighthouse-"));
      let context;
      try {
        const port = await debugPort();
        context = await launchChromeContext(profileDirectory, {
          args: [`--remote-debugging-port=${port}`],
          ignoreDefaultArgs: ["--disable-back-forward-cache"],
          viewport:
            formFactor === "mobile" ? { width: 412, height: 823 } : { width: 1350, height: 940 },
        });
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        const browser = await cdp.send("Browser.getVersion");
        await cdp.detach();
        // A real ordinary visit, in the SAME default context Lighthouse uses.
        // Cold runs skip warming and explicitly reset storage/cache below.
        if (cacheProfile === "warm") await page.goto(url, { waitUntil: "networkidle" });
        const settings =
          formFactor === "desktop"
            ? {
                formFactor,
                screenEmulation: {
                  mobile: false,
                  width: 1350,
                  height: 940,
                  deviceScaleFactor: 1,
                  disabled: false,
                },
                throttling: {
                  rttMs: 40,
                  throughputKbps: 10240,
                  cpuSlowdownMultiplier: 1,
                  requestLatencyMs: 0,
                  downloadThroughputKbps: 0,
                  uploadThroughputKbps: 0,
                },
              }
            : { formFactor };
        const audit = await playAudit({
          page,
          url,
          port,
          ignoreError: true,
          opts: { disableStorageReset: cacheProfile === "warm" },
          thresholds: { performance: 100, accessibility: 100, "best-practices": 100, seo: 100 },
          reports: {
            formats: { json: true },
            name: `${formFactor}-${cacheProfile}-${run}`,
            directory,
          },
          config: { extends: "lighthouse:default", settings },
        });
        const lhr = audit.lhr || audit;
        const assets = (lhr.audits["network-requests"].details?.items ?? [])
          .filter((request) => new URL(request.url).pathname.startsWith("/assets/"))
          .map(({ url, transferSize, resourceSize, statusCode }) => ({
            url,
            transferSize,
            resourceSize,
            statusCode,
          }));
        const row = {
          formFactor,
          cacheProfile,
          run,
          browserVersion: browser.product,
          storageReset: !lhr.configSettings.disableStorageReset,
          throttlingMethod: lhr.configSettings.throttlingMethod,
          throttling: lhr.configSettings.throttling,
          assetTransferBytes: assets.reduce((bytes, asset) => bytes + asset.transferSize, 0),
          zeroTransferAssets: assets.filter((asset) => asset.transferSize === 0).length,
          assets,
          scores: Object.fromEntries(
            Object.entries(lhr.categories).map(([k, v]) => [k, Math.round(v.score * 100)]),
          ),
          lcp: lhr.audits["largest-contentful-paint"].numericValue,
          tbt: lhr.audits["total-blocking-time"].numericValue,
          cls: lhr.audits["cumulative-layout-shift"].numericValue,
          failures: Object.entries(lhr.audits)
            .filter(([, a]) => a.score !== null && a.score < 1)
            .map(([id, a]) => ({ id, title: a.title, score: a.score })),
        };
        results.push(row);
        await writeFile(`${directory}/summary.json`, JSON.stringify(results, null, 2));
        console.log(JSON.stringify(row));
      } finally {
        try {
          await context?.close();
        } finally {
          await rm(profileDirectory, { recursive: true, force: true });
        }
      }
    }
  }
}
