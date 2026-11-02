import { createFileRoute } from "@tanstack/react-router";
import { DocPage, DocSection } from "@/features/site/doc-page";
import { docHead } from "@/features/site/doc-head";
import { MODEL_NOTICES, modelUrl } from "@/lib/model-notices";
import license from "../../LICENSE?raw";
import notice from "../../NOTICE?raw";
import { Scale, FileText, Download, Box } from "lucide-react";

export const Route = createFileRoute("/licenses")({
  head: () =>
    docHead(
      "Open-source licenses",
      "Cutout's MIT licence, the notices for the software it includes, the models it downloads, and the source for the HEIC decoder.",
    ),
  component: Licenses,
});

// Versions compiled into the vendored heic-to build (vendor/heic-to); the archives are named after them.
const HEIC = { heicTo: "1.5.2", libheif: "1.23.5", libde265: "1.1.3" } as const;

const SOURCES = [
  ...[
    `heic-to-${HEIC.heicTo}.tar.gz`,
    `libheif-${HEIC.libheif}.tar.gz`,
    `libde265-${HEIC.libde265}.tar.gz`,
    `libheif-${HEIC.libheif}-emscripten-libde265-cmake.patch`,
    `heic-to-${HEIC.heicTo}-emscripten5.patch`,
    "build-heic-to.sh",
    "BUILD.md",
  ].map((file) => ({ href: `/third-party/source/${file}`, label: file })),
  { href: "/third-party/heic-to-LICENSE.txt", label: "LGPL-3.0 (heic-to licence)" },
  { href: "/third-party/GPL-3.0.txt", label: "GPL-3.0.txt" },
];

const preClass =
  "overflow-auto whitespace-pre-wrap rounded-xl border border-fg/8 bg-fg/[0.03] p-4 text-[12px] leading-5 font-mono text-muted";
const code = "text-fg font-mono";

function Licenses() {
  return (
    <DocPage
      title="Open-source licenses"
      subtitle="Cutout's own licence, the software it includes, the models it downloads, and where to get the source code the licences require us to offer."
      badge="Licenses"
    >
      <DocSection title="Cutout" badge="MIT" icon={<Scale className="size-5" />}>
        <p>
          Cutout&apos;s original application code and independently implemented removal engine are
          licensed under the MIT License. Copyright 2026 EgerDev. Third-party software, models and
          assets retain their own licenses. The source code is at{" "}
          <a className="text-accent underline" href="https://github.com/EgerDev/cutout">
            github.com/EgerDev/cutout
          </a>
          .
        </p>
        <p>
          Earlier versions of Cutout used BG0 by OpenCoreDev (
          <code className={code}>@bg0/browser</code>, Apache License 2.0). The current removal
          engine was written independently, from a behaviour specification and without BG0&apos;s
          source code, and contains no code copied from BG0. Cutout is not affiliated with or
          endorsed by OpenCoreDev.
        </p>
        <pre className={preClass}>{notice}</pre>
        <details>
          <summary className="cursor-pointer text-fg">MIT License, full text</summary>
          <pre className={`${preClass} mt-3 max-h-[22rem]`}>{license}</pre>
        </details>
      </DocSection>

      <DocSection
        title="Third-party software"
        badge="Notices"
        icon={<FileText className="size-5" />}
      >
        <p>
          <a className="text-accent underline" href="/third-party/THIRD_PARTY_NOTICES.txt">
            THIRD_PARTY_NOTICES.txt
          </a>{" "}
          lists Cutout&apos;s production dependencies and the server framework&apos;s dependency
          tree with their licence and copyright text, followed by ONNX Runtime&apos;s licence and
          third-party notices (ONNX Runtime runs the models in your browser) and the models below.
          It is generated from the project&apos;s lockfile, so it changes whenever the dependencies
          do.
        </p>
        <p>
          Most packages are under the MIT, ISC, BSD or Apache 2.0 licences. ExifReader, which reads
          image metadata, is under the Mozilla Public License 2.0 and is used unmodified; its source
          is at{" "}
          <a className="text-accent underline" href="/third-party/source/exifreader-4.45.0.tgz">
            ExifReader 4.45.0 source archive (MPL-2.0)
          </a>
          .
        </p>
      </DocSection>

      <DocSection title="Models" badge="Downloaded at runtime" icon={<Box className="size-5" />}>
        <p>
          These model weights are not part of Cutout. Your browser downloads each one from Hugging
          Face at the revision shown the first time a feature needs it, then keeps it in its cache.
          The licence column is what the publisher of each repository declares.
        </p>
        <div className="overflow-x-auto my-3">
          <table className="w-full text-left text-xs border border-fg/8">
            <thead className="bg-fg/[0.04] text-fg font-semibold border-b border-fg/8">
              <tr>
                <th className="py-2.5 px-3">Model</th>
                <th className="py-2.5 px-3">Used for</th>
                <th className="py-2.5 px-3">Licence</th>
                <th className="py-2.5 px-3">Converted from</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-fg/6 text-muted align-top">
              {MODEL_NOTICES.map((model) => (
                <tr key={model.id}>
                  <td className="py-2 px-3">
                    <a className="font-mono text-fg underline" href={modelUrl(model.id)}>
                      {model.id}
                    </a>
                    <div className="font-mono text-[12px]">rev {model.revision.slice(0, 7)}</div>
                  </td>
                  <td className="py-2 px-3">{model.use}</td>
                  <td className="py-2 px-3">{model.licence}</td>
                  <td className="py-2 px-3">
                    {model.upstream}
                    {model.note ? <p className="mt-1 text-fg">{model.note}</p> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DocSection>

      <DocSection
        title="HEIC decoder source"
        badge="LGPL-3.0"
        icon={<Download className="size-5" />}
      >
        <p>
          When your browser cannot open HEIC or HEIF photos itself, Cutout loads a HEIC decoder
          built from heic-to {HEIC.heicTo} with libheif {HEIC.libheif} and libde265 {HEIC.libde265}{" "}
          (all LGPL-3.0-or-later). They are patched only so they build with Emscripten 5. The
          decoder is a separate file that can be replaced. The corresponding source code, patches,
          build script and licence texts:
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-3">
          {SOURCES.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="flex items-center justify-between rounded-xl border border-fg/8 bg-fg/[0.02] hover:bg-fg/5 p-3 text-xs transition-colors group"
            >
              <span className="font-mono text-fg group-hover:text-accent font-medium">
                {item.label}
              </span>
              <Download
                aria-hidden="true"
                className="size-3.5 text-muted group-hover:text-accent transition-colors"
              />
            </a>
          ))}
        </div>
      </DocSection>
    </DocPage>
  );
}
