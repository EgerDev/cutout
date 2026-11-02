/**
 * Swin2SR off the main thread: loads the pipeline once per model and upscales
 * tiles sent as RGBA buffers, so the page stays responsive while a long run
 * churns through its tiles.
 */
import { loadPipeline } from "./enhance.ts";

type WorkerRequest =
  | { type: "load"; model: string }
  | { type: "tile"; id: number; rgba: ArrayBuffer; width: number; height: number };

let pending: ReturnType<typeof loadPipeline> | null = null;
let tf: ReturnType<typeof import("./transformers.ts").transformers> | null = null;

async function load(model: string) {
  tf ??= (await import("./transformers.ts")).transformers();
  return loadPipeline(model, (fraction) => postMessage({ type: "progress", fraction }));
}

addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const data = event.data;
  if (data.type === "load") {
    pending ??= load(data.model);
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
  if (data.type === "tile") {
    void (async () => {
      try {
        if (!pending || !tf) throw new Error("upscaler not loaded");
        const { run } = await pending;
        const image = new tf.RawImage(
          new Uint8ClampedArray(data.rgba),
          data.width,
          data.height,
          4,
        ).rgb();
        const result = await run(image);
        const out = new Uint8ClampedArray(result.rgba().data);
        postMessage({ type: "tile", id: data.id, rgba: out.buffer }, { transfer: [out.buffer] });
      } catch (error) {
        postMessage({
          type: "tile",
          id: data.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  }
});
