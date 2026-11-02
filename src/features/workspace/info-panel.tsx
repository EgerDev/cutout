import { Component, useState, useMemo, useEffect, type ReactNode } from "react";
import { ModelsPanel } from "./models-panel";
import type { RemovalMethod } from "@/lib/engine";
import { useSheetInert } from "./use-sheet-inert";
import { Check, ChevronDown, Copy, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatAspectRatio } from "@/lib/aspect-ratio";
import { cn } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

type SheetProps = { open: boolean; mobile: boolean };

/** Embedded metadata is untrusted: whatever it holds, a bad field must cost this panel,
 *  not the workspace and the user's unsaved work. */
export function InfoPanel(props: SheetProps) {
  const activeId = useWorkspace((s) => s.activeId);
  return (
    <InfoErrorBoundary key={activeId ?? ""} fallback={<InfoFallback {...props} />}>
      <InfoPanelContent {...props} />
    </InfoErrorBoundary>
  );
}

class InfoErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function InfoFallback({ open, mobile }: SheetProps) {
  const inert = useSheetInert(open);
  return (
    <aside
      id="cutout-info"
      aria-hidden={!open}
      inert={inert}
      data-side={mobile ? "south" : "east"}
      className={sheetClass(mobile)}
    >
      <div className="sheet-head">
        <h2 className="sheet-title">Image information</h2>
        <DoneButton />
      </div>
      <p role="alert" className="sheet-body text-[13px] text-muted">
        Couldn’t read this file’s details. The image itself is unaffected.
      </p>
    </aside>
  );
}

function DoneButton() {
  return (
    <Button variant="ghost" size="sm" onClick={() => useWorkspace.getState().closeInfo()}>
      Done
    </Button>
  );
}

function sheetClass(mobile: boolean) {
  return cn(
    "sheet z-30 flex flex-col overflow-hidden border border-line/30 bg-float shadow-[var(--shadow-float)]",
    mobile
      ? "fixed start-0 end-0 bottom-0 pb-[env(safe-area-inset-bottom)]"
      : "absolute end-4 h-fit w-[min(24rem,calc(100%-2rem))]",
  );
}

function InfoPanelContent({ open, mobile }: SheetProps) {
  const item = useWorkspace((s) => s.items.find((entry) => entry.id === s.activeId));
  const metadata = useWorkspace((s) => s.metadata);
  const name = item?.name ?? "",
    width = item?.width ?? 0,
    height = item?.height ?? 0,
    fileSize = item?.source.size,
    durationMs = item?.durationMs,
    provider = item?.provider,
    method = item?.method,
    enhanced = item?.enhanced;
  const [showAllTags, setShowAllTags] = useState(false);
  useEffect(() => {
    if (metadata && metadata.allTags.length > 0 && metadata.allTags.length <= 24)
      setShowAllTags(true);
  }, [metadata]);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNamespace, setSelectedNamespace] = useState<string>("ALL");
  const [copied, setCopied] = useState<string | null>(null);

  const copy = (key: string, text: string | undefined, ms = 2000) => {
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), ms);
    });
  };

  const copyAllJson = () => {
    if (!metadata) return;
    const json = JSON.stringify(
      {
        fileName: name,
        mimeType: metadata.mimeType,
        dimensions: { width, height },
        fileSize: metadata.fileSize ?? fileSize,
        hash: metadata.hash,
        fileType: metadata.fileType,
        colorType: metadata.colorType,
        colorSpace: metadata.colorSpace,
        iccProfile: metadata.iccProfile,
        bitDepth: metadata.bitDepth,
        alpha: metadata.alpha,
        compression: metadata.compression,
        interlace: metadata.interlace,
        filter: metadata.filter,
        channels: metadata.channels,
        gamma: metadata.gamma,
        renderingIntent: metadata.renderingIntent,
        orientation: metadata.orientation,
        resolutionDpi: metadata.resolutionDpi,
        software: metadata.software,
        copyright: metadata.copyright,
        artist: metadata.artist,
        description: metadata.description,
        comment: metadata.comment,
        created: metadata.created,
        modified: metadata.modified,
        fields: metadata.fields,
        ai: metadata.ai,
        camera: metadata.camera,
        gps: metadata.gps,
        tags: metadata.allTags,
      },
      null,
      2,
    );
    copy("json", json);
  };

  const namespaces = useMemo(() => {
    if (!metadata?.allTags) return [];
    const set = new Set<string>();
    for (const tag of metadata.allTags) {
      if (tag.namespace) set.add(tag.namespace);
    }
    return Array.from(set);
  }, [metadata?.allTags]);

  const filteredTags = useMemo(() => {
    if (!metadata?.allTags) return [];
    const q = searchQuery.trim().toLowerCase();
    return metadata.allTags.filter((tag) => {
      if (selectedNamespace !== "ALL" && tag.namespace !== selectedNamespace) return false;
      if (!q) return true;
      return (
        tag.label.toLowerCase().includes(q) ||
        tag.tag.toLowerCase().includes(q) ||
        tag.value.toLowerCase().includes(q) ||
        tag.namespace.toLowerCase().includes(q)
      );
    });
  }, [metadata?.allTags, searchQuery, selectedNamespace]);

  const isAi = Boolean(metadata?.ai?.isAi);
  const camera = metadata?.camera;
  const gps = metadata?.gps;
  const megapixels = width && height ? ((width * height) / 1_000_000).toFixed(2) : null;
  const aspectRatio = formatAspectRatio(width, height);
  const extraFields = useMemo(() => {
    if (!metadata?.fields.length) return [];
    const shown = new Set([
      "software",
      "artist",
      "copyright",
      "description",
      "comment",
      "date",
      "orientation",
      "color space",
      "compression",
      "interlace",
      "filter",
      "color type",
      "subsampling",
      "x resolution",
      "y resolution",
      "latitude",
      "longitude",
      "altitude",
    ]);
    return metadata.fields.filter((field) => !shown.has(field.label.toLowerCase()));
  }, [metadata?.fields]);
  const inert = useSheetInert(open);
  const shotSpecs = camera
    ? [
        ["Aperture", camera.fNumber],
        ["Shutter", camera.exposureTime],
        ["ISO", camera.iso],
        ["Focal length", camera.focalLength],
        ["35 mm equivalent", camera.focalLength35mm],
        ["Exposure bias", camera.exposureBias],
        ["Program", camera.exposureProgram],
        ["Mode", camera.exposureMode],
        ["Metering", camera.metering],
        ["White balance", camera.whiteBalance],
        ["Scene", camera.scene],
        ["Flash", camera.flash],
      ]
    : [];

  return (
    <aside
      id="cutout-info"
      aria-hidden={!open}
      aria-labelledby="cutout-info-title"
      inert={inert}
      data-side={mobile ? "south" : "east"}
      className={sheetClass(mobile)}
    >
      <div className="sheet-head">
        <div className="min-w-0 flex-1">
          <h2 id="cutout-info-title" className="sheet-title">
            Image information
          </h2>
          <p className="truncate text-[12px] text-muted" title={name || undefined}>
            {name || "Uploaded file"}
          </p>
        </div>
        <DoneButton />
      </div>

      <div className="sheet-body sheet-scroll">
        {isAi && metadata?.ai ? (
          <section className="sheet-section" aria-labelledby="info-ai">
            <h3 id="info-ai" className="sheet-section-title">
              Made with AI
            </h3>
            <dl className="info-fields">
              <Field label="Generator" value={metadata.ai.generator || "Generative AI"} wide />
              <Field label="Model" value={metadata.ai.model} wide />
              <Field label="Seed" value={metadata.ai.seed} />
              <Field label="Steps" value={metadata.ai.steps} />
              <Field label="Sampler" value={metadata.ai.sampler} />
              <Field label="CFG scale" value={metadata.ai.cfgScale} />
              <Field label="Aspect ratio" value={metadata.ai.aspectRatio} />
            </dl>
            {metadata.ai.prompt ? (
              <CopyBlock
                label="Prompt"
                text={metadata.ai.prompt}
                copied={copied === "prompt"}
                onCopy={() => copy("prompt", metadata.ai?.prompt)}
              />
            ) : null}
            {metadata.ai.negativePrompt ? (
              <CopyBlock
                label="Negative prompt"
                text={metadata.ai.negativePrompt}
                copied={copied === "negative"}
                onCopy={() => copy("negative", metadata.ai?.negativePrompt)}
              />
            ) : null}
            {metadata.ai.evidence.length > 0 ? (
              <p className="edit-note">Found in: {metadata.ai.evidence[0]}</p>
            ) : null}
          </section>
        ) : null}

        {!isAi && camera && (camera.make || camera.model || camera.lens) ? (
          <section className="sheet-section" aria-labelledby="info-camera">
            <h3 id="info-camera" className="sheet-section-title">
              Camera
            </h3>
            <dl className="info-fields">
              <Field
                label="Camera"
                value={[camera.make, camera.model].filter(Boolean).join(" ")}
                wide
              />
              <Field label="Lens" value={camera.lens} wide />
              {shotSpecs.map(([label, value]) => (
                <Field
                  key={label}
                  label={String(label)}
                  value={value ? String(value) : undefined}
                />
              ))}
              <Field label="Taken" value={camera.dateTaken} wide />
            </dl>
          </section>
        ) : null}

        {gps ? (
          <section className="sheet-section" aria-labelledby="info-location">
            <h3 id="info-location" className="sheet-section-title">
              Location
            </h3>
            <dl className="info-fields">
              <Field
                label="Coordinates"
                value={`${gps.formattedLat.split(" ")[0]}, ${gps.formattedLng.split(" ")[0]}`}
                wide
                numeric
              />
              <Field
                label="Altitude"
                value={gps.altitude != null ? `${gps.altitude} m` : undefined}
              />
            </dl>
            <p className="edit-note">
              This file records where it was taken. To share the original without it, turn on Strip
              metadata in Adjust and download the cleaned original.
            </p>
            <a className="info-link" href={gps.mapsUrl} target="_blank" rel="noreferrer noopener">
              Open in Google Maps
              <ExternalLink className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(opens a new tab and sends the coordinates to Google)</span>
            </a>
          </section>
        ) : null}

        <section className="sheet-section" aria-labelledby="info-image">
          <h3 id="info-image" className="sheet-section-title">
            Image
          </h3>
          <dl className="info-fields">
            <Field
              label="Dimensions"
              value={width && height ? `${width} × ${height} px` : undefined}
              numeric
            />
            <Field label="Megapixels" value={megapixels ? `${megapixels} MP` : undefined} numeric />
            <Field label="Aspect ratio" value={aspectRatio !== "—" ? aspectRatio : undefined} />
            <Field label="Orientation" value={metadata?.orientation} />
            <Field
              label="File size"
              value={
                fileSize || metadata?.fileSize
                  ? formatBytes(fileSize ?? metadata?.fileSize ?? 0)
                  : undefined
              }
              numeric
            />
            <Field label="Format" value={metadata?.fileType || typeFromName(name)} />
            <Field label="MIME type" value={metadata?.mimeType} />
            <Field label="Colour type" value={metadata?.colorType} />
            <Field label="Colour space" value={metadata?.colorSpace} />
            <Field label="ICC profile" value={metadata?.iccProfile} />
            <Field label="Bit depth" value={metadata?.bitDepth} />
            <Field label="Channels" value={metadata?.channels} />
            <Field label="Transparency" value={metadata?.alpha} />
            <Field label="Compression" value={metadata?.compression} />
            <Field label="Filter" value={metadata?.filter} />
            <Field label="Interlace" value={metadata?.interlace} />
            <Field label="Resolution" value={metadata?.resolutionDpi} />
            <Field label="Gamma" value={metadata?.gamma} />
            <Field label="Rendering intent" value={metadata?.renderingIntent} />
            <Field label="Chroma subsampling" value={metadata?.subsampling} />
          </dl>
          {!metadata ? (
            <p className="edit-note" role="status">
              Reading the file’s details…
            </p>
          ) : null}
        </section>

        {metadata &&
        (metadata.software ||
          metadata.copyright ||
          metadata.artist ||
          metadata.description ||
          metadata.comment ||
          metadata.created ||
          metadata.modified ||
          metadata.hash) ? (
          <section className="sheet-section" aria-labelledby="info-file">
            <h3 id="info-file" className="sheet-section-title">
              File and provenance
            </h3>
            <dl className="info-fields">
              <Field label="Software" value={metadata.software} />
              <Field label="Artist" value={metadata.artist} />
              <Field label="Copyright" value={metadata.copyright} />
              <Field label="Created" value={metadata.created} />
              <Field
                label="Modified"
                value={
                  metadata.modified && !Number.isNaN(Date.parse(metadata.modified))
                    ? new Date(metadata.modified).toLocaleString()
                    : metadata.modified
                }
              />
              <Field label="Description" value={metadata.description} wide />
              <Field label="Comment" value={metadata.comment} wide />
            </dl>
            {metadata.hash ? (
              <CopyBlock
                label="SHA-256"
                text={metadata.hash}
                copied={copied === "hash"}
                onCopy={() => copy("hash", metadata.hash)}
                code
              />
            ) : null}
          </section>
        ) : null}

        {extraFields.length ? (
          <section className="sheet-section" aria-labelledby="info-more">
            <h3 id="info-more" className="sheet-section-title">
              More from the file
            </h3>
            <dl className="info-fields">
              {extraFields.map((field) => (
                <Field key={field.label} label={field.label} value={field.value} />
              ))}
            </dl>
          </section>
        ) : null}

        <section className="sheet-section" aria-labelledby="info-cutout">
          <h3 id="info-cutout" className="sheet-section-title">
            How it was cut out
          </h3>
          <dl className="info-fields">
            <Field label="Method" value={methodLabel(method, provider, item?.model)} />
            <Field label="Ran on" value={providerLabel(provider)} />
            <Field
              label="Enhanced"
              value={
                enhanced
                  ? `${enhanced.scale}× with Swin2SR (${enhanced.device === "webgpu" ? "GPU" : "CPU"})`
                  : undefined
              }
            />
            <Field
              label="Processing time"
              value={durationMs ? `${(durationMs / 1000).toFixed(2)} s` : undefined}
              numeric
            />
          </dl>
        </section>

        <section className="sheet-section" aria-labelledby="info-models">
          <h3 id="info-models" className="sheet-section-title">
            On-device models
          </h3>
          {open ? <ModelsPanel compact /> : null}
        </section>

        {metadata?.allTags && metadata.allTags.length > 0 ? (
          <section className="sheet-section">
            <button
              type="button"
              aria-expanded={showAllTags}
              aria-controls="info-all-tags"
              onClick={() => setShowAllTags((prev) => !prev)}
              className="info-disclosure"
            >
              <span>All metadata</span>
              <span className="tool-count">{metadata.allTags.length}</span>
              <ChevronDown
                aria-hidden="true"
                className={cn("ms-auto size-4 text-muted", showAllTags && "rotate-180")}
              />
            </button>

            {showAllTags ? (
              <div id="info-all-tags" className="mt-2 space-y-2">
                <label htmlFor="metadata-filter" className="block text-[12px] text-muted">
                  Filter metadata
                </label>
                <div className="relative">
                  <Search
                    aria-hidden="true"
                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted"
                  />
                  <input
                    id="metadata-filter"
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Filter, e.g. ISO or prompt"
                    className="info-filter"
                  />
                </div>

                {namespaces.length > 1 ? (
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Metadata groups">
                    {["ALL", ...namespaces].map((ns) => {
                      const count =
                        ns === "ALL"
                          ? metadata.allTags.length
                          : metadata.allTags.filter((t) => t.namespace === ns).length;
                      return (
                        <button
                          key={ns}
                          type="button"
                          aria-pressed={selectedNamespace === ns}
                          onClick={() => setSelectedNamespace(ns)}
                          className="info-chip"
                        >
                          {ns === "ALL" ? "All" : ns} <span className="tabular-nums">{count}</span>
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {filteredTags.length === 0 ? (
                  <p className="edit-note" role="status">
                    No fields match “{searchQuery.trim() || selectedNamespace}”.
                  </p>
                ) : (
                  <ul className="info-tags">
                    {filteredTags.map((tag) => (
                      <li key={tag.id}>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12px] text-muted">
                            {tag.label} <span className="info-namespace">{tag.namespace}</span>
                          </p>
                          <p className="break-words text-[13px] select-text">{tag.value}</p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-9 min-h-9 min-w-9 shrink-0"
                          aria-label={`Copy ${tag.label}`}
                          onClick={() => copy(`tag:${tag.id}`, tag.value, 1800)}
                        >
                          {copied === `tag:${tag.id}` ? (
                            <Check className="size-4 text-ok" aria-hidden="true" />
                          ) : (
                            <Copy className="size-4" aria-hidden="true" />
                          )}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}

                <Button variant="secondary" size="sm" onClick={copyAllJson} className="w-full">
                  {copied === "json" ? (
                    <>
                      <Check className="size-4" aria-hidden="true" /> Copied as JSON
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" aria-hidden="true" /> Copy all as JSON
                    </>
                  )}
                </Button>
              </div>
            ) : null}
          </section>
        ) : null}

        {metadata && !metadata.extras && metadata.allTags.length === 0 ? (
          <p className="edit-note">This image carries no extra metadata.</p>
        ) : null}
        <span role="status" className="sr-only">
          {copied ? "Copied to the clipboard" : ""}
        </span>
      </div>
    </aside>
  );
}

function Field({
  label,
  value,
  wide,
  numeric,
}: {
  label: string;
  value?: string | null;
  wide?: boolean;
  numeric?: boolean;
}) {
  if (!value) return null;
  return (
    <div className={cn(wide && "col-span-2")}>
      <dt>{label}</dt>
      <dd className={cn(numeric && "tabular-nums")} title={value.length > 40 ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

function CopyBlock({
  label,
  text,
  copied,
  onCopy,
  code,
}: {
  label: string;
  text: string;
  copied: boolean;
  onCopy: () => void;
  code?: boolean;
}) {
  return (
    <div className="info-block">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] text-muted">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-9 px-2 text-[13px]"
          onClick={onCopy}
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <Check className="size-4 text-ok" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className={cn("info-block-text", code && "font-mono text-[12px] break-all")}>{text}</p>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function typeFromName(name: string) {
  const ext = name.split(".").pop()?.toUpperCase();
  return ext && ext !== name.toUpperCase() ? ext : "—";
}

function methodLabel(
  method?: RemovalMethod,
  provider?: "webgpu" | "wasm" | "fallback",
  model?: "birefnet" | "isnet",
) {
  if (method === "logo") return "Colour key (flat art)";
  if (method === "illustration") return "Flood key (illustration)";
  if (method === "flood") return "Flood key (recovery)";
  if (method === "passthrough") return "Already transparent";
  if (method === "model" || provider === "webgpu" || provider === "wasm")
    return model === "isnet" ? "ISNet" : "BiRefNet";
  return "—";
}

function providerLabel(provider?: "webgpu" | "wasm" | "fallback") {
  if (provider === "webgpu") return "Graphics card (WebGPU)";
  if (provider === "wasm") return "Processor (WebAssembly)";
  if (provider === "fallback") return "Compatibility mode";
  return "This device";
}
