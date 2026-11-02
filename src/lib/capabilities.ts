/**
 * Browser features removal cannot run without. transformers.js draws through
 * OffscreenCanvas even on the main thread, so a browser without it (Safari before
 * 16.4) fails every cutout; better to say so before the model download starts.
 */
const REQUIRED = ["OffscreenCanvas", "WebAssembly", "createImageBitmap", "Worker"] as const;

export function missingCapabilities(g: object = globalThis): string[] {
  return REQUIRED.filter((name) => (g as Record<string, unknown>)[name] === undefined);
}
