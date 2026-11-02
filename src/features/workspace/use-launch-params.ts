import { useCallback, useEffect, useRef, useState } from "react";
import type { LaunchPlan } from "@/lib/url-api";
import { classifyError } from "@/lib/errors";
import { backgroundPatch, defaults, presetPatch, type EditSettings } from "@/lib/editor/model";
import { runtime } from "@/lib/workspace-runtime";
import { useWorkspace } from "@/lib/workspace-store";
import type { QueueItem, WorkspaceState } from "@/lib/workspace-types";

/**
 * Drives the workspace from the page's query string once (see url-api.ts):
 * loads ?src, applies preset / format / background, and downloads when asked.
 * The parameters are stripped from the address so a reload does not repeat it.
 * A plan that needs confirmation is returned as `pending` and runs only on `confirm`.
 */
let launched = false;

export function useLaunchParams(enabled = true) {
  const [pending, setPending] = useState<LaunchPlan | null>(null);
  const mounted = useRef(false);
  const operation = useRef<AbortController | null>(null);
  const start = useCallback((plan: LaunchPlan) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    void runLaunch(plan, controller.signal);
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (enabled && typeof window !== "undefined" && window.location.search && !launched) {
      launched = true;
      void (async () => {
        const { parseLaunchParams, needsConfirmation } = await import("@/lib/url-api");
        // The ref survives StrictMode's setup/cleanup/setup, but not actual navigation.
        if (!mounted.current) return;
        const plan = parseLaunchParams(window.location.search);
        if (!plan) return;
        window.history.replaceState(window.history.state, "", window.location.pathname);
        if (needsConfirmation(plan, window.location.origin)) setPending(plan);
        else start(plan);
      })();
    }
    return () => {
      mounted.current = false;
      operation.current?.abort();
      operation.current = null;
    };
  }, [enabled, start]);
  const confirm = useCallback(() => {
    if (pending && mounted.current) start(pending);
    setPending(null);
  }, [pending, start]);
  const cancel = useCallback(() => setPending(null), []);
  return { pending, confirm, cancel };
}

async function runLaunch(plan: LaunchPlan, signal = new AbortController().signal) {
  let { job, drop } = runtime;
  const initial = useWorkspace.getState();
  let target = initial.items.find((item) => item.id === initial.activeId) ?? null;
  let settings = target ? initial.settings[target.id] : undefined;
  let mode: "fetch" | "ingest" | "target" | "next" = plan.src
    ? "fetch"
    : target
      ? "target"
      : "next";
  let cancelled = false;
  let result: Blob | null | undefined = target?.status === "done" ? target.resultBlob : undefined;
  let expectedSettings: EditSettings | null = null;
  const ingestion = new AbortController();
  let stop = () => {};
  let resolveCancel: (value: null) => void;
  const cancellation = new Promise<null>((resolve) => {
    resolveCancel = resolve;
  });
  let resolveTarget: (value: QueueItem | null) => void;
  const terminal = new Promise<QueueItem | null>((resolve) => {
    resolveTarget = resolve;
  });
  const release = () => {
    stop();
    signal.removeEventListener("abort", cancel);
  };
  const cancel = () => {
    cancelled = true;
    ingestion.abort();
    release();
    resolveCancel(null);
    resolveTarget(null);
  };
  const sameTarget = () => {
    const s = useWorkspace.getState();
    const owned = target;
    return (
      s.activeId === (owned?.id ?? null) &&
      (!owned ||
        (s.items.find((item) => item.id === owned.id)?.source === owned.source &&
          (result === undefined ||
            (s.items.find((item) => item.id === owned.id)?.resultBlob === result &&
              s.items.find((item) => item.id === owned.id)?.status === "done")) &&
          s.settings[owned.id] === settings))
    );
  };
  const current = () =>
    !cancelled && !signal.aborted && job === runtime.job && drop === runtime.drop && sameTarget();
  const check = (next?: WorkspaceState, previous?: WorkspaceState) => {
    const s = useWorkspace.getState();
    // Accept exactly our one synchronous settings transition. Never suspend observation:
    // another subscriber may make a nested edit/selection before this callback runs.
    if (expectedSettings && target && next && previous) {
      const incoming = next.settings[target.id];
      if (incoming !== settings) {
        if (
          previous.settings[target.id] !== settings ||
          s.settings[target.id] !== incoming ||
          !incoming ||
          Object.keys(incoming).length !== Object.keys(expectedSettings).length ||
          !Object.entries(expectedSettings).every(
            ([key, value]) =>
              Reflect.get(incoming, key) === value ||
              (key === "background" &&
                Object.keys(incoming.background).length ===
                  Object.keys(expectedSettings!.background).length &&
                Object.entries(expectedSettings!.background).every(
                  ([name, entry]) => Reflect.get(incoming.background, name) === entry,
                )),
          )
        )
          return cancel();
        settings = incoming;
        expectedSettings = null;
      }
    }
    if (mode === "next") {
      // A settings-only link on an empty workspace belongs to the first subsequent ingest.
      if (runtime.drop === drop + 1 && (runtime.job === job || runtime.job === job + 1)) {
        drop = runtime.drop;
        mode = "ingest";
      } else if (!current() || s.errorMessage) return cancel();
      else return;
    }
    if (mode === "ingest" && runtime.drop === drop && runtime.job === job + 1) {
      // Observe publication synchronously, before a user can switch away and back during
      // the receiveFiles promise continuation. The receipt below confirms these identities.
      job = runtime.job;
      target = s.items[0] ?? null;
      result = undefined;
      settings = target ? s.settings[target.id] : undefined;
      mode = "target";
    }
    if (!current()) return cancel();
    if (mode !== "target" || !target) return;
    const id = target.id;
    const item = s.items.find((entry) => entry.id === id)!;
    if (item.status === "error") return cancel();
    if (item.status === "done") {
      result = item.resultBlob;
      resolveTarget(item);
    }
  };
  stop = useWorkspace.subscribe(check);
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    check();
    if (plan.src && !cancelled) {
      const { fetchLaunchSource } = await import("@/lib/url-api");
      if (!current()) return;
      const file = await Promise.race([fetchLaunchSource(plan.src, plan.name), cancellation]);
      if (!file || !current()) return;
      mode = "ingest";
      drop++; // ingest claims this drop synchronously, before validating/converting its source.
      const receipt = await Promise.race([
        useWorkspace.getState().receiveFiles([file], ingestion.signal),
        cancellation,
      ]);
      const received = receipt?.items[0];
      if (
        !receipt ||
        !received ||
        !current() ||
        receipt.job !== job ||
        receipt.drop !== drop ||
        received.id !== target?.id ||
        received.source !== target.source
      )
        return;
    }
    const item = await terminal;
    if (!item || !current()) return;
    const apply = (patch: Partial<EditSettings>, action: () => void) => {
      if (!current()) return;
      expectedSettings = { ...(settings ?? defaults), ...patch };
      action();
      expectedSettings = null;
    };
    if (plan.preset)
      apply(presetPatch(plan.preset, item.width ? item : undefined), () =>
        useWorkspace.getState().setPreset(plan.preset!),
      );
    if (plan.background)
      apply(
        backgroundPatch(settings ?? defaults, plan.background),
        () => useWorkspace.getState().setBackground(plan.background!),
      );
    if (plan.format)
      apply({ exportFormat: plan.format }, () =>
        useWorkspace.getState().setExportFormat(plan.format!),
      );
    if (plan.download && current())
      await useWorkspace.getState().downloadActive(plan.format ?? undefined, {
        signal: ingestion.signal,
        isCurrent: current,
      });
  } catch (error) {
    // A fetch/preparation failure belongs to this intent, never a newer workspace.
    if (current()) {
      const failure = error instanceof Error ? classifyError(error) : null;
      // A network failure here is the link's own fetch, not the remover starting.
      const message =
        failure && failure.code !== "model"
          ? failure.message
          : failure
            ? "Couldn’t load the linked image. Check the link and your connection."
            : "Couldn’t load the linked image.";
      useWorkspace
        .getState()
        .reportError(`${message} Choose a file from your device to continue.`);
    }
  } finally {
    release();
  }
}
