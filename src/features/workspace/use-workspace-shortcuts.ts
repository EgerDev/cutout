import { useEffect } from "react";
import { fileFromClipboard } from "@/lib/files";
import { isEditableTarget } from "@/lib/utils";
import { useWorkspace } from "@/lib/workspace-store";

export function useWorkspaceShortcuts(actions: {
  readonly openPicker: () => void;
  readonly receive: (files: File[]) => void;
  readonly openHelp: () => void;
}) {
  const { openPicker, receive, openHelp } = actions;
  useEffect(() => {
    const releasePeek = () => useWorkspace.getState().setPeeking(false);
    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (
        document.querySelector(
          '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], dialog[open]',
        )
      )
        return;
      const file = fileFromClipboard(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      receive([file]);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      // A modal owns the keyboard even when focus drops to <body> (a button disabling itself).
      if (document.querySelector('[role="dialog"][data-state="open"]')) return;
      if (target instanceof Element && target.closest('[role="dialog"], [role="menu"], dialog'))
        return;
      const key = event.key.toLowerCase();
      const current = useWorkspace.getState();
      const active = current.items.find((item) => item.id === current.activeId);
      if (key === "escape" && !event.altKey && !event.metaKey && !event.ctrlKey) {
        if (event.repeat) return;
        if (current.inspecting) current.closeInfo();
        else if (current.phase === "adjusting") current.closeAdjust();
        else releasePeek();
        return;
      }
      if (isEditableTarget(target)) return;
      if (event.metaKey || event.ctrlKey) {
        if (!event.altKey && !event.repeat && (key === "z" || key === "y")) {
          event.preventDefault();
          if (key === "y" || event.shiftKey) current.redo();
          else current.undo();
          return;
        }
        if (event.altKey || event.shiftKey || event.repeat) return;
        if (key === "o") {
          event.preventDefault();
          openPicker();
        }
        if (key === "c" && active?.status === "done" && !window.getSelection()?.toString()) {
          event.preventDefault();
          void current.copyActive();
        }
        if (key === "s" && active?.status === "done") {
          event.preventDefault();
          void current.downloadActive();
        }
        // Native paste delivers the image once, without a second clipboard permission request.
        return;
      }
      if (event.altKey) return;
      if (key === "?" && !event.repeat) {
        event.preventDefault();
        releasePeek();
        openHelp();
        return;
      }
      const interactive =
        target instanceof Element && target.closest('button, a, [role="button"], [role="slider"]');
      if (interactive || event.shiftKey || event.repeat) return;
      if (key === " " && active?.status === "done") {
        event.preventDefault();
        current.setPeeking(true);
      }
      if (key === "i" && active?.status === "done") {
        event.preventDefault();
        if (current.inspecting) current.closeInfo();
        else current.openInfo();
      }
      if (key === "m" && active?.status === "done") {
        event.preventDefault();
        current.cycleInspectMode();
      }
      if (key === "g" && active?.status === "done") {
        event.preventDefault();
        current.setShowGuides(!current.showGuides);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") releasePeek();
    };
    const onVisibility = () => {
      if (document.hidden) releasePeek();
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releasePeek);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releasePeek);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [openPicker, receive, openHelp]);
}
