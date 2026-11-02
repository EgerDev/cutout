# Sample image provenance

The silver tabby image was AI-generated specifically for Cutout on 2026-10-24
using the built-in OpenAI `image_gen` tool, from Opus's art direction. No input
or reference images were supplied. The tool did not expose a model version or
seed; neither is inferred here. It returned a 1024 × 1536 PNG with SHA-256
`9c09382e5fc1fe6b21ae2ab999b43b957944fdfb51766a88b48c0c874421a0aa`.

OpenAI's [Terms of Use, Content](https://openai.com/policies/terms-of-use/#content),
effective 2026-01-01 and checked on the generation date, assign OpenAI's output
rights, if any, to the user to the extent permitted by applicable law. They also
explain that outputs may not be unique. EgerDev offers its rights, if any, in
these project assets under the MIT License; this is not a claim of exclusive
copyright in AI-generated imagery.

## Exact generation prompt

Use case: photorealistic-natural

Asset type: Cutout open-source browser photo editor sample photograph. This is a new original image with no input references.

A realistic photograph of a silver tabby cat with green eyes sitting upright on a pale oak floor in a quiet living room, body turned slightly to the left, looking at the camera, tail curled around its front paws. The entire cat is in frame and small enough to fit inside the central square of the portrait picture, with generous empty space above the ears, below the paws and on both sides. Soft daylight from a window on the left gives a gentle rim of light along the fur; individual whiskers are visible. Background: a warm cream plaster wall, a softly out-of-focus oatmeal linen sofa and a green houseplant at the far right, shallow depth of field like a 50 mm lens at f/2. Natural, true-to-life colours, neutral white balance, fine natural fur texture, slight film grain. Portrait orientation, 2:3.

No text, watermark, signature, frame or border, collar or tag, people or hands, extra limbs or toes, duplicated tail, cartoon, illustration, 3D render, HDR look, oversharpening, heavy vignette or glowing outline.

Composition invariant: whole cat including ears, whiskers, paws and tail tip comfortably within central square of the portrait frame, no subject cut off. Anatomically coherent real cat with contact at floor.

## Derived assets and reproduction

`scripts/render-sample-assets.mjs` uses the existing Sharp dependency. It crops
the generated source to 3:4, converts to sRGB JPEG (mozjpeg quality 84, no EXIF/XMP),
and derives the 72 × 72 thumbnail and text-free 1200 × 630 share card from the
accepted sample plus its actual Cutout PNG result. The mark uses the project's
SVG geometry. No stock artwork or fonts are used in the share card.

```sh
node scripts/render-sample-assets.mjs --source generated-sample-source.png
# Open public/sample.jpg in Cutout; download PNG, Original preset, transparent.
node scripts/render-sample-assets.mjs --cutout sample-cutout.png
node scripts/render-sample-assets.mjs --heic  # macOS ImageIO/sips, 320px wide
```

Pass `--out <directory>` for a preview/reproduction and `--sample <jpg>` to read
a sample outside `public/`. Only `--heic` needs macOS; consuming the committed
HEIC fixture works on the supported test platforms through the bundled decoder.

| File | Dimensions / bytes | SHA-256 |
| --- | --- | --- |
| `sample.jpg` | 1024 × 1365 / 120829 | `ef1850694f1ed3393856a3031a2018875fa1d6f91c29ac07de41f70f32ef7dc7` |
| `sample-thumb.webp` | 72 × 72 / 1258 | `5b30aecbe4cb3f543a3222220da4109524b6f3bbf0efa5a60bbad82e0e27783a` |
| `og.jpg` | 1200 × 630 / 42291 | `ed921fd90ec0154e5743ac5b072d92b30319fb2714d3445206cd8ddb63c8dcdc` |
| Source-tree `scripts/fixtures/sample.heic` | 320 × 426 / 14915 | `7a2b01db364f7d2bc8d7375cc1b7a0b500c1ada90ac8c751a400ceb4efa49af0` |

The thumbnail/share-card bytes were reproduced independently from the same
sample and actual result. The sample was checked through the real BiRefNet
WebGPU route and the low-memory ISNet/WASM route. This is visual acceptance of
this example, not a universal quality or performance claim. Historical versions
of the former sample and its derivatives are not covered by this record.
