import type { RemovalMethod } from "./engine";
import type { ConsumerProgress } from "./engine";
import type { BackgroundMode, ExportFormat } from "./formats";
import type { MetadataReport } from "./metadata";
import type { RemovalDiagnostics } from "./removal-diagnostics";
import type { RemovalModelKind } from "./removal-provider";
import type { EditorState } from "./editor/state";
export type Phase = "idle" | "processing" | "result" | "adjusting" | "error";

export type QueueItem = {
  id: string;
  name: string;
  source: File;
  sourceUrl: string;
  preview: ImageBitmap | null;
  resultBlob: Blob | null;
  resultUrl: string | null;
  width: number;
  height: number;
  status: "queued" | "working" | "done" | "error";
  error?: string;
  retryable?: boolean;
  /** Stopped by the user before finishing; cleared when the item runs again. */
  cancelled?: boolean;
  durationMs?: number;
  provider?: "webgpu" | "wasm" | "fallback";
  method?: RemovalMethod;
  /** The removal model that ran, when one did. */
  model?: RemovalModelKind;
  /** Set once the source has been upscaled on-device before removal. */
  enhanced?: { scale: number; model: string; device: "webgpu" | "wasm" };
  diagnostics?: RemovalDiagnostics;
  removalNote?: "clean" | "refined" | "choose";
};

/** Published identities, after asynchronous source validation/conversion has finished. */
export type IngestReceipt = {
  job: number;
  drop: number;
  items: Pick<QueueItem, "id" | "source">[];
};

/** Only automatic launch exports opt into this lifetime; manual actions keep their API. */
export type LaunchDownload = {
  signal: AbortSignal;
  isCurrent: () => boolean;
};

export type WorkspaceState = EditorState & {
  phase: Phase;
  items: QueueItem[];
  activeId: string | null;
  comparing: boolean;
  peeking: boolean;
  inspecting: boolean;
  copied: boolean;
  saved: boolean;
  exporting: boolean;
  copying: boolean;
  dragging: boolean;
  errorMessage: string | null;
  progress: ConsumerProgress;
  receiveFiles: (files: File[], signal?: AbortSignal) => Promise<IngestReceipt | null>;
  selectItem: (id: string) => void;
  setComparing: (value: boolean) => void;
  setPeeking: (value: boolean) => void;
  setDragging: (value: boolean) => void;
  openAdjust: () => void;
  closeAdjust: () => void;
  openInfo: () => void;
  closeInfo: () => void;
  setExportFormat: (format: ExportFormat) => void;
  setExportSize: (width: number | null, height: number | null) => void;
  setBackground: (background: BackgroundMode) => void;
  setCustomColor: (value: string) => void;
  setBackgroundImage: (file: File) => void;
  setStripMetadata: (value: boolean) => void;
  setFeather: (value: number) => void;
  setChoke: (value: number) => void;
  reprocessActive: () => void;
  /** Upscale the active source with Swin2SR (×2 general, ×4 for compressed), then reprocess it. */
  enhanceActive: (options?: {
    scale?: 2 | 4;
    /** Longest side the output is brought down to (print targets). */
    targetSide?: number;
    /** Reuse the current matte instead of removing the background again; skips empty tiles. */
    keepCutout?: boolean;
  }) => Promise<void>;
  /** Abort the enhancement in progress, if any. */
  cancelEnhance: () => void;
  /** Stop every queued/running removal. Done results, settings and history stay;
   *  stopped items remain individually retryable. */
  cancelProcessing: () => void;
  reprocessItem: (id: string) => void;
  /** Swap the active cutout for a re-cut one (Choose subject → Fix area). */
  replaceResult: (blob: Blob) => void;
  copyActive: () => Promise<void>;
  downloadActive: (format?: ExportFormat, launch?: LaunchDownload) => Promise<void>;
  downloadOriginal: () => Promise<void>;
  /** Trace the edited cutout into an SVG of filled paths (flat art). */
  downloadVector: () => Promise<void>;
  resetAdjust: () => void;
  reset: () => void;
  reportError: (message: string) => void;
  metadata: MetadataReport | null;
};
