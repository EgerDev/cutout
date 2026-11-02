import assert from "node:assert/strict";
import { test } from "node:test";
import { fixPublicAssetEncodings, rewriteManifestFilePaths } from "./build-fixups.mjs";

const asset = (type, encoding) => ({ type, ...(encoding ? { encoding } : {}) });

test("a .gz file with no uncompressed sibling is the archive itself", () => {
  const assets = {
    "/third-party/source/heic-to-1.5.2.tar.gz": asset("application/x-tar", "gzip"),
  };
  fixPublicAssetEncodings(assets);
  assert.deepEqual(assets["/third-party/source/heic-to-1.5.2.tar.gz"], {
    type: "application/gzip",
  });
});

test(".br and .zst files without a sibling are intrinsic content too", () => {
  const assets = {
    "/data/file.br": asset("application/wasm", "br"),
    "/data/file.zst": asset("application/wasm", "zstd"),
  };
  fixPublicAssetEncodings(assets);
  assert.deepEqual(assets["/data/file.br"], { type: "application/octet-stream" });
  assert.deepEqual(assets["/data/file.zst"], { type: "application/zstd" });
});

test("a .gz/.br next to its real file stays a transport encoding", () => {
  const assets = {
    "/index.html": asset("text/html; charset=utf-8"),
    "/index.html.gz": asset("text/html; charset=utf-8", "gzip"),
    "/index.html.br": asset("text/html; charset=utf-8", "br"),
    "/assets/app.css": asset("text/css; charset=utf-8"),
    "/assets/app.css.gz": asset("text/css; charset=utf-8", "gzip"),
  };
  fixPublicAssetEncodings(assets);
  assert.deepEqual(assets["/index.html.gz"], {
    type: "text/html; charset=utf-8",
    encoding: "gzip",
  });
  assert.deepEqual(assets["/index.html.br"], {
    type: "text/html; charset=utf-8",
    encoding: "br",
  });
  assert.deepEqual(assets["/assets/app.css.gz"], {
    type: "text/css; charset=utf-8",
    encoding: "gzip",
  });
});

test("a .tgz archive gets the gzip type and variants mirror it", () => {
  const assets = {
    "/third-party/source/exifreader-4.45.0.tgz": asset("text/plain; charset=utf-8"),
    "/third-party/source/exifreader-4.45.0.tgz.gz": asset("text/plain; charset=utf-8", "gzip"),
    "/third-party/source/exifreader-4.45.0.tgz.br": asset("text/plain; charset=utf-8", "br"),
  };
  fixPublicAssetEncodings(assets);
  assert.equal(assets["/third-party/source/exifreader-4.45.0.tgz"].type, "application/gzip");
  // The variants still decode to the .tgz: their type mirrors the fixed base.
  assert.deepEqual(assets["/third-party/source/exifreader-4.45.0.tgz.gz"], {
    type: "application/gzip",
    encoding: "gzip",
  });
  assert.deepEqual(assets["/third-party/source/exifreader-4.45.0.tgz.br"], {
    type: "application/gzip",
    encoding: "br",
  });
});

test("the fix is idempotent and leaves other files alone", () => {
  const assets = {
    "/x.tar.gz": asset("application/x-tar", "gzip"),
    "/README.txt": asset("text/plain; charset=utf-8"),
  };
  fixPublicAssetEncodings(assets);
  const once = structuredClone(assets);
  fixPublicAssetEncodings(assets);
  assert.deepEqual(assets, once);
  assert.deepEqual(assets["/README.txt"], { type: "text/plain; charset=utf-8" });
});

test("manifest filePaths under the project root become relative", () => {
  const code = `export const tsrStartManifest = () => ({ routes: {
    __root__: { filePath: "/repo/src/routes/__root.tsx", children: ["/"] },
    "/": { filePath: "/repo/src/routes/index.tsx", preloads: ["/assets/x.js"] },
  }})`;
  const out = rewriteManifestFilePaths(code, "/repo");
  assert.match(out, /filePath:\s*"src\/routes\/__root\.tsx"/);
  assert.match(out, /filePath:\s*"src\/routes\/index\.tsx"/);
  assert.match(out, /preloads: \["\/assets\/x\.js"\]/);
  assert.ok(!out.includes("/repo/"), `still absolute: ${out}`);
});

test("a filePath outside the project root fails loudly", () => {
  const code = `export const tsrStartManifest = () => ({ routes: {
    "/": { filePath: "/elsewhere/src/routes/index.tsx" },
  }})`;
  assert.throws(() => rewriteManifestFilePaths(code, "/repo"), /not inside the project root/);
});

test("a manifest without filePaths fails loudly instead of passing silently", () => {
  const code = `export const tsrStartManifest = () => ({ routes: {} })`;
  assert.throws(() => rewriteManifestFilePaths(code, "/repo"), /no route filePath/);
});
