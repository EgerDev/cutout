# Release candidate status

The source is public at <https://github.com/EgerDev/cutout>, published as one squashed
snapshot of the private development tree. No version has been tagged or released, and
production hosting has not been set up.

## Verification scope

The product baseline is `620bdad67eeed18dbfe1435951ab202b760c7651`, a commit in the private
development repository. It includes
the verified application and subsequent test-harness portability fixes. Publication
cleanup preserves application code, model/runtime pins, lockfile, test assertions
and third-party source/notices. Its own source/build identity is recorded separately
from the earlier platform receipts.

| Environment                               | Recorded result and limits                                                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native macOS arm64, Apple hardware WebGPU | Clean install/build/server and relevant browser suites passed. All ten named integrity cases passed. The retained-session removal-to-depth workload completed within the declared 6 GiB budget. Installed Safari automation and VoiceOver speech were unavailable.                                                      |
| Linux x86_64 containers                   | Unit/server and supported browser scopes, model mirror, production Caddy stack, local restart/rollback and artifact checks were exercised. WPE-WebKit renderer/codec stress crashes and missing fp16 hardware remain recorded environment limits; the complete Linux matrix is not described as an exception-free pass. |
| Native Windows x64                        | Native build/server and Chromium scopes passed. GPU-less fp16 cases, Windows WebKit without OffscreenCanvas, missing HEIC/AVIF encoders and speech capture without an audio endpoint remain limitations.                                                                                                                |
| External HTTPS site                       | A deployment on the intended domain/operator configuration has not been verified. Local container HTTPS/restart/rollback evidence does not establish external hosting.                                                                                                                                                  |

The integrated verification reported 1,118 strict units, with additional focused
harness regression checks. Raw platform logs and private datasets are retained
outside the source distribution. Emulation, software WebGPU and accessibility-tree
inspection are narrower evidence than physical hardware or spoken assistive
technology. Codec exports remain capability-gated.

## Source and license scope

Eligible original application/engine code is MIT. Third-party software, model
weights, codec/metadata corresponding sources and notices retain their own terms.
The current generated sample and its thumbnail/share-card/HEIC derivatives have
recorded provenance. See [provenance.md](provenance.md), root `NOTICE`, and
`public/sample-provenance.md`.

The exact Xenova Swin2SR 2×/4× converted-model publisher terms remain unresolved.
The app downloads those pinned weights separately; this source snapshot does not
bundle them, invent a publisher license, or clear model redistribution.

Publication snapshots exclude original private Git history, internal audit/agent
records and restricted benchmark material. The original private repository and
evidence remain preserved. A clean snapshot does not revoke a credential from old
history or authorize making that original repository public.

## Release and hosting

Tests and artifact packaging can run outside GitHub Actions. Hosted CI runs on the public
repository. On its Linux runners WPE WebKit can crash mid-test in the export, ingest and
route suites; a WebKit leg that crashes is reported as skipped, and every leg that stays
up is asserted as usual. No release, signature or GitHub-generated attestation exists yet.

A release needs an exact source/build identity, source/output archives, full
source/build SBOM, checksums, accurate notes and final publication authorization.
Do not push a version tag merely to prepare one: the existing version-tag workflow
attempts publication. This cleanup does not execute it.

For a hosted copy, follow [DEPLOYMENT.md](../DEPLOYMENT.md), set the intended
build-time origin/operator/contact/model-host values, and verify the actual HTTPS
site before launch. No paid CI service is required for local use or verification.
