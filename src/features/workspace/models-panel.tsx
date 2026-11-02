import { useEffect, useRef, useState } from "react";
import { classifyError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import {
  MODELS,
  clearModelCache,
  formatMB,
  listModelCache,
  persistStorage,
  prepareModel,
  storageSummary,
  type ModelId,
  type ModelStatus,
} from "@/lib/models";

/**
 * Download sizes measured at the pinned revisions; the range spans the variants the
 * device can take (WebGPU fp16 or fp32, WASM q8, ISNet on low-memory devices).
 */
const SIZE_LABEL: Record<ModelId, string> = {
  birefnet: "about 90–192 MB",
  "swin2sr-x2": "about 8 MB",
  "swin2sr-x4": "22–55 MB",
  depth: "27–99 MB",
};

type Outcome = "cancelled" | "timeout" | "failed";
const OUTCOME_TEXT: Record<Outcome, string> = {
  cancelled: "Stopped waiting",
  timeout: "Took too long",
  failed: "Didn’t finish",
};
const CANCELLED_NOTE = "Stopped waiting. The model may finish preparing in the background.";
/** A config or two reads "under 1 MB" rather than "0 MB". */
const cachedSize = (bytes: number) => (bytes < 1e6 ? "under 1 MB" : formatMB(bytes));
const TIMEOUT_NOTE = "That took too long. Try again.";

/**
 * What is cached on this device, per model, with download-ahead, cancel, retry and clear.
 * Cancel and closing the panel stop only this panel's wait: a download another feature is
 * using carries on (see the preparation contract in models.ts).
 */
export function ModelsPanel({ compact = false }: { readonly compact?: boolean }) {
  const [status, setStatus] = useState<ModelStatus[] | null>(null);
  const [cacheUnavailable, setCacheUnavailable] = useState(false);
  const [storage, setStorage] = useState<{
    usage: number;
    quota: number;
    persisted: boolean;
  } | null>(null);
  const [busy, setBusy] = useState<Partial<Record<ModelId, number>>>({});
  const [outcome, setOutcome] = useState<Partial<Record<ModelId, Outcome>>>({});
  const [note, setNote] = useState("");
  const [all, setAll] = useState(false);
  const controllers = useRef(new Map<ModelId, AbortController>());
  const allStopped = useRef(false);
  const mounted = useRef(true);
  // The Cache API exists only in secure contexts: over a plain-HTTP LAN address every
  // visit downloads the models again (~190 MB) and "Download all" keeps nothing.
  // Read after mount so the server render and hydration agree.
  const [canCache, setCanCache] = useState(true);
  useEffect(() => setCanCache(typeof caches !== "undefined"), []);
  useEffect(() => {
    mounted.current = true;
    const owned = controllers.current;
    return () => {
      // Closing the panel ends this panel's waits; shared loads keep running.
      mounted.current = false;
      allStopped.current = true;
      for (const controller of owned.values()) controller.abort();
      owned.clear();
    };
  }, []);
  const refresh = async () => {
    // Either storage API can fail independently (private mode, eviction, disk errors).
    const [next, summary] = await Promise.allSettled([listModelCache(), storageSummary()]);
    if (!mounted.current) return;
    setStatus(next.status === "fulfilled" ? next.value : null);
    setCacheUnavailable(next.status === "rejected");
    setStorage(summary.status === "fulfilled" ? summary.value : null);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const download = async (id: ModelId): Promise<boolean> => {
    if (controllers.current.has(id)) return false;
    const controller = new AbortController();
    controllers.current.set(id, controller);
    // Only the row's current, unaborted wait may change it: a tick or a settlement from an
    // ended wait (cancelled, closed, or followed by Retry on the same row) is ignored.
    const current = () =>
      mounted.current && controllers.current.get(id) === controller && !controller.signal.aborted;
    setBusy((b) => ({ ...b, [id]: 0 }));
    setOutcome((o) => ({ ...o, [id]: undefined }));
    setNote("");
    try {
      await prepareModel(
        id,
        // Shows what the loader reports, as reported.
        (fraction) => {
          if (current()) setBusy((b) => (b[id] === undefined ? b : { ...b, [id]: fraction }));
        },
        { signal: controller.signal },
      );
      return true;
    } catch (error) {
      if (!mounted.current || controllers.current.get(id) !== controller) return false;
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      const kind: Outcome = controller.signal.aborted
        ? "cancelled"
        : timedOut
          ? "timeout"
          : "failed";
      setOutcome((o) => ({ ...o, [id]: kind }));
      setNote(
        kind === "cancelled"
          ? CANCELLED_NOTE
          : kind === "timeout"
            ? TIMEOUT_NOTE
            : classifyError(error).message,
      );
      return false;
    } finally {
      const mine = controllers.current.get(id) === controller;
      if (mine) controllers.current.delete(id);
      if (mounted.current && mine) {
        setBusy((b) => {
          const next = { ...b };
          delete next[id];
          return next;
        });
        await refresh();
      }
    }
  };
  const cancel = (id: ModelId) => controllers.current.get(id)?.abort();
  const clear = async (id: ModelId) => {
    try {
      const removed = await clearModelCache(id);
      setOutcome((o) => ({ ...o, [id]: undefined }));
      setNote(
        removed
          ? `Removed ${removed} currently cached file${removed === 1 ? "" : "s"}. Active downloads can save files again.`
          : "No cached files found. Active downloads can save files again.",
      );
    } catch {
      setNote("Couldn’t clear the model files. Try again.");
    } finally {
      await refresh();
    }
  };
  const downloadAll = async () => {
    allStopped.current = false;
    setAll(true);
    let failed = false;
    try {
      for (const model of MODELS) {
        if (allStopped.current) break;
        // A cached config alone does not prove the model is complete; the loader reuses valid cache.
        if (!(await download(model.id))) failed = true;
      }
    } finally {
      if (mounted.current) setAll(false);
    }
    if (!mounted.current) return;
    setNote(
      allStopped.current
        ? "Stopped waiting. Models that finished stay on this device."
        : failed
          ? "Some models couldn’t be prepared. Try again."
          : "All models are ready in this browser. Cached files are listed above.",
    );
  };
  const stopAll = () => {
    allStopped.current = true;
    for (const controller of controllers.current.values()) controller.abort();
  };
  const keep = async () => {
    const ok = await persistStorage();
    setNote(
      ok
        ? "The browser will keep the models unless you clear them."
        : "The browser did not grant persistent storage; models may be evicted when space is low.",
    );
    await refresh();
  };
  const total = status?.reduce((sum, s) => sum + s.cachedBytes, 0) ?? 0;
  const anyBusy = Object.keys(busy).length > 0;
  return (
    <div className={compact ? "models-panel space-y-2" : "models-panel space-y-3"}>
      <ul className="models-list" aria-label="On-device models">
        {MODELS.map((model) => {
          const entry = status?.find((s) => s.id === model.id);
          const cached = entry?.cachedBytes ?? 0;
          const progress = busy[model.id];
          const ended = outcome[model.id];
          const again = ended === "failed" || ended === "timeout" ? "Retry" : "Download";
          const fetchButton = (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`${again} ${model.label}`}
              disabled={all}
              onClick={() => void download(model.id)}
            >
              {again}
            </Button>
          );
          const clearButton = (
            <Button
              size="sm"
              variant="secondary"
              aria-label={`Clear ${model.label}`}
              onClick={() => void clear(model.id)}
            >
              Clear
            </Button>
          );
          return (
            <li key={model.id} data-busy={progress !== undefined || undefined}>
              <div className="models-name">
                <span>{model.label}</span>
                <small>
                  {progress !== undefined
                    ? progress > 0
                      ? "Downloading and preparing"
                      : "Starting…"
                    : ended
                      ? OUTCOME_TEXT[ended]
                      : cached
                        ? `${model.use} · on this device`
                        : model.use}
                </small>
              </div>
              <span className="models-size">
                {progress !== undefined
                  ? `${Math.round(progress * 100)}%`
                  : cached
                    ? cachedSize(cached)
                    : SIZE_LABEL[model.id]}
              </span>
              {progress !== undefined ? (
                all ? (
                  <span aria-hidden="true" />
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    aria-label={`Cancel ${model.label}`}
                    onClick={() => cancel(model.id)}
                  >
                    Cancel
                  </Button>
                )
              ) : cached && ended && canCache ? (
                // The last wait here didn't finish, so cached files may be only part of the
                // model: Retry reuses them through prepareModel, and clearing is never required.
                <span className="models-actions">
                  {fetchButton}
                  {clearButton}
                </span>
              ) : cached ? (
                clearButton
              ) : !canCache ? null : (
                fetchButton
              )}
              {progress !== undefined && progress > 0 ? (
                <span
                  className="models-progress"
                  role="progressbar"
                  aria-label={`${model.label} download`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress * 100)}
                >
                  <span style={{ transform: `scaleX(${progress})` }} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="edit-note tabular-nums">
        {status
          ? `${formatMB(total)} of models on this device`
          : cacheUnavailable
            ? "Model storage is unavailable. Try reopening this panel."
            : "Reading the cache…"}
        {storage?.quota
          ? ` · ${formatMB(storage.usage)} used of ${formatMB(storage.quota)} available`
          : ""}
        {storage?.persisted ? " · kept by the browser" : ""}
      </p>
      {canCache ? null : (
        <p role="note" className="edit-note">
          Models can’t be saved on this address, so they download again on every visit. Open Cutout
          at http://localhost or over HTTPS to keep them on this device.
        </p>
      )}
      <div className="editor-actions">
        {canCache ? (
          all ? (
            <Button
              size="sm"
              variant="secondary"
              aria-label="Cancel download all"
              onClick={stopAll}
            >
              Cancel
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={anyBusy}
              onClick={() => void downloadAll()}
            >
              Download all now
            </Button>
          )
        ) : null}
        {storage && !storage.persisted ? (
          <Button size="sm" variant="secondary" onClick={() => void keep()}>
            Ask browser to keep them
          </Button>
        ) : null}
      </div>
      {anyBusy ? (
        <p className="edit-note">
          Cancel stops waiting here; a model another tool is already using keeps loading.
        </p>
      ) : null}
      {note ? (
        <p role="status" className="models-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
