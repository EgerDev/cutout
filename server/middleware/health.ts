interface HealthEvent {
  readonly url: URL;
  readonly req: { readonly method: string };
}

export default function health(event: HealthEvent, next: () => unknown): unknown {
  if (event.url.pathname !== "/healthz") return next();
  if (event.req.method !== "GET" && event.req.method !== "HEAD")
    return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
  return new Response(event.req.method === "HEAD" ? null : "ok\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
