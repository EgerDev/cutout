# Contributing to Cutout

Thanks for helping. Bug reports, fixes and small improvements are welcome. For larger
changes, open an issue first so we can agree on the approach before you spend time on it.

Security problems: do not open an issue; follow [SECURITY.md](SECURITY.md).

## Set up

You need:

- Node.js 24 or 26 and npm;
- a network connection to `huggingface.co` (the browser tests download the models);
- ports 8080 and 8081 free (dev server and production build used by the tests);
- optional: [wabt](https://github.com/WebAssembly/wabt) **1.0.37** on your `PATH` (`wat2wasm --version`). CI installs that exact release for the SIMD keyer byte-identity check. Without it, `test:unit` skips that check unless `CUTOUT_REQUIRE_TOOLS=1`.

```sh
npm ci                                            # installs exactly the lockfile, then patches transformers.js and onnxruntime-web
npx playwright install chromium firefox webkit    # browsers for the test suites
npm run dev                                       # http://127.0.0.1:8080
```

`npm run dev` listens on 127.0.0.1 only. To try the app on a phone on your network, use
`npm run dev:lan` (it listens on all interfaces). A plain-HTTP LAN address is not a secure
context: the browser gives it no model cache (models download again on every load), no
WebGPU, no multithreaded inference and no clipboard or sharing, so it is slower and some
features behave differently than on `localhost` or HTTPS.

`npm ci` runs `scripts/patch-dependencies.mjs`, which patches transformers.js and
onnxruntime-web in `node_modules`. It fails loudly if the upstream code no longer matches; if
you update either package, update the patch table in that script too.

The development constraint on `lru-cache` supplies Nitro/unstorage's optional
11.x peer; Babel keeps its own 5.x copy. This keeps the installed dependency tree
and the complete source SBOM consistent. The source SBOM includes build tools
because Nitro generates shipped server code despite being a development dependency.

[docs/architecture.md](docs/architecture.md) describes how the pieces fit together.

## Checks

Run these before opening a pull request:

```sh
npm run typecheck
npm run lint
npm run test:unit     # node:test unit tests (src/**/*.test.ts, scripts/*.test.mjs)
npm run build
```

End-to-end and browser suites run against a real server:

```sh
npm run build && PORT=8081 npm start      # production build on 8081, in another terminal
npm run test:e2e                          # end-to-end tests against it
npm run dev                               # dev server on 8080, in another terminal
npm run test:ui                           # browser suites; see package.json for the others
```

`npm test` runs the unit tests and then the end-to-end tests. Without a server the
end-to-end tests are reported as skipped; set `CUTOUT_REQUIRE_E2E=1` (CI does) to make a
missing server a failure instead. `APP_URL` and `DEV_URL` point the suites at other
addresses.

The UI audit regressions run with `npm run test:ui:audit` against the dev server;
`test:formats` also includes the pixel/export regressions. For `test:ui:audit`, set
`CUTOUT_BROWSER_PROFILE` to a newly created temporary directory for its isolated WebKit
storage profiles, and remove it after the suite's browsers close.

`npm run test:ingest:audit` runs the native ingest checks against the production server,
where they verify the enforced CSP. `npm run test:routes` also targets production and
reads the build's `.output/public`; set `CUTOUT_PUBLIC_DIR` if that directory is elsewhere.
For each command, set both `APP_URL` and `DEV_URL` to its required server.

Every behaviour change needs a test that fails without it. Test what the code does, not
what its source text says.

## Manual tools

These stay as local commands. They are not part of `npm test` or CI.

**Profiling.** `npm run perf:profile` drives Chrome against a running app and prints
ingest, preview and result timings plus main-thread stalls while sheets and sliders
move. Run it against a server without DevTools open:

```sh
npx vite --host 127.0.0.1 --port 8082 --strictPort &
APP_URL=http://127.0.0.1:8082/ npm run perf:profile
```

`PERF_PROFILE_DIR` (default: a temp `cutout-perf-profile` directory) keeps model
weights cached between runs.

**Icons.** `npm run icons` regenerates `public/icon-*.png` from `public/favicon.svg`
(see `public/CREDITS.md`).

**Owned-engine corpus.** The registered parity protocol uses fixtures under
`.omo/benchmarks/`. Build them with the CLIs (defaults shown):

```sh
node scripts/benchmark/generate-known-alpha.mjs    # .omo/benchmarks/cutout-owned-engine/corpus/known-alpha
node scripts/benchmark/build-corpus-manifest.mjs   # .omo/benchmarks/cutout-owned-engine/corpus
```

## Third-party notices

`public/third-party/THIRD_PARTY_NOTICES.txt` is generated. After adding, removing or
updating a dependency, or changing a model in `src/lib/model-notices.ts`, run:

```sh
node scripts/third-party-notices.mjs
```

and commit the result. `scripts/third-party-notices.test.mjs` fails when the file is out of
date or a model the code downloads is missing from `model-notices.ts`.

## Style

- Prettier formats the code (`npm run format`); `npm run format:check` reports drift
  without writing. The config is in `.prettierrc`. Vendor, generated route tree, build
  output and local agent dirs are listed in `.prettierignore`.
- Files use LF line endings (`.gitattributes` enforces this).
- Comments explain why, not what.
- Commit subjects are short and imperative, describing the effect ("Reject oversized TIFFs
  before decoding"), with details in the body.

## Sign-off (DCO)

New contributions to Cutout's original application code are accepted under the MIT
License. Keep third-party code under its existing license and retain its notices.
A sign-off certifies the DCO; it does not assign copyright. Sign off every commit to certify
the [Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s
```

This adds a `Signed-off-by: Your Name <you@example.com>` line with the name and email from
your git config. A GitHub `noreply` address works if you prefer not to publish yours.
