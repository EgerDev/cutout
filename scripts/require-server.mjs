// How e2e and browser suites find the app. Locally a missing server skips an e2e suite;
// with CUTOUT_REQUIRE_E2E set (CI) it fails, so a run that tested nothing is never green.
import assert from "node:assert/strict";
import { findCutout } from "./app-url.mjs";

/** Skip locally; fail when CUTOUT_REQUIRE_E2E is set. */
export function skipOrFail(t, reason) {
  if (process.env.CUTOUT_REQUIRE_E2E) assert.fail(`${reason} (CUTOUT_REQUIRE_E2E is set)`);
  t.skip(reason);
}

function missing(candidates) {
  const commit = process.env.CUTOUT_EXPECT_COMMIT;
  return `No Cutout${commit ? ` build of ${commit}` : ""} at ${candidates.join(" or ")}`;
}

/** The first candidate serving this build, or null after skipOrFail. */
export async function cutoutOrSkip(t, candidates) {
  const url = await findCutout(candidates);
  if (!url) skipOrFail(t, missing(candidates));
  return url;
}

/** Same lookup for suites that always need a server: throws when there is none. */
export async function requireCutout(candidates) {
  const url = await findCutout(candidates);
  if (!url) throw new Error(missing(candidates));
  return url;
}
