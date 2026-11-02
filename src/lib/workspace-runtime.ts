// The queue owns cancellation separately from serializable workspace state.
export const runtime: {
  job: number;
  /** Bumped as each drop starts, before its async preparation (job moves only after). */
  drop: number;
  queueToken: number | null;
  runAbort: AbortController | null;
  itemAborts: Map<string, AbortController>;
} = { job: 0, drop: 0, queueToken: null, runAbort: null, itemAborts: new Map() };
export const PREVIEW_CONCURRENCY = 2;

export function cancelWorkspaceJobs() {
  runtime.runAbort?.abort();
  runtime.runAbort = null;
  for (const controller of runtime.itemAborts.values()) controller.abort();
  runtime.itemAborts.clear();
}
