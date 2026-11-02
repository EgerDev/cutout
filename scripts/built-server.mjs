// A production build must exist (npm run build): run with `npm run test:server`, not with the
// unit tests, so a stale local .output never fails `npm run test:unit`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { after, before, test } from "node:test";
import { inlineScriptHashes, policyFor } from "./csp.mjs";

/**
 * The production server (`npm run build` output), copied to a temporary directory so
 * it is proven standalone, on a random port. Without a build the suite skips, unless
 * CUTOUT_REQUIRE_E2E is set (CI), where a missing build is a failure.
 */
const output = resolve(process.env.CUTOUT_SERVER_OUTPUT || ".output");
const built = existsSync(join(output, "server/index.mjs"));
const skip = !built && !process.env.CUTOUT_REQUIRE_E2E && "no .output: run `npm run build` first";
const STRICT = "default-src 'none'; frame-ancestors 'none'";
const PAGES = readdirSync(resolve("src/routes"))
  .filter((file) => file.endsWith(".tsx") && file !== "__root.tsx")
  .map((file) => (file === "index.tsx" ? "/" : `/${file.slice(0, -4)}`));

let base, child, directory, expectedHsts;
before(async () => {
  if (skip) return;
  directory = await mkdtemp(join(tmpdir(), "cutout-server-"));
  await cp(output, join(directory, ".output"), { recursive: true });
  child = spawn(process.execPath, [".output/server/index.mjs"], {
    cwd: directory,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: process.env.CUTOUT_TEST_PORT || "0",
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => (stderr += data));
  base = await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error("Server startup timed out")), 15000);
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Server exited ${code}: ${stderr}`)));
    child.stdout.on("data", (data) => {
      const match = String(data).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) {
        clearTimeout(timer);
        done(match[0]);
      }
    });
  });
  const home = await fetch(base).then((response) => response.text());
  expectedHsts = /rel="canonical" href="https:/.test(home) ? "max-age=31536000" : null;
});
after(async () => {
  if (child && child.exitCode === null) {
    const exit = once(child, "exit");
    child.kill("SIGTERM");
    // A wedged server must not hang the whole suite: SIGTERM, then SIGKILL.
    const graceful = await Promise.race([exit.then(() => true), sleep(5000, false)]);
    if (!graceful) {
      child.kill("SIGKILL");
      await exit;
    }
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

const sleep = (ms, value) => new Promise((done) => setTimeout(() => done(value), ms));

const get = (path, init) => fetch(base + path, init);

test(
  "malformed percent-encoded paths finish with 400 before H3 creates an event",
  { skip },
  async () => {
    for (const path of ["/%", "/%GG", "/%FF", "/%C0%AF", "/%E0%A4%A"])
      for (const method of ["GET", "HEAD", "POST"]) {
        const response = await get(path, { method, signal: AbortSignal.timeout(2000) });
        assert.equal(response.status, 400, `${method} ${path}`);
        assertSecurityHeaders(response, path);
        assert.equal(response.headers.get("content-security-policy"), STRICT);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(await response.text(), "");
      }
    for (const path of ["/%25", "/%2525", "/%E2%82%AC"])
      assert.equal((await get(path)).status, 404, `valid escaped path ${path}`);
    assert.equal((await get("/?q=%GG")).status, 200, "query escapes are not path decoding");
    assert.equal(await get("/healthz").then((response) => response.text()), "ok\n");
  },
);

/** The headers every response carries, whatever produced it. */
function assertSecurityHeaders(response, label) {
  const h = response.headers;
  assert.equal(h.get("cross-origin-opener-policy"), "same-origin", label);
  assert.equal(h.get("cross-origin-embedder-policy"), "require-corp", label);
  assert.equal(h.get("x-content-type-options"), "nosniff", label);
  assert.equal(h.get("x-frame-options"), "SAMEORIGIN", label);
  assert.equal(h.get("referrer-policy"), "strict-origin-when-cross-origin", label);
  assert.equal(
    h.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    label,
  );
  assert.ok(h.get("content-security-policy"), `${label}: CSP`);
  assert.equal(h.get("strict-transport-security"), expectedHsts, `${label}: HSTS`);
}

/** Derive real compressed identities from emitted files, independently of the server map. */
const aliasesFor = (page) => {
  const index = page === "/" ? "index.html" : `${page.slice(1)}/index.html`;
  const compressed = readdirSync(join(output, "public"), { recursive: true })
    // recursive readdir returns platform separators (guide\index.html.gz on Windows)
    .map((file) => file.replaceAll(sep, "/"))
    .filter((file) => file === `${index}.gz` || file === `${index}.br`)
    .map((file) => `/${file}`);
  assert.equal(compressed.length, 2, `${page}: both emitted HTML encodings`);
  const exact = page === "/" ? ["/index.html"] : [`${page}.html`, `${page}/index.html`];
  return [...exact, ...compressed]
    .flatMap((alias) => [alias, `${alias}/`])
    .concat(page === "/" ? "//" : `${page}//`);
};

test("HTML aliases redirect to canonical routes with the query intact", { skip }, async () => {
  for (const page of PAGES) {
    for (const alias of aliasesFor(page)) {
      const query =
        "?src=https%3a%2f%2fimages.example%2fa.png&src=second&name=a+b&raw=%0d%0aLocation%3A%20https%3A%2F%2Fevil.example&blank=&e2e";
      for (const method of ["GET", "HEAD"]) {
        const response = await get(alias + query, { method, redirect: "manual" });
        assert.equal(response.status, 308, `${method} ${alias}`);
        assert.equal(response.headers.get("location"), page + query, alias);
        assertSecurityHeaders(response, alias);
        assert.equal(await response.text(), "", `${method} ${alias}: bodyless redirect`);
      }
      const followed = await get(alias + query);
      assert.equal(followed.status, 200, alias);
      assert.equal(new URL(followed.url).pathname, page);
      assert.equal(new URL(followed.url).search, query);
      const html = await followed.text();
      assert.equal(
        followed.headers.get("content-security-policy"),
        policyFor(inlineScriptHashes(html)),
      );
      const canonical = html.match(/rel="canonical" href="([^"]+)"/)?.[1];
      if (canonical) assert.equal(new URL(canonical).pathname, page);
      const post = await get(alias + query, { method: "POST", redirect: "manual" });
      assert.equal(post.status, 405, alias);
      assert.equal(post.headers.get("allow"), "GET, HEAD");
      assertSecurityHeaders(post, alias);
      assert.equal(post.headers.get("location"), null);
      assert.equal(await post.text(), "");
    }
  }
  const extra = readdirSync(join(output, "public"), { recursive: true })
    .filter((file) => /(^|\/)index\.html(?:\.(?:gz|br))?$/.test(file))
    .flatMap((file) => [`/${file}//`, `/${file}///`]);
  for (const path of [
    ...extra,
    "/unknown.html/",
    "/unknown.html.gz",
    "/guide.html//",
    "/guide.html.gz",
    "/guide//index.html",
    "/guide//index.html.br",
    "/guide/index.html.zst",
    "/guide///",
    "/guide////",
    "///",
    "////",
  ]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = await get(`${path}?x=1`, { method, redirect: "manual" });
      assert.equal(response.status, method === "POST" ? 405 : 404, `${method} ${path}`);
      assert.equal(response.headers.get("location"), null, path);
      assertSecurityHeaders(response, path);
      if (method !== "GET") assert.equal(await response.text(), "");
    }
  }
  const guideSlash = await get("/guide/", { redirect: "manual" });
  assert.equal(guideSlash.status, 200, "/guide/ is the canonical page, not an alias redirect");
  assert.equal(guideSlash.headers.get("location"), null);
});

test("every route is a prerendered page with its own script-hash policy", { skip }, async () => {
  assert.ok(PAGES.includes("/") && PAGES.includes("/guide"), `routes found: ${PAGES}`);
  for (const page of PAGES) {
    const response = await get(page);
    assert.equal(response.status, 200, page);
    assertSecurityHeaders(response, page);
    // Pages are static files (an ETag), revalidated so a deploy never leaves stale HTML.
    assert.ok(response.headers.get("etag"), `${page} is served from a prerendered file`);
    assert.equal(response.headers.get("cache-control"), "no-cache", page);
    const html = await response.text();
    assert.equal(
      response.headers.get("content-security-policy"),
      policyFor(inlineScriptHashes(html)),
      page,
    );
  }
});

test(
  "assets are immutable, compressed, and workers get a policy that lets them run",
  { skip },
  async () => {
    const html = await get("/").then((r) => r.text());
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    assert.ok(css && js, "the page links its assets");
    const script = await get(js);
    assert.equal(script.status, 200);
    assertSecurityHeaders(script, js);
    assert.equal(script.headers.get("cache-control"), "public, max-age=31536000, immutable");
    // A worker script's own response policy governs the worker: it must allow WebAssembly.
    assert.equal(script.headers.get("content-security-policy"), policyFor([]));
    const style = await get(css, { headers: { "accept-encoding": "br, gzip" } });
    assert.equal(style.status, 200);
    assert.match(style.headers.get("content-type"), /text\/css/);
    assert.match(style.headers.get("content-encoding") ?? "", /br|gzip/);
  },
);

test(
  "direct compressed CSS, JS and WASM retain decoded bytes and immutable caching",
  { skip },
  async () => {
    const files = readdirSync(join(output, "public/assets"), { recursive: true });
    for (const extension of ["css", "js", "wasm"]) {
      const file = files.find(
        (file) =>
          file.endsWith(`.${extension}`) &&
          files.includes(`${file}.gz`) &&
          files.includes(`${file}.br`),
      );
      assert.ok(file, `emitted compressed ${extension}`);
      const expected = readFileSync(join(output, "public/assets", file));
      for (const encoding of ["", ".gz", ".br"]) {
        for (const slash of ["", "/"]) {
          const path = `/assets/${file}${encoding}${slash}`;
          const response = await get(path, { redirect: "manual" });
          assert.equal(response.status, 200, path);
          assert.equal(response.headers.get("location"), null, path);
          assert.equal(
            response.headers.get("cache-control"),
            "public, max-age=31536000, immutable",
            path,
          );
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, path);
          assertSecurityHeaders(response, path);
        }
      }
    }
  },
);

test("other files get a policy that allows nothing", { skip }, async () => {
  for (const path of ["/manifest.webmanifest", "/favicon.svg", "/robots.txt"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assertSecurityHeaders(response, path);
    assert.equal(response.headers.get("content-security-policy"), STRICT, path);
  }
  const manifest = await get("/manifest.webmanifest").then((r) => r.json());
  assert.equal(manifest.name, "Cutout");
  for (const icon of manifest.icons) assert.equal((await get(icon.src)).status, 200, icon.src);
});

test(
  "the standalone artifact serves its notices and corresponding source unchanged",
  { skip },
  async () => {
    const exif = JSON.parse(readFileSync(resolve("package-lock.json"), "utf8")).packages[
      "node_modules/exifreader"
    ].version;
    const archives = new Set([
      `/third-party/source/exifreader-${exif}.tgz`,
      "/third-party/source/heic-to-1.5.2.tar.gz",
      "/third-party/source/libheif-1.23.5.tar.gz",
      "/third-party/source/libde265-1.1.3.tar.gz",
    ]);
    // A declared transport encoding is only honest when the server holds that
    // compressed variant: *.tar.gz carries its own gzip, and once went out as
    // Content-Encoding: gzip + x-tar, so fetch saved a bare .tar.
    const variantSuffix = { gzip: ".gz", br: ".br", zstd: ".zst" };
    for (const path of [
      "/third-party/THIRD_PARTY_NOTICES.txt",
      "/third-party/Apache-2.0.txt",
      ...archives,
      "/third-party/source/BUILD.md",
    ]) {
      const expected = readFileSync(resolve(`public${path}`));
      const digest = createHash("sha256").update(expected).digest("hex");
      for (const accept of ["identity", "br, gzip"]) {
        const response = await get(path, { headers: { "accept-encoding": accept } });
        assert.equal(response.status, 200, `${accept} ${path}`);
        assertSecurityHeaders(response, path);
        const body = Buffer.from(await response.arrayBuffer());
        assert.equal(body.length, expected.length, `${accept} ${path}: length`);
        assert.equal(
          createHash("sha256").update(body).digest("hex"),
          digest,
          `${accept} ${path}: sha256`,
        );
        if (archives.has(path))
          assert.equal(
            response.headers.get("content-type"),
            "application/gzip",
            `${accept} ${path}`,
          );
        const coding = response.headers.get("content-encoding");
        if (coding !== null)
          assert.ok(
            existsSync(join(output, "public", `${path.slice(1)}${variantSuffix[coding]}`)),
            `${accept} ${path}: Content-Encoding ${coding} is not an emitted variant`,
          );
      }
    }
  },
);

test("the shipped server manifest carries no build-machine paths", { skip }, async () => {
  const manifests = readdirSync(join(output, "server")).filter(
    (file) => file.startsWith("_tanstack-start-manifest_v-") && file.endsWith(".mjs"),
  );
  assert.equal(manifests.length, 1, `expected one manifest, found: ${manifests}`);
  const filePaths = [
    ...readFileSync(join(output, "server", manifests[0]), "utf8").matchAll(
      /filePath\s*:\s*"((?:[^"\\]|\\.)*)"/g,
    ),
  ].map((match) => JSON.parse(`"${match[1]}"`));
  assert.ok(filePaths.length > 0, "manifest has no route filePath entries to check");
  for (const filePath of filePaths) {
    assert.ok(!isAbsolute(filePath), `absolute path shipped in manifest: ${filePath}`);
    assert.ok(existsSync(resolve(filePath)), `route filePath does not resolve: ${filePath}`);
  }
  // Nothing else in the artifact may embed the checkout path either.
  const leaked = [];
  for (const file of readdirSync(output, { recursive: true })) {
    const full = join(output, file);
    if (!statSync(full).isFile() || statSync(full).size > 8 * 1024 * 1024) continue;
    if (readFileSync(full).includes(process.cwd())) leaked.push(file);
  }
  assert.deepEqual(leaked, [], "checkout path embedded in the build output");
});

test("methods other than GET and HEAD answer 405 without rendering", { skip }, async () => {
  for (const path of ["/", "/guide", "/nope", "/assets/x.js", "/healthz"])
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await get(path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get("allow"), "GET, HEAD", `${method} ${path}`);
      assert.equal(await response.text(), "", `${method} ${path} has no page body`);
      assertSecurityHeaders(response, `${method} ${path}`);
    }
  // fetch() refuses to send TRACE, so ask with node:http.
  const status = await new Promise((done, fail) => {
    const req = request(base + "/", { method: "TRACE" }, (res) => done(res.statusCode));
    req.on("error", fail).end();
  });
  assert.equal(status, 405);
  assert.equal((await get("/", { method: "HEAD" })).status, 200);
});

test("unknown paths get the prerendered 404, not a rendered one", { skip }, async () => {
  const first = await get("/nope");
  const body = await first.text();
  assert.equal(first.status, 404);
  assertSecurityHeaders(first, "404");
  assert.match(first.headers.get("content-type"), /^text\/html/);
  assert.equal(first.headers.get("x-robots-tag"), "noindex");
  assert.equal(first.headers.get("cache-control"), "no-cache");
  assert.match(body, /Page not found/);
  assert.match(body, /<title>Page not found · Cutout<\/title>/);
  assert.match(body, /<meta name="robots" content="noindex"/);
  assert.ok(!/rel="canonical"/.test(body), "a 404 has no canonical URL");
  assert.equal(first.headers.get("content-security-policy"), policyFor(inlineScriptHashes(body)));
  // A rendered 404 embeds a per-request value; the static one is the same bytes every time.
  const second = await get("/somewhere/else?x=1");
  assert.ok(first.headers.get("etag"), "static 404 has an ETag");
  assert.equal(second.headers.get("etag"), first.headers.get("etag"));
  assert.equal(await second.text(), body);
  for (const path of ["/404", "/assets/missing.js", "/guide/nope", "/.env", "/_server"])
    assert.equal((await get(path)).status, 404, path);
  const head = await get("/nope", { method: "HEAD" });
  assert.equal(head.status, 404);
  assert.equal(await head.text(), "");
});

test("/version.json names the running build and is never cached", { skip }, async () => {
  const response = await get("/version.json");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assertSecurityHeaders(response, "version.json");
  const info = await response.json();
  assert.deepEqual(Object.keys(info).sort(), ["commit", "version"]);
  assert.match(info.version, /^\d+\.\d+\.\d+/);
  assert.match(info.commit, /^([0-9a-f]{40}|dev)$/);
});

test("/healthz answers plainly and uncached", { skip }, async () => {
  const health = await get("/healthz");
  assert.equal(await health.text(), "ok\n");
  assert.equal(health.headers.get("cache-control"), "no-store");
  assertSecurityHeaders(health, "healthz");
});

test("robots.txt, security.txt, sitemap and canonical URLs agree", { skip }, async () => {
  const robots = await get("/robots.txt").then((r) => r.text());
  assert.match(robots, /^User-agent: \*\nAllow: \/\n/);
  const security = await get("/.well-known/security.txt");
  assert.equal(security.status, 200);
  const text = await security.text();
  assert.match(
    text,
    /^Contact: https:\/\/github\.com\/EgerDev\/cutout\/security\/advisories\/new$/m,
  );
  assert.ok(
    new Date(text.match(/^Expires: (.+)$/m)[1]) > new Date(),
    "security.txt has not expired",
  );
  const home = await get("/").then((r) => r.text());
  const canonical = home.match(/<link rel="canonical" href="([^"]+)"/)?.[1];
  const sitemap = await get("/sitemap.xml");
  if (!canonical) {
    // Built without SITE_URL: no guessed absolute URLs, no sitemap.
    assert.equal(sitemap.status, 404);
    assert.ok(!/og:url|og:image"/.test(home), "no og:url or relative og:image");
    return;
  }
  const site = canonical.replace(/\/$/, "");
  assert.match(home, new RegExp(`<meta property="og:image" content="${site}/og.jpg"`));
  assert.match(robots, new RegExp(`Sitemap: ${site}/sitemap.xml`));
  const xml = await sitemap.text();
  for (const page of PAGES) {
    const html = await get(page).then((r) => r.text());
    const url = site + (page === "/" ? "/" : page);
    assert.match(html, new RegExp(`<link rel="canonical" href="${url}"`), page);
    assert.match(html, new RegExp(`<meta property="og:url" content="${url}"`), page);
    assert.ok(xml.includes(`<loc>${url}</loc>`), `${page} in sitemap`);
  }
});
