/**
 * What the workspace offers next, in order: the capsule's Stop or Retry, the batch's Stop or
 * Resume, Download, and last the workspace heading, which only takes focus from script.
 */
const NEXT = [".status-capsule-action", ".summary-action", ".download-main", "#workspace-heading"];

/**
 * Ref callback for a control that can disappear while it has keyboard focus: Stop or Retry
 * when the cutout finishes, a notice's Retry or Dismiss. The browser would drop focus to the
 * page and the next Tab would start again at the logo; this moves it to what comes next.
 * React runs the cleanup while the element is still in the document.
 */
export function focusNextOnRemove(element: HTMLElement | null) {
  if (!element) return;
  return () => {
    if (element !== document.activeElement) return;
    // After React has rendered what replaces it.
    requestAnimationFrame(() => {
      const current = document.activeElement;
      if (current && current !== document.body && current.isConnected) return;
      for (const selector of NEXT) {
        const next = document.querySelector<HTMLElement>(selector);
        if (!next || next.matches(":disabled")) continue;
        next.focus();
        if (document.activeElement === next) return;
      }
    });
  };
}
