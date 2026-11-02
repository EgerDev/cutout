import { useEffect, useRef, type RefObject } from "react";
import { createDropSession } from "@/lib/drop-session";
import { filesFromDrop, isCutoutExportDrag, isFileTransfer } from "@/lib/files";
import { useWorkspace } from "@/lib/workspace-store";

export function useWorkspaceDrop(dropRef: RefObject<HTMLDivElement | null>, receive: (files: File[]) => void) {
  const dropSession = useRef(createDropSession());
  useEffect(() => {
    let rafId: number | null = null;
    let pendingX = 0;
    let pendingY = 0;

    const flushCoords = () => {
      rafId = null;
      const node = dropRef.current;
      if (!node) return;
      const offsetX = Math.max(-8, Math.min(8, (pendingX - window.innerWidth / 2) * 0.018));
      const offsetY = Math.max(-8, Math.min(8, (pendingY - window.innerHeight / 2) * 0.018));
      node.style.setProperty("--drop-offset-x", `${offsetX}px`);
      node.style.setProperty("--drop-offset-y", `${offsetY}px`);
    };

    const updateCoords = (x: number, y: number) => {
      pendingX = x;
      pendingY = y;
      if (rafId === null) {
        rafId = requestAnimationFrame(flushCoords);
      }
    };

    const session = dropSession.current;
    const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });
    // A modal owns the workspace, as for paste: a drop under it would replace every image
    // behind the dialog. Still taken (prevented), so the browser does not open the file.
    const modalOpen = () =>
      document.querySelector(
        '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], dialog[open]',
      ) !== null;
    const relatedInside = (related: unknown) => related instanceof Node && document.documentElement.contains(related);
    const armDrop = (event: DragEvent) => {
      if (!event.dataTransfer || isCutoutExportDrag() || !isFileTransfer(event.dataTransfer)) return false;
      event.preventDefault();
      if (modalOpen()) {
        event.dataTransfer.dropEffect = "none";
        return false;
      }
      event.dataTransfer.dropEffect = "copy";
      if (session.acceptCoords(event.clientX, event.clientY)) {
        updateCoords(event.clientX, event.clientY);
      }
      return true;
    };
    const endDrop = () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      session.reset();
      const node = dropRef.current;
      if (node) {
        node.style.setProperty("--drop-offset-x", "0px");
        node.style.setProperty("--drop-offset-y", "0px");
      }
      if (useWorkspace.getState().dragging) {
        useWorkspace.getState().setDragging(false);
      }
    };
    const onDragEnter = (event: DragEvent) => {
      if (!armDrop(event)) return;
      session.enter(event.target);
      if (!useWorkspace.getState().dragging) {
        useWorkspace.getState().setDragging(true);
      }
    };
    const onDragOver = (event: DragEvent) => {
      if (!armDrop(event)) return;
      // Types can populate only after the first dragover — arm even if enter was skipped.
      if (!useWorkspace.getState().dragging) {
        session.enter(event.target);
        useWorkspace.getState().setDragging(true);
      }
    };
    const onDragLeave = (event: DragEvent) => {
      const ended = session.leave(
        {
          target: event.target,
          relatedTarget: event.relatedTarget,
          clientX: event.clientX,
          clientY: event.clientY,
        },
        viewport(),
        relatedInside,
      );
      if (ended) endDrop();
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer || isCutoutExportDrag() || !isFileTransfer(event.dataTransfer)) return;
      event.preventDefault();
      endDrop();
      if (modalOpen()) return;
      receive(filesFromDrop(event.dataTransfer));
    };
    const opts = { capture: true } as const;
    document.addEventListener("dragenter", onDragEnter, opts);
    document.addEventListener("dragover", onDragOver, opts);
    document.addEventListener("dragleave", onDragLeave, opts);
    document.addEventListener("drop", onDrop, opts);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      session.reset();
      document.removeEventListener("dragenter", onDragEnter, opts);
      document.removeEventListener("dragover", onDragOver, opts);
      document.removeEventListener("dragleave", onDragLeave, opts);
      document.removeEventListener("drop", onDrop, opts);
    };
  }, [dropRef, receive]);
}
