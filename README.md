# Cutout

Cutout removes the background from photos and graphics in your browser. The image is
processed on your device with an on-device neural network (or a colour key for flat
art), then you can refine the edge, change the background, frame it for a marketplace or
profile picture, and export it. Images are not uploaded; the server only serves the app.

The [release status](docs/release-status.md) records verified platforms, known limits
and remaining release decisions. No version has been released yet.

## Features

- Background removal with BiRefNet lite (ISNet on low-memory devices without WebGPU),
  running on WebGPU or WebAssembly.
- Refining: brush, click to keep or remove pieces, box re-cut,
  edge clean-up, colour recolour and knock-out.
- Backgrounds (transparent, colour, gradient, blur, depth-aware blur, your own image),
  shadows, framing presets, enhance (2× and 4×), 40-step history.
- Opens PNG, JPEG, WebP, AVIF, GIF, BMP, HEIC/HEIF, TIFF, SVG, PDF (embedded image), DXF,
  DWG and SketchUp (embedded preview). TIFF files are limited to 50 MB.
- Exports PNG, JPEG, WebP and BMP; AVIF and HEIC where the browser can encode them; SVG for
  flat art; ZIP batches, contact sheets and sprite sheets. Optional removal of metadata.
- Optional saved workspace in the browser.

## Supported browsers

Current Chrome or Edge, Firefox, and Safari 16.4 or later (iOS/iPadOS 16.4 or later).
Browsers without OffscreenCanvas, WebAssembly, `createImageBitmap` or Web Workers get a
notice instead of the app. The first background removal downloads about 90–192 MB of model
files from Hugging Face, depending on the device; they are cached for later visits.
A compatibility retry can download another model variant.

## Run it on your computer

Everything runs in your browser, so a local copy works like the website. Once the models
are downloaded, an open tab keeps working offline. A new visit or reload needs the network
to load the app; Cutout has no service worker.

**Prebuilt (when a public release is available).** The [release](https://github.com/EgerDev/cutout/releases)
artifact is `cutout-<version>-output.tar.gz`. With Node.js 24 or 26 installed:

```sh
tar xzf cutout-<version>-output.tar.gz     # tar is built into Windows 10+, macOS, Linux
HOST=127.0.0.1 node .output/server/index.mjs
```

Or with Docker: `docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/egerdev/cutout:<version>`.

**From source** (Node.js 24 or 26; about 850 MB of dependencies and a minute to build):

```sh
ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci   # the variable skips ~340 MB of CUDA libraries on Linux
npm run build
HOST=127.0.0.1 npm start
```

Then open http://localhost:3000 and drop a photo, or paste one with Cmd/Ctrl+V. In
Windows PowerShell set the address with `$env:HOST = "127.0.0.1"` before the command, or put
`HOST=127.0.0.1` in a `.env.production` file next to `package.json` (read by `npm start`).

- **Keep it on your machine:** without `HOST=127.0.0.1` the server listens on every network
  interface (your LAN can reach it, and Windows asks about the firewall).
- **Offline:** the first cut downloads the removal model (about 90–192 MB), or fetch models
  ahead in _Models → Download all now_. An open tab with the needed models loaded keeps
  working offline; a new visit or reload needs the network for the app. Models are kept per
  address: `localhost:3000` and `localhost:4000` each download their own copy.
- **Keep models:** Safari and other browsers may evict cached models. In _Models_, use
  _Ask browser to keep them_ to request persistent storage; the browser may decline.
- **Use `localhost` or HTTPS.** From another device over a plain `http://192.168.…`
  address the browser allows no model cache, no WebGPU and no multithreading: every visit
  downloads the models again and runs slower. Serve it over HTTPS for other devices
  ([DEPLOYMENT.md](DEPLOYMENT.md)).

For development (hot reload on http://127.0.0.1:8080):

```sh
npm ci
npm run dev
```

[CONTRIBUTING.md](CONTRIBUTING.md) explains the test suites and how to contribute.
[DEPLOYMENT.md](DEPLOYMENT.md) covers hosting on a Linux server: Docker with automatic HTTPS,
systemd, running behind nginx or Cloudflare, model mirrors and releases. Serve Cutout at
a domain or subdomain root; path-prefix hosting (such as `/tools/cutout/`) is unsupported.
Set `SITE_URL=https://<your-domain>` before a public build for canonical URLs and the sitemap.
For a busy public site, mirror the models with `VITE_MODEL_HOST` to avoid depending on Hugging
Face’s anonymous rate limits and plan for about 90–192 MB of model egress per new visitor.
Cross-origin mirrors require CORS (`Access-Control-Allow-Origin`) and must return complete
files with HTTP 200; CORP alone and Range/206-only delivery do not work.

## Additional regression suites

`npm run test:formats` checks native dimensions, alpha, BMP masks, SVG input, TIFF
orientation and advertised exports. `npm run test:advanced` covers editor recovery,
shadow composition, preview disposal, model caching and cancellation. These run
against the dev server alongside `test:ui`, `test:editor` and `test:removal`; see
[CONTRIBUTING.md](CONTRIBUTING.md) for server setup.

Export size targets commit on blur or Enter. The file-size preview can download
the exact inspected bytes. Colour, subject and quality checks offer retry actions;
quality-filtered ZIP downloads wait for checks and exclude unavailable results.

`npm run audit:performance` records cold and returning visits separately.
`AUDIT_PROFILES=cold` or `warm` selects one profile; `AUDIT_RUNS` controls repetitions.
Returning visits warm the same browser context Lighthouse measures.

## Configuration

| Variable                        | Used by        | Purpose                                                                                                                                       |
| ------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`, `PORT`                  | server         | Address and port the production server listens on (all interfaces, port 3000 by default; `HOST=127.0.0.1` keeps it local).                    |
| `NITRO_PRESET`                  | build          | Nitro deployment preset; `node-server` by default.                                                                                            |
| `SITE_URL`                      | build          | Public address such as `https://cutout.example.com`. Enables canonical links, absolute share-card URLs and `sitemap.xml`; omitted when unset. |
| `VITE_MODEL_HOST`               | build          | Where browsers download models from. Default `https://huggingface.co/`; a mirror must use the same `<repo>/resolve/<revision>/<file>` layout. |
| `VITE_SITE_OPERATOR`            | build          | Who runs this copy, named on the Privacy and Terms pages. Nobody is named when unset.                                                         |
| `VITE_SITE_CONTACT`             | build          | A private contact for this copy (e.g. `privacy@example.com`), shown on the Privacy and Terms pages.                                           |
| `CUTOUT_DOMAIN`                 | Docker Compose | Domain Caddy serves and obtains a certificate for.                                                                                            |
| `CUTOUT_IMAGE`                  | Docker Compose | Image to run, e.g. a released `ghcr.io/egerdev/cutout:<version>`. Builds locally when unset.                                                  |
| `APP_URL`, `DEV_URL`            | tests          | Addresses of the production server (port 8081) and dev server (port 8080) the suites test.                                                    |
| `CUTOUT_REQUIRE_E2E`            | tests          | `1` makes end-to-end tests fail, instead of skip, when no server is running.                                                                  |
| `CUTOUT_REQUIRE_TOOLS`          | tests          | `1` makes `test:unit` fail when `wat2wasm` or Playwright Firefox is missing (CI sets this).                                                   |
| `CUTOUT_EXPECT_COMMIT`          | tests          | Commit the server's `/version.json` must report, so tests cannot pass against another build.                                                  |
| `ONNXRUNTIME_NODE_INSTALL_CUDA` | install        | `skip` avoids downloading about 340 MB of CUDA libraries the app never uses.                                                                  |

## Opening Cutout from a link

Other tools can start Cutout with query parameters:

```
https://<your-site>/?src=https://example.com/photo.jpg&preset=amazon&format=webp&bg=white&download=1&name=product.webp
```

| Parameter  | Values                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src`      | Image to load. Must be `https`, a raster image (SVG is refused) and at most 50 MB, from the same site or a host that allows cross-origin requests. |
| `preset`   | `original`, `trim`, `square`, `portrait`, `landscape`, `story`, `passport`, `product`, `profile`, `asset`, `amazon`, `etsy`, `ebay`                |
| `format`   | `png`, `webp`, `avif`, `heic`, `jpeg` (or `jpg`), `bmp`                                                                                            |
| `bg`       | `transparent`, `blur`, `white`, `black`, or a hex colour such as `%23ffcc00`                                                                       |
| `download` | `1` saves the result as soon as it is ready                                                                                                        |
| `name`     | File name for the download                                                                                                                         |

When `src` points to another site, or `download` is set, Cutout shows the host and asks the
user before it fetches anything or downloads a model.

## Documentation

- [docs/architecture.md](docs/architecture.md): how the app is built
- [SECURITY.md](SECURITY.md): reporting vulnerabilities
- [CONTRIBUTING.md](CONTRIBUTING.md), [SUPPORT.md](SUPPORT.md),
  [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [CHANGELOG.md](CHANGELOG.md)
- [docs/design.md](docs/design.md): interface and interaction rules
- [docs/release-status.md](docs/release-status.md): verification and publication status

## License

Cutout's original application code and independently implemented removal engine are
licensed under the [MIT License](LICENSE). Copyright 2026 EgerDev. See
[NOTICE](NOTICE) and `public/third-party/THIRD_PARTY_NOTICES.txt` for third-party
software, and the site's `/licenses` page for the models it downloads. Their own
licenses still apply; previous Apache-2.0 grants remain valid. The
[provenance record](docs/provenance.md) distinguishes code, models, assets and
remaining public-distribution decisions.
