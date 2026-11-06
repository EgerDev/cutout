import { REMOVAL_MODELS, REMOVAL_MODEL_SHA256 } from "./removal-model-specs.ts";

export class RemovalModelIntegrityError extends Error {
  readonly name = "RemovalModelIntegrityError";
  readonly code = "removal-model-integrity";
  readonly file: string;
  constructor(file: string) {
    super(
      "The model download failed its safety check. Check your connection or model mirror, then reload the page.",
    );
    this.file = file;
  }
}

/** Called by our hub.js patch on its existing buffer, before cache.put, JSON parse or ORT.
 *  Hash every read: no trusted-URL memo can hide a later replacement in Cache Storage. */
export async function verifyRemovalModelBytes(
  modelId: string,
  file: string,
  revision: string,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  const model = (Object.keys(REMOVAL_MODELS) as (keyof typeof REMOVAL_MODELS)[]).find(
    (model) => REMOVAL_MODELS[model].modelId === modelId,
  );
  if (!model) return; // Upscale and depth models have separate loaders and are outside these pins.
  const expected =
    revision === REMOVAL_MODELS[model].revision ? REMOVAL_MODEL_SHA256[model][file] : undefined;
  if (!expected) throw new RemovalModelIntegrityError(file);
  // An insecure origin (`npm run dev:lan` over plain HTTP) has no WebCrypto. There the page's
  // own code is unauthenticated too, so a pin proves nothing; damaged bytes still fail to
  // parse. Anywhere else, being unable to hash is a failed check, not a pass.
  if (!globalThis.crypto?.subtle) {
    if (globalThis.isSecureContext === false) return;
    throw new RemovalModelIntegrityError(file);
  }
  let digest: ArrayBuffer;
  try {
    digest = await crypto.subtle.digest("SHA-256", bytes);
  } catch {
    throw new RemovalModelIntegrityError(file);
  }
  const actual = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (actual !== expected) throw new RemovalModelIntegrityError(file);
}

/** By code too: the code survives the worker's error serialization, the class does not. */
export function isRemovalModelIntegrityError(error: unknown): error is RemovalModelIntegrityError {
  return (
    error instanceof RemovalModelIntegrityError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "removal-model-integrity")
  );
}

/** The stock custom-cache hooks swallow errors, so verification cannot live in put().
 *  Use Cache Storage when allowed; the independent buffer hook also runs without it. */
export function removalModelCache(env: { useBrowserCache: boolean }) {
  async function cache() {
    try {
      return env.useBrowserCache ? await globalThis.caches?.open("transformers-cache") : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    async match(key: string): Promise<Response | undefined> {
      return (await cache())?.match(key);
    },
    async put(key: string, response: Response): Promise<void> {
      await (await cache())?.put(key, response);
    },
    verify: verifyRemovalModelBytes,
  };
}
