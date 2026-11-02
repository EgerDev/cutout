import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Connect, Plugin } from "vite";
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";
import type { Nitro } from "nitro/types";
import { SECURITY_HEADERS, STRICT_CSP } from "./server/headers.ts";
import { fixPublicAssetEncodings, rewriteManifestFilePaths } from "./scripts/build-fixups.mjs";
import { inlineScriptHashes, policyFor } from "./scripts/csp.mjs";
import {
  modelHostFrom,
  robotsTxt,
  securityTxt,
  siteUrlFrom,
  sitemapXml,
} from "./scripts/site-files.mjs";

/**
 * Every page renders the same HTML for every visitor (no loaders or server functions),
 * so Nitro prerenders them: the server sends precompressed files instead of rendering
 * React per request. Every route must be listed: any other URL answers the static 404
 * (scripts/built-server.mjs checks that each file in src/routes is here).
 */
const PAGES = ["/", "/guide", "/library", "/licenses", "/privacy", "/terms"];

/**
 * No route matches this path, so prerendering it captures the router's not-found
 * page exactly as the client renders it at any unknown URL (hydration matches).
 */
const NOT_FOUND = "/404";

/** Public origin for canonical/og URLs and the sitemap, e.g. https://cutout.example.com. */
const SITE_URL = siteUrlFrom(process.env.SITE_URL);
const HSTS_HEADERS = SITE_URL.startsWith("https:")
  ? { "Strict-Transport-Security": "max-age=31536000" }
  : {};

/** What /version.json reports, so tests and operators can tell which build answers. */
async function buildVersion() {
  const { version = "0.0.0" } = JSON.parse(await readFile("package.json", "utf8"));
  let commit = process.env.GITHUB_SHA;
  try {
    commit ||= execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    /* no git (the Docker build context has no .git) */
  }
  return { version, commit: commit || "dev" };
}

/**
 * Browser-only libraries become an empty module in the server build. Every page is
 * prerendered and the server reaches these only through dynamic imports it never runs,
 * yet it carried them all: heic-to, transformers, exifreader and the rest, 8 MB of the
 * server's files (about 2.4 MB without them). Client and worker builds are untouched.
 */
function clientOnlyPlugin(): Plugin {
  const browserOnly =
    /^(@huggingface\/transformers|exifreader|utif2|dxf-parser|imagetracerjs|heic-to\/csp)$/;
  const stub = "\0cutout:client-only";
  return {
    name: "cutout:client-only",
    apply: "build",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name !== "client",
    resolveId: (id) =>
      browserOnly.test(id) || /[\\/]vendor[\\/]heic-to[\\/]/.test(id) ? stub : undefined,
    load: (id) => (id === stub ? "export default {};" : undefined),
  };
}

/**
 * The emitted server manifest keeps each route's absolute filePath (used at
 * build time to match chunks to route files), so the build checkout's paths
 * shipped to every deployment. Rewrite them project-relative inside the SSR
 * build; the helper throws if a path is outside the root or none are found.
 */
function portableManifestPlugin(): Plugin {
  let root = "";
  return {
    name: "cutout:portable-manifest",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "ssr",
    configResolved: (config) => {
      root = config.root;
    },
    transform: {
      filter: { id: /tanstack-start-manifest:v/ },
      handler(code) {
        if (!root) throw new Error("cutout:portable-manifest ran without a resolved root");
        if (!code.includes("tsrStartManifest"))
          throw new Error(`expected the start manifest module, got: ${code.slice(0, 80)}`);
        return { code: rewriteManifestFilePaths(code, root), map: null };
      },
    },
  };
}

/**
 * Nitro tags every public file ending .gz/.br/.zst as a transport encoding of
 * the name without the suffix — right for its own precompressed copies, wrong
 * for real archives such as third-party/source/*.tar.gz, which browsers then
 * saved as bare tarballs. Rewrite the generated asset map inside the Nitro
 * bundle so only files with an uncompressed sibling keep Content-Encoding.
 */
function archiveAssetsPlugin() {
  return {
    name: "cutout:archive-assets",
    transform: {
      filter: { id: /^#nitro\/virtual\/public-assets-data$/ },
      handler(code: string) {
        if (!code.startsWith("export default "))
          throw new Error("public-assets-data: expected an `export default {…}` module");
        const assets = JSON.parse(code.slice(15).replace(/;\s*$/, ""));
        return {
          code: `export default ${JSON.stringify(fixPublicAssetEncodings(assets), null, 2)};`,
          map: null,
        };
      },
    },
  };
}

function devHeadersPlugin(): Plugin {
  // Connect middleware: `server.headers` misses SSR documents. No CSP in dev: Vite's
  // client injects inline scripts. Production policies come from the route rules below.
  const addHeaders = (server: {
    middlewares: { use: (fn: Connect.NextHandleFunction) => unknown };
  }) => {
    server.middlewares.use((_req, res, next) => {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
      next();
    });
  };
  return {
    name: "cutout:dev-headers",
    configureServer(server) {
      addHeaders(server);
      server.middlewares.use("/version.json", (_req, res) => {
        void buildVersion().then((info) => {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          res.end(JSON.stringify(info));
        });
      });
    },
    configurePreviewServer: addHeaders,
  };
}

/** The prerendered /404, handed to server/middleware/not-found.ts through a virtual module. */
let notFoundPage: { html: string; etag: string; csp: string } | null = null;

/**
 * After each page is prerendered: hash its inline scripts into its own
 * Content-Security-Policy route rule (route rules also reach static files, which
 * middleware never sees). The not-found page answers 404, which is expected here; it
 * is kept out of the public files and bundled instead. Then write the
 * build-dependent files next to the pages.
 */
function cutoutBuild(nitro: Nitro) {
  nitro.hooks.hook("prerender:generate", (route) => {
    if (route.route === NOT_FOUND && route.error?.status === 404) route.error = undefined;
    if (route.error || !route.contentType?.includes("text/html") || !route.contents) return;
    const html = route.contents;
    const csp = policyFor(inlineScriptHashes(html));
    if (route.route === NOT_FOUND) {
      const etag = `"${createHash("sha256").update(html).digest("base64url").slice(0, 27)}"`;
      notFoundPage = { html, etag, csp };
      route.skip = true;
      return;
    }
    const rule = (nitro.options.routeRules[route.route] ??= {});
    rule.headers = { ...rule.headers, "Content-Security-Policy": csp };
  });
  nitro.hooks.hook("prerender:done", async () => {
    if (!notFoundPage) throw new Error(`${NOT_FOUND} (the not-found page) was not prerendered`);
    nitro.routing.sync();
    const out = (path: string, text: string) =>
      mkdir(dirname(join(nitro.options.output.publicDir, path)), { recursive: true }).then(() =>
        writeFile(join(nitro.options.output.publicDir, path), text),
      );
    await out("version.json", JSON.stringify(await buildVersion()));
    await out("robots.txt", robotsTxt(SITE_URL));
    await out(".well-known/security.txt", securityTxt(new Date(), SITE_URL));
    if (SITE_URL) await out("sitemap.xml", sitemapXml(SITE_URL, PAGES));
  });
}

export default defineConfig(({ command, isPreview, mode }) => ({
  server: {
    host: "127.0.0.1",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 8081,
    strictPort: true,
  },
  define: {
    "import.meta.env.SITE_URL": JSON.stringify(SITE_URL),
    "import.meta.env.VITE_MODEL_HOST": JSON.stringify(
      modelHostFrom(loadEnv(mode, process.cwd(), "VITE_").VITE_MODEL_HOST),
    ),
  },
  resolve: {
    tsconfigPaths: true,
    // heic-to rebuilt against patched libheif/libde265; see public/third-party/source/BUILD.md.
    alias: { "heic-to/csp": fileURLToPath(new URL("./vendor/heic-to/csp.js", import.meta.url)) },
  },
  // Pre-bundle the ML runtimes: discovering them on first use makes Vite
  // re-optimise and reload the page mid-session (and serve 504 "Outdated
  // Optimize Dep" to the import that triggered it).
  optimizeDeps: { include: ["@huggingface/transformers", "imagetracerjs"] },
  // Workers are already `type: "module"`. The default iife format inlines every
  // dynamic import, so each worker carried its own transformers copy and the
  // decode worker shipped heic-to to every large JPEG. ES workers share chunks.
  worker: {
    format: "es",
    // Each worker is bundled on its own, so the removal and enhance workers each carried
    // a copy of transformers (~180 KB brotli apiece). One named group makes them share
    // it. Not for the page build: there the preload helper lands in this chunk and the
    // home page would load transformers.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "transformers", test: /[\\/]@huggingface[\\/]transformers[\\/]/ }],
        },
      },
    },
  },
  plugins: [
    clientOnlyPlugin(),
    portableManifestPlugin(),
    devHeadersPlugin(),
    tailwindcss(),
    tanstackStart(),
    ...(command === "build" || isPreview
      ? [
          nitro({
            preset: process.env.NITRO_PRESET || "node-server",
            // Runs inside the Nitro bundle build, where the generated
            // #nitro/virtual/public-assets-data module is transformed.
            rolldownConfig: { plugins: [archiveAssetsPlugin()] },
            // Nitro serves the first of .br/.gz/.zst the client accepts, and every
            // zstd-capable browser accepts brotli: .zst copies were never sent.
            compressPublicAssets: { brotli: true, gzip: true },
            routeRules: {
              "/**": {
                headers: {
                  ...SECURITY_HEADERS,
                  "Content-Security-Policy": STRICT_CSP,
                  // From the app itself, so it also holds behind nginx or a Cloudflare
                  // Tunnel without Caddy; only for an https SITE_URL (browsers ignore it
                  // over plain HTTP, and a local build has no domain to pin).
                  ...HSTS_HEADERS,
                },
              },
              // Worker scripts run under their own response's policy: without hashes,
              // but they must compile WebAssembly and fetch models.
              "/assets/**": { headers: { "Content-Security-Policy": policyFor([]) } },
              // Prerendered pages carry Last-Modified, so browsers could cache them
              // heuristically and keep HTML pointing at removed hashed assets after a
              // deploy. Revalidate instead: a 304 via ETag. Their CSP is added once
              // each page is prerendered (cutoutBuild).
              ...Object.fromEntries(
                PAGES.map((page) => [page, { headers: { "Cache-Control": "no-cache" } }]),
              ),
              "/version.json": { headers: { "Cache-Control": "no-store" } },
              // Files with fixed names (no content hash): a day, instead of letting each
              // browser guess from Last-Modified. The home page preloads sample-thumb.
              ...Object.fromEntries(
                [
                  "/sample-thumb.webp",
                  "/sample.jpg",
                  "/og.jpg",
                  "/favicon.svg",
                  "/icon-180.png",
                  "/icon-192.png",
                  "/icon-512.png",
                  "/icon-maskable-512.png",
                  "/manifest.webmanifest",
                ].map((file) => [file, { headers: { "Cache-Control": "public, max-age=86400" } }]),
              ),
            },
            // Auto-registers server/middleware/* in file-name order.
            // Nitro v3 defaults serverDir to false.
            serverDir: "./server",
            virtual: {
              "#cutout/not-found": () => `export default ${JSON.stringify(notFoundPage)};`,
              "#cutout/hsts": () => `export default ${JSON.stringify(HSTS_HEADERS)};`,
              "#cutout/html-aliases": () =>
                `export default ${JSON.stringify(
                  Object.fromEntries(
                    PAGES.flatMap((page) =>
                      page === "/"
                        ? [["/index.html", page]]
                        : [
                            [`${page}.html`, page],
                            [`${page}/index.html`, page],
                          ],
                    ),
                  ),
                )};`,
            },
            modules: [cutoutBuild],
            // transformers.js's Node entry pulls in onnxruntime-node and sharp
            // (~440 MB of Linux binaries). Inference only runs in the browser;
            // the server reaches transformers solely through never-run dynamic imports.
            traceDeps: ["!onnxruntime-node", "!sharp"],
            prerender: { routes: [...PAGES, NOT_FOUND], failOnError: true },
          }),
        ]
      : []),
    viteReact(),
  ],
}));
