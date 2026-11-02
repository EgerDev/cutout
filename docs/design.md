# Cutout design system

Updated 2026-10-24 for the final polish pass. This describes what ships; change it with the
code.

## 1. Identity

A quiet, local-first photo workbench. Warm paper surfaces, ink text, one slate-blue accent,
a dominant canvas and compact, labelled tools. The photo is the subject: chrome never
competes with it, and nothing animates on its own while you work.

Personas: a first-time phone user removing one background; a keyboard-heavy desktop user
working through a batch; someone on a slow connection or with reduced motion.

Principles:

- The image is the centre. Sheets never cover the dock; on phones the stage reflows so the
  photo being adjusted stays in view.
- First use is obvious: one primary action, plain facts about privacy and the first
  download, a sample to try.
- Advanced work is one level down (labelled tools, disclosures), never hidden behind
  unlabelled icons.
- Every state is honest: loading never reads as empty, progress shows only what was
  reported, cancel says what it actually stops.

## 2. Colour

Tokens in `src/styles.css` (`@theme`, dark values under `prefers-color-scheme: dark`):

| Token                  | Light             | Dark              | Use                                                          |
| ---------------------- | ----------------- | ----------------- | ------------------------------------------------------------ |
| `bg`                   | #f3f1eb           | #10100e           | Page ground                                                  |
| `elevated` / `float`   | #fffcf7           | #1a1916 / #22211c | Fields; docks, sheets, menus                                 |
| `subtle`               | #ece8de           | #22211c           | Segmented tracks, code, notes                                |
| `fg`                   | #1c1b16           | #f3f1ea           | Text, icons                                                  |
| `muted`                | #6a685f           | #a3a095           | Secondary text, labels, values                               |
| `faint`                | #9a978c           | #6f6d64           | Decoration only, never text                                  |
| `accent` / `accent-fg` | #3d5a73 / #f7f4ee | #8aa4b8 / #10100e | Primary action, selection, focus                             |
| `ok`                   | #2f6f4e           | #8fb89a           | Done state (always with an icon or label)                    |
| `line`                 | fg 12%            | fg 12%            | Hairlines, field borders (32% with `prefers-contrast: more`) |
| `checker-a/b`          | #e7e3d8 / #f6f3eb | #5a574c / #3f3d36 | Transparency only                                            |

Measured WCAG ratios: fg/bg 15.3 (dark 16.9); muted/bg 4.95 (7.27); muted/subtle 4.57
(6.16); accent-fg/accent 6.58 (7.33); accent on float 7.06 (6.21). The accent fills one
primary action per view; selection inside a control uses a raised neutral segment or a ring
plus `aria-pressed`/`aria-checked`, never colour alone. `theme-color` follows the scheme.

## 3. Typography

One family: the system sans (`--font-sans`). No web fonts; the serif that some labels
asked for was never loaded and is gone.

| Role                            | Size / weight                                                      |
| ------------------------------- | ------------------------------------------------------------------ |
| Start-screen headline           | clamp(2.5rem, 7vw, 4.25rem) / 600, leading 1.04, tracking -0.025em |
| Reading page title              | clamp(2rem, …, 2.75rem) / 600                                      |
| Dialog title                    | 17 px / 600                                                        |
| Sheet title, header brand       | 15 px / 600                                                        |
| UI text, buttons                | 14 px / 500                                                        |
| Labels, section titles, fields  | 13 px (titles 600)                                                 |
| Values, notes, captions, badges | 12 px (the floor; nothing smaller ships)                           |
| Reading body                    | 16 px / 1.65, ~68ch measure                                        |

Numbers that change (progress, sizes, counts, dimensions) use tabular figures. Section
labels are sentence case; no uppercase eyebrows. Keycaps inherit the UI font. Monospace
only for hashes and the HEIC/licence texts.

## 4. Space, radius and layout

- Tailwind's 4 px scale. Groups tighten inside (4-8 px) and separate by 12-24 px or a
  hairline.
- Radius scale: `xs` 6 (keycaps), `sm` 8 (thumbnails), `image` 8 (the photo frame),
  `md` 12 (buttons, fields, swatches), `lg` 16 (menus), docks 18 (12 + padding), `xl` 20
  (sheets, dialogs). Pills only for small controls and the start-screen action.
- The workspace owns the viewport (`100dvh`): header, image summary, editing tools, stage,
  dock. The stage flexes with `min-height: 0`; sheets and dialogs scroll inside.
- Compact layout at ≤ 720 px or a phone user agent. Verified at 375, 390, 768, 1280,
  1440 and 844 × 390.
- East sheets (desktop) start below the header (`--sheet-top`) and end above the dock
  (`--dock-space`); the photo does not move when they open. South sheets (phones) are
  `--south-sheet-h: min(52dvh, 28rem)` tall; while one is open the frame reserves that
  height and hides the dock and batch rail, so the stage reflows above it. In short
  landscape the panel sits at the side, the stage gives up its width, and a closed panel
  leaves sideways (sliding down left its head over the stage).
- Safe-area insets pad the header, idle screen, footer, sheets and dialogs.

## 5. Components

- **Button** (`components/ui/button-variants.ts`): `primary`, `secondary` (bordered, the
  default for dialog actions), `ghost` (toolbars, row actions), `quiet`; sizes `sm` 44 px,
  `md` 48 px, `pill`, `icon` 44 px. Press scales to 0.97; disabled never scales.
- **Editing tools** (`active-workspace.tsx`): Undo, Redo | Brush, Subject, Enhance, Batch,
  each icon plus label. Compact: six equal columns, icon over label. Batch keeps the
  accessible name "Batch (N)" and shows a count badge only above one image. Hints in
  tooltips.
- **Dock** (`toolbar.tsx`, `download-menu.tsx`): Compare, Copy or Share, Download split
  (current format in one click, chevron opens "Download as"), Adjust, Info. Compact: one
  row, icon over label, 52 px tall; labels drop to screen-reader text below 360 px. Copy
  and share are announced through a polite status region.
- **Stage** (`stage.tsx`): 8 px frame, float shadow, checker under transparency only.
  Compare is a slider with `aria-valuetext` ("40% original, 60% result"); the wipe follows
  pointer and arrow keys without easing.
- **Batch rail** (`batch-strip.tsx`): vertical on desktop, one scrolling row of 48 px
  thumbnails when compact. Status badge with an icon per state (a stop mark, not the
  alert, for an image the user stopped); the active thumbnail has a 2 px accent ring and
  `aria-pressed`; arrow keys move between images.
- **Adjust** (`adjust-panel.tsx`): Background (swatches) → Edges (Feather, Expand /
  contract, View with its M shortcut) → disclosures in frequency order (Framing &
  presets, Shadow, Colours, Edge colour, Match background, Quality & file size, Removal,
  History) → quality report → export. Desktop pins export to the foot: a one-row format
  radio group, width and height, Download, Strip metadata. Reset is undoable.
- **Info** (`info-panel.tsx`): flat sections (Made with AI, Camera, Location, Image, File
  and provenance, More from the file, How it was cut out, On-device models, All metadata)
  of term/value pairs. Location adds a privacy note and an explicit external Maps link.
- **Controls**: one slider row (`edit-slider.tsx`: label, value with unit, range with
  `aria-valuetext`); fields 40 px (44 px and 16 px text on touch); swatches with an offset
  active ring; segmented radio groups with arrow keys and one tab stop
  (`radio-keys.ts`), which falls to the first offered option when the chosen one is not
  offered (a restored export format this browser can't encode) without changing the
  setting; disclosures with a drawn chevron; checkboxes in 44 px rows.
- **Dialogs** (`editor-dialog.tsx`, Radix): title, description, 44 px close, internal
  scroll, Escape closes the innermost layer first (guide popovers before the dialog),
  focus returns to the opener. Secondary action before primary; confirmations that fetch
  from elsewhere focus Cancel first. Brush and Subject apply only on Apply.
- **Models panel** (`models-panel.tsx`): rows of name, purpose or state, size or
  reported percentage, and one action (Download, Cancel, Retry, Clear) in fixed lanes; a
  download that didn't finish but left files stacks Retry (Download after a cancel) over
  Clear in the same lane, so recovering never requires deleting. A 2 px progress bar
  while a fraction is reported; at most one status note.
- **Processing capsule** (`status-capsule.tsx`): short stage label, transform progress
  bar, percentage; announced politely, from the first moment of a removal ("Preparing");
  "Queued" for an image waiting its turn. With one image, Stop is the capsule's end cap
  and turns into Retry in place, so focus stays on it. A batch keeps Stop, then Resume,
  on its status line, which always keeps 44 px of height. A Stop that turns into Retry
  or Resume ignores presses for 500 ms, so a double-click cannot undo it.
- **Start screen** (`idle-screen.tsx`): headline; Choose files (and Take photo on phones,
  "or drop images anywhere" otherwise); formats and the 15-image limit; paste shortcut;
  Try a sample and On-device models; "Photos stay on this device. The first cut
  downloads a 90-192 MB model once."
- **Reading pages** (`doc-page.tsx`): brand, section navigation with the current page
  marked, "Back to Cutout", title, lede, sections divided by hairlines; tables share one
  style. Not found and crash pages share the theme and offer a way out.

## 6. Motion

Tokens: `--motion-quick` 150 ms, `--motion-fast` 250 ms, `--motion-sheet` 220 ms (in) /
160 ms (out), `--ease-out` cubic-bezier(0.22, 1, 0.36, 1), `--ease-sheet`
cubic-bezier(0.32, 0.72, 0, 1). CSS only; no animation library.

- Animate only what explains a change: sheets slide (interruptible transitions), menus
  grow from their trigger (scale 0.97 + opacity), dialogs and scrims fade, a new image
  settles in (scale 0.97 + opacity), progress moves by `scaleX`.
- Never animate high-frequency or keyboard actions: compare nudges, undo/redo, tool
  switches, zoom, brush strokes.
- The start screen's staggered entrance (300 ms, 4 px blur, 8 px rise, 60-180 ms
  offsets) is the one authored moment. Nothing loops except activity indicators while
  work runs: the sheen inside a progress bar and a working batch thumbnail's spinner.
- Hover styles only for hover-capable fine pointers; presses respond on `:active`.
- `prefers-reduced-motion`: movement, scale and blur are removed; sheets, menus, dialogs
  and the start screen crossfade (150 ms) instead of popping, and progress bars step to
  each value instead of easing.

## 7. Accessibility

WCAG 2.2 AA target: visible 2 px accent focus rings, 44 px touch targets, named icon
controls, pressed/checked/expanded states exposed, radio groups and menus on the APG key
maps, dialogs trapping and returning focus, Escape layering, shortcuts suppressed while
typing, Space peek never stealing a focused button's activation, one polite status per
update (no announcement per progress tick), no colour-only status, 16 px editable text on
touch, pinch zoom kept, no horizontal page overflow at 320 px, text that survives 200 %.

A toggle keeps its label and `aria-pressed` carries the state (Batch's Skip ZIP names its
image). A control that disappears while focused (Stop or Retry when the cutout finishes, a
notice's Retry or Dismiss) hands focus to what comes next: Stop or Retry, the batch's Stop
or Resume, Download, else the workspace heading. Under forced colours (Windows contrast
themes) pressed and checked controls use `Highlight`/`HighlightText`, rings and progress
use system colours, and swatches, the checker and the mask keep their own colours.

## 8. Writing

British English, as in the site prose (colour, centre, licence). Plain verbs on buttons;
errors say what happened and what to do; cancel copy says what it stops ("Stopped
waiting. The model may finish preparing in the background."). Something the user
stopped reads "Stopped", never "Failed", and is not an alert. Sizes are measured
download sizes at the pinned revisions, given as ranges where routes differ.

## 9. Feature and state inventory

| Family                     | Where                                                                                        | Store/API                                                                                                                             | States designed                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry and ingest           | `idle-screen.tsx`, `workspace.tsx`, `use-workspace-drop.ts`, `drop-layer.tsx`                | `receiveFiles`, `reportError`                                                                                                         | idle, drag-over (drop / replace), sample loading, unsupported browser, invalid file error, replace confirmation                                                                                                                           |
| Launch links               | `launch-confirm.tsx`, `use-launch-params.ts`                                                 | `url-api.ts`                                                                                                                          | host confirmation, auto-download confirmation, cancel                                                                                                                                                                                     |
| Queue and batch            | `batch-strip.tsx`, `batch-manager.tsx`, `active-workspace.tsx` (summary)                     | `selectItem`, `retryItem`, `cancelProcessing`, `removeItem`, `toggleExcluded`, `applySelected`, `matchFraming`, `applyPresetSelected` | queued, working, done, error with Retry, stopped (Stop / Resume on the status line, finished cutouts kept, Retry per image), long names (truncated with full name), quality checking / warnings / unavailable, export progress and cancel |
| Removal                    | `status-capsule.tsx`, Adjust → Removal                                                       | `setRemovalMode`, `reprocessActive`, `cancelProcessing`, `retryItem`                                                                  | preparing, queued, finding subject, cleaning edges, compatibility mode, done, failed + Retry, Stop, stopped + Retry (a Retry right after Stop waits for the old run and keeps its own result)                                             |
| Canvas                     | `stage.tsx`, `check-areas-overlay.tsx`                                                       | `setComparing`, `setPeeking`, `cycleInspectMode`, `setShowGuides`, `setShowCheckAreas`                                                | result, compare slider, peek, mask/edge/on-white/on-black views, guides, areas checking / none / failed + Retry, preview updating                                                                                                         |
| Manual refinement          | `brush-editor.tsx`, `subject-editor.tsx`                                                     | `replaceResult`, draft strokes                                                                                                        | preparing, erase/restore, size/softness, zoom/pan, show original, undo/redo, apply/cancel, pointer cancel                                                                                                                                 |
| Edges and colour           | Adjust → Edges, Colours, Edge colour, Match background                                       | `setFeather`, `setChoke`, `changeEdit`                                                                                                | values with units, reading colours / none found / failed + Retry, 24-rule limit                                                                                                                                                           |
| Background and composition | `background-controls.tsx`, Adjust → Framing, Shadow                                          | `setBackground`, `setCustomColor`, `setBackgroundImage`, `setPreset`, `changeEdit`                                                    | none, white, black, colour, blur (+ depth note), gradient, image, presets, transform, contact/cast shadow                                                                                                                                 |
| Enhancement                | `enhance-editor.tsx`                                                                         | `enhanceActive`, `cancelEnhance`                                                                                                      | scale choice, print target, keep cutout, running with progress, stopping, already enhanced, not available                                                                                                                                 |
| History                    | Editing tools, Adjust → History                                                              | `undo`, `redo`, `jumpBack`                                                                                                            | empty, named steps, redo count                                                                                                                                                                                                            |
| Export                     | `download-menu.tsx`, `export-fields.tsx`, `export-estimate.tsx`                              | `downloadActive`, `setExportFormat`, `setExportSize`, `downloadVector`                                                                | one-click format, format menu, chosen format not offered (first offered radio holds the Tab stop), JPG transparency note, size target met / not met, exact-preview download, exporting, saved                                             |
| Copy and share             | Dock, `share-ready-dialog.tsx`                                                               | `copyActive`                                                                                                                          | copied / shared (announced), share-ready continuation, download fallback                                                                                                                                                                  |
| Metadata                   | `info-panel.tsx`, export foot                                                                | `setStripMetadata`, `downloadOriginal`                                                                                                | reading, none, AI, camera, location (privacy note), all fields filter / no match, copy                                                                                                                                                    |
| Saved workspace            | `session-controls.tsx`                                                                       | session snapshot API                                                                                                                  | off, saving, saved, not saved (reason), resume, delete (confirm), paused                                                                                                                                                                  |
| Models                     | `models-panel.tsx`, `models-dialog.tsx`, Info                                                | `prepareModel(id, onProgress, { signal })`, cache APIs                                                                                | cached size, uncached range, starting, reported %, cancelled, timed out + Retry, failed + Retry, unfinished with files kept (Retry over Clear), download all (partial, cancel), clear, keep request, cache unavailable, insecure address  |
| Site and help              | `app-header.tsx`, `site-rail.tsx`, `doc-page.tsx`, routes, `shortcut-help.tsx`, status pages | router                                                                                                                                | current page, grouped shortcuts, guide, library, privacy, terms, licenses, not found, crash with reload                                                                                                                                   |

## 10. Sample and share card

`public/sample.jpg` is a generated photograph (provenance in `public/CREDITS.md`).
`node scripts/render-sample-assets.mjs` derives `sample-thumb.webp` and a text-free
`og.jpg` from Cutout's own cut of the sample (the compare moment on the paper ground with
the mark). Those two outputs reproduce byte-for-byte. The CSP suite's HEIC fixture was
encoded separately with macOS ImageIO; its command and identity are recorded in
`public/sample-provenance.md`.
