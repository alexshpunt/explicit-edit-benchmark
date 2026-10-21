import assert from "node:assert/strict";
import test from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const node = (id, dependencies = []) => ({ id, dependencies });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test("fifty ready edits share one delivery while every participant can stay busy", async () => {
  const nodes = Array.from({ length: 750 }, (_, index) => node(`edit-${index}`));
  const release = Promise.withResolvers();
  const batches = [];
  const active = new Set();
  const result = await runAtomicStream(nodes, {
    agents: 15,
    batchSize: 50,
    executeBatch: async (items, agent, _signal, context) => {
      assert.ok(!active.has(agent));
      active.add(agent);
      batches.push({ ids: items.map((item) => item.id), agent });
      assert.equal(items.length, 50);
      assert.ok(items.every((item) => context.writers.has(item.id)));
      if (batches.length === 15) release.resolve();
      await release.promise;
      assert.equal(context.writers.size, 750);
      active.delete(agent);
      return { delivery: agent };
    },
    verify: async () => true,
  });
  assert.equal(result.status, "pass");
  assert.equal(batches.length, 15);
  assert.equal(new Set(batches.map((batch) => batch.agent)).size, 15);
  assert.deepEqual(
    [...result.completed],
    nodes.map((item) => item.id),
  );
});

test("a delivery cannot exceed fifty independently ready edits", async () => {
  let dispatched = false;
  await assert.rejects(
    runAtomicStream([node("first")], {
      agents: 15,
      batchSize: 51,
      executeBatch: async () => {
        dispatched = true;
      },
      verify: async () => true,
    }),
    /Invalid atomic batch size/,
  );
  assert.equal(dispatched, false);
});
test("a small ready frontier uses all free participants rather than one full batch", async () => {
  const release = Promise.withResolvers();
  const batches = [];
  const result = await runAtomicStream(
    Array.from({ length: 15 }, (_, i) => node(`edit-${i}`)),
    {
      agents: 15,
      batchSize: 50,
      executeBatch: async (items, agent) => {
        batches.push({ ids: items.map((item) => item.id), agent });
        if (batches.length === 15) release.resolve();
        await release.promise;
      },
      verify: async () => true,
    },
  );
  assert.equal(result.status, "pass");
  assert.equal(batches.length, 15);
  assert.ok(batches.every((batch) => batch.ids.length === 1));
});

test("an undispatched dependency cannot enter its predecessor's batch", async () => {
  const verified = new Set();
  const batches = [];
  const result = await runAtomicStream(
    [node("first"), node("dependent", ["first"]), node("peer")],
    {
      agents: 1,
      batchSize: 50,
      executeBatch: async (items) => {
        for (const item of items) assert.ok(item.dependencies.every((id) => verified.has(id)));
        batches.push(items.map((item) => item.id));
      },
      verify: async (item) => {
        await turn();
        verified.add(item.id);
        return true;
      },
    },
  );
  assert.equal(result.status, "pass");
  assert.deepEqual(batches, [["first", "peer"], ["dependent"]]);
});

test("a failed batch member retains verified peers and correction delivers only the failure", async () => {
  const nodes = [node("wrong"), node("peer"), node("dependent", ["wrong"])];
  const batches = [];
  const first = await runAtomicStream(nodes, {
    agents: 1,
    batchSize: 50,
    executeBatch: async (items) => batches.push(items.map((item) => item.id)),
    verify: async (item) => item.id !== "wrong",
  });
  assert.equal(first.status, "blocked");
  assert.deepEqual(first.failed, ["wrong"]);
  assert.deepEqual([...first.completed], ["peer"]);
  const repaired = await runAtomicStream(nodes, {
    agents: 1,
    batchSize: 50,
    completed: first.completed,
    started: first.started,
    executeBatch: async (items) => batches.push(items.map((item) => item.id)),
    verify: async () => true,
  });
  assert.equal(repaired.status, "pass");
  assert.deepEqual(batches, [["wrong", "peer"], ["wrong"], ["dependent"]]);
});

test("preflight checks every member and excludes unmet inputs from the native delivery", async () => {
  const delivered = [];
  const result = await runAtomicStream([node("ready"), node("invalid"), node("peer")], {
    agents: 1,
    batchSize: 50,
    checkInputs: async (item) => item.id !== "invalid",
    executeBatch: async (items) => delivered.push(...items.map((item) => item.id)),
    verify: async () => true,
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.failed, ["invalid"]);
  assert.deepEqual(delivered, ["ready", "peer"]);
  assert.equal(result.started.has("invalid"), false);
});

test("batch execution failure aborts and settles peer deliveries before returning", async () => {
  const entered = Promise.withResolvers();
  let started = 0;
  let peerClosed = false;
  const run = runAtomicStream(
    Array.from({ length: 20 }, (_, i) => node(`edit-${i}`)),
    {
      agents: 2,
      batchSize: 50,
      executeBatch: async (_items, agent, signal) => {
        if (++started === 2) entered.resolve();
        await entered.promise;
        if (agent === 0) throw Error("Batch driver failed");
        try {
          await new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally {
          peerClosed = true;
        }
      },
      verify: async () => true,
    },
  );
  await assert.rejects(run, /Batch driver failed/);
  assert.equal(peerClosed, true);
});

test("pending member gates retry verification without repeating the batch delivery", async () => {
  const first = new Set();
  let calls = 0;
  const result = await runAtomicStream([node("north"), node("south")], {
    agents: 1,
    batchSize: 50,
    executeBatch: async () => calls++,
    verify: async (item) => {
      if (item.id === "north" && !first.has(item.id)) {
        first.add(item.id);
        return "pending";
      }
      return true;
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.completed.size, 2);
  assert.equal(calls, 1);
});
