import assert from "node:assert/strict";
import test from "node:test";

import { partitionFlatTask } from "../../src/suites/explicit-edit-multi-agent/extraction/flat-batches.mjs";

function task(sizes) {
  let offset = 0;
  return {
    id: "example",
    file: "example.h",
    fragments: sizes.map((size, index) => {
      const start = offset;
      const text = String(index % 10).repeat(size);
      offset += size;
      return { id: `item-${index}`, start, end: offset, text };
    }),
  };
}

const render = ({ fragments }) => fragments.map(({ text }) => text).join("");

test("batches preserve every complete entity in source order and bound edits", async () => {
  const input = task(Array(23).fill(100));
  const batches = await partitionFlatTask(input, { render });
  assert.deepEqual(
    batches.map(({ fragments }) => fragments.length),
    [10, 10, 3],
  );
  assert.deepEqual(
    batches.flatMap(({ fragments }) => fragments),
    input.fragments,
  );
  assert.ok(batches.every(({ bytes }) => bytes <= 2048));
});

test("rendered UTF-8 bytes, not character count, determine the size limit", async () => {
  const input = task([1, 1, 1]);
  const batches = await partitionFlatTask(input, {
    maxBytes: 10,
    render: ({ fragments }) => `øø${"é".repeat(fragments.length)}`,
  });
  assert.deepEqual(
    batches.map(({ fragments }) => fragments.length),
    [3],
  );
  assert.equal(batches[0].bytes, 10);
  const smaller = await partitionFlatTask(input, {
    maxBytes: 9,
    render: ({ fragments }) => `øø${"é".repeat(fragments.length)}`,
  });
  assert.deepEqual(
    smaller.map(({ fragments }) => fragments.length),
    [2, 1],
  );
});

test("oversized indivisible entities remain alone and are marked", async () => {
  const input = task([5, 30, 5]);
  const batches = await partitionFlatTask(input, { render, maxBytes: 10 });
  assert.deepEqual(
    batches.map(({ fragments }) => fragments.length),
    [1, 1, 1],
  );
  assert.deepEqual(
    batches.map(({ oversized }) => oversized),
    [false, true, false],
  );
  assert.deepEqual(
    batches.flatMap(({ fragments }) => fragments),
    input.fragments,
  );
});

test("rejects duplicate, overlapping and out-of-order source fragments", async () => {
  for (const fragments of [
    [
      { id: "a", start: 0, end: 1 },
      { id: "a", start: 1, end: 2 },
    ],
    [
      { id: "a", start: 0, end: 2 },
      { id: "b", start: 1, end: 3 },
    ],
    [
      { id: "a", start: 4, end: 5 },
      { id: "b", start: 1, end: 2 },
    ],
  ]) {
    await assert.rejects(partitionFlatTask({ id: "x", file: "x", fragments }, { render }));
  }
});
