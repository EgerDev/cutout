import { createHash } from "node:crypto";

/**
 * `sha256-…` of each inline `<script>` body in the page, in document order. Hashed as
 * the browser sees it after parsing: line breaks normalised to LF and NUL replaced by
 * U+FFFD (TanStack's dehydrated router state contains NUL bytes).
 */
export function inlineScriptHashes(html) {
  const hashes = [];
  for (const [, attributes, body] of html.matchAll(
    /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\t\n\f\r />])[^>]*>/gi,
  ))
    if (!/\bsrc\s*=/i.test(attributes)) {
      const text = body.replace(/\r\n?/g, "\n").replace(/\0/g, "�");
      hashes.push(`sha256-${createHash("sha256").update(text, "utf8").digest("base64")}`);
    }
  return hashes;
}

/**
 * The policy for one page. Inline scripts are allowed by hash only; styles stay
 * 'unsafe-inline' for React's style attributes; ONNX Runtime compiles WebAssembly;
 * heic-to starts a blob: worker; connect-src takes any https: host because a
 * `?src=` link may point anywhere (models come from Hugging Face or a mirror).
 */
export function policyFor(hashes) {
  // No script inserted at runtime needs a hash: the audit's extra "React runtime"
  // hash is not requested once the prerendered scripts hash correctly (verified by
  // serving the pages without it). scripts/browser-csp.mjs fails if one appears.
  const scripts = [...new Set(hashes)].map((hash) => `'${hash}'`);
  return [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", ...scripts].join(" "),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self' blob: data: https:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}
