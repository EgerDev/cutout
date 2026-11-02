import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useShareReady } from "@/lib/share-ready";
import { missingCapabilities } from "@/lib/capabilities";
import { useClient } from "./use-client";
import { fileInputAccept, iosSafariFileInput } from "@/lib/files";
import { useWorkspace } from "@/lib/workspace-store";
import { AppHeader } from "@/features/site/app-header";
import { SiteRail } from "@/features/site/site-rail";
import { DropLayer } from "./drop-layer";
import { ErrorNotice } from "./error-notice";
import { IdleScreen } from "./idle-screen";
import { useWorkspaceDrop } from "./use-workspace-drop";
import { useWorkspaceShortcuts } from "./use-workspace-shortcuts";
import { useLaunchParams } from "./use-launch-params";
import { useUnsavedGuard } from "./use-unsaved-guard";
import { hasUnsavedWork } from "@/lib/workspace-saved";

const ActiveWorkspace = lazy(() => import("./active-workspace").then((m) => ({ default: m.ActiveWorkspace })));
const ShareReadyDialog = lazy(() => import("./share-ready-dialog").then((m) => ({ default: m.ShareReadyDialog })));
const ShortcutHelp = lazy(() => import("./shortcut-help").then((m) => ({ default: m.ShortcutHelp })));
const ModelsDialog = lazy(() => import("./models-dialog").then((m) => ({ default: m.ModelsDialog })));
const LaunchConfirm = lazy(() => import("./launch-confirm").then((m) => ({ default: m.LaunchConfirm })));

export function Workspace() {
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const client = useClient();
  const shareReady = useShareReady((s) => s.pending !== null);
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  // Checked after hydration: the prerendered page cannot know the visitor's browser.
  const [missing, setMissing] = useState<string[] | null>(null);
  useEffect(() => setMissing(missingCapabilities()), []);
  const unsupported = Boolean(missing?.length);
  const isIdle = useWorkspace((state) => state.phase === "idle" && state.items.length === 0);
  const dragging = useWorkspace((state) => state.dragging);
  const errorMessage = useWorkspace((state) => state.errorMessage);
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const [modelsMounted, setModelsMounted] = useState(false);
  const openModels = useCallback(() => { setModelsMounted(true); setModelsOpen(true); }, []);
  const launch = useLaunchParams(missing?.length === 0);
  useUnsavedGuard();
  const [helpMounted, setHelpMounted] = useState(false);
  const [sampleLoading, setSampleLoading] = useState(false);
  const samplePending = useRef(false);
  const openHelp = useCallback(() => { setHelpMounted(true); setHelpOpen(true); }, []);
  const openPicker = useCallback(() => {
    if (fileRef.current) { fileRef.current.value = ""; fileRef.current.click(); }
  }, []);
  const openCamera = useCallback(() => {
    if (cameraRef.current) { cameraRef.current.value = ""; cameraRef.current.click(); }
  }, []);
  const canCamera = client.ios || client.android;
  const receive = useCallback((files: File[] | FileList | null | undefined) => {
    // Nothing would come of it but a model download and an error.
    if (missingCapabilities().length) return;
    if (!files?.length) return;
    if (hasUnsavedWork(useWorkspace.getState()) &&
        !window.confirm("Replace the open images? Unsaved cutouts and edits will be lost.")) return;
    void useWorkspace.getState().receiveFiles(Array.from(files));
  }, []);
  useWorkspaceDrop(dropRef, receive);
  useWorkspaceShortcuts({ openPicker, receive, openHelp });

  const loadSample = async () => {
    if (samplePending.current) return;
    samplePending.current = true;
    setSampleLoading(true);
    try {
      const response = await fetch("/sample.jpg");
      if (!response.ok) throw new Error("Sample unavailable");
      const blob = await response.blob();
      // A chosen image wins if the sample finishes loading later.
      if (useWorkspace.getState().items.length === 0) receive([new File([blob], "sample.jpg", { type: blob.type || "image/jpeg" })]);
    } catch (error) {
      if (error instanceof Error) useWorkspace.getState().reportError("Couldn’t load the sample. Choose an image or try again.");
      else throw error;
    } finally { samplePending.current = false; setSampleLoading(false); }
  };

  return <main className="relative min-h-dvh bg-bg text-fg">
    <input ref={fileRef} type="file" accept={fileInputAccept(client)} multiple
      className={iosSafariFileInput(client) ? "file-input" : "sr-only"} tabIndex={-1}
      aria-hidden="true" aria-label="Choose files"
      onChange={(event) => { receive(event.target.files); event.currentTarget.value = ""; }} />
    {canCamera ? (
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="file-input"
        tabIndex={-1}
        aria-hidden="true"
        aria-label="Take photo"
        onChange={(event) => { receive(event.target.files); event.currentTarget.value = ""; }}
      />
    ) : null}
    <AppHeader idle={isIdle} onReset={() => useWorkspace.getState().reset()} onChoose={openPicker} onHelp={openHelp} />
    {isIdle && unsupported ? <>
      <div className="idle-shell flex min-h-dvh flex-col">
        <div className="idle-stack">
          <h1 className="max-w-[20ch] text-[clamp(1.75rem,5vw,2.75rem)] font-semibold leading-[1.1] tracking-tight">This browser can’t run Cutout.</h1>
          <p className="text-[15px] text-muted">Use a current Chrome, Edge, Firefox, or Safari 16.4 or later.</p>
        </div>
      </div>
      <SiteRail />
    </> : isIdle ? <>
      <IdleScreen ready={interactive} receding={dragging} onChoose={openPicker} onCamera={canCamera ? openCamera : undefined} onSample={() => void loadSample()} sampleLoading={sampleLoading} onModels={openModels} />
      <SiteRail />
    </> : <div className="workspace-frame transition-opacity duration-[var(--motion-fast)] ease-[var(--ease-out)]" style={{ opacity: dragging ? 0.4 : 1 }}>
      <Suspense fallback={<p role="status" className="m-auto text-sm text-muted">Opening image…</p>}>
        <ActiveWorkspace mobile={client.compact} />
      </Suspense>
    </div>}
    {shareReady ? <Suspense fallback={null}><ShareReadyDialog /></Suspense> : null}
    {errorMessage ? <ErrorNotice message={errorMessage} /> : null}
    <DropLayer ref={dropRef} open={dragging} replacing={!isIdle} />
    {helpMounted ? <Suspense fallback={null}><ShortcutHelp open={helpOpen} onOpenChange={setHelpOpen} /></Suspense> : null}
    {modelsMounted ? <Suspense fallback={null}><ModelsDialog open={modelsOpen} onOpenChange={setModelsOpen} /></Suspense> : null}
    {launch.pending ? <Suspense fallback={null}><LaunchConfirm plan={launch.pending} onConfirm={launch.confirm} onCancel={launch.cancel} /></Suspense> : null}
  </main>;
}
