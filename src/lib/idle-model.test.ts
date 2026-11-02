import assert from "node:assert/strict";
import test from "node:test";
import { idleModel, isPrepareTimeout, remainingPrepareMs, waitForIdle } from "./idle-model.ts";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a model is loaded once, disposed after idling, and reloaded on next use", async () => {
  let loads = 0;
  const disposed: number[] = [];
  const model = idleModel(
    async () => ++loads,
    (n) => disposed.push(n),
    { idleMs: 20 },
  );
  assert.deepEqual(await Promise.all([model.use((n) => n), model.use((n) => n)]), [1, 1]);
  await tick(40);
  assert.deepEqual(disposed, [1]);
  assert.equal(await model.use((n) => n), 2);
  model.release();
  await tick(0);
  assert.deepEqual(disposed, [1, 2]);
});

test("a model in use is not disposed under it", async () => {
  const disposed: number[] = [];
  const model = idleModel(
    async () => 1,
    (n) => disposed.push(n),
    { idleMs: 5 },
  );
  await model.use(async () => {
    model.release();
    await tick(20);
  });
  assert.deepEqual(disposed, []);
  await tick(20);
  assert.deepEqual(disposed, [1]);
});

test("a failed load is remembered briefly unless the caller asks to retry", async () => {
  let loads = 0;
  const model = idleModel(
    async () => {
      loads += 1;
      if (loads === 1) throw new Error("offline");
      return loads;
    },
    () => {},
    { idleMs: 5, retryMs: 10_000 },
  );
  await assert.rejects(
    model.use((n) => n),
    /offline/,
  );
  await assert.rejects(
    model.use((n) => n),
    /offline/,
  );
  assert.equal(loads, 1);
  assert.equal(await model.use((n) => n, { retry: true }), 2);
  await tick(10);
});

test("a caller joins a retry that is already loading instead of repeating the old failure", async () => {
  let loads = 0;
  const model = idleModel(
    async () => {
      loads += 1;
      if (loads === 1) throw new Error("offline");
      return loads;
    },
    () => {},
    { idleMs: 5, retryMs: 10_000 },
  );
  await assert.rejects(
    model.use((n) => n),
    /offline/,
  );
  const retried = model.use((n) => n, { retry: true });
  assert.equal(await model.use((n) => n), 2, "joined the load the retry started");
  assert.equal(await retried, 2);
  assert.equal(loads, 2);
  await tick(10);
});

test("shared loads report progress to late callers and detach cancelled callers", async () => {
  let report: ((n: number) => void) | undefined;
  let finish!: (n: number) => void;
  const model = idleModel(
    (progress) => {
      report = progress;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
    () => {},
    { idleMs: 5 },
  );
  const first: number[] = [],
    second: number[] = [];
  const controller = new AbortController();
  let ran = false;
  const a = model.use(
    () => {
      ran = true;
    },
    { onProgress: (n) => first.push(n), signal: controller.signal },
  );
  const rejected = assert.rejects(a, { name: "AbortError" });
  report?.(0.3);
  const b = model.use((n) => n, { onProgress: (n) => second.push(n) });
  assert.deepEqual(second, [0.3], "joining caller sees current load progress");
  controller.abort();
  assert.equal(
    await Promise.race([rejected.then(() => "aborted"), tick(20).then(() => "pending")]),
    "aborted",
  );
  report?.(0.8);
  finish(7);
  assert.equal(await b, 7);
  assert.equal(ran, false, "cancelled load waiter never starts inference");
  assert.deepEqual(first, [0.3]);
  assert.deepEqual(second, [0.3, 0.8]);
  model.release();
});

test("cancelling a running caller releases its wait but retains the model until compute ends", async () => {
  let finish!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let disposed = 0;
  const model = idleModel(
    async () => 1,
    () => {
      disposed++;
    },
    { idleMs: 5 },
  );
  const controller = new AbortController();
  const a = model.use(
    async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
    { signal: controller.signal },
  );
  const rejected = assert.rejects(a, { name: "AbortError" });
  await ready;
  controller.abort();
  assert.equal(
    await Promise.race([rejected.then(() => "aborted"), tick(20).then(() => "pending")]),
    "aborted",
  );
  model.release();
  assert.equal(disposed, 0);
  finish();
  await tick(10);
  assert.equal(disposed, 1);
});

test("a never-settling load times out and a retry starts a new generation", async () => {
  let loads = 0;
  let finish!: (n: number) => void;
  const disposed: number[] = [];
  const model = idleModel(
    () => {
      loads += 1;
      if (loads === 1) return new Promise<number>(() => {});
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
    (n) => disposed.push(n),
    { idleMs: 5 },
  );
  const first = model.use((n) => n, { timeoutMs: 20 });
  await assert.rejects(first, (error: unknown) => isPrepareTimeout(error));
  assert.equal(loads, 1);
  const retried = model.use((n) => n, { retry: true });
  assert.equal(loads, 2, "retry must not join the never-settling singleton");
  finish(9);
  assert.equal(await retried, 9);
  await tick(10);
});

test("a deadline followed by a healthy retry disposes a late abandoned success", async () => {
  let loads = 0;
  let finishFirst!: (n: number) => void;
  const disposed: number[] = [];
  const model = idleModel(
    () => {
      loads += 1;
      if (loads === 1)
        return new Promise<number>((resolve) => {
          finishFirst = resolve;
        });
      return Promise.resolve(2);
    },
    (n) => disposed.push(n),
    { idleMs: 5 },
  );
  const timedOut = model.use((n) => n, { timeoutMs: 20 });
  await assert.rejects(timedOut, (error: unknown) => isPrepareTimeout(error));
  assert.equal(await model.use((n) => n, { retry: true }), 2);
  finishFirst(1);
  await tick(20);
  assert.ok(disposed.includes(1), "abandoned late success is disposed");
  assert.equal(loads, 2);
});

test("late failure of an abandoned generation does not poison a healthy retry", async () => {
  let loads = 0;
  let failFirst!: (error: Error) => void;
  const model = idleModel(
    () => {
      loads += 1;
      if (loads === 1)
        return new Promise<number>((_, reject) => {
          failFirst = reject;
        });
      return Promise.resolve(2);
    },
    () => {},
    { idleMs: 5, retryMs: 10_000 },
  );
  const timedOut = model.use((n) => n, { timeoutMs: 20 });
  await assert.rejects(timedOut, (error: unknown) => isPrepareTimeout(error));
  const retried = model.use((n) => n, { retry: true });
  failFirst(new Error("late offline"));
  await tick(0);
  assert.equal(await retried, 2);
  assert.equal(loads, 2);
});

test("stale progress from an abandoned load does not reach a newer operation", async () => {
  let reportFirst: ((n: number) => void) | undefined;
  let reportSecond: ((n: number) => void) | undefined;
  let loads = 0;
  const model = idleModel(
    (progress) => {
      loads += 1;
      if (loads === 1) {
        reportFirst = progress;
        return new Promise<number>(() => {});
      }
      reportSecond = progress;
      return new Promise<number>((resolve) => {
        queueMicrotask(() => resolve(2));
      });
    },
    () => {},
    { idleMs: 5 },
  );
  const first: number[] = [];
  const second: number[] = [];
  const timedOut = model.use(() => undefined, {
    timeoutMs: 20,
    onProgress: (n) => first.push(n),
  });
  await tick(0);
  reportFirst?.(0.2);
  await assert.rejects(timedOut, (error: unknown) => isPrepareTimeout(error));
  const retried = model.use((n) => n, { retry: true, onProgress: (n) => second.push(n) });
  reportFirst?.(0.9);
  reportSecond?.(0.4);
  assert.equal(await retried, 2);
  assert.deepEqual(first, [0.2]);
  assert.ok(!second.includes(0.9), "abandoned generation must not report to the retry");
  assert.ok(second.includes(0.4));
});

test("another waiter survives a sibling timeout and still receives the shared model", async () => {
  let finish!: (n: number) => void;
  const model = idleModel(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
    () => {},
    { idleMs: 5 },
  );
  const timedOut = model.use((n) => n, { timeoutMs: 20 });
  const live = model.use((n) => n);
  await assert.rejects(timedOut, (error: unknown) => isPrepareTimeout(error));
  finish(4);
  assert.equal(await live, 4);
});

test("remainingPrepareMs clamps a spent budget and leaves unbounded values alone", () => {
  assert.equal(remainingPrepareMs(Date.now() - 50, 20), 0);
  assert.ok((remainingPrepareMs(Date.now(), 20) ?? 99) <= 20);
  assert.equal(remainingPrepareMs(Date.now(), undefined), undefined);
  assert.equal(remainingPrepareMs(Date.now(), Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
});

test("waitForIdle observes a pre-aborted pending promise so a late failure is handled", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const controller = new AbortController();
    controller.abort();
    let fail!: (error: Error) => void;
    const pending = new Promise<number>((_, reject) => {
      fail = reject;
    });
    await assert.rejects(waitForIdle(pending, { signal: controller.signal }), {
      name: "AbortError",
    });
    fail(new Error("late worker failure"));
    await tick(0);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a late success before retry never leaves a disposed model cached", async () => {
  let finish!: () => void;
  let loads = 0;
  const disposals: number[] = [];
  const model = idleModel(
    () => {
      const session = { id: ++loads, disposed: false };
      return loads === 1
        ? new Promise<{ id: number; disposed: boolean }>((resolve) => {
            finish = () => resolve(session);
          })
        : Promise.resolve(session);
    },
    (session) => {
      session.disposed = true;
      disposals.push(session.id);
    },
    { idleMs: 5 },
  );
  await assert.rejects(
    model.use(() => {}, { timeoutMs: 10 }),
    (error: unknown) => isPrepareTimeout(error),
  );
  finish();
  await tick(0);
  await model.use(
    (session) => {
      assert.equal(session.disposed, false);
    },
    { retry: true },
  );
  assert.equal(loads, 2);
  assert.ok(disposals.includes(1));
  model.release();
});

test("a timeout during compute then completion before retry never returns a disposed session", async () => {
  let loads = 0;
  const disposals: number[] = [];
  let finishRun!: () => void;
  const model = idleModel(
    async () => ({ id: ++loads, disposed: false }),
    (session) => {
      session.disposed = true;
      disposals.push(session.id);
    },
    { idleMs: 5 },
  );
  const first = model.use(
    () =>
      new Promise<void>((resolve) => {
        finishRun = resolve;
      }),
    { timeoutMs: 10 },
  );
  await assert.rejects(first, (error: unknown) => isPrepareTimeout(error));
  finishRun();
  await tick(0);
  assert.equal(disposals.filter((id) => id === 1).length, 1);
  await model.use(
    (session) => {
      assert.equal(session.disposed, false);
      assert.equal(session.id, 2);
    },
    { retry: true },
  );
  model.release();
});

test("a sibling timeout then a third use does not receive a disposed session", async () => {
  let finish!: () => void;
  let loads = 0;
  const model = idleModel(
    () =>
      new Promise<{ id: number; disposed: boolean }>((resolve) => {
        const session = { id: ++loads, disposed: false };
        finish = () => resolve(session);
      }),
    (session) => {
      session.disposed = true;
    },
    { idleMs: 5 },
  );
  const short = model.use(() => {}, { timeoutMs: 10 });
  const live = model.use((session) => {
    assert.equal(session.disposed, false);
    return session.id;
  });
  await assert.rejects(short, (error: unknown) => isPrepareTimeout(error));
  finish();
  assert.equal(await live, 1);
  await tick(0);
  const next = model.use(
    (session) => {
      assert.equal(session.disposed, false);
    },
    { retry: true },
  );
  if (loads > 1) finish();
  await next;
  model.release();
});

test("the last cancelled pending waiter lets a retry start a new generation", async () => {
  let loads = 0;
  let finish!: (n: number) => void;
  const model = idleModel(
    () =>
      ++loads === 1
        ? new Promise<number>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(2),
    () => {},
    { idleMs: 5 },
  );
  const cancel = new AbortController();
  const first = model.use((n) => n, { signal: cancel.signal, timeoutMs: 100 });
  cancel.abort();
  await assert.rejects(first, { name: "AbortError" });
  const retried = model.use((n) => n, { retry: true });
  assert.equal(loads, 2, "retry must not join the cancelled never-settling generation");
  assert.equal(await retried, 2);
  finish(1);
  await tick(0);
  model.release();
});

test("cancelling one pending waiter keeps a sibling on the shared load", async () => {
  let finish!: (n: number) => void;
  let loads = 0;
  const model = idleModel(
    () => {
      loads += 1;
      return new Promise<number>((resolve) => {
        finish = resolve;
      });
    },
    () => {},
    { idleMs: 5 },
  );
  const cancel = new AbortController();
  const cancelled = model.use((n) => n, { signal: cancel.signal });
  const live = model.use((n) => n);
  cancel.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  assert.equal(loads, 1);
  finish(4);
  assert.equal(await live, 4);
  model.release();
});

test("a device-loss during compute drops the session so the next use reloads", async () => {
  let loads = 0;
  const disposed: number[] = [];
  const model = idleModel(
    async () => ++loads,
    (n) => disposed.push(n),
    { idleMs: 5 },
  );
  await assert.rejects(
    model.use(() => {
      throw new Error("The GPUDevice was lost.");
    }),
    /device was lost/i,
  );
  await tick(0);
  assert.deepEqual(disposed, [1], "lost session is not kept for the idle timer");
  assert.equal(await model.use((n) => n), 2);
});

test("a broken session is dropped so a later no-op use loads again", async () => {
  let loads = 0;
  const disposed: number[] = [];
  const model = idleModel(
    async () => ({ id: ++loads, broken: false }),
    (session) => disposed.push(session.id),
    { idleMs: 60_000, isBroken: (session) => session.broken },
  );
  await assert.rejects(
    model.use((session) => {
      session.broken = true;
      throw new Error("Depth worker stopped responding. Try again.");
    }),
    /stopped responding/,
  );
  await tick(0);
  assert.deepEqual(disposed, [1]);
  assert.equal(await model.use((session) => session.id), 2);
  const idle = await model.use((session) => session);
  idle.broken = true;
  assert.equal(await model.use(() => "ready"), "ready");
  assert.equal(loads, 3);
  assert.ok(disposed.includes(2));
  model.release();
});
