import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { downloadBlob, isSaveAbort } from "@/lib/files";
import { finishShare, isCurrentShare, useShareReady } from "@/lib/share-ready";
import { EditorDialog } from "./editor-dialog";

export function ShareReadyDialog() {
  const request = useShareReady((state) => state.pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    setBusy(false);
    setError("");
    return () => {
      mounted.current = false;
      // Abort only on a real unmount. StrictMode runs this cleanup and re-runs the
      // effect synchronously on mount; deciding a microtask later sees the remount.
      queueMicrotask(() => {
        if (!mounted.current && request) finishShare(request, "aborted");
      });
    };
  }, [request]);
  if (!request) return null;
  const first = request.files[0];
  const share = async () => {
    if (!isCurrentShare(request)) return;
    setBusy(true);
    setError("");
    // Call synchronously in the click handler: encoding already finished.
    try {
      await navigator.share({ files: [...request.files] });
      finishShare(request, "shared");
    } catch (reason) {
      if (!isCurrentShare(request) || !mounted.current) return;
      if (isSaveAbort(reason)) finishShare(request, "aborted");
      else {
        setBusy(false);
        setError("Sharing is unavailable. You can download the file instead.");
      }
    }
  };
  return (
    <EditorDialog
      open
      onOpenChange={(open) => {
        if (!open) finishShare(request, "aborted");
      }}
      title="Your image is ready"
      description="Save to Photos, Files, or share with another app."
    >
      <p className="mt-4 break-all text-sm">{first?.name}</p>
      <div className="editor-actions">
        <Button variant="primary" disabled={busy} onClick={() => void share()}>
          {busy ? "Sharing…" : "Share image"}
        </Button>
        {request.files.length === 1 && first ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              if (!isCurrentShare(request)) return;
              const downloaded = downloadBlob(first, first.name);
              if (!isCurrentShare(request)) return;
              if (downloaded) finishShare(request, "downloaded");
              else setError("Could not start the download. Please try again.");
            }}
          >
            Download file
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm">
          {error}
        </p>
      ) : null}
    </EditorDialog>
  );
}
