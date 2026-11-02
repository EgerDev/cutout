import { useEffect, useState } from "react";
import { exportCaps, prepareExportCaps, webpSupported } from "@/lib/composite";
import type { ExportCaps } from "@/lib/formats";

export function useExportCaps(): ExportCaps {
  const [caps, setCaps] = useState<ExportCaps>(() => ({
    ...exportCaps(),
    webp: webpSupported(),
  }));
  useEffect(() => {
    void prepareExportCaps().then(setCaps);
  }, []);
  return caps;
}
