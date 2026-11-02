import { useEffect, useState } from "react";
import { COMPACT_QUERY, SERVER_ENV, readClient, type ClientProfile } from "@/lib/device";

function onMediaChange(media: MediaQueryList, listener: () => void) {
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

/**
 * Starts from the server profile and reads the real one after mount. Reading
 * navigator during the first client render made phones hydrate against markup
 * the server never produced (the camera input, the iOS file-input class), so
 * React threw the server DOM away and re-rendered from scratch on every load.
 * Lives here, not in lib/device.ts, so the removal worker that reads the
 * environment from device.ts does not bundle React.
 */
export function useClient() {
  const [client, setClient] = useState<ClientProfile>(() => readClient(SERVER_ENV));
  useEffect(() => {
    const update = () => setClient(readClient());
    update();
    let unbindCompact: (() => void) | undefined;
    try {
      if (typeof window.matchMedia === "function") {
        unbindCompact = onMediaChange(window.matchMedia(COMPACT_QUERY), update);
      }
    } catch {
      unbindCompact = undefined;
    }
    return () => {
      unbindCompact?.();
    };
  }, []);
  return client;
}
