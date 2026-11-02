/**
 * The first candidate URL that serves Cutout, or null. Any server can answer on these
 * ports (another project's dev server on 8080 made the e2e tests drive the wrong app
 * until they hung), so check the web manifest instead of trusting a response. Another
 * checkout of Cutout passes that check too; when `expectCommit` (CUTOUT_EXPECT_COMMIT in
 * CI) is set, the build's /version.json must also name that commit.
 */
export async function findCutout(
  candidates,
  { expectCommit = process.env.CUTOUT_EXPECT_COMMIT } = {},
) {
  for (const url of candidates) {
    try {
      const get = (path) => fetch(new URL(path, url), { signal: AbortSignal.timeout(1500) });
      const manifest = await get("/manifest.webmanifest");
      if (!manifest.ok || (await manifest.json()).name !== "Cutout") continue;
      if (!expectCommit) return url;
      const version = await get("/version.json");
      if (version.ok && (await version.json()).commit === expectCommit) return url;
    } catch {
      /* not running, or not Cutout */
    }
  }
  return null;
}

/** APP_URL when set (and only it: falling back past it reaches whatever else is running), else the fallbacks. */
export const appCandidates = (...fallbacks) =>
  process.env.APP_URL ? [process.env.APP_URL] : fallbacks;

/**
 * The page URL with `?e2e`, which makes a production build expose its store to tests as
 * `window.__cutoutTest` (dev builds always do).
 */
export function e2eUrl(base, route = "/") {
  const url = new URL(route, base);
  url.search = url.search ? `${url.search}&e2e` : "?e2e";
  return url.href;
}
