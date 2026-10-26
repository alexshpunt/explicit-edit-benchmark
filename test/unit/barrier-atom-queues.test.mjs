import assert from "node:assert/strict";
import test from "node:test";
import {
  partitionAtomicQueues,
  runAtomicStream,
} from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const atom = (id, dependencies = []) => ({ id, dependencies });

test("independent atoms are divided evenly before any harness turn starts", () => {
  const nodes = Array.from({ length: 3070 }, (_, i) => atom(String(i)));
  const queues = partitionAtomicQueues(nodes, 15);
  assert.equal(queues.length, 15);
  assert.equal(Math.min(...queues.map((items) => items.length)), 204);
  assert.equal(Math.max(...queues.map((items) => items.length)), 205);
  assert.equal(new Set(queues.flat().map((item) => item.id)).size, nodes.length);
});

test("connected dependency chains stay on one participant in prerequisite order", () => {
  const queues = partitionAtomicQueues(
    [atom("third", ["second"]), atom("peer"), atom("first"), atom("second", ["first"])],
    3,
  );
  assert.deepEqual(
    queues.find((queue) => queue.some((item) => item.id === "first")).map((item) => item.id),
    ["first", "second", "third"],
  );
  assert.equal(queues.filter((queue) => queue.length).length, 2);
});

test("small barriers use only the participants they need", () => {
  assert.deepEqual(
    partitionAtomicQueues([atom("one"), atom("two")], 15).map((queue) => queue.length),
    [1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  );
});

test("a turn end advances the participant queue without inspecting reply text or granting credit", async () => {
  const batches = [];
  const forbidden = () => assert.fail("No intermediate source verification");
  const result = await runAtomicStream(
    Array.from({ length: 8 }, (_, i) => atom(String(i))),
    {
      agents: 2,
      batchSize: 2,
      checkInputs: forbidden,
      verify: forbidden,
      executeBatch: async (nodes, agent) => {
        batches.push([agent, nodes.map((node) => node.id)]);
        return Object.defineProperty({}, "text", { get: forbidden });
      },
    },
  );
  assert.equal(result.status, "drained");
  assert.equal(result.delivered.size, 8);
  assert.equal(Object.hasOwn(result, "completed"), false);
  assert.deepEqual(
    batches.filter(([agent]) => agent === 0).map(([, ids]) => ids),
    [
      ["0", "2"],
      ["4", "6"],
    ],
  );
  assert.deepEqual(
    batches.filter(([agent]) => agent === 1).map(([, ids]) => ids),
    [
      ["1", "3"],
      ["5", "7"],
    ],
  );
});

test("batch size is configurable above and below fifty", async () => {
  for (const batchSize of [1, 7, 51, 100]) {
    const sizes = [];
    await runAtomicStream(
      Array.from({ length: 102 }, (_, i) => atom(String(i))),
      {
        agents: 1,
        batchSize,
        executeBatch: async (nodes) => sizes.push(nodes.length),
      },
    );
    assert.ok(sizes.every((size) => size <= batchSize));
    assert.equal(
      sizes.reduce((total, size) => total + size, 0),
      102,
    );
  }
});

test("a driver failure aborts peers and waits for their turns to close", async () => {
  const both = Promise.withResolvers();
  const failure = Error("driver failed");
  let entered = 0,
    closed = false;
  await assert.rejects(
    runAtomicStream([atom("first"), atom("peer")], {
      agents: 2,
      executeBatch: async (_nodes, agent, signal) => {
        if (++entered === 2) both.resolve();
        await both.promise;
        if (agent === 0) throw failure;
        try {
          await new Promise((resolve) =>
            signal.aborted ? resolve() : signal.addEventListener("abort", resolve, { once: true }),
          );
          signal.throwIfAborted();
        } finally {
          closed = true;
        }
      },
    }),
    (error) => error === failure,
  );
  assert.equal(closed, true);
});

test("invalid dependency graphs fail before opening a turn", async () => {
  for (const nodes of [
    [atom("a"), atom("a")],
    [atom("a", ["missing"])],
    [atom("a", ["b"]), atom("b", ["a"])],
  ]) {
    await assert.rejects(
      runAtomicStream(nodes, {
        agents: 2,
        executeBatch: async () => assert.fail("Invalid graph dispatched"),
      }),
    );
  }
});
