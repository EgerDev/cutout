import { create } from "zustand";

export type ShareResult = "shared" | "downloaded" | "aborted" | "unsupported";
type PendingShare = {
  readonly files: readonly File[];
  readonly resolve: (result: ShareResult) => void;
  readonly signal?: AbortSignal;
};
export const useShareReady = create<{ readonly pending: PendingShare | null }>(() => ({
  pending: null,
}));

export function finishShare(request: PendingShare, result: ShareResult) {
  if (useShareReady.getState().pending !== request) return;
  useShareReady.setState({ pending: null });
  request.resolve(result);
}

export function isCurrentShare(request: PendingShare) {
  return !request.signal?.aborted && useShareReady.getState().pending === request;
}

export function requestShare(files: readonly File[], signal?: AbortSignal): Promise<ShareResult> {
  if (signal?.aborted) return Promise.resolve("aborted");
  const previous = useShareReady.getState().pending;
  if (previous) finishShare(previous, "aborted");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const cancel = () => finishShare(request, "aborted");
    const request: PendingShare = {
      files: [...files],
      signal,
      resolve: (result) => {
        signal?.removeEventListener("abort", cancel);
        resolve(result);
      },
    };
    signal?.addEventListener("abort", cancel, { once: true });
    useShareReady.setState({ pending: request });
  });
}
