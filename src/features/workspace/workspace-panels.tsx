import { useEffect } from "react";
import { inspectImageMetadata } from "@/lib/metadata-client";
import { useWorkspace } from "@/lib/workspace-store";
import { AdjustPanel } from "./adjust-panel";
import { InfoPanel } from "./info-panel";

export function WorkspacePanels({ mobile }: { mobile: boolean }) {
  const activeId = useWorkspace((state) => state.activeId);
  const hasItem = useWorkspace((state) => state.items.some((item) => item.id === state.activeId));
  const metadataSource = useWorkspace(
    (state) => state.items.find((item) => item.id === state.activeId)?.source,
  );
  useEffect(() => {
    if (!metadataSource) return;
    let current = true;
    const warm = () => {
      void inspectImageMetadata(metadataSource)
        .then((report) => {
          if (current) useWorkspace.setState({ metadata: report });
        })
        .catch(() => undefined);
    };
    const idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(warm, { timeout: 800 })
        : window.setTimeout(warm, 120);
    return () => {
      current = false;
      if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
      else clearTimeout(idle);
    };
  }, [metadataSource]);
  if (!hasItem || !activeId) return null;

  return (
    <>
      <AdjustSheet mobile={mobile} />
      <InfoSheet mobile={mobile} />
    </>
  );
}

function AdjustSheet({ mobile }: { mobile: boolean }) {
  const open = useWorkspace((state) => {
    const item = state.items.find((entry) => entry.id === state.activeId);
    return state.phase === "adjusting" && !state.inspecting && item?.status === "done";
  });
  return <AdjustPanel open={open} mobile={mobile} />;
}

function InfoSheet({ mobile }: { mobile: boolean }) {
  const open = useWorkspace((state) => {
    const item = state.items.find((entry) => entry.id === state.activeId);
    return state.inspecting && item?.status === "done";
  });
  return <InfoPanel open={open} mobile={mobile} />;
}
