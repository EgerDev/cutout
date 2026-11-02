import assert from "node:assert/strict";
import { test } from "node:test";
import { robotsTxt, securityTxt, siteUrlFrom, sitemapXml } from "./site-files.mjs";

test("SITE_URL is normalised to an origin without a trailing slash, or rejected", () => {
  assert.equal(siteUrlFrom(undefined), "");
  assert.equal(siteUrlFrom(""), "");
  assert.equal(siteUrlFrom("https://cutout.example.com/"), "https://cutout.example.com");
  assert.equal(
    siteUrlFrom("https://example.com/tools/cutout//"),
    "https://example.com/tools/cutout",
  );
  assert.throws(() => siteUrlFrom("cutout.example.com"), /SITE_URL/);
  assert.throws(() => siteUrlFrom("ftp://cutout.example.com"), /SITE_URL/);
  assert.throws(() => siteUrlFrom("https://cutout.example.com/?a=1"), /SITE_URL/);
});

test("robots.txt allows everything and names the sitemap only when there is one", () => {
  assert.equal(robotsTxt(""), "User-agent: *\nAllow: /\n");
  assert.equal(
    robotsTxt("https://c.example"),
    "User-agent: *\nAllow: /\n\nSitemap: https://c.example/sitemap.xml\n",
  );
});

test("the sitemap lists every page by absolute URL", () => {
  const xml = sitemapXml("https://c.example", ["/", "/guide", "/a&b"]);
  assert.match(
    xml,
    /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9">/,
  );
  assert.deepEqual(
    [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]),
    ["https://c.example/", "https://c.example/guide", "https://c.example/a&amp;b"],
  );
});

test("security.txt points at GitHub private reporting and expires a year after the build", () => {
  const now = new Date("2026-09-23T12:00:00Z");
  const text = securityTxt(now, "https://c.example");
  const fields = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
  );
  assert.deepEqual(fields, {
    Contact: "https://github.com/EgerDev/cutout/security/advisories/new",
    Expires: "2027-09-23T12:00:00.000Z",
    Policy: "https://github.com/EgerDev/cutout/blob/main/SECURITY.md",
    "Preferred-Languages": "en",
    Canonical: "https://c.example/.well-known/security.txt",
  });
  assert.ok(!securityTxt(now, "").includes("Canonical"), "no canonical without a site URL");
  assert.ok(!/@|mailto/i.test(text), "no email address");
});
