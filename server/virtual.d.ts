/** Filled in by vite.config.ts once /404 is prerendered; null during prerendering. */
declare module "#cutout/not-found" {
  const page: { html: string; etag: string; csp: string } | null;
  export default page;
}

/** Build-time HTTPS policy shared by route rules and middleware-created responses. */
declare module "#cutout/hsts" {
  const headers: Record<string, string>;
  export default headers;
}

/** Only aliases of the explicitly prerendered public routes. */
declare module "#cutout/html-aliases" {
  const aliases: Record<string, string>;
  export default aliases;
}
