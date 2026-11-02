/**
 * Depth Anything in a dedicated worker so a retired page-realm ORT init
 * (rejected or never-settling InferenceSession.create / wasmInitPromise)
 * can still run the remaining waterfall in a fresh realm.
 */
import { estimateDepth, loadDepthPipeline, type DepthAttempt } from "./depth.ts";

type WorkerRequest =
  { type: "load"; attempt: DepthAttempt } | { type: "infer"; id: number; blob: Blob };

let pending: ReturnType<typeof loadDepthPipeline> | null = null;

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (data.type === "load") {
    pending = loadDepthPipeline(
      (fraction) => postMessage({ type: "progress", fraction }),
      data.attempt,
    );
    pending.then(
      ({ device }) => postMessage({ type: "loaded", device }),
      (error: unknown) => {
        pending = null;
        postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return;
  }
  if (data.type === "infer") {
    void (async () => {
      try {
        if (!pending) throw new Error("depth worker not loaded");
        const { run } = await pending;
        const { depth } = await estimateDepth(run, data.blob);
        const bytes = new Uint8Array(depth.data);
        postMessage(
          {
            type: "map",
            id: data.id,
            bytes: bytes.buffer,
            width: depth.width,
            height: depth.height,
          },
          { transfer: [bytes.buffer] },
        );
      } catch (error) {
        postMessage({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
});
