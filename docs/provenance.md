# Code, model and asset provenance

Reviewed during release preparation. This records distribution
evidence and open decisions; an SPDX label alone is not proof of ownership.

## Application license and scope

The owner requested MIT for eligible original Cutout application code, including
the independently implemented removal engine. `LICENSE`, package metadata, the
site and generated notices reflect that grant. Dependencies, vendored source,
model weights and third-party artwork keep their own terms. Previous Apache-2.0
grants remain valid; `public/third-party/Apache-2.0.txt` preserves the prior text.

The application grant covers the owner's eligible original work. It does not
establish ownership of dependency code, external artwork or model weights.
DCO sign-offs certify contributions rather than transferring copyright.
AI-assisted/generated code alone does not establish rights to third-party
templates or assets. Required third-party and historical notices are retained.

## Distribution inventory

| Component / exact version or revision                                         | Origin and declared terms                                                                                                                                                                                      | Changes / distributed form                                                                           | Required evidence and status                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Original Cutout application and removal engine                                | Owner's code; MIT                                                                                                                                                                                              | TypeScript, workers, built client/server                                                             | Root LICENSE and NOTICE; runtime/import/network independence regressions retained. Earlier BG0 acknowledgment retained; no BG0 source used in this work.                                                       |
| Transformers.js 3.8.1                                                         | [Hugging Face](https://github.com/huggingface/transformers.js/tree/3.8.1); Apache-2.0                                                                                                                          | Install-time model-buffer verification and rejected-inference-chain recovery patches; browser chunks | Exact patches in `scripts/patch-dependencies.mjs`; package license/notices included in generated notices.                                                                                                      |
| ONNX Runtime Web 1.22.0-dev.20250409-89f8206ba4                               | [89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0](https://github.com/microsoft/onnxruntime/tree/89f8206ba4f1c22c39e0297fb55272e8ce8cd7d0); MIT plus compiled third-party notices                                      | GatherND shader-index patches in installed JS; browser WASM/JS                                       | Patch script, `scripts/data/onnxruntime-{LICENSE,ThirdPartyNotices}.txt`, generated notices. Node runtime override is separate.                                                                                |
| ExifReader 4.45.0                                                             | [Exact npm source](https://registry.npmjs.org/exifreader/-/exifreader-4.45.0.tgz); MPL-2.0                                                                                                                     | Unmodified source bundled for metadata                                                               | Exact package including `src/` and LICENSE served at `/third-party/source/exifreader-4.45.0.tgz`; SHA-512 matches lockfile; SHA-256 `8e082955b0974d78dca9ba632b11e441f551d7a67c96204619a6a778870f8b07`.        |
| heic-to 1.5.2, libheif 1.23.5, libde265 1.1.3                                 | [heic-to](https://github.com/hoppergee/heic-to), [libheif](https://github.com/strukturag/libheif), [libde265](https://github.com/strukturag/libde265); LGPL-3.0-or-later                                       | Separate rebuilt CSP asm.js decoder, two Emscripten compatibility patches                            | Corresponding source archives, hashes, patches, pinned build recipe and replacement/relink instructions in `public/third-party/source/BUILD.md`; LGPL/GPL texts served. No rebuild claimed during Docker hold. |
| BiRefNet lite conversion `4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7`           | [studioludens/birefnet-lite-512](https://huggingface.co/studioludens/birefnet-lite-512/tree/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7); publisher MIT; upstream ZhengPeng7/BiRefNet_lite MIT                    | Pinned downloaded weights/config; unmodified                                                         | Revisions and byte hashes in removal-model specs; publisher and upstream remain distinct.                                                                                                                      |
| ISNet conversion `440dea96dd4a3b06bbbf5abec3e26569dd7ec49f`                   | [imgly/isnet-general-onnx](https://huggingface.co/imgly/isnet-general-onnx/tree/440dea96dd4a3b06bbbf5abec3e26569dd7ec49f); publisher MIT; [DIS upstream](https://github.com/xuebinqin/DIS) Apache-2.0          | Pinned downloaded weights/config; unmodified                                                         | Preserve both declarations and upstream obligations. This is the model repository, not a separate IMG.LY software-package license.                                                                             |
| Swin2SR ×2 conversion `92a21aca5713f20faf9a87590cdfbdce2e34112c`              | [Xenova/swin2SR-lightweight-x2-64](https://huggingface.co/Xenova/swin2SR-lightweight-x2-64/tree/92a21aca5713f20faf9a87590cdfbdce2e34112c); publisher license not stated; upstream caidas/mv-lab Apache-2.0     | Unmodified runtime download; not bundled                                                             | **OPEN:** base-model attribution is present, but does not establish an explicit license grant for this pinned converted artifact. Do not invent a publisher declaration or mirror it as cleared.               |
| Swin2SR ×4 conversion `7d3f2242026e00cbd998056c2a11e200fce198a7`              | [Xenova/swin2SR-compressed-sr-x4-48](https://huggingface.co/Xenova/swin2SR-compressed-sr-x4-48/tree/7d3f2242026e00cbd998056c2a11e200fce198a7); publisher license not stated; upstream caidas/mv-lab Apache-2.0 | Unmodified runtime download; not bundled                                                             | **OPEN:** same converted-artifact provenance decision as ×2. Preserve advertised feature and model pins while preparing the candidate.                                                                         |
| Depth Anything V2 Small conversion `4472b7362082ad9968fee890ca0f1e5aca36b93d` | [onnx-community/depth-anything-v2-small](https://huggingface.co/onnx-community/depth-anything-v2-small/tree/4472b7362082ad9968fee890ca0f1e5aca36b93d); Apache-2.0; upstream Depth-Anything-V2-Small Apache-2.0 | Unmodified runtime download                                                                          | Small variant only; other variants' terms are not interchangeable. Optional-model bytes are outside the removal-integrity wrapper.                                                                             |
| Remaining npm production closure and Nitro server/build closure               | Exact versions/integrities in `package-lock.json`; each package's own declared license                                                                                                                         | Browser modules, generated server code and build tools as identified in notices                      | `public/third-party/THIRD_PARTY_NOTICES.txt` includes Nitro 3.0.260610-beta and its separately locked h3/rou3/srvx runtime versions, with package copyright/license text. No global Apache-to-MIT replacement. |
| Mark, icons, sample, share card and fonts                                     | See `public/CREDITS.md` and `public/sample-provenance.md`                                                                                                                                                      | Generated sample, deterministic thumbnail/share card and HEIC fixture; system/local fonts            | Current sample derivatives have recorded origins and byte hashes. Thumbnail/share card independently reproduced byte-for-byte. No font used in the share card. This record does not license former assets.     |

Model files are downloaded separately; they do not become MIT through use by Cutout.
Removal-file byte verification proves identity, not the provenance or safety of a
neural model. A local model mirror is a distribution decision and must retain the
corresponding upstream obligations. No model pin changes are part of this migration.

## Source snapshot and remaining model decisions

The publication snapshot contains the current application, tests, development
documentation, generated project assets and required third-party materials. It
excludes private development history, internal orchestration/audit records and
restricted benchmark datasets. Those records remain private; this cleanup does
not relicense them or resolve credentials retained in the original private history.

The current `scripts/fixtures/sample.heic` derives from the generated sample in
`public/sample-provenance.md`. No former sample or historical benchmark copy is
included in this source snapshot.

The two pinned Xenova Swin2SR conversion-license decisions in the table remain
open. Upstream terms and publisher metadata are recorded separately. Preserve
their exact revisions and required notices; do not describe an unstated publisher
license as an established grant or redistribute a mirror as cleared. This source
cleanup does not resolve that question or change the models the app downloads.

Before publication, review the exact source/output archive contents, notices,
checksums and verification scope. Packaging a clean snapshot does not authorize
publishing a repository, release or deployment. See
[release-status.md](release-status.md) for the current disposition.
