import type { ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { DocPage, DocSection } from "@/features/site/doc-page";
import { docHead } from "@/features/site/doc-head";

export const Route = createFileRoute("/guide")({
  head: () =>
    docHead(
      "Guide",
      "How to open images in Cutout, remove and refine backgrounds, frame and export the result, work on several images, save a workspace, and which browsers are supported.",
    ),
  component: Guide,
});

function Guide() {
  return (
    <DocPage
      title="Guide"
      subtitle="Open a photo, remove its background, refine the edge, then frame and export it. Everything happens in this browser, on this device."
    >
      <DocSection title="Open images">
        <p>
          Choose files, drop them anywhere on the page, or paste with <Keys k="⌘ V" /> or{" "}
          <Keys k="Ctrl V" />. Up to 15 images open at once. On a phone, <strong>Take photo</strong>{" "}
          opens the camera.
        </p>
        <p>
          Cutout opens PNG, JPEG, WebP, AVIF, GIF, BMP, HEIC and HEIF, TIFF up to 50 MB and SVG.
          From PDF, DXF, DWG and SketchUp files it uses the embedded image or preview. The{" "}
          <a href="/library">Library</a> explains how each format is read.
        </p>
      </DocSection>

      <DocSection title="Remove the background">
        <p>
          Removal starts as soon as an image opens. Photos go through an on-device neural network;
          the first one downloads the model (about 90–192 MB, depending on the device) into your
          browser’s cache. Flat art on a plain backdrop, such as logos, scans and clip art, uses a
          faster colour key with crisp anti-aliased edges. <strong>Info</strong> shows which method
          ran. <strong>Stop</strong>, on the progress bar, ends a removal; <strong>Retry</strong>{" "}
          starts it again.
        </p>
        <p>
          Under <strong>Adjust → Removal</strong> you can choose how much detail to work for:{" "}
          <strong>Quick</strong> is one pass, <strong>Auto</strong> also refines small subjects and{" "}
          <strong>Maximum detail</strong> uses extra crops. <strong>Reprocess this image</strong>{" "}
          applies the new choice.
        </p>
      </DocSection>

      <DocSection title="Fix what the cutout got wrong">
        <dl>
          <div>
            <dt>Subject</dt>
            <dd>
              Click a piece to remove it, click it again to bring it back, or drag across specks to
              clean several up at once. <strong>Keep largest</strong> keeps only the main piece.{" "}
              <strong>Fix area</strong> re-cuts a box you draw at full detail.
            </dd>
          </div>
          <div>
            <dt>Brush</dt>
            <dd>
              <strong>Erase</strong> paints away anything left behind; <strong>Restore</strong>{" "}
              paints back pixels from your photo, which shows faded underneath. Size is in pixels of
              your image (<Keys k="[" /> and <Keys k="]" />
              ), and a soft edge blends into hair and fur. With a stylus, a lighter touch starts a
              thinner stroke. Zoom up to 800% where you point and hold <Keys k="Space" /> to move
              around.
            </dd>
          </div>
          <div>
            <dt>Edges</dt>
            <dd>
              <strong>Feather</strong> softens the edge and <strong>Expand / contract</strong> grows
              or shrinks it. <strong>Edge colour</strong> removes the old background’s tint from the
              rim, such as a green fringe after a green wall.
            </dd>
          </div>
        </dl>
        <p>
          Brush and Subject change nothing until you choose <strong>Apply</strong>;{" "}
          <strong>Cancel</strong> throws the session away. To judge an edge, cycle the view with{" "}
          <Keys k="M" /> (on white, on black, red overlay, mask, edge band), hold <Keys k="Space" />{" "}
          to see the original, or use <strong>Compare</strong>.
        </p>
      </DocSection>

      <DocSection title="Change the background and frame it">
        <p>
          In <strong>Adjust</strong>, the background can stay transparent or become white, black,
          any colour, a two-colour gradient, a blurred copy of the photo (optionally depth-aware, so
          nearby surfaces stay sharper) or an image of your own.
        </p>
        <p>
          <strong>Framing &amp; presets</strong> fits the subject to a canvas with adjustable
          padding and position: square, 4:5, 16:9, story, passport photo, product (1600 px), profile
          (512 px), transparent asset (1024 px), Amazon, Etsy and eBay, or trimmed to the subject.
          It also scales, rotates and flips, and <Keys k="G" /> shows centre and thirds guides.{" "}
          <strong>Shadow</strong> adds a contact or cast shadow, and <strong>Colours</strong>{" "}
          recolours or keys out any colour of the cutout.
        </p>
      </DocSection>

      <DocSection title="Make a small image bigger">
        <p>
          <strong>Enhance</strong> enlarges an image 2× or 4× on your device. 2× suits clean images;
          4× also cleans up small or heavily compressed photos and needs a one-time download of up
          to 55 MB. If you plan to print, choose the size and Enhance makes the image just big
          enough for it.
        </p>
      </DocSection>

      <DocSection title="Download, copy and share">
        <ul>
          <li>
            <strong>Download</strong> saves the current format in one click; the arrow next to it
            picks another. PNG, WebP, JPG and BMP always work, AVIF and HEIC where your browser can
            encode them, and SVG for flat art.
          </li>
          <li>
            <strong>Adjust</strong> sets the size (up to 4096 px a side), the quality and, under{" "}
            <strong>Quality &amp; file size</strong>, a size limit in kilobytes. Preview export
            checks the exact file before you save it.
          </li>
          <li>
            <strong>Copy</strong> puts the cutout on the clipboard; on phones,{" "}
            <strong>Share</strong> sends it to another app. On a computer you can also drag the
            cutout straight off the canvas.
          </li>
          <li>
            Exports are new images. <strong>Strip metadata</strong> also checks each one for
            leftover data and, when your original carries location, camera or date details, offers{" "}
            <strong>Download original, cleaned</strong>. PNG, JPEG and WebP keep their pixels; other
            formats are saved as PNG. If a file can’t be cleaned, nothing is saved.
          </li>
        </ul>
      </DocSection>

      <DocSection title="Work on several images">
        <p>
          With more than one image open, thumbnails show each one’s progress and you can switch
          between them while the rest are processed. <strong>Batch</strong> applies one image’s
          settings or a preset to a selection, matches framing, retries failures and downloads a ZIP
          (up to 200 MB), a labelled contact sheet or a sprite sheet with a JSON atlas. It can leave
          out images whose quality check found problems. <strong>Stop</strong>, beside the count
          above the image, stops the rest of a batch and keeps the finished cutouts;{" "}
          <strong>Resume</strong> carries on.
        </p>
      </DocSection>

      <DocSection title="Undo and history">
        <p>
          Every edit can be undone with <Keys k="⌘ Z" /> or <Keys k="Ctrl Z" />, up to 40 steps.
          Dragging a slider counts as one step. <strong>Adjust → History</strong> names each step so
          you can jump back several at once. Removal itself and opening new images are not undo
          steps.
        </p>
      </DocSection>

      <DocSection title="Save for later">
        <p>
          <strong>Save workspace</strong> keeps one workspace in this browser on this device: your
          original files (with any location or camera details they contain), results and settings,
          up to 15 images and 250 MB. Nothing is uploaded or synced. Next time, open{" "}
          <strong>Saved workspace</strong> and choose <strong>Resume saved workspace</strong>, or
          delete it from the same dialog. Browsers can clear this storage, so keep downloads of
          anything important.
        </p>
      </DocSection>

      <DocSection title="Open Cutout from a link">
        <p>
          Other tools can start Cutout with an image and settings, for example{" "}
          <code className="break-all">
            ?src=https://…&amp;preset=amazon&amp;format=webp&amp;bg=white&amp;download=1
          </code>
          . For an image on another site, or a link that downloads automatically, Cutout shows the
          site and asks first. The address must use HTTPS, the site must allow cross-origin access,
          SVG is refused and files over 50 MB are refused.
        </p>
      </DocSection>

      <DocSection title="Browsers and offline use">
        <p>
          Cutout needs a current Chrome, Edge or Firefox, or Safari 16.4 or later (including iPhone
          and iPad). It uses the graphics card through WebGPU where it can and WebAssembly
          otherwise, so speed depends on the device. Browsers that can’t run it show a notice
          instead of downloading anything.
        </p>
        <p>
          Once the models are downloaded, an open tab keeps working offline. A new visit or a reload
          needs the network. <strong>On-device models</strong>, on the start screen and in Info,
          downloads models ahead of time or clears them to free space.
        </p>
      </DocSection>

      <DocSection title="Keyboard shortcuts">
        <div className="doc-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Keys</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map(([action, keys]) => (
                <tr key={action}>
                  <td>{action}</td>
                  <td>{keys}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Shortcuts pause while you type in a field. In Brush, <Keys k="E" /> erases, <Keys k="R" />{" "}
          restores and <Keys k="X" /> switches between them.
        </p>
      </DocSection>
    </DocPage>
  );
}

function Keys({ k }: { k: string }) {
  return <kbd className="keycap">{k}</kbd>;
}

const SHORTCUTS: readonly (readonly [string, ReactNode])[] = [
  ["Choose images", <Keys key="o" k="⌘/Ctrl O" />],
  ["Paste an image", <Keys key="v" k="⌘/Ctrl V" />],
  ["Copy the cutout", <Keys key="c" k="⌘/Ctrl C" />],
  ["Download in the current format", <Keys key="s" k="⌘/Ctrl S" />],
  ["Undo", <Keys key="z" k="⌘/Ctrl Z" />],
  ["Redo", <Keys key="sz" k="⌘/Ctrl Shift Z" />],
  ["See the original while held", <Keys key="sp" k="Space" />],
  ["Image information", <Keys key="i" k="I" />],
  ["Next view (white, black, mask…)", <Keys key="m" k="M" />],
  ["Centre and thirds guides", <Keys key="g" k="G" />],
  ["Close the open panel", <Keys key="esc" k="Esc" />],
  ["All shortcuts", <Keys key="q" k="?" />],
];
