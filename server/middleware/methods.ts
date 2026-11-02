interface MethodEvent {
  readonly req: { readonly method: string };
}

/**
 * The site is read-only. Without this, POST/PUT/DELETE on a page reached the React
 * renderer and answered 200 with a freshly rendered page: CPU spent for nothing.
 * Static files are already served (GET/HEAD only) before any middleware here runs.
 */
export default function methods(event: MethodEvent, next: () => unknown): unknown {
  if (event.req.method === "GET" || event.req.method === "HEAD") return next();
  return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
}
