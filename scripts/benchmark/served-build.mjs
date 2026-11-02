import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { BenchmarkContractError } from "./contract.mjs";

const run = promisify(execFile);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function fetchHash(url, path, timeoutMs, signal) {
  const requestSignal = signal
    ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
    : AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(new URL(path.slice(1), url), { signal: requestSignal });
  } catch (error) {
    throw new BenchmarkContractError(`Could not read ${path} from ${url}: ${String(error)}`);
  }
  if (!response.ok) return { status: response.status, sha256: null };
  return { status: response.status, sha256: sha256(Buffer.from(await response.arrayBuffer())) };
}

/**
 * What a checkout's server must serve byte for byte: the page, version.json and every file
 * its build wrote under assets/ (the client and worker bundles, wasm included). The .br/.gz
 * siblings are other encodings of those files; fetch decodes whichever one is served.
 */
async function builtFiles(publicDir) {
  const entries = await readdir(join(publicDir, "assets"), {
    recursive: true,
    withFileTypes: true,
  });
  const assets = entries
    .filter((entry) => entry.isFile() && !/\.(br|gz)$/.test(entry.name))
    .map(
      (entry) => `/${relative(publicDir, join(entry.parentPath, entry.name)).split(sep).join("/")}`,
    );
  return ["/", "/version.json", ...assets].sort();
}

/**
 * The build a production origin serves, as hashes (C54). /version.json is a commit string,
 * which a dirty or swapped build reports just the same; the bytes are the build. Without a
 * checkout this fingerprints /version.json and the page (which names every content-hashed
 * entry asset), which detects page/version changes but cannot verify asset bytes or release
 * eligibility. With the checkout the server was built from, that checkout must be at the
 * named commit with a clean status (unless dirt is allowed, then it is recorded) and every
 * built file must be what the origin serves.
 * Needs nothing from the server beyond what 5522eee already serves.
 */
export async function servedBuild(
  url,
  { checkoutDir, expectedCommit, allowDirty = false, timeoutMs, signal } = {},
) {
  const version = await fetchHash(url, "/version.json", timeoutMs, signal);
  const page = await fetchHash(url, "/", timeoutMs, signal);
  for (const [path, response] of [
    ["/version.json", version],
    ["/", page],
  ])
    if (!response.sha256)
      throw new BenchmarkContractError(`${url} answered ${path} with HTTP ${response.status}`);
  const fingerprint = { versionSha256: version.sha256, pageSha256: page.sha256, checkout: null };
  if (!checkoutDir) return fingerprint;

  // Read-only: no optional index refresh in a checkout that is someone else's to keep clean.
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  const git = async (...args) =>
    (await run("git", ["-C", checkoutDir, ...args], { env })).stdout.trim();
  const head = await git("rev-parse", "HEAD");
  if (head !== expectedCommit)
    throw new BenchmarkContractError(
      `checkout ${checkoutDir} HEAD ${head} is not ${expectedCommit}`,
    );
  const status = await git("status", "--porcelain=v1", "--untracked-files=all");
  const dirtyPaths = status ? status.split("\n") : [];
  if (dirtyPaths.length > 0 && !allowDirty)
    throw new BenchmarkContractError(
      `checkout ${checkoutDir} is dirty: ${dirtyPaths.slice(0, 5).join(", ")}${dirtyPaths.length > 5 ? ` and ${dirtyPaths.length - 5} more` : ""}; its build is not the named commit (--allow-dirty records a non-release run)`,
    );

  const publicDir = join(checkoutDir, ".output/public");
  const files = await builtFiles(publicDir);
  const known = { "/": page, "/version.json": version };
  const mismatched = [];
  const lines = [];
  for (const path of files) {
    const local = sha256(
      await readFile(join(publicDir, path === "/" ? "index.html" : path.slice(1))),
    );
    const response = known[path] ?? (await fetchHash(url, path, timeoutMs, signal));
    if (!response.sha256) mismatched.push(`${path} (HTTP ${response.status})`);
    else if (response.sha256 !== local) mismatched.push(`${path} (bytes differ)`);
    lines.push(`${local}  ${path}`);
  }
  if (mismatched.length > 0)
    throw new BenchmarkContractError(
      `${url} does not serve the build in ${publicDir}: ${mismatched.slice(0, 5).join(", ")}${mismatched.length > 5 ? ` and ${mismatched.length - 5} more` : ""}`,
    );
  return {
    ...fingerprint,
    checkout: { dir: checkoutDir, head, dirtyPaths, files, sha256: sha256(lines.join("\n")) },
  };
}

/** What differs between two fingerprints of one origin, e.g. at lane start and lane end. */
export function servedBuildChanges(start, end) {
  const changes = [];
  if (start.versionSha256 !== end.versionSha256) changes.push("/version.json");
  if (start.pageSha256 !== end.pageSha256) changes.push("/");
  if (start.checkout?.sha256 !== end.checkout?.sha256)
    changes.push(`the build files of ${start.checkout?.dir}`);
  return changes;
}
