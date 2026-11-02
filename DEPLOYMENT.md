# Hosting Cutout on Linux

The production build is a standalone Node 24 server. Background removal and image editing run in each visitor's browser; the Linux server does not need a GPU, receive photos, or store saved workspaces. Local workspace saves remain in that browser's IndexedDB.

See the [release status](docs/release-status.md) for the verified platform scopes,
Linux container/rollback results and remaining external HTTPS check.

## Before you start

- **Server:** a Linux VPS, amd64 or arm64. Compose limits each service to 256 MB; allow additional memory for the OS and Docker. **Building** needs about 2 GB of RAM: on a 512 MB or 1 GB VPS, use a released image or tarball (below) instead of building, or add swap first:

  ```sh
  sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
  ```

- **Site address:** serve at a domain or subdomain root, such as `https://cutout.example.com/`. Path-prefix hosting (for example `/tools/cutout/`) is not supported.
- **DNS:** an `A` record (and `AAAA` only if the server really has IPv6; a stale `AAAA` makes the certificate request fail) pointing your domain at the server.
- **Firewall:** SSH, TCP 80 and 443, and UDP 443 for HTTP/3, e.g. `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw allow 443/udp && sudo ufw enable`.
- **Who runs it:** the Privacy and Terms pages name the operator and a private contact only when you set them at build time: `VITE_SITE_OPERATOR="Your name or organisation"` and `VITE_SITE_CONTACT=privacy@example.com` (export them before building, or put them in `.env`). Read both pages before going public and adjust them to your setup, for example if you log differently.

## Docker and HTTPS (recommended)

Install Docker Engine with the Compose plugin on your Linux machine, then get the code:

```sh
git clone https://github.com/EgerDev/cutout.git && cd cutout
export CUTOUT_DOMAIN=cutout.example.com
# Replace the example with your real domain.
GITHUB_SHA=$(git rev-parse HEAD) docker compose up -d --build
docker compose ps
docker compose logs --tail=100 app proxy
curl --fail https://cutout.example.com/healthz
curl --fail https://cutout.example.com/version.json
curl -sI https://cutout.example.com/ | grep -i '^cross-origin-'
```

`/healthz` answers `ok`. `/version.json` reports the version and commit that is serving.
The two `Cross-Origin-*` headers (`same-origin` and `require-corp`) are required for
WebAssembly threads; keep them on every response, including worker scripts.

Caddy obtains and renews HTTPS certificates automatically. The app runs as a non-root user with a read-only filesystem and a private writable temporary directory. Only Caddy publishes ports; the app's port 3000 stays inside the Docker network. Certificate state uses named volumes. Keep those volumes when updating.

Pages are prerendered at build time and served as precompressed files. Compose caps each service at 256 MB and 128 processes, and rotates both services' logs at 10 MB × 3 files. Both services have health checks.

For subsequent Compose commands, keep CUTOUT_DOMAIN exported or put it in a local `.env` file. Do not bake secrets or local node_modules into the image; `.dockerignore` excludes them.

```sh
docker compose up -d --build       # rebuild after updating source
docker compose logs -f app        # application logs
docker compose down              # stop; retain certificate volumes
```

Compose builds with `SITE_URL=https://$CUTOUT_DOMAIN`, so pages carry canonical links and absolute share-card URLs and the build writes `sitemap.xml`. For builds outside Compose, set `SITE_URL` yourself (for example `https://cutout.example.com`); without it those tags are left out.

To update, first tag the serving image so it stays available for rollback, then rebuild:

```sh
# Updates only — the first deploy has no image to tag; a failed tag must stop the update.
docker tag "${CUTOUT_IMAGE:-cutout-app:local}" cutout-app:rollback &&
git pull && GITHUB_SHA=$(git rev-parse HEAD) docker compose up -d --build
```

`GITHUB_SHA` makes `/version.json` report the commit instead of `dev`. Reclaim disk only
after the new build is verified serving: `docker image prune -f` removes every dangling
image on the host (each old Cutout build is about 330 MB), and the rollback tag is what
keeps the previous image out of that set — see "Staging and rollback rehearsal" below. If
you rolled back by exporting `CUTOUT_IMAGE=cutout-app:rollback`, unset it (or fix `.env`)
before the next `--build`, or the new build takes the rollback name.

### Deploying a released image and rolling back

Tagged releases publish an image to `ghcr.io/egerdev/cutout:<version>` (and `:sha-<commit>`, for amd64 and arm64), with checksums and build provenance attached to the GitHub release. Nothing is built on the server, so this is the way to run on a small VPS:

```sh
export CUTOUT_DOMAIN=cutout.example.com
export CUTOUT_IMAGE=ghcr.io/egerdev/cutout:0.1.0
docker compose pull app
docker compose up -d --no-build
curl --fail https://cutout.example.com/version.json    # {"version":"0.1.0","commit":"…"}
```

Always pass `--no-build` with `CUTOUT_IMAGE`: if the image cannot be pulled (a typo, a removed tag), Compose would otherwise build the checked-out source and tag it with the release name. To roll back, set `CUTOUT_IMAGE` to the previous version and run the same `pull` and `up -d --no-build`.

A released image carries the `SITE_URL` it was built with (canonical links, share cards and the sitemap point at that address) and downloads models from Hugging Face. `SITE_URL`, `VITE_MODEL_HOST`, `VITE_SITE_OPERATOR` and `VITE_SITE_CONTACT` are compiled into the client at build time: setting them on `docker compose up` or `docker run` does not change a prebuilt image. Build it yourself (above) for your own domain, a model mirror, or your operator details. Nothing is stored server-side, so there is no data to migrate or restore; only the `caddy_data` volume (certificates) must be kept. Without `CUTOUT_IMAGE`, Compose builds `cutout-app:local` from the checkout as before. `/version.json` always reports the version and commit that is actually serving.

### Access logs

Caddy writes an access log line for every request: client IP address, time, full URL including the query string, request headers such as User-Agent and Referer, status and size. Compose keeps at most three 10 MB log files per service and discards the oldest, so retention depends on traffic, not on a number of days. The site's Privacy page describes exactly this; if you change logging (format, fields, rotation, or journald with the systemd setup), update the Privacy page to match.

Use the production HTTPS domain on phones. A plain HTTP LAN IP is not a secure browser context, and clipboard/sharing APIs may be unavailable. This Compose configuration is for this public, local-processing tool.

### Health checks and backups

Both services restart automatically and carry health checks (`docker compose ps` shows their state); point an uptime monitor at `https://<your domain>/healthz` and use `/version.json` to confirm which build answers. The server is stateless, so the backup set is small but wider than certificates: keep the `caddy_data` volume (certificates; `caddy_config` regenerates itself from the mounted Caddyfile, and reissuance costs an ACME round-trip and rate-limit budget), the deployment configuration — `.env`/exported `CUTOUT_DOMAIN` and `CUTOUT_IMAGE`, the build-time values (`SITE_URL`, the `VITE_*` settings, `GITHUB_SHA`), and any edited `deploy/Caddyfile` or `compose.override.yaml` — the recorded image digest or tarball checksum of what is serving, and the `./models` mirror directory if you built one (`scripts/mirror-models.mjs` can re-create it, but a copy keeps the verified bytes without a re-download).

## Node and systemd alternative

Each release also has `cutout-<version>-output.tar.gz`: the built server and its required traced runtime files, with no dependency installation or build step. On the server, with Node 24 installed:

```sh
sudo mkdir -p /opt/cutout && sudo tar xzf cutout-<version>-output.tar.gz -C /opt/cutout
```

then continue at "For a service" below. To build it yourself instead (on any machine with about 2 GB of RAM), install Node 24 and run:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node scripts/patch-dependencies.mjs
GITHUB_SHA=$(git rev-parse HEAD) SITE_URL=https://cutout.example.com npm run build   # replace with your public origin
HOST=127.0.0.1 PORT=3000 npm start
# In another terminal while the foreground server is running:
curl --fail http://127.0.0.1:3000/healthz
```

For a service, copy the entire `.output` directory to `/opt/cutout/.output`, create an unprivileged `cutout` system user/group, and install `deploy/cutout.service` under `/etc/systemd/system/`. Set its ExecStart path to your installed Node 24 binary if it differs from `/usr/bin/node`. The generated `.output` (about 60 MB) contains its runtime dependencies and no native binaries, so it can also be built on another OS or CPU architecture and copied over; never copy `node_modules`.

```sh
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cutout
sudo install -m 644 deploy/cutout.service /etc/systemd/system/cutout.service
sudo systemctl daemon-reload
sudo systemctl enable --now cutout
sudo journalctl -u cutout -f
```

Place an HTTPS reverse proxy in front of `127.0.0.1:3000`. For a host-installed Caddy, copy `deploy/Caddyfile`, change its upstream from `app:3000` to `127.0.0.1:3000`, and replace every `{$CUTOUT_DOMAIN}` placeholder with your domain. Alternatively, set `CUTOUT_DOMAIN` in Caddy’s own service environment; exporting it in your shell or setting it for the Cutout service does not configure Caddy. Keep its `lb_try_duration`: during a restart the proxy then holds requests for a few seconds instead of answering 502.

`HOST` and `PORT` configure the server listener. `npm start` can also read `.env.production`; systemd optionally reads `/etc/cutout.env`. Choose an alternate hosting provider’s Nitro preset with `NITRO_PRESET` before building; changing it requires rebuilding the output.

## Refreshing deployed builds

`/.well-known/security.txt` is generated at **build time**, with an `Expires` date one year later. Rebuild and redeploy at least every six months, and always before the currently served expiry, even if application code has not changed. Check the deployed file after each deployment:

```sh
curl --fail https://cutout.example.com/.well-known/security.txt
```

Verify the contact still works and the `Expires` date covers your next planned refresh. For released images or tarballs, check their served expiry too and choose a fresh build before it expires. Restarting a server, reusing an old image, or pulling the same release does not renew this static file. There is no runtime renewal or expiry monitor; the operator owns this cadence.

## Capacity and restarts

Everything heavy runs in each visitor's browser; the server sends files. Hashed client files are cached and precompressed. Measure first-visit bandwidth, memory and request latency on your intended VPS before assigning it a user-capacity target. Docker Desktop measurements on a development Mac do not establish VPS capacity.

Caddy retries connections while the app container is replaced. A Linux ARM64 smoke check at 10 health requests/second saw no failed requests during app replacement (150 requests), with the longest waiting about 1.3 seconds. Restarting Caddy itself failed 2 of 150 requests: a single proxy cannot serve while it is stopped. If uninterrupted proxy updates are required, put a draining load balancer or a second proxy in front. Keep Caddy running for ordinary app updates.

The models (about 90–192 MB per new visitor for background removal, cached in the browser; compatibility retries can fetch another variant, and optional enhance and depth features need more models) download from Hugging Face's CDN, at revisions pinned in the source.

## Serving models from your own mirror

By default every visitor's browser downloads the models from huggingface.co repositories owned by third parties, at revisions pinned in the source (listed in `src/lib/model-notices.ts` and on `/licenses`). If one of those repositories is deleted or Hugging Face is unreachable, background removal stops working for new visitors, and Hugging Face limits anonymous downloads per IP address. For busy public sites, use `VITE_MODEL_HOST` to mirror the pinned files: anonymous rate limits can affect visitors sharing an IP, and hosting the models yourself adds about 90–192 MB of egress per new removal user (more for optional features). Compatibility retries can download another variant. Choose a host whose bandwidth costs fit that traffic. To remove the default-host dependency:

1. Download exactly the files the app loads (run `--list` to see the current total), in Hugging Face's layout (`<model>/resolve/<revision>/<file>`). Re-running skips finished files:

   ```sh
   node scripts/mirror-models.mjs ./models     # --list shows the files first
   ```

   Mirror only models whose licence allows redistribution (see `/licenses`).

   On HTTPS and localhost, the browser checks every background-removal model file against a SHA-256 pinned in the source (`src/lib/removal-model-specs.ts`) and refuses a file that differs, so the mirror must serve the files **byte for byte**: no re-encoding, reformatted JSON, or Git LFS pointer files. Plain-HTTP LAN development skips this check when WebCrypto is unavailable. The script verifies each file it downloads (and any file it keeps from an earlier run) against those pins, or Hugging Face's LFS hash for the other models.

2. Serve the directory:
   - **Same domain, with Compose:** uncomment the `./models:/srv/models:ro` volume in `compose.yaml` and the `/models/*` block in `deploy/Caddyfile`, and use `VITE_MODEL_HOST=https://<your domain>/models/`.
   - **Another host or object storage** (useful for busy public sites): upload the directory as is. Cross-origin mirrors **must** send `Access-Control-Allow-Origin: https://<your domain>` (or `*` for public files). `Cross-Origin-Resource-Policy: cross-origin` can be sent as well, but CORP alone does not satisfy the loader’s CORS requests.

   Serve complete files with HTTP **200** for ordinary GET requests. A CDN that responds only with partial **206** responses will fail; the loader does not resume downloads with Range requests.

3. Build with the mirror's base URL:

   ```sh
   SITE_URL=https://cutout.example.com VITE_MODEL_HOST=https://cutout.example.com/models/ npm run build
   ```

   With Docker Compose, export it (or put it in `.env`) before `docker compose up -d --build`; Compose passes it to the image build. Set `SITE_URL` to your public app origin too (Compose defaults it from `CUTOUT_DOMAIN`).

The value is fixed into the client bundle at build time. Use an absolute **HTTPS** base URL, with no credentials, query string, or fragment; a trailing slash is added when absent. Leaving it unset uses Hugging Face at the existing pinned revisions. Vite validates process environment overrides and the selected mode's `.env` files when loading the configuration, before building or starting dev.

The production Content-Security-Policy allows HTTPS connections. Plain HTTP mirrors, **including localhost and loopback**, are rejected even for local development: a different localhost port is a different origin and is blocked by the production policy. For a local mirror, serve it with HTTPS and a certificate the browser trusts. This keeps local builds consistent with production without widening the public policy. If the mirror is on another host, update the Privacy page, which names Hugging Face as the model source. To check the switch, block `huggingface.co` in your browser's developer tools and run a cut.

## Staging and rollback rehearsal

Rehearse the full cycle once on a staging deployment (or a throwaway Compose stack behind a staging name) before relying on it; an incident is the wrong time to learn the order.

1. **Record what is serving.** `/version.json` names the running build; the image digest pins the artifact:

   ```sh
   curl --fail https://cutout.example.com/version.json
   docker image inspect "$CUTOUT_IMAGE" -f '{{index .RepoDigests 0}}'   # released image
   docker compose images app                                          # local build's image ID
   ```

   `ghcr.io/egerdev/cutout@sha256:…` is also a valid `CUTOUT_IMAGE` value — usable for rollback while that digest remains published (the next step keeps a local copy so it need not). On the systemd path keep the previous release tarball and its `SHA256SUMS` entry instead. Save these identifiers with the configuration that deployed them (see the backup list above).

2. **Keep a rollback artifact on the host.** A registry tag can be moved or deleted and an unreferenced digest collected, so a recorded `CUTOUT_IMAGE` alone is not a rollback guarantee. Before updating, re-tag the serving image locally — `docker tag "${CUTOUT_IMAGE:-cutout-app:local}" cutout-app:rollback` — or archive it with `docker image save`, and keep it with the recorded digest/version/config until the rollback window closes.

3. **Update** as in the sections above (`up -d --build` for a source checkout; `pull` + `up -d --no-build` with the new `CUTOUT_IMAGE` for a release), keeping the same exported/`.env` values throughout. `SITE_URL`, `VITE_MODEL_HOST`, `VITE_SITE_OPERATOR`, `VITE_SITE_CONTACT`, `GITHUB_SHA` and `NITRO_PRESET` are compiled in at build time — changing them means a rebuild, not a restart. `CUTOUT_DOMAIN` and `CUTOUT_IMAGE` (and `HOST`, `PORT` on the systemd path) are runtime values.

4. **Verify before calling it done**, in this order:

   ```sh
   docker compose ps                                                # both services healthy
   curl --fail https://cutout.example.com/healthz                   # ok
   curl --fail https://cutout.example.com/version.json              # the build just deployed
   curl --http1.1 -s -o /dev/null -w '%{http_code}\n' https://cutout.example.com/%GG   # 400
   curl -sI https://cutout.example.com/ | grep -i '^cross-origin-'
   ```

   Then in a browser on a fresh visit: `crossOriginIsolated` is true, a real removal completes, refinement and export produce a file, and a reload restores the shell with the cached models — that covers the cache path. The model-host failure check needs a clean browser profile with no cached models: block the model host's request paths in its developer tools before starting a removal (for a same-origin mirror, block the `/models/*` paths only, not the shell's origin). The download must fail with a usable retry instead of hanging; unblock and retry, and the removal succeeds.

5. **Restart gracefully.** `docker compose up -d` (or `restart app`) replaces the app while Caddy's `lb_try_duration` holds requests — see "Capacity and restarts" for the measured behavior. `docker compose down` keeps `caddy_data`, so certificates persist; only `down -v` or removing the volume drops them. Logs stay inside the 10 MB × 3 rotation described above.

6. **Roll back while Caddy stays up.** With the retained tag: `CUTOUT_IMAGE=cutout-app:rollback docker compose up -d --no-build` — no pull; a local-only name has nothing to fetch. From the registry instead, only while the tag or digest is still published: set `CUTOUT_IMAGE` back to it and repeat `docker compose pull app` and `docker compose up -d --no-build` (see "Deploying a released image and rolling back"). systemd: restore the previous `.output` and `systemctl restart cutout`. Re-run step 4 — `/version.json` must report the rollback build.

## Behind nginx, Traefik or Cloudflare

The app sends its own security headers (CSP with per-build script hashes, COOP/COEP, `X-Frame-Options`, `Permissions-Policy`, `nosniff`, `Referrer-Policy`, and HSTS when `SITE_URL` is `https://`), precompressed brotli/gzip with `Vary: Accept-Encoding`, `immutable` caching on `/assets/*` and `no-cache` on pages. Any proxy in front must pass these through unchanged.

- **Run only the app with Compose** and publish it on the host's loopback: create `compose.override.yaml` with

  ```yaml
  services:
    app:
      ports: ["127.0.0.1:3000:3000"]
  ```

  and start it with `CUTOUT_DOMAIN=cutout.example.com docker compose up -d app`. Then proxy your server block to `http://127.0.0.1:3000`. For nginx: `proxy_pass http://127.0.0.1:3000;` with `proxy_http_version 1.1;` and no `gzip on` for this location (the app already compresses).

- **Cloudflare:** SSL mode **Full (strict)** (Flexible loops redirects). Turn off **Rocket Loader**, automatic **Web Analytics** injection, **Zaraz** and any HTML rewriting: a modified inline script no longer matches the CSP hashes and the app stops loading. Add a cache rule making `/assets/*` eligible for cache and respecting the origin's cache headers (Cloudflare does not cache `.wasm`, `.mjs` or `.json` by default, so otherwise the 3 MB runtime comes from your server on every first visit). Pages and 404s send `no-cache` and stay revalidated. For real visitor IPs in Caddy's log, add `trusted_proxies` with Cloudflare's ranges and `client_ip_headers CF-Connecting-IP` to its global options, and name Cloudflare on your Privacy page.
- **HTTP/3 with Caddy:** if the log warns about UDP buffer sizes, raise them: `sudo sysctl -w net.core.rmem_max=7500000 net.core.wmem_max=7500000` (persist in `/etc/sysctl.d/`).
- **`www`:** the Caddyfile serves only `CUTOUT_DOMAIN`. To redirect `www`, add a DNS record for it and a Caddy block: `www.{$CUTOUT_DOMAIN} { redir https://{$CUTOUT_DOMAIN}{uri} permanent }`.
- **HSTS preload:** Caddy and the app send `max-age=31536000`. Add `includeSubDomains; preload` (Caddyfile) and submit to hstspreload.org only once every subdomain serves HTTPS.

## Mobile behavior and limits

- iPhone Photos selection, Android file selection, HEIC conversion, touch brush gestures, and native sharing keep their capability-based fallbacks.
- Form controls use 16px text on touch devices to avoid iOS focus zoom; pinch zoom stays enabled. Controls have 44px touch areas, and dialogs respect safe-area insets.
- Slow exports retain the finished file and request a fresh tap for sharing if the original user activation has expired. The ready dialog also offers a direct file download.
- The first photo-model download can be large and needs a network connection. Processing speed and memory depend on the visitor's phone. Server upgrades do not make on-device inference faster.
- Local autosave is optional and is not a backup. Browser/private-mode storage can be limited or cleared.
- Safari and other browsers may evict cached models when storage is not persisted. In _Models_, choose _Ask browser to keep them_ to request persistence. The browser may decline; losing the cache means downloading the models again.
- With the needed models already loaded, an open tab keeps working offline. A new visit or reload needs the network for the app shell; there is no service worker.

Browser emulation does not replace testing the real iOS share sheet, Photos picker, keyboard, or low-memory behavior on a physical phone.

## Cross-origin isolation (WebAssembly threads)

Every response (worker scripts included) carries `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, which makes the page
`crossOriginIsolated` and lets onnxruntime-web run inference on several cores
wherever WebGPU is unavailable (iPhones before Safari 26, Firefox, Linux
Chrome): roughly 2x faster per image.

If you put another proxy in front, do not strip these headers, and serve any
extra cross-origin scripts, fonts or images with CORS.

## Running Linux CI locally

With Docker Engine/Compose, Git and Node 24 available, run the counterpart of every job in `.github/workflows/ci.yml`:

```sh
node scripts/linux-ci.mjs --ref HEAD --logs /absolute/path/to/linux-ci-evidence
```

The runner clones the selected commit, installs Linux dependencies inside isolated Node 24 / Ubuntu 24.04 / Playwright 1.63.0 containers, and runs tests as an unprivileged user. It verifies the pinned wabt 1.0.37 archive; ARM Linux builds that release from source and needs container-only CMake/compiler packages. The upstream source still prints version `1.0.36`; its SHA256 identifies the 1.0.37 release. No host `node_modules`, environment files or local data enter the checkout. Docker runs the production stack separately and checks HTTPS through Caddy on loopback port 9310, including `/healthz`, the commit reported by `/version.json`, and a prompt 400 for a malformed path.

The UI recipe runs each declared file separately. Synthetic stage graphics checks use Swiftshader WebGPU; other UI files use the Linux CPU path. Software graphics coverage provides no physical GPU performance measurement. Each file keeps its raw test summary, and the runner sums those counts for the suite.

Each piece has a timeout below ten minutes. Raw logs and incremental `results.jsonl` records include commands, commits, exit codes and test counts; a missing count is `null`. Any failed test fails the piece, and so does any skip outside the declared exclusion below. Use a new evidence directory for each commit. To run or resume one piece, retain the original commit and directory:

```sh
node scripts/linux-ci.mjs --ref <commit> --logs /absolute/path/to/linux-ci-evidence --job test --step unit
node scripts/linux-ci.mjs --ref <commit> --logs /absolute/path/to/linux-ci-evidence --cleanup
```

### Ordinary and real-model lanes

The ordinary lane tolerates exactly one declared exclusion: the ten `P1 real integrity:` cases in `scripts/browser-model-cache.mjs`, which run only with `RUN_REAL_MODELS=1` and a `MODEL_CACHE_PROFILE` — an environment the container never receives unless asked. The runner compares the suite's named skips against those ten cases exactly — a renamed, added, missing, duplicated or unnamed skip fails the step, as does any failed, cancelled or todo test or a truncated/inconsistent summary; every other step tolerates no skips at all. Hosted `ci.yml` applies the same check to its advanced-suite log and runs that suite under `shell: bash` (pipefail), so a failing suite cannot go green through the log tee.

The strict lane opts in, and requires the shared lock and a persistent profile:

```sh
node scripts/linux-ci.mjs --ref <commit> --logs /absolute/path/to/evidence \
  --lock /absolute/path/to/shared-lock --real-models --job dev-server --step advanced
```

`--real-models` requires `--lock`, passes `RUN_REAL_MODELS=1` and `MODEL_CACHE_PROFILE=/tmp/real-model-profile` into the container for the advanced step, and bind-mounts `<logs>/real-model-profile` so the roughly 90–192 MB of weights persist between runs. Under it no skip is tolerated, and each of the ten cases must appear in the log as passed under its own name — a suite that merely reports zero skips without running them fails. A container created before `--real-models` lacks the profile mount; the runner refuses to use it until recreated (`--cleanup` or `docker rm -f <container>`).

The container's WebGPU is SwiftShader software rendering, so this lane proves the integrity and recovery logic on Linux but is not hardware certification and does not replace the complementary Mac gate (`RUN_REAL_MODELS=1` with `MODEL_CACHE_PROFILE` on hardware WebGPU, under the same shared lock). Record the ten case names from whichever lane executed them; a skip never counts as a pass.

`node scripts/linux-ci.mjs --verify-skips <suite-log>` re-checks a saved suite log against the exact declared exclusion set and the suite's own summary — a failed, cancelled, todo-bearing or incomplete log is rejected — and needs no Docker.

Jobs are `test`, `dev-server`, `model-host` and `docker`; `--help` lists options. Run each job's `install` piece before individual suites and the `test` job's `tools` and `build` before unit/server/production-browser checks. `--port` selects the stack's HTTPS port. For shared benchmark machines, `--lock /absolute/path/to/heavy.lock` takes a mkdir lock separately for each piece; its `owner` file records the PID and operation. Cleanup removes this run's containers and certificate volumes; it retains evidence and images. This harness reproduces the jobs, not GitHub's checkout/cache actions or release publishing.
