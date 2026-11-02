import { createFileRoute } from "@tanstack/react-router";
import { DocPage, DocSection } from "@/features/site/doc-page";
import { docHead } from "@/features/site/doc-head";

const FORMATS = [
  ["PNG", ".png", "Your browser's decoder"],
  ["JPEG", ".jpg, .jpeg, .jfif", "Your browser's decoder"],
  ["WebP", ".webp", "Your browser's decoder"],
  ["AVIF", ".avif", "Your browser's decoder (8-bit colour)"],
  ["GIF", ".gif", "Your browser's decoder; first frame only"],
  ["BMP", ".bmp", "Your browser's decoder"],
  [
    "HEIC / HEIF",
    ".heic, .heif, .hif",
    "Your browser's decoder where it has one (Safari); otherwise heic-to (libheif) in the page",
  ],
  [
    "TIFF / BigTIFF",
    ".tif, .tiff",
    "UTIF (utif2) in a background worker. A TIFF larger than this device's pixel budget is refused as too large for this device instead of being decoded.",
  ],
  ["SVG", ".svg", "Drawn to a PNG by your browser before anything else uses it"],
  [
    "PDF",
    ".pdf",
    "Uses the largest image embedded in the file. PDFs that contain only vector drawings or text can't be opened.",
  ],
  [
    "DXF",
    ".dxf",
    "Drawn on your device with dxf-parser. Files over 20 MB and very complex drawings (over 1,000,000 points or 100,000 block inserts) are refused with a message.",
  ],
  ["DWG, SketchUp", ".dwg, .skp", "Uses the preview image saved inside the file"],
] as const;

const PRESETS = [
  ["Product", "1600 × 1600 px", "White background, 10% margin around the subject."],
  ["Profile", "512 × 512 px", "Transparent background, 16% margin, for avatars."],
  ["Transparent asset", "1024 × 1024 px", "Transparent background, 10% margin."],
  ["Amazon · Etsy", "2000 × 2000 px", "White background, 8% margin."],
  ["eBay", "1600 × 1600 px", "White background, 8% margin."],
  [
    "Passport photo",
    "413 × 531 px",
    "35 × 45 mm at 300 dpi on white, head placed above centre, saved as JPEG.",
  ],
  ["Original size", "Source size", "Keeps the dimensions and aspect ratio of your image."],
] as const;

export const Route = createFileRoute("/library")({
  head: () =>
    docHead(
      "Formats & presets",
      "Which image and drawing formats Cutout opens and how, the framing presets, the export formats, and how removal works on your device.",
    ),
  component: Library,
});

function Library() {
  return (
    <DocPage
      title="Formats & presets"
      subtitle="What Cutout can open and how it reads each format, the framing presets, the export formats, and how background removal works."
    >
      <DocSection title="Formats Cutout opens">
        <p>
          Every file is read on your device. You can open up to 15 files at a time. Very large
          images are scaled down to what your device can process: about 96 megapixels on a computer,
          less on phones and devices with little memory. PDF, DWG and SketchUp files over 50 MB, and
          DXF files over 20 MB, are refused.
        </p>
        <div className="doc-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Format</th>
                <th scope="col">Extensions</th>
                <th scope="col">How it is read</th>
              </tr>
            </thead>
            <tbody>
              {FORMATS.map(([format, extensions, decoder]) => (
                <tr key={format}>
                  <th scope="row">{format}</th>
                  <td>{extensions}</td>
                  <td>{decoder}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection title="Framing presets">
        <p>
          Presets place the cutout in a fixed canvas, centred with a margin. Square, 4:5, 16:9, 9:16
          and &ldquo;Trim to subject&rdquo; are also available in Adjust.
        </p>
        <div className="doc-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Preset</th>
                <th scope="col">Size</th>
                <th scope="col">Canvas</th>
              </tr>
            </thead>
            <tbody>
              {PRESETS.map(([title, size, description]) => (
                <tr key={title}>
                  <th scope="row">{title}</th>
                  <td className="whitespace-nowrap tabular-nums">{size}</td>
                  <td>{description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection title="Export formats">
        <p>
          Every export, single or in a ZIP, is drawn on a 2D canvas at the export size and then
          encoded:
        </p>
        <ul>
          <li>
            <strong>PNG:</strong> lossless compression with transparency. Best for graphics and
            further editing.
          </li>
          <li>
            <strong>WebP:</strong> smaller files with transparency, when your browser can encode it.
          </li>
          <li>
            <strong>AVIF:</strong> 8-bit colour with a solid background, offered when your browser
            can encode AV1.
          </li>
          <li>
            <strong>HEIC:</strong> 8-bit colour with transparency stored as a separate alpha image,
            offered when your browser can encode HEVC.
          </li>
          <li>
            <strong>JPEG:</strong> no transparency; the background you chose (white by default)
            fills it.
          </li>
          <li>
            <strong>BMP:</strong> uncompressed, for tools that need it.
          </li>
          <li>
            <strong>SVG:</strong> a traced vector version, offered for flat art such as logos.
          </li>
          <li>
            <strong>Batches:</strong> a ZIP of every result (up to 200 MB), a labelled contact
            sheet, or a sprite sheet with a JSON atlas.
          </li>
        </ul>
      </DocSection>

      <DocSection title="How removal works">
        <dl>
          <div>
            <dt>Neural network</dt>
            <dd>
              Photos go through BiRefNet lite, or ISNet on low-memory devices without WebGPU. The
              model runs in your browser with WebGPU where available and WebAssembly otherwise.
            </dd>
          </div>
          <div>
            <dt>Colour key for flat art</dt>
            <dd>
              Logos, scans and clip art on a plain background are keyed out by colour with a small
              WebAssembly routine instead of the model, which keeps crisp edges. The Info panel
              shows which method ran.
            </dd>
          </div>
          <div>
            <dt>Edge clean-up</dt>
            <dd>
              After removal, Cutout refines the edge against the original photo and can remove
              colour the old background left in semi-transparent areas such as hair (
              <em>Edge colour</em> in Adjust).
            </dd>
          </div>
        </dl>
      </DocSection>

      <DocSection title="Saved workspace">
        <p>
          If you choose to save your workspace, Cutout stores your original files, results and
          settings (up to 250 MB) in this browser&apos;s IndexedDB. Nothing is uploaded and no
          account is needed. Delete it under <em>Saved workspace</em> in the header, or by clearing
          this site&apos;s data in your browser; see <a href="/privacy">Privacy</a>.
        </p>
      </DocSection>
    </DocPage>
  );
}
