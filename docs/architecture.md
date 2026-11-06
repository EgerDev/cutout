# Cutout architecture

This describes the current application. See [release-status.md](release-status.md)
for the verification scope and supported-platform limits.

## What the product is

Cutout is a background remover and light photo editor that runs **entirely in the
visitor's browser**. A user drops, pastes, picks, or links an image; an on-device
neural network (BiRefNet lite, or ISNet on low-memory devices) produces an alpha matte;
the user refines it (brush, subject pieces, colour edits, backgrounds, presets) and
exports PNG / JPEG / WebP / BMP (always), AVIF / HEIC (when WebCodecs allows), SVG
(traced), ZIP batches, and contact/sprite sheets.

There are **no accounts, no database, no server API, no uploads, no analytics, no
payments, no email**. The server only serves static files.

## Components

```
Visitor browser ──HTTPS──> Caddy (TLS, HSTS, nosniff, Referrer-Policy, access log)
      │                        └─> Nitro node-server :3000 (prerendered HTML + hashed assets, /healthz)
      │
      ├──HTTPS──> huggingface.co (+ its CDN)  model weights, pinned revisions, cached in Cache API
      ├──HTTPS──> any host named in ?src=     only when a launch link asks for it (CORS, no credentials)
      └──click──> www.google.com/maps         only when the user clicks a GPS link in Info
```

| Layer                      | Technology                                                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| UI                         | React 19, TanStack Router/Start, Tailwind 4, Radix dialog/dropdown, lucide icons                                                                                                                                                                                                                                                                                                                   | `src/routes`, `src/features`                                                                     |
| State                      | zustand store (`useWorkspace`), per-item queue, editor state                                                                                                                                                                                                                                                                                                                                       | `src/lib/workspace-*.ts`, `src/lib/editor/state.ts`                                              |
| Decoding                   | `createImageBitmap`/`<img>`; heic-to (libheif+libde265 asm.js) for HEIC; utif2 in a worker for TIFF (50 MB compressed-file cap before full reads); hand-written PDF/DWG/SKP thumbnail extractors and dxf-parser rasteriser for CAD. JPEG/HEIF header scan limits refuse decoding if the size cannot be checked.                                                                                    | `files.ts`, `decode-bitmap.ts`, `decode-worker.ts`, `cad.ts`                                     |
| Removal                    | Cutout's own removal engine → transformers.js 3.8.1 (patched at install) → onnxruntime-web (WebGPU, else WASM threads/SIMD). Worker when OffscreenCanvas exists, main thread otherwise                                                                                                                                                                                                             | `engine.ts`, `removal-client.ts`, `removal-worker.ts`, `scripts/patch-dependencies.mjs`          |
| Graphics fast path         | WASM colour key for logos / flat art (hand-written SIMD `.wat`)                                                                                                                                                                                                                                                                                                                                    | `graphics.ts`, `knock-wasm.ts`, `key-simd.wat`                                                   |
| Matte finishing            | guided filter, defringe/decontaminate, GPU unblend                                                                                                                                                                                                                                                                                                                                                 | `guided-filter.ts`, `defringe.ts`, `gpu-matte.ts`                                                |
| Optional models            | Swin2SR ×2/×4 (enhance, worker), Depth Anything V2 small (depth blur with fresh-worker recovery after failed or hung page initialization)                                                                                                                                                                                                                                                          | `enhance*.ts`, `editor/depth.ts`, `editor/depth-worker.ts`                                       |
| Preview                    | WebGPU → WebGL2 → 2D canvas stage                                                                                                                                                                                                                                                                                                                                                                  | `stage-gpu.ts`, `features/workspace/stage.tsx`                                                   |
| Export                     | 2D canvas encode, target-size search, BMP encoder, WebCodecs + custom HEIF muxer, imagetracerjs SVG, fflate ZIP                                                                                                                                                                                                                                                                                    | `editor/export.ts`, `still-encode.ts`, `heif-mux.ts`, `editor/vectorize.ts`, `editor/archive.ts` |
| Metadata                   | ExifReader inspection, lossless PNG/JPEG/WebP strippers, canvas fallback                                                                                                                                                                                                                                                                                                                           | `metadata.ts`, `metadata-client.ts`                                                              |
| Persistence (browser only) | IndexedDB `cutout-workspace` (opt-in autosave, 250 MB cap, zod-validated); Cache API `transformers-cache` (models); localStorage `cutout.enhance.tileMs`, `cutout:removal-webgpu-failure:v1` (`{version, fingerprint, kind}`; fingerprint = transformers and model revisions, no user agent; legacy `bg0:webgpu-failure:*` is only read for compatibility, and removed when local data is cleared) | `editor/session.ts`, `models.ts`                                                                 |
| Server                     | Nitro 3 beta `node-server` preset; 6 prerendered pages plus a prerendered `/404`; middleware `/healthz` and COOP/COEP on every response                                                                                                                                                                                                                                                            | `vite.config.ts`, `server/`                                                                      |
| Deploy                     | Docker multi-stage (node:24 slim → alpine, non-root, read-only) + Caddy 2 via compose; or systemd unit                                                                                                                                                                                                                                                                                             | `Dockerfile`, `compose.yaml`, `deploy/`                                                          |
| Tests                      | node:test unit, Playwright e2e, and browser suites listed under the `test:*` scripts in `package.json`; runnable locally or in CI                                                                                                                                                                                                                                                                  | `src/**/*.test.ts`, `scripts/`, `.github/workflows/ci.yml`                                       |
| Optional CI/CD             | GitHub Actions recipes for tests, release, CodeQL, dependency-review, Scorecard and uptime; hosted execution is not required for local operation or manual verification                                                                                                                                                                                                                            | `.github/workflows/`                                                                             |

Deletion leaves only a random `cutout:workspace-deleted` receipt, containing no workspace
data. Tabs check it before opening IndexedDB, creating stores, writing and publishing saves;
storage notifications also pause autosave and invalidate locally saved results. This fences
old saves even when a background tab receives the notification late.

## Main workflow

1. **Ingest** (`workspace-ingest.ts`): drop / paste / file picker / `?src=` link → up to
   15 files → sniff type (`files.ts`) → convert HEIC/TIFF/CAD/SVG to something the
   engine accepts → pixel budget (`processingLimits`) → queue item with an object URL.
2. **Queue** (`workspace-queue.ts`, `workspace-process.ts`): one item at a time,
   cancellable (`AbortController` per job). Stop preserves completed results and
   source images; Retry/Resume serialize new work and reject stopped completions.
3. **Remove** (`removal-client.ts` → `engine.ts`): graphics classifier first (paper /
   flat art keyed in WASM), else model inference; WebGPU failure falls back to WASM;
   empty mask → flood recovery; result matte finished (guided filter, defringe).
4. **Edit**: brush, subject pieces (click to keep/remove components), colour
   recolour/knock-out, backgrounds (solid, gradient, image, blur, depth blur), shadow,
   presets, enhance (upscale then re-cut), history (40 steps / 64 MB).
5. **Export / share**: download, copy to clipboard, Web Share, ZIP, sheets, SVG.
   Optional "Strip metadata" and "Download original, cleaned".
6. **Persist** (opt-in): snapshot to IndexedDB; resume on next visit.

## Trust boundaries and attack surface

There is no server-side user data, so classic server vulnerabilities (IDOR, SQLi,
auth) do not apply. The real surface is:

- **Untrusted files** the user opens (every decoder/parser above runs on attacker bytes).
- **Untrusted links** (`?src=`, `preset`, `format`, `bg`, `name`, `download`) —
  `url-api.ts`, `use-launch-params.ts`.
- **Third-party model hosting** (Hugging Face repos owned by unrelated individuals).
- **The static server** (public, unauthenticated, no rate limit).
- **Supply chain**: npm deps, the install-time patch of transformers.js and onnxruntime-web.

## Not present (verified absent)

Authentication, sessions, cookies, OAuth, database, queues, server workers, caches
beyond the browser, file upload endpoints, WebSockets, email, payments, analytics,
telemetry, crash reporting, admin routes, feature-flag service, LLMs/agents/tool
calling, service worker.

## Source distribution

The current app has no authentication provider or preview-auth scaffold. Public
source snapshots omit private development history, internal audit reports and
orchestration prompts. Legacy browser-storage migration keys remain intentionally
supported; they do not load the retired removal runtime. Required historical
attribution is retained in the root `NOTICE`.
