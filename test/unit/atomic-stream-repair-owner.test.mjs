import assert from "node:assert/strict";
import test from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const node = (id, dependencies = []) => ({ id, dependencies });

test("a failed atom returns to its original participant without repeating a verified peer", async () => {
  const nodes = [node("wrong"), node("peer"), node("dependent", ["wrong"])];
  const deliveries = [];
  const executeBatch = async (items, agent) => {
    deliveries.push({ ids: items.map((item) => item.id), agent });
  };
  const first = await runAtomicStream(nodes, {
    agents: 3,
    batchSize: 50,
    executeBatch,
    verify: async (item) => item.id !== "wrong",
  });
  assert.equal(first.status, "blocked");
  assert.deepEqual([...first.completed], ["peer"]);
  const repaired = await runAtomicStream(nodes, {
    agents: 3,
    batchSize: 50,
    completed: first.completed,
    started: first.started,
    owners: first.owners,
    rotation: first.rotation,
    executeBatch,
    verify: async () => true,
  });
  assert.equal(repaired.status, "pass");
  const retries = deliveries.filter((delivery) => delivery.ids.includes("wrong"));
  assert.equal(retries.length, 2);
  assert.equal(retries[1].agent, retries[0].agent);
  assert.equal(deliveries.filter((delivery) => delivery.ids.includes("peer")).length, 1);
});

test("correction batches preserve each member's participant despite the rotation cursor", async () => {
  const nodes = [node("wrong-a"), node("peer-a"), node("wrong-b"), node("peer-b")];
  const initialOwners = new Map();
  const first = await runAtomicStream(nodes, {
    agents: 2,
    batchSize: 50,
    executeBatch: async (items, agent) => {
      for (const item of items) initialOwners.set(item.id, agent);
    },
    verify: async (item) => item.id.startsWith("peer"),
  });
  assert.equal(first.status, "blocked");
  assert.notEqual(initialOwners.get("wrong-a"), initialOwners.get("wrong-b"));
  const corrections = [];
  const repaired = await runAtomicStream(nodes, {
    agents: 2,
    batchSize: 50,
    completed: first.completed,
    started: first.started,
    owners: first.owners,
    rotation: 1,
    executeBatch: async (items, agent) => {
      corrections.push({ ids: items.map((item) => item.id), agent });
    },
    verify: async () => true,
  });
  assert.equal(repaired.status, "pass");
  for (const delivery of corrections)
    for (const id of delivery.ids) assert.equal(delivery.agent, initialOwners.get(id), id);
  assert.deepEqual(corrections.flatMap((delivery) => delivery.ids).sort(), ["wrong-a", "wrong-b"]);
});

test("a correction without its original executor rejects before any native delivery", async () => {
  let delivered = false;
  await assert.rejects(
    runAtomicStream([node("wrong")], {
      agents: 2,
      started: new Set(["wrong"]),
      execute: async () => {
        delivered = true;
      },
      verify: async () => true,
    }),
    /Missing original atomic executor/,
  );
  assert.equal(delivered, false);
});
test("a busy repair owner does not hold up unrelated work on free participants", async () => {
  const release = Promise.withResolvers();
  const deliveries = [];
  const nodes = [node("first"), node("second"), node("fresh-a"), node("fresh-b")];
  const result = await runAtomicStream(nodes, {
    agents: 3,
    batchSize: 1,
    started: new Set(["first", "second"]),
    owners: new Map([
      ["first", 0],
      ["second", 0],
    ]),
    execute: async (item, agent) => {
      deliveries.push({ id: item.id, agent });
      if (deliveries.length >= 3) release.resolve();
      if (item.id === "first") await release.promise;
    },
    verify: async () => true,
  });
  assert.equal(result.status, "pass");
  assert.equal(deliveries.find((delivery) => delivery.id === "second").agent, 0);
  const second = deliveries.findIndex((delivery) => delivery.id === "second");
  for (const id of ["fresh-a", "fresh-b"])
    assert.ok(deliveries.findIndex((delivery) => delivery.id === id) < second, id);
});
