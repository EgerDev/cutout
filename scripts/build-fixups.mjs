/**
 * Corrections applied inside the build to artifacts Nitro/TanStack emit. Kept
 * pure and in scripts/ so the rules can be unit tested without a build.
 */

/** Nitro's transport-encoding suffixes, same table as its internal EncodingMap. */
const TRANSPORT_SUFFIX = /\.(gz|br|zst)$/;

/** A served `.gz`/`.br`/`.zst` file with no uncompressed sibling is content, not encoding. */
const INTRINSIC_TYPE = {
  gz: "application/gzip",
  br: "application/octet-stream",
  zst: "application/zstd",
};

/**
 * Nitro marks every public file ending in .gz/.br/.zst as a transport encoding of
 * the same path without the suffix. That is only true for the compressed copies
 * it emits next to a real file: public/third-party/source/*.tar.gz are the files
 * themselves, and serving one with `Content-Encoding: gzip` makes fetch/browsers
 * hand the downloader a bare .tar under a .tar.gz name. Keep the encoding only
 * when the uncompressed sibling exists; otherwise serve the archive bytes under
 * the archive's type. `.tgz` never matched the suffix, so Nitro fell back to
 * text/plain for exifreader's tarball: give it the gzip type too.
 */
export function fixPublicAssetEncodings(assets) {
  for (const [id, asset] of Object.entries(assets)) {
    if (!TRANSPORT_SUFFIX.test(id) && id.endsWith(".tgz")) asset.type = "application/gzip";
  }
  for (const [id, asset] of Object.entries(assets)) {
    const suffix = id.match(TRANSPORT_SUFFIX);
    if (!suffix) continue;
    const base = id.slice(0, -suffix[0].length);
    const sibling = assets[base];
    if (sibling) {
      // A real compressed variant: Content-Encoding stays, and its type is the
      // (already fixed) type of the file it decodes to.
      asset.type = sibling.type;
    } else {
      delete asset.encoding;
      asset.type = INTRINSIC_TYPE[suffix[1]];
    }
  }
  return assets;
}

/**
 * The emitted TanStack start manifest serializes each route's absolute filePath
 * so the build can match chunks to route files. Nothing reads them at runtime
 * (getStartManifest forwards only preloads/scripts/css), so a shipped server
 * carried the build checkout's absolute paths. Rewrite them relative to the
 * project root; anything that is not an absolute path inside the root means the
 * upstream shape changed — fail instead of shipping a wrong or leaky manifest.
 */
export function rewriteManifestFilePaths(code, root) {
  const prefix = `${root.replaceAll("\\", "/").replace(/\/+$/, "")}/`;
  let found = 0;
  const out = code.replace(/(filePath\s*:\s*)("(?:[^"\\]|\\.)*")/g, (_match, key, raw) => {
    const value = JSON.parse(raw).replaceAll("\\", "/");
    found += 1;
    if (!value.startsWith(prefix))
      throw new Error(`start manifest filePath is not inside the project root: ${value}`);
    return key + JSON.stringify(value.slice(prefix.length));
  });
  if (!found) throw new Error("start manifest has no route filePath entries to make portable");
  return out;
}
