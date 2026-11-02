import { runtime } from "./workspace-runtime";
import { copyPngOrShare } from "./clipboard";
import { encodeExport } from "./editor/export";
import { activeSettings, type Get, type Set } from "./editor/state";
import { readClient } from "./device";
import {
  beginSavePicker,
  canShareFiles,
  downloadBlob,
  isSaveAbort,
  resultFilename,
  shareBlob,
  writeToSaveHandle,
} from "./files";
import { formatExtension, previewBackground } from "./formats";
import {
  cleanedFilename,
  downscaleNotice,
  stripExportMetadata,
  stripOriginalMetadata,
} from "./metadata-client";
import { CutoutError, messageFor } from "./errors";
import type { WorkspaceState } from "./workspace-types";
import { markSaved } from "./workspace-saved";
function exportMessage(error: unknown, fallback: "export" | "copy" = "export") {
  return error instanceof CutoutError && error.code === "export"
    ? error.message
    : messageFor(fallback);
}

export function downloadActions(
  get: Get,
  set: Set,
): Pick<WorkspaceState, "copyActive" | "downloadActive" | "downloadOriginal" | "downloadVector"> {
  let copiedTimer = 0,
    savedTimer = 0;
  let activeDownload: object | null = null;
  function savedResult(
    item: WorkspaceState["items"][number],
    settings: ReturnType<typeof activeSettings>,
  ) {
    if (!item.resultBlob) return;
    markSaved(item.resultBlob, settings);
    const current = get();
    if (
      current.activeId !== item.id ||
      current.items.find((entry) => entry.id === item.id)?.resultBlob !== item.resultBlob ||
      activeSettings(current) !== settings
    )
      return;
    window.clearTimeout(savedTimer);
    set({ saved: true, errorMessage: null });
    savedTimer = window.setTimeout(() => set({ saved: false }), 1400);
  }

  return {
    copyActive: async () => {
      if (get().copying) return;
      const generation = runtime.job;
      set({ copying: true });
      let exportError: unknown;
      try {
        const item = get().items.find((entry) => entry.id === get().activeId);
        if (!item?.resultBlob) return;
        const filename = resultFilename(item.name, "png");
        const settings = activeSettings(get());
        const result = await copyPngOrShare(
          encodeExport({
            result: item.resultBlob,
            source: item.source,
            settings: {
              ...settings,
              background: previewBackground(settings.background, settings.exportFormat),
              exportFormat: "png",
              targetKB: null,
            },
          })
            .then((output) => output.blob)
            .catch((error: unknown) => {
              // Clipboard/share fallbacks consume the rejection; retain safe export copy.
              exportError = error;
              throw error;
            }),
          filename,
        );
        if (result === "downloaded" || result === "shared") markSaved(item.resultBlob, settings);
        if (generation !== runtime.job || get().activeId !== item.id) return;
        if (result === "downloaded") {
          savedResult(item, settings);
          return;
        }
        if (result === "copied" || result === "shared") {
          window.clearTimeout(copiedTimer);
          set({ copied: true, errorMessage: null });
          copiedTimer = window.setTimeout(() => set({ copied: false }), 1400);
          return;
        }
        if (result === "aborted") return;
        set({ errorMessage: exportMessage(exportError, "copy") });
      } finally {
        if (generation === runtime.job) set({ copying: false });
      }
    },
    downloadActive: async (format, launch) => {
      if (launch && (launch.signal.aborted || !launch.isCurrent())) return;
      if (get().exporting) return;
      const generation = runtime.job,
        shared = runtime.runAbort?.signal;
      let signal = launch ? launch.signal : shared;
      let release = () => {};
      // AbortSignal.any is missing before Safari 17.4. Follow both inputs; never abort shared work.
      if (launch && shared) {
        const composed = new AbortController();
        const onLaunch = () => {
          if (!composed.signal.aborted) composed.abort(launch.signal.reason);
        };
        const onShared = () => {
          if (!composed.signal.aborted) composed.abort(shared.reason);
        };
        launch.signal.addEventListener("abort", onLaunch);
        shared.addEventListener("abort", onShared);
        if (launch.signal.aborted) onLaunch();
        else if (shared.aborted) onShared();
        signal = composed.signal;
        release = () => {
          launch.signal.removeEventListener("abort", onLaunch);
          shared.removeEventListener("abort", onShared);
        };
      }
      const owner = {};
      activeDownload = owner;
      const item = get().items.find((entry) => entry.id === get().activeId);
      const settings = activeSettings(get());
      const current = () =>
        generation === runtime.job &&
        !signal?.aborted &&
        (!launch ||
          (launch.isCurrent() &&
            get().activeId === item?.id &&
            get().items.find((entry) => entry.id === item?.id)?.source === item?.source &&
            get().items.find((entry) => entry.id === item?.id)?.resultBlob === item?.resultBlob &&
            activeSettings(get()) === settings));
      let cancel = () => {};
      // Release the UI promptly even if a native encoder/picker/share never settles.
      // Its already-dispatched work may finish, but cannot publish or start a fallback.
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => reject(signal?.reason ?? new DOMException("Cancelled", "AbortError"));
      });
      void cancelled.catch(() => {});
      if (launch) signal?.addEventListener("abort", cancel, { once: true });
      const wait = <T>(work: Promise<T>) => (launch ? Promise.race([work, cancelled]) : work);
      // The success flash is separate from the captured result/settings saved above.
      set({ exporting: true, ...(launch ? { saved: false } : {}) });
      try {
        if (!current()) return;
        if (!item?.resultBlob) {
          set({ errorMessage: messageFor("download") });
          return;
        }
        const exportFormat = format ?? settings.exportFormat;
        const filename = resultFilename(item.name, formatExtension(exportFormat));
        const client = readClient();
        const picker = client.saveViaShare ? null : beginSavePicker(filename);
        // Observe immediate cancellation while image encoding is still in progress.
        void picker?.catch(() => undefined);

        let output: Blob;
        try {
          const encoded = await wait(
            encodeExport(
              {
                result: item.resultBlob,
                source: item.source,
                settings: { ...settings, exportFormat },
              },
              signal,
            ),
          );
          if (!current()) return;
          const blob = encoded.blob;
          if (!encoded.metTarget) {
            set({
              errorMessage: "The target is too small. Increase the target size and try again.",
            });
            return;
          }
          if (!blob) {
            set({ errorMessage: messageFor("export") });
            return;
          }
          output = settings.stripMetadata ? await wait(stripExportMetadata(blob)) : blob;
        } catch (error) {
          if (current()) set({ errorMessage: exportMessage(error) });
          return;
        }

        if (!current() || !get().items.some((i) => i.id === item.id)) return;
        if (client.saveViaShare && canShareFiles()) {
          const shared = await wait(shareBlob(output, filename, launch ? signal : undefined));
          if (!current()) return;
          if (shared === "shared" || shared === "downloaded") {
            savedResult(item, settings);
            return;
          }
          if (shared === "aborted") return;
        }

        if (picker) {
          try {
            await wait(writeToSaveHandle(picker, output, launch ? signal : undefined));
            if (!current()) return;
            savedResult(item, settings);
            return;
          } catch (error) {
            if (!current() || isSaveAbort(error)) return;
          }
        }

        if (!current()) return;
        const downloaded = downloadBlob(output, filename);
        if (!current()) return;
        if (!downloaded) set({ errorMessage: messageFor("download") });
        else savedResult(item, settings);
      } catch {
        if (current()) set({ errorMessage: messageFor("download") });
      } finally {
        release();
        signal?.removeEventListener("abort", cancel);
        if (activeDownload === owner) {
          activeDownload = null;
          if (generation === runtime.job) set({ exporting: false });
        }
      }
    },
    downloadVector: async () => {
      if (get().exporting) return;
      const generation = runtime.job;
      const item = get().items.find((entry) => entry.id === get().activeId);
      if (!item?.resultBlob) {
        set({ errorMessage: messageFor("download") });
        return;
      }
      const settings = activeSettings(get());
      set({ exporting: true });
      try {
        const [{ editedMatte, MATTE_PREVIEW_MAX }, { vectorizeBlob }] = await Promise.all([
          import("./editor/canvas"),
          import("./editor/vectorize"),
        ]);
        // The trace runs at 1024 px, so the preview's cached matte is enough; no full-size edit pass.
        const matte = await editedMatte(item.resultBlob, item.source, settings, {
          tight: false,
          maxSide: MATTE_PREVIEW_MAX,
        });
        const svg = await vectorizeBlob(matte.blob ?? (await matte.encode()), { colors: 16 });
        if (generation !== runtime.job || get().activeId !== item.id) return;
        if (!downloadBlob(svg, resultFilename(item.name, "svg")))
          set({ errorMessage: messageFor("download") });
        else savedResult(item, settings);
      } catch (error) {
        if (generation === runtime.job) set({ errorMessage: exportMessage(error) });
      } finally {
        if (generation === runtime.job) set({ exporting: false });
      }
    },
    downloadOriginal: async () => {
      const item = get().items.find((entry) => entry.id === get().activeId);
      if (!item) {
        set({ errorMessage: messageFor("download") });
        return;
      }
      try {
        // Never falls back to the source: a failed clean saves nothing and says why.
        const blob = await stripOriginalMetadata(item.source);
        if (!downloadBlob(blob, cleanedFilename(item.name, blob.type))) {
          set({ errorMessage: messageFor("download") });
          return;
        }
        set({ errorMessage: null });
        const notice = await downscaleNotice(item.source, blob);
        if (notice) set({ errorMessage: notice });
      } catch (error) {
        set({ errorMessage: error instanceof CutoutError ? error.message : messageFor("export") });
      }
    },
  };
}
