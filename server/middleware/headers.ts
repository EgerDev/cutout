import { SECURITY_HEADERS, STRICT_CSP } from "../headers.ts";
import hsts from "#cutout/hsts";

/**
 * Route rules put the security headers on static files and pages, but h3 only merges
 * them into a Response a middleware returns when its status is 2xx: the 404 and 405
 * would go out bare. A page without COOP/COEP is not crossOriginIsolated, and a
 * visitor who then opened the app in that tab got single-threaded inference.
 * Runs first (files run in name order) so it wraps every other middleware.
 */
export default async function headers(_event: unknown, next: () => unknown): Promise<unknown> {
  const response = await next();
  if (response instanceof Response) {
    try {
      for (const [name, value] of Object.entries({
        ...SECURITY_HEADERS,
        ...hsts,
        "Content-Security-Policy": STRICT_CSP,
      }))
        if (!response.headers.has(name)) response.headers.set(name, value);
    } catch {
      /* immutable headers (a proxied response): leave them as they are */
    }
  }
  return response;
}
