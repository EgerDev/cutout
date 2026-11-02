import type { NitroApp } from "nitro/types";
import { decodePath, joinURL, withLeadingSlash, withoutTrailingSlash } from "ufo";
import aliases from "#cutout/html-aliases";
import hsts from "#cutout/hsts";
import { SECURITY_HEADERS, STRICT_CSP } from "../headers.ts";

export default function htmlAliases(app: NitroApp) {
  const h3 = app.h3;
  if (!h3) throw new Error("HTML aliases require Nitro's H3 server");
  const fetchRequest = h3.fetch.bind(h3);
  h3.fetch = (request) => {
    try {
      return fetchRequest(request);
    } catch (error) {
      // Pinned H3 decodes the path before its error boundary or any middleware runs.
      if (!(error instanceof URIError)) throw error;
      return new Response(null, {
        status: 400,
        headers: {
          ...SECURITY_HEADERS,
          ...hsts,
          "Content-Security-Policy": STRICT_CSP,
          "Cache-Control": "no-store",
        },
      });
    }
  };
  // Nitro serves public index.html files before its middleware. Wrap the H3 handler
  // so aliases redirect before that static-file lookup, keeping the normal request
  // and response hooks. Route-rule redirects would also redirect POSTs and re-encode
  // queries (dropping duplicate parameters); retain the site's 405 and exact search.
  const handle = h3.handler.bind(h3);
  // These are the index files emitted for the explicit public pages, including
  // compressPublicAssets' directly addressable Brotli/gzip siblings. Synthetic
  // /guide.html aliases have no emitted compressed siblings.
  const publicHtml = new Map(
    Object.entries(aliases)
      .filter(([path]) => path.endsWith("/index.html"))
      .flatMap(([path, target]) =>
        ["", ".br", ".gz"].map((encoding) => [path + encoding, target] as const),
      ),
  );
  const aliasTarget = (pathname: string) => {
    // Match pinned Nitro's static resolver: one trailing slash, decoded direct
    // id, then a directory-index join. In particular /guide// joins to its index,
    // while /guide/// and /guide//index.html do not. Only known files yield a
    // fixed canonical target; arbitrary paths and non-HTML assets fall through.
    const id = decodePath(withLeadingSlash(withoutTrailingSlash(pathname)));
    const target = Object.hasOwn(aliases, id)
      ? aliases[id]
      : (publicHtml.get(id) ?? publicHtml.get(joinURL(id, "index.html")));
    if (pathname === target || (target !== "/" && pathname === `${target}/`)) return;
    return target;
  };
  h3.handler = (event) => {
    const target = aliasTarget(event.url.pathname);
    if (!target || (event.req.method !== "GET" && event.req.method !== "HEAD"))
      return handle(event);
    return new Response(null, {
      status: 308,
      headers: {
        ...SECURITY_HEADERS,
        ...hsts,
        "Content-Security-Policy": STRICT_CSP,
        "Cache-Control": "no-cache",
        Location: target + event.url.search,
      },
    });
  };
}
