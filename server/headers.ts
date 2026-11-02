/**
 * Headers for every response, set here so a plain Node deployment (systemd, no Caddy)
 * sends them too. Where they are applied: vite.config.ts (dev server, and Nitro route
 * rules for static files and pages) and middleware/headers.ts (responses middleware
 * builds itself, which route rules miss when the status is not 2xx).
 *
 * Cross-origin isolation: onnxruntime-web only uses WebAssembly threads when the
 * document is crossOriginIsolated, and under COEP require-corp worker scripts need
 * the headers too.
 */
export const SECURITY_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "X-Content-Type-Options": "nosniff",
  // Legacy twin of the pages' CSP frame-ancestors 'self'.
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

/**
 * The policy for anything that is not a page or a script: nothing may run or load if
 * such a file is ever opened as a document. Pages and /assets get theirs from
 * scripts/csp.mjs at build time.
 */
export const STRICT_CSP = "default-src 'none'; frame-ancestors 'none'";
