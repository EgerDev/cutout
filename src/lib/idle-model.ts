type Progress = ((fraction: number) => void) | undefined;

type LoadState<T> = {
  readonly id: number;
  promise: Promise<T>;
  users: number;
  pendingWaiters: number;
  computing: number;
  settled: boolean;
  abandoned: boolean;
  released: boolean;
  fraction?: number;
  value?: T;
};

export function prepareTimeoutError(message = "Model preparation timed out.") {
  return new DOMException(message, "TimeoutError");
}

export function isPrepareTimeout(error: unknown): boolean {
  return error instanceof DOMException && error.name === "TimeoutError";
}

/** Remaining wait budget after `started`. `undefined`/`Infinity` stay unbounded. */
export function remainingPrepareMs(started: number, timeoutMs?: number): number | undefined {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 0)
    return timeoutMs;
  return Math.max(0, timeoutMs - (Date.now() - started));
}

/**
 * `pending`, or abort/timeout as soon as either fires. Does not cancel `pending`.
 * Always observes `pending` so a late rejection cannot become unhandled.
 * No AbortSignal.any (Safari < 17.4).
 */
export function waitForIdle<T>(
  pending: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<T> {
  const { signal, timeoutMs, onTimeout } = options;
  const timed = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0;
  if (!signal && !timed) return pending;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (action: () => void) => {
      if (done) return;
      done = true;
      cleanup();
      action();
    };
    const onAbort = () => finish(() => reject(signal!.reason));
    const expire = () =>
      finish(() => {
        onTimeout?.();
        reject(prepareTimeoutError());
      });
    void pending.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }
    if (timed && !done) timer = setTimeout(expire, timeoutMs);
  });
}

/** Combine a caller signal with an optional deadline. Caller must `stop()` when the wait ends. */
export function withPrepareDeadline(options: { signal?: AbortSignal; timeoutMs?: number } = {}): {
  signal?: AbortSignal;
  stop: () => void;
} {
  const timed =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs >= 0;
  if (!options.signal && !timed) return { signal: undefined, stop() {} };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const onAbort = () => {
    stop();
    controller.abort(options.signal?.reason);
  };
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort(options.signal.reason);
      return { signal: controller.signal, stop };
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
  }
  if (timed) {
    timer = setTimeout(() => {
      stop();
      controller.abort(prepareTimeoutError());
    }, options.timeoutMs);
  }
  return { signal: controller.signal, stop };
}

function looksLikeDeviceLoss(error: unknown) {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /device(?: was)? lost|GPUDevice\.lost|uncapturederror/i.test(text);
}

/**
 * A lazily loaded model that is disposed `idleMs` after its last use: an ONNX
 * session pins hundreds of MB of WASM or GPU memory that never shrinks on its own.
 * A failed load is remembered for `retryMs`, so a caller that runs on every
 * preview render cannot turn an outage into a download loop; `retry` skips that.
 *
 * A deadline or the last cancelled pending waiter abandons the generation so a
 * later `retry` starts a new load instead of joining a never-settling singleton.
 * Cancel only stops this wait; a session another consumer is computing with is kept.
 */
export function idleModel<T>(
  load: (onProgress: Progress) => Promise<T>,
  dispose: (model: T) => unknown,
  {
    idleMs = 60_000,
    retryMs = 30_000,
    isBroken,
  }: { idleMs?: number; retryMs?: number; isBroken?: (model: T) => boolean } = {},
) {
  let current: LoadState<T> | null = null;
  let nextId = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failedAt = -Infinity;
  let failure: unknown;
  const listeners = new Set<{ id: number; fn: NonNullable<Progress> }>();

  const disposeModel = (model: T) => {
    void Promise.resolve(model)
      .then(dispose)
      .catch(() => {});
  };

  const detach = (state: LoadState<T>) => {
    if (current === state) current = null;
  };

  const disposeState = (state: LoadState<T>) => {
    if (state.released) return;
    state.released = true;
    if (state.value !== undefined) {
      const model = state.value;
      state.value = undefined;
      disposeModel(model);
      return;
    }
    void state.promise.then(
      (model) => {
        if (state.computing === 0) disposeModel(model);
      },
      () => {},
    );
  };

  const scheduleRelease = (state: LoadState<T>) => {
    if (state.users > 0 || state.computing > 0) return;
    if (state === current && !state.abandoned) {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (current !== state || state.users || state.computing) return;
        current = null;
        disposeState(state);
      }, idleMs);
      return;
    }
    detach(state);
    disposeState(state);
  };

  const abandon = (state: LoadState<T>) => {
    state.abandoned = true;
    detach(state);
  };

  const release = () => {
    clearTimeout(timer);
    const state = current;
    if (!state || state.users || state.computing) return;
    current = null;
    disposeState(state);
  };

  // A page kept in the back/forward cache has its timers frozen: release on the way out.
  globalThis.addEventListener?.("pagehide", release);

  return {
    async use<R>(
      run: (model: T) => R | Promise<R>,
      options: {
        onProgress?: Progress;
        retry?: boolean;
        signal?: AbortSignal;
        timeoutMs?: number;
      } = {},
    ): Promise<R> {
      options.signal?.throwIfAborted();
      clearTimeout(timer);
      if (current && (current.abandoned || current.released)) current = null;
      if (current?.value !== undefined && isBroken?.(current.value)) {
        const dead = current;
        abandon(dead);
        disposeState(dead);
      }
      if (!options.retry && !current && Date.now() - failedAt < retryMs) throw failure;
      if (!current) {
        const id = nextId++;
        const state: LoadState<T> = {
          id,
          users: 0,
          pendingWaiters: 0,
          computing: 0,
          settled: false,
          abandoned: false,
          released: false,
          promise: null as unknown as Promise<T>,
        };
        current = state;
        state.promise = load((next) => {
          state.fraction = next;
          for (const listener of listeners) if (listener.id === id) listener.fn(next);
        }).then(
          (model) => {
            state.settled = true;
            state.value = model;
            if (current === state) failedAt = -Infinity;
            return model;
          },
          (error) => {
            state.settled = true;
            if (current === state) {
              current = null;
              failedAt = Date.now();
              failure = error;
            }
            throw error;
          },
        );
      }
      const state = current;
      const listener = options.onProgress ? { id: state.id, fn: options.onProgress } : undefined;
      if (listener) {
        listeners.add(listener);
        if (state.fraction !== undefined) listener.fn(state.fraction);
      }
      state.users += 1;
      state.pendingWaiters += 1;
      let skipRun = false;
      let pendingWaiter = true;
      const leavePending = () => {
        if (!pendingWaiter) return;
        pendingWaiter = false;
        state.pendingWaiters -= 1;
      };
      const orphanIfIdlePending = () => {
        if (state.pendingWaiters === 0 && state.computing === 0 && !state.settled) abandon(state);
      };
      // Keep the model held until its actual computation ends, even if this caller
      // stops waiting: disposing a live ONNX session is not cancellation.
      const operation = (async () => {
        try {
          const model = await state.promise;
          options.signal?.throwIfAborted();
          if (skipRun) throw prepareTimeoutError();
          leavePending();
          state.computing += 1;
          try {
            return await run(model);
          } catch (error) {
            if (looksLikeDeviceLoss(error) || isBroken?.(model)) abandon(state);
            throw error;
          } finally {
            state.computing -= 1;
          }
        } finally {
          leavePending();
          state.users -= 1;
          if (listener) listeners.delete(listener);
          scheduleRelease(state);
        }
      })();
      try {
        return await waitForIdle(operation, {
          signal: options.signal,
          timeoutMs: options.timeoutMs,
          onTimeout: () => {
            skipRun = true;
            leavePending();
            abandon(state);
          },
        });
      } catch (error) {
        if (options.signal?.aborted) {
          skipRun = true;
          leavePending();
          orphanIfIdlePending();
        }
        throw error;
      } finally {
        if (listener) listeners.delete(listener);
      }
    },
    /** Dispose now unless a run is in progress (after an offline download). */
    release,
  };
}
