#!/bin/bash
# Rebuilds heic-to 1.5.2's CSP bundle (dist/csp/heic-to.js) against libheif 1.23.5
# and libde265 1.1.3. Runs inside emscripten/emsdk 5.0.7 with the directory holding
# this script and the archives mounted read-only at /src and an output dir at /out.
# See BUILD.md for the docker command.
set -euo pipefail
SRC=${SRC:-/src}
OUT=${OUT:-/out}
WORK=$(mktemp -d)
cd "$WORK"

tar xzf "$SRC/libheif-1.23.5.tar.gz"
tar xzf "$SRC/heic-to-1.5.2.tar.gz" # unpacks to ./package

# libheif's own emscripten recipe, as heic-to's README uses it, for the CSP variant.
cd libheif-1.23.5
patch -p1 < "$SRC/libheif-1.23.5-emscripten-libde265-cmake.patch"
mkdir buildjs
cd buildjs
cp "$SRC/libde265-1.1.3.tar.gz" . # the script builds it; nothing is downloaded
LIBDE265_VERSION=1.1.3 USE_UNSAFE_EVAL=0 USE_WASM=0 USE_TYPESCRIPT=0 ../build-emscripten.sh ..

# heic-to ships the emscripten output as an ES module under src/lib.
cd "$WORK/package"
{
  echo "// Build from libheif 1.23.5 with USE_UNSAFE_EVAL=0 and LIBDE265_VERSION=1.1.3"
  cat "$WORK/libheif-1.23.5/buildjs/libheif.js"
  printf '\nexport default libheif\n'
} > src/lib/libheif-without-unsafe-eval.js

# Emscripten 5's factory is async (heic-to called it synchronously), and its unused
# Node branch requires "node:fs" etc., which esbuild must leave external like "fs".
patch -p1 < "$SRC/heic-to-1.5.2-emscripten5.patch"
# Install only the integrity-locked build tool, not heic-to's other devDependencies.
# Its optional platform binary is locked too; disable postinstall download fallbacks.
cp "$SRC/heic-build-tools/package.json" "$SRC/heic-build-tools/package-lock.json" "$WORK/"
(cd "$WORK" && npm ci --ignore-scripts --include=optional --no-audit --no-fund)
node esbuild.mjs

mkdir -p "$OUT"
cp dist/csp/heic-to.js "$OUT/csp.js"
cp dist/csp/heic-to.d.ts "$OUT/csp.d.ts"
sha256sum "$OUT/csp.js" "$OUT/csp.d.ts"
