import assert from "node:assert/strict";
import test from "node:test";
import { attachStageGpu } from "./stage-gpu.ts";

test("2d attachment listeners belong to live handles and cannot revive destroyed ones", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { devicePixelRatio: 1 } });
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const target = new EventTarget();
  const ctx = {
    setTransform() {}, fillRect() {}, drawImage() {},
  };
  const canvas = {
    width: 16, height: 16, clientWidth: 16, clientHeight: 16,
    getContext: (kind: string) => kind === "2d" ? ctx : null,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      const set = listeners.get(type) ?? new Set();
      set.add(fn); listeners.set(type, set); target.addEventListener(type, fn);
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      listeners.get(type)?.delete(fn); target.removeEventListener(type, fn);
    },
  } as unknown as HTMLCanvasElement;
  const frame = { comparing: false, peeking: false, masking: false, wipe: 0.5 };
  const count = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  try {
    const old = await attachStageGpu(canvas);
    assert.equal(old?.kind, "2d");
    assert.equal(count(), 2);
    assert.equal(old!.paint(frame), true);
    old!.destroy();
    assert.equal(count(), 0, "destroy removes both listeners");
    const active = await attachStageGpu(canvas);
    assert.equal(count(), 2, "reattach owns one listener pair");
    const lost = new Event("contextlost", { cancelable: true });
    target.dispatchEvent(lost);
    assert.equal(lost.defaultPrevented, true);
    assert.equal(active!.paint(frame), false, "active renderer pauses while context is lost");
    target.dispatchEvent(new Event("contextrestored"));
    assert.equal(active!.paint(frame), true, "live attachment recovers");
    assert.equal(old!.paint(frame), false, "restore cannot revive a destroyed handle");
    old!.destroy();
    assert.equal(count(), 2, "stale destroy cannot remove the new listeners");
    active!.destroy();
    target.dispatchEvent(new Event("contextrestored"));
    assert.equal(active!.paint(frame), false);
    assert.equal(count(), 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
