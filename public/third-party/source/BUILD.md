# HEIC decoder: what ships and how to rebuild it

## What ships

When a browser cannot decode HEIC/HEIF itself (for example Chrome and Firefox),
Cutout loads a separate JavaScript module, `assets/csp-<hash>.js`, that contains
the HEIC decoder. It is the "CSP" build (no `eval`, no `new Function`) of
[heic-to](https://github.com/hoppergee/heic-to) 1.5.2, rebuilt against newer
decoder libraries than the ones heic-to 1.5.2 was published with:

| Component | Version                                        | Licence                                                    | Role                          |
| --------- | ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------- |
| heic-to   | 1.5.2 (with `heic-to-1.5.2-emscripten5.patch`) | LGPL-3.0-or-later (see `/third-party/heic-to-LICENSE.txt`) | JavaScript wrapper and worker |
| libheif   | 1.23.5                                         | LGPL-3.0-or-later                                          | HEIF container parsing        |
| libde265  | 1.1.3                                          | LGPL-3.0-or-later                                          | HEVC image decoding           |

heic-to's `package.json` uses the deprecated SPDX id `LGPL-3.0`; its LICENSE text
grants "version 3 of the License, or (at your option) any later version".

The libraries are compiled to asm.js (JavaScript, `-sWASM=0`) with Emscripten.
The npm release of heic-to 1.5.2 bundles libheif 1.22.2 and libde265 1.0.16,
which have published security advisories; Cutout does not ship that code.

In this repository the module is `vendor/heic-to/csp.js` (SHA-256
`c53bfb35516bee71191ef066a43cf1cfb9837417befb8189345dfef576a6b2a3`, 3,350,528 bytes).
The app's `import("heic-to/csp")` resolves to it through a Vite alias, and Vite
emits it as its own chunk (re-minified, same code).

## Corresponding source in this directory

| File                                             | SHA-256                                                            | Upstream                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `heic-to-1.5.2.tar.gz`                           | `a301b46a2e5a2a050c44d7c1655d63b4c17415312ebcfa82920e950baffc5a7f` | https://registry.npmjs.org/heic-to/-/heic-to-1.5.2.tgz (npm sha1 `a512b9564bcfe4729071c7eb621643855f826465`) |
| `libheif-1.23.5.tar.gz`                          | `fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a` | https://github.com/strukturag/libheif/releases/download/v1.23.5/libheif-1.23.5.tar.gz                        |
| `libde265-1.1.3.tar.gz`                          | `554228bd17788c99a7e63b37ab5634722190e6e2bf60c1dcb01cef328e133905` | https://github.com/strukturag/libde265/releases/download/v1.1.3/libde265-1.1.3.tar.gz                        |
| `libheif-1.23.5-emscripten-libde265-cmake.patch` | `04cde97f8e317fba97e65096f10d8e5f0a7da1709c0d62446f712ea59a639ca0` | our change to libheif's `build-emscripten.sh`                                                                |
| `heic-to-1.5.2-emscripten5.patch`                | `53210d1c0e4a90b47d2a8462bf982efd6ad3338458e92ca3b9f4ac9e81dcb09d` | our change to heic-to's `src/worker.js` and `esbuild.mjs`                                                    |
| `build-heic-to.sh`                               | `0c27ccca8a44aead9b4a533fdcc64954e17ba2a95389e1f3790820af21c0430c` | the build script below                                                                                       |
| `heic-build-tools/package.json` | `87abe01e9610e6caab1ae6bed1a0df85e51015671c167f6f2abe941a18e7947c` | isolated esbuild 0.25.12 build-tool inputs |
| `heic-build-tools/package-lock.json` | `5088ac4d843419d1c5b54431adaeedc859842a38ed84711cabb86f7bccbf06d8` | isolated esbuild 0.25.12 build-tool inputs |

The two upstream archives are the release assets GitHub publishes for those tags;
their SHA-256 matches the `digest` GitHub reports for each asset
(`gh api repos/strukturag/libheif/releases/tags/v1.23.5 --jq '.assets[].digest'`,
likewise for libde265 `v1.1.3`).

What the patches change, and why:

- **libheif `build-emscripten.sh`**: libde265 1.1 builds with CMake only (its
  autotools `configure` was removed), so the script builds it with `emcmake cmake`
  (static, no SDL, no SIMD, no `dec265`/`enc265` tools) and links the installed
  `libde265.a`. Everything else in libheif's script is unchanged.
- **heic-to `src/worker.js`**: Emscripten 5's module factory returns a promise; the
  worker now awaits it before decoding. The public API (`heicTo`, `isHeic`) and its
  behaviour are unchanged.
- **heic-to `esbuild.mjs`**: Emscripten 5 writes `require("node:fs")` (and
  `node:path`, `node:crypto`) in a branch that only runs under Node; they are marked
  external exactly like heic-to already does for `fs`, `path` and `crypto`.

## Rebuild it

Requirements: Docker (Linux containers). From this directory:

```sh
mkdir -p out
docker run --rm --memory 8g --cpus 6 -e CORES=6 \
  -v "$PWD:/src:ro" -v "$PWD/out:/out" \
  emscripten/emsdk:5.0.7@sha256:4e332f7343b6f66320bf72f7ecc01a3d9f3866721a13b0e5c7b96505d6ab148a \
  bash /src/build-heic-to.sh
sha256sum out/csp.js   # c53bfb35516bee71191ef066a43cf1cfb9837417befb8189345dfef576a6b2a3
```

The build is deterministic: clean runs with exactly this command produced
byte-identical `csp.js`. Lower `--memory`/`--cpus`/`CORES` values also work, only
slower. Do not drop the limits: without them the script compiles on every core at
once and can exhaust Docker Desktop's memory.

`build-heic-to.sh` does the following inside the container (Emscripten 5.0.7):

1. Unpacks libheif 1.23.5, applies `libheif-1.23.5-emscripten-libde265-cmake.patch`,
   and runs libheif's own recipe the way heic-to's README documents it for the
   CSP variant (libde265 comes from the archive here; nothing is downloaded):

   ```sh
   LIBDE265_VERSION=1.1.3 USE_UNSAFE_EVAL=0 USE_WASM=0 USE_TYPESCRIPT=0 ../build-emscripten.sh ..
   ```

   That script links with `-sWASM=0 -sDYNAMIC_EXECUTION=0 -sMODULARIZE`,
   `-sEXPORT_NAME=libheif -sWASM_ASYNC_COMPILATION=0 -sALLOW_MEMORY_GROWTH`,
   `-lembind -O3 --post-js post.js`.

2. Unpacks heic-to 1.5.2, applies `heic-to-1.5.2-emscripten5.patch`, and replaces
   `src/lib/libheif-without-unsafe-eval.js` with the new `libheif.js` plus
   `export default libheif` (the same shape heic-to ships).
3. Copies the isolated `heic-build-tools` manifest and lock into the temporary
   build root, then installs esbuild 0.25.12 with `npm ci --ignore-scripts
   --include=optional`. The lock records SHA-512 integrity for esbuild and each
   native platform package; optional packages are included so no postinstall
   download fallback is needed. This excludes heic-to's unrelated development
   server dependencies. Runs heic-to's own `node esbuild.mjs`, which resolves
   esbuild from the parent build root's `node_modules`.
4. Copies `dist/csp/heic-to.js` to `out/csp.js` and `dist/csp/heic-to.d.ts` to
   `out/csp.d.ts`.

## Replace or relink the decoder

The decoder is a separate module with a two-function interface
(`heicTo({ blob, type, quality, options })` and `isHeic(file)`, typed in
`vendor/heic-to/csp.d.ts`), so you can swap in your own build of heic-to, libheif
or libde265:

1. Build your version (for example, change the archives or patches above and rerun
   the build), or take any other module with the same exports.
2. In a checkout of Cutout (its source is public), copy it over
   `vendor/heic-to/csp.js`.
3. `npm ci && npm run build`, then run the new `.output` as usual.

Rebuild rather than swapping the file inside an existing `.output`: the Node
server's asset table records each file's size and ETag at build time, and it
serves precompressed `.br`/`.gz` copies first.
