import { useEffect, useState } from "react";

export function useSheetInert(open: boolean) {
  const [inert, setInert] = useState(!open);
  useEffect(() => {
    const reduced =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const delay = reduced ? 0 : open ? 220 : 160;
    const id = window.setTimeout(() => setInert(!open), delay);
    return () => clearTimeout(id);
  }, [open]);
  return inert;
}
