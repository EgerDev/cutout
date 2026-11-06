import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { inspectImageMetadata } from "./metadata-client.ts";

const image = readFileSync(new URL("../../public/sample.jpg", import.meta.url));

test("metadata reads an image once across concurrent requests and panel reopen", async (t) => {
  const file = new File([image], "sample.jpg", { type: "image/jpeg" });
  const read = file.arrayBuffer.bind(file);
  const tracked = t.mock.method(file, "arrayBuffer", read);
  const [first, second] = await Promise.all([
    inspectImageMetadata(file),
    inspectImageMetadata(file),
  ]);
  const reopened = await inspectImageMetadata(file);
  assert.equal(tracked.mock.callCount(), 1);
  assert.deepEqual(first, second);
  assert.deepEqual(reopened, first);
});

test("metadata cache keeps distinct images separate even when names match", async (t) => {
  const first = new File([image], "sample.jpg", { type: "image/jpeg" });
  const second = new File([image], "sample.jpg", { type: "image/jpeg" });
  const readFirst = t.mock.method(first, "arrayBuffer", first.arrayBuffer.bind(first));
  const readSecond = t.mock.method(second, "arrayBuffer", second.arrayBuffer.bind(second));
  await Promise.all([inspectImageMetadata(first), inspectImageMetadata(second)]);
  assert.equal(readFirst.mock.callCount(), 1);
  assert.equal(readSecond.mock.callCount(), 1);
});
