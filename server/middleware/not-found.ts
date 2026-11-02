import page from "#cutout/not-found";

interface NotFoundEvent {
  readonly req: { readonly method: string };
}

/**
 * Every page is prerendered and served as a file before middleware runs, so whatever
 * reaches this point does not exist. Answer with the prerendered /404 page (captured
 * at build time into the server bundle) instead of rendering React per request: a
 * flood of random URLs then costs what a static file costs. `page` is null while the
 * build prerenders, which lets the renderer draw /404 in the first place.
 */
export default function notFound(event: NotFoundEvent, next: () => unknown): unknown {
  if (!page) return next();
  return new Response(event.req.method === "HEAD" ? null : page.html, {
    status: 404,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ETag: page.etag,
      "X-Robots-Tag": "noindex",
      "Content-Security-Policy": page.csp,
    },
  });
}
