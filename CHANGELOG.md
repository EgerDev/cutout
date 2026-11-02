# Changelog

All notable changes to Cutout are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - unreleased

First public release.

### Added

- Background removal in the browser (BiRefNet lite, or ISNet on low-memory devices without
  WebGPU), with a colour-key path for flat art.
- Brush, subject pieces, colour edits, backgrounds, shadows, framing
  presets, enhance (2× and 4×), history.
- Exports to PNG, JPEG, WebP, BMP, AVIF and HEIC (where the browser can encode them) and
  SVG for flat art; ZIP batches, contact sheets and sprite sheets.
- Optional saved workspace in the browser.
- URL launch parameters (`?src=`, `preset`, `format`, `bg`, `download`, `name`).
- MIT licence for original application/engine code, scoped third-party notices,
  corresponding codec/metadata source, security policy and contribution guide.
- New AI-generated sample photograph with traceable derivatives, including the
  HEIC test fixture; share card generated from Cutout's actual result.

### Changed

- A consistent workbench across editing tools, dialogs, export and image information;
  labelled mobile actions and sheets that keep the image visible.
- Task-based guide and reference pages, keyboard-operable export choices, clearer
  loading states, and motion that respects reduced-motion settings.
- Complete source SBOM includes the server build graph; Nitro's optional cache peer
  now resolves without invalid dependency entries.

### Fixed

- Model preparation has a bounded wait and caller cancellation, with safe retries
  and late-result disposal. Cancelling the wait preserves work used by another caller.
- Stop background removal without discarding finished cutouts, then Retry or Resume
  stopped images. Late results cannot replace a requested retry.
- Partial model downloads retain their Retry action and valid cached files; saved or
  linked formats unavailable in the current browser keep a keyboard entry to the format picker.
- Depth preparation skips unsupported fp16 on compatible WebGPU adapters.
- Depth recovers from failed or hung page-runtime initialization in a fresh worker,
  preserving its dtype fallback order and bounded session ownership.
- Linux CI distinguishes its ten named opt-in integrity cases from required tests;
  the strict real-model lane propagates its profile and environment explicitly.
- Third-party notices cover the generated server framework and its runtime versions.
- Corresponding-source archives download with their exact compressed bytes and correct MIME;
  generated route manifests use portable relative paths.
- Narrow Batch rows keep actions clear of names, and reduced-motion progress fills stop easing.
- Forced-colour themes retain selection and progress marks; Batch ZIP toggles keep a stable name that identifies their image.
- Retry and Dismiss hand keyboard focus to the next workspace action when their button disappears.
- Photographs no longer keep faint floor/contact shadows as a halo around subjects
  (e.g. under chair legs and caster wheels): partial-alpha pixels that are a
  near-uniform darkening of the local backdrop in a flat area are attenuated.
  Scans and flat art are unaffected.

### Security

- Updated Zod and the affected URI/Lighthouse tooling dependencies within compatible
  ranges. Oversized saved workspaces are rejected before visiting their items.
- Removing metadata fails closed: if Cutout cannot clean a file, nothing is saved.
- SVG files are rasterised before use.
- Drawing and TIFF parsers have size and work limits.
- Links that load an image from another site ask for confirmation first.
- The server sends a Content-Security-Policy and answers unsupported methods with 405.

- Description-based selection is unavailable pending confirmation of model-weight permissions.
