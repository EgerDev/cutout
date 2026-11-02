/**
 * Files the build writes next to the prerendered pages. They depend on the build
 * (date, SITE_URL), so they are generated instead of living in public/.
 */

/** SITE_URL without a trailing slash, "" when unset. A malformed value fails the build. */
export function siteUrlFrom(value) {
  if (!value) return "";
  const url = URL.canParse(value) ? new URL(value) : null;
  if (!url || !/^https?:$/.test(url.protocol) || url.search || url.hash)
    throw new Error(
      `SITE_URL must be an absolute http(s) URL like https://cutout.example.com, got "${value}"`,
    );
  return (url.origin + url.pathname).replace(/\/+$/, "");
}

/** A model mirror must be a base URL allowed by the production connect-src policy. */
export function modelHostFrom(value) {
  if (!value) return "";
  const url = URL.canParse(value) ? new URL(value) : null;
  if (
    !/^https:\/\//i.test(value) ||
    /[\s\\?#]/.test(value) ||
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password
  )
    // Do not echo the URL: a mistaken credential or query may contain a secret.
    throw new Error(
      "VITE_MODEL_HOST must be an absolute HTTPS base URL without credentials, query, or fragment " +
        "(for example https://models.example.com/models/); HTTP, including localhost, is unsupported by production CSP",
    );
  return url.href.replace(/\/?$/, "/");
}

export function robotsTxt(siteUrl) {
  return `User-agent: *\nAllow: /\n${siteUrl ? `\nSitemap: ${siteUrl}/sitemap.xml\n` : ""}`;
}

const escapeXml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function sitemapXml(siteUrl, pages) {
  const urls = pages
    .map((page) => `  <url><loc>${escapeXml(siteUrl + page)}</loc></url>\n`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}</urlset>\n`;
}

/** RFC 9116. Reports go through GitHub's private vulnerability reporting; no email by design. */
export function securityTxt(now, siteUrl) {
  const expires = new Date(now);
  expires.setUTCFullYear(expires.getUTCFullYear() + 1);
  return [
    "Contact: https://github.com/EgerDev/cutout/security/advisories/new",
    `Expires: ${expires.toISOString()}`,
    "Policy: https://github.com/EgerDev/cutout/blob/main/SECURITY.md",
    "Preferred-Languages: en",
    ...(siteUrl ? [`Canonical: ${siteUrl}/.well-known/security.txt`] : []),
    "",
  ].join("\n");
}
