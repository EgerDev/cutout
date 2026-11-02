/**
 * Every model the browser downloads at runtime, at the revision the code pins.
 * One list feeds the Models panel (models.ts), the /licenses page and
 * THIRD_PARTY_NOTICES.txt; scripts/third-party-notices.test.mjs fails when it
 * drifts from the ids and revisions in the code. Weights are never bundled.
 */
export type ModelGroup = "birefnet" | "swin2sr-x2" | "swin2sr-x4" | "depth";

export type ModelNotice = Readonly<{
  /** Hugging Face repository the weights are fetched from. */
  id: string;
  revision: string;
  group: ModelGroup;
  use: string;
  /** As declared by the publisher of `id`; "Not stated" when the repository declares none. */
  licence: string;
  /** The work `id` was converted from, and its licence. */
  upstream: string;
  note?: string;
}>;

export const MODEL_NOTICES: readonly ModelNotice[] = [
  {
    id: "studioludens/birefnet-lite-512",
    revision: "4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7",
    group: "birefnet",
    use: "Background removal (loaded by Cutout's removal engine via Transformers.js)",
    licence: "MIT",
    upstream: "ZhengPeng7/BiRefNet_lite (MIT)",
  },
  {
    id: "imgly/isnet-general-onnx",
    revision: "440dea96dd4a3b06bbbf5abec3e26569dd7ec49f",
    group: "birefnet",
    use: "Background removal on low-memory devices without WebGPU",
    licence: "MIT",
    upstream: "ISNet general-use weights from xuebinqin/DIS (Apache License 2.0)",
    note: "The repository declares MIT; the ISNet weights it converts were published under the Apache License 2.0.",
  },
  {
    id: "Xenova/swin2SR-lightweight-x2-64",
    revision: "92a21aca5713f20faf9a87590cdfbdce2e34112c",
    group: "swin2sr-x2",
    use: "Enhance 2×",
    licence: "Not stated",
    upstream: "caidas/swin2SR-lightweight-x2-64 (Apache License 2.0), Swin2SR by mv-lab",
  },
  {
    id: "Xenova/swin2SR-compressed-sr-x4-48",
    revision: "7d3f2242026e00cbd998056c2a11e200fce198a7",
    group: "swin2sr-x4",
    use: "Enhance 4×",
    licence: "Not stated",
    upstream: "caidas/swin2SR-compressed-sr-x4-48 (Apache License 2.0), Swin2SR by mv-lab",
  },
  {
    id: "onnx-community/depth-anything-v2-small",
    revision: "4472b7362082ad9968fee890ca0f1e5aca36b93d",
    group: "depth",
    use: "Depth-aware background blur",
    licence: "Apache License 2.0",
    upstream: "depth-anything/Depth-Anything-V2-Small (Apache License 2.0)",
  },
];

export const modelUrl = (id: string) => `https://huggingface.co/${id}`;
