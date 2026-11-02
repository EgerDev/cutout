import assert from "node:assert/strict";
import test from "node:test";
import { runPool } from "./pool.ts";

test("runPool never exceeds the concurrency limit", async () => {
  let live = 0;
  let max = 0;
  const seen: number[] = [];
  await runPool([1, 2, 3, 4, 5], 2, async (item) => {
    live += 1;
    max = Math.max(max, live);
    seen.push(item);
    await new Promise((resolve) => setTimeout(resolve, 15));
    live -= 1;
  });
  assert.equal(max, 2);
  assert.deepEqual(seen.slice().sort(), [1, 2, 3, 4, 5]);
});

test("runPool with limit 1 is serial", async () => {
  const seen: number[] = [];
  await runPool([1, 2, 3], 1, async (item) => {
    seen.push(item);
  });
  assert.deepEqual(seen, [1, 2, 3]);
});
