import assert from "node:assert/strict";
import test from "node:test";
import {
  applyHintMask,
  keepLargest,
  labelPieces,
  pieceAt,
  removedPieces,
  setPieces,
} from "./hints.ts";

function twoBlobs() {
  const width = 40,
    height = 20;
  const alpha = new Uint8Array(width * height);
  for (let y = 2; y < 18; y += 1) for (let x = 2; x < 14; x += 1) alpha[y * width + x] = 255;
  for (let y = 2; y < 18; y += 1) for (let x = 26; x < 38; x += 1) alpha[y * width + x] = 255;
  return { alpha, width, height };
}

test("keep marks drop unmarked components", () => {
  const { alpha, width, height } = twoBlobs();
  const next = applyHintMask(alpha, width, height, [
    { kind: "keep", size: 0.08, points: [{ x: 0.2, y: 0.5 }] },
  ]);
  assert.ok((next[10 * width + 8] ?? 0) > 200);
  assert.equal(next[10 * width + 32], 0);
});

test("remove marks drop only the marked component", () => {
  const { alpha, width, height } = twoBlobs();
  const next = applyHintMask(alpha, width, height, [
    { kind: "remove", size: 0.08, points: [{ x: 0.8, y: 0.5 }] },
  ]);
  assert.ok((next[10 * width + 8] ?? 0) > 200);
  assert.equal(next[10 * width + 32], 0);
});

test("no hints leaves the mask unchanged", () => {
  const { alpha, width, height } = twoBlobs();
  assert.equal(applyHintMask(alpha, width, height, []), alpha);
});

test("a keep mark that misses every component does not wipe the mask", () => {
  const { alpha, width, height } = twoBlobs();
  const next = applyHintMask(alpha, width, height, [
    { kind: "keep", size: 0.02, points: [{ x: 0, y: 0 }] },
  ]);
  assert.ok((next[10 * width + 8] ?? 0) > 200);
  assert.ok((next[10 * width + 32] ?? 0) > 200);
});

test("hints act on a component's own pixels, not its bounding box", () => {
  const width = 100;
  const height = 100;
  const alpha = new Uint8Array(width * height);
  // A: an L-shape whose bounding box spans the whole 80x80 square.
  for (let y = 0; y < 80; y += 1)
    for (let x = 0; x < 80; x += 1) if (x < 15 || y >= 65) alpha[y * width + x] = 255;
  // B: a block sitting inside A's box without touching A.
  for (let y = 20; y < 50; y += 1) for (let x = 30; x < 60; x += 1) alpha[y * width + x] = 255;
  const count = (mask: Uint8Array, inside: (x: number, y: number) => boolean) => {
    let n = 0;
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) if (inside(x, y) && mask[y * width + x]! > 24) n += 1;
    return n;
  };
  const inA = (x: number, y: number) => x < 80 && y < 80 && (x < 15 || y >= 65);
  const inB = (x: number, y: number) => x >= 30 && x < 60 && y >= 20 && y < 50;

  const removedA = applyHintMask(alpha, width, height, [
    { kind: "remove", size: 0.05, points: [{ x: 0.07, y: 0.3 }] },
  ]);
  assert.equal(count(removedA, inA), 0, "the tapped L is removed");
  assert.equal(count(removedA, inB), 900, "the block inside the L's box survives");

  const keptB = applyHintMask(alpha, width, height, [
    { kind: "keep", size: 0.05, points: [{ x: 0.45, y: 0.35 }] },
  ]);
  assert.equal(count(keptB, inB), 900, "the kept block survives");
  assert.equal(
    count(keptB, inA),
    0,
    "keeping the block drops the L even though its box contains the tap",
  );

  const ghost = applyHintMask(alpha, width, height, [
    { kind: "remove", size: 0.03, points: [{ x: 0.4, y: 0.55 }] },
  ]);
  assert.equal(count(ghost, inA), 2175, "a tap on empty space inside the L's box touches nothing");
  assert.equal(count(ghost, inB), 900);
});

test("clicking a piece removes it and clicking again brings it back", () => {
  const { alpha, width, height } = twoBlobs();
  const pieces = labelPieces(alpha, width, height);
  const right = pieceAt(pieces, 32, 10, 0);
  assert.ok(right);
  const removed = setPieces(pieces, [], [right], true);
  assert.deepEqual(removedPieces(pieces, removed), [false, true]);
  assert.deepEqual(removedPieces(pieces, setPieces(pieces, removed, [right], false)), [
    false,
    false,
  ]);
});

test("bringing back a piece hidden by keep-only adds a keep instead of wiping the keep", () => {
  const { alpha, width, height } = twoBlobs();
  const pieces = labelPieces(alpha, width, height);
  const keepLeft = [{ kind: "keep" as const, size: 0.08, points: [{ x: 0.2, y: 0.5 }] }];
  assert.deepEqual(removedPieces(pieces, keepLeft), [false, true]);
  const right = pieceAt(pieces, 32, 10, 0)!;
  assert.deepEqual(removedPieces(pieces, setPieces(pieces, keepLeft, [right], false)), [
    false,
    false,
  ]);
});

test("a click in empty space snaps to the nearest piece within reach", () => {
  const { alpha, width, height } = twoBlobs();
  const pieces = labelPieces(alpha, width, height);
  assert.equal(pieceAt(pieces, 20, 10, 2), null);
  assert.equal(pieceAt(pieces, 16, 10, 3)?.label, 1);
});

test("a clicked piece stays removed when the matte renders at a smaller size", () => {
  const big = labelPieces(twoBlobs().alpha, 40, 20);
  const right = pieceAt(big, 27, 3, 0)!;
  const hints = setPieces(big, [], [right], true);
  const width = 20,
    height = 10,
    small = new Uint8Array(width * height);
  for (let y = 1; y < 9; y += 1) for (let x = 1; x < 7; x += 1) small[y * width + x] = 255;
  for (let y = 1; y < 9; y += 1) for (let x = 13; x < 19; x += 1) small[y * width + x] = 255;
  const next = applyHintMask(small, width, height, hints);
  assert.equal(next[5 * width + 15], 0);
  assert.ok((next[5 * width + 3] ?? 0) > 200);
});

test("a removed speck that later merges into the subject does not take the subject with it", () => {
  const width = 40,
    height = 20,
    alpha = new Uint8Array(width * height);
  for (let y = 2; y < 18; y += 1) for (let x = 2; x < 14; x += 1) alpha[y * width + x] = 255;
  alpha[10 * width + 16] = 255; // a speck two pixels off the subject
  const before = labelPieces(alpha, width, height);
  const hints = setPieces(before, [], [pieceAt(before, 16, 10, 0)!], true);
  assert.equal(applyHintMask(alpha, width, height, hints)[10 * width + 16], 0);
  const merged = alpha.slice();
  merged[10 * width + 14] = merged[10 * width + 15] = 255; // a re-cut bridges the gap
  assert.ok((applyHintMask(merged, width, height, hints)[10 * width + 8] ?? 0) > 200);
});

test("keep largest survives specks the matte gains at another resolution", () => {
  const { alpha, width, height } = twoBlobs();
  alpha[10 * width + 20] = 255;
  const hints = keepLargest(labelPieces(alpha, width, height));
  const noisy = alpha.slice();
  for (let x = 0; x < width; x += 3) noisy[19 * width + x] = 255;
  const next = applyHintMask(noisy, width, height, hints);
  assert.ok((next[10 * width + 8] ?? 0) > 200);
  assert.equal(next[10 * width + 20], 0);
  assert.equal(next[19 * width + 0], 0);
});

test("restoring one piece preserves another piece removed by the same hint", () => {
  // Given two subjects within one removal brush disc.
  const width = 100,
    height = 100,
    alpha = new Uint8Array(width * height);
  for (let y = 40; y < 60; y += 1)
    for (let x = 40; x < 51; x += 1) if (x !== 45) alpha[y * width + x] = 255;
  const pieces = labelPieces(alpha, width, height);
  const hints = [{ kind: "remove" as const, size: 0.12, points: [{ x: 0.45, y: 0.5 }] }];
  const left = pieceAt(pieces, 43, 50, 0);
  assert.ok(left);
  assert.deepEqual(removedPieces(pieces, hints), [true, true]);

  // When only the left subject is brought back.
  const next = setPieces(pieces, hints, [left], false);

  // Then the neighboring subject stays removed.
  assert.deepEqual(removedPieces(pieces, next), [false, true]);
});

test("picking a large matte's rim removes only the clicked piece", () => {
  // Given equally sized subjects separated by one pixel on a large matte.
  const width = 2000,
    height = 2000,
    alpha = new Uint8Array(width * height);
  for (let y = 900; y < 1100; y += 1)
    for (let x = 900; x < 1101; x += 1) if (x !== 1000) alpha[y * width + x] = 255;
  const pieces = labelPieces(alpha, width, height);
  const left = pieceAt(pieces, 999, 1000, 0);
  assert.ok(left);

  // When the left subject is removed at its rim.
  const next = setPieces(pieces, [], [left], true);

  // Then the hint disc does not remove the neighboring subject.
  assert.deepEqual(removedPieces(pieces, next), [true, false]);
});

test("a saved pick at the right image edge does not inherit the next row's label", () => {
  // Given separate pixels at the end of one row and the start of the next.
  const alpha = new Uint8Array(100);
  alpha[19] = alpha[20] = 255;
  const pieces = labelPieces(alpha, 10, 10);

  // When a saved pick lands on the right image boundary near the first pixel.
  const removed = removedPieces(pieces, [
    { kind: "remove", size: 0.002, points: [{ x: 1, y: 0.15 }], areas: [0.01] },
  ]);

  // Then only that edge pixel's component is removed.
  assert.deepEqual(removed, [true, false]);
});
