import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runChunkTeam } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-team.mjs";

function factory() {
  const drivers = [];
  return {
    drivers,
    async createDriver(agent) {
      const driver = {
        agent,
        closed: false,
        ready: Promise.resolve(),
        async assertIdle() {
          return { sessionId: `worker-${agent}`, messageCount: 0 };
        },
        async terminate() {
          assert.equal(this.closed, false);
          this.closed = true;
        },
      };
      drivers.push(driver);
      return driver;
    },
  };
}

test("one timed-out participant retires and surviving participants complete remaining batches", async () => {
  const pool = factory();
  const assigned = [];
  const batches = Array.from({ length: 8 }, (_, i) => ({ id: `batch-${i}` }));
  const result = await runChunkTeam([{ id: "task", batches }], {
    ...pool,
    agents: 2,
    async execute(driver, batch) {
      assigned.push(batch.id);
      await sleep(2);
      if (driver.agent === 0) {
        await driver.terminate();
        return { timedOut: true };
      }
    },
  });
  assert.equal(pool.drivers.length, 2);
  assert.ok(pool.drivers.every((x) => x.closed));
  assert.equal(result.timeouts.length, 1);
  assert.equal(result.status, "partial");
  assert.equal(result.deliveries.find((x) => x.receipt?.timedOut).status, "timed-out");
  assert.equal(result.timeouts[0].batchId, "batch-0");
  assert.deepEqual(result.unissued, []);
  assert.equal(assigned.length, 8);
  assert.equal(new Set(assigned).size, 8);
});

test("exhausting the team records every unissued batch and drains with no survivors", async () => {
  const pool = factory(),
    assigned = [];
  const tasks = [
    { id: "one", batches: [1, 2, 3, 4, 5] },
    { id: "two", batches: [6, 7] },
  ];
  let retained;
  const result = await runChunkTeam(tasks, {
    ...pool,
    agents: 2,
    signal: AbortSignal.timeout(1500),
    async execute(driver, batch) {
      assigned.push(batch);
      await sleep(5);
      await driver.terminate();
      return { timedOut: true };
    },
    async onDrained({ participants }) {
      retained = participants;
    },
  });
  assert.deepEqual(assigned.sort(), [1, 2]);
  assert.equal(result.timeouts.length, 2);
  assert.deepEqual(
    result.unissued.map(({ task, index }) => `${task}:${index}`),
    ["one:2", "one:3", "one:4", "two:0", "two:1"],
  );
  assert.deepEqual(retained, []);
  assert.ok(pool.drivers.every((x) => x.closed));
});

test("the retained barrier receives only workers that survived their assignments", async () => {
  const pool = factory();
  let retained;
  const result = await runChunkTeam([{ id: "one", batches: [1, 2] }], {
    ...pool,
    agents: 2,
    signal: AbortSignal.timeout(1500),
    async execute(driver) {
      if (driver.agent === 0) {
        await driver.terminate();
        return { timedOut: true };
      }
    },
    async onDrained({ participants }) {
      retained = participants;
    },
  });
  assert.equal(result.timeouts.length, 1);
  assert.equal(retained.length, 1);
  assert.equal(retained[0].agent, 1);
  assert.ok(pool.drivers.every((x) => x.closed));
});
test("a correction participant can be retired inside the retained barrier", async () => {
  const pool = factory();
  await runChunkTeam([{ id: "one", batches: [1] }], {
    ...pool,
    agents: 2,
    signal: AbortSignal.timeout(1500),
    async execute() {},
    async onDrained({ participants }) {
      assert.equal(participants.length, 2);
      await participants[0].retire();
      assert.equal(participants[0].driver.closed, true);
      assert.equal(participants[1].driver.closed, false);
    },
  });
  assert.ok(pool.drivers.every((x) => x.closed));
});

test("a deferred split remains unissued when the last worker times out", async () => {
  const result = await runChunkTeam([{ id: "one", batches: [{ id: "whole", taskId: "one" }] }], {
    agents: 1,
    async createDriver(_agent, session) {
      return {
        closed: false,
        ready: Promise.resolve(),
        async assertIdle() {
          return { sessionId: `split-only-${session}`, messageCount: 0 };
        },
        async terminate() {
          this.closed = true;
        },
      };
    },
    async execute(driver, _batch, context) {
      context.defer({ id: "remainder", taskId: "one" });
      await driver.terminate();
      return { timedOut: true };
    },
  });
  assert.deepEqual(
    result.unissued.map((x) => x.batchId),
    ["remainder"],
  );
  assert.equal(result.timeouts.length, 1);
});
test("a split assignment preserves its unissued remainder when its worker times out", async () => {
  const seen = [];
  const result = await runChunkTeam([{ id: "one", batches: [{ id: "whole", taskId: "one" }] }], {
    agents: 2,
    async createDriver(agent, session) {
      return {
        closed: false,
        ready: Promise.resolve(),
        async assertIdle() {
          return { sessionId: `split-${session}`, messageCount: 0 };
        },
        async terminate() {
          this.closed = true;
        },
      };
    },
    async execute(driver, batch, context) {
      seen.push(batch.id);
      if (batch.id === "whole") {
        context.defer({ id: "remainder", taskId: "one" });
        await driver.terminate();
        return { timedOut: true };
      }
    },
  });
  assert.deepEqual(seen, ["whole", "remainder"]);
  assert.equal(result.timeouts.length, 1);
  assert.equal(result.unissued.length, 0);
});
test("a false timeout receipt cannot retire a still-live participant", async () => {
  const pool = factory();
  await assert.rejects(
    runChunkTeam([{ id: "one", batches: [1] }], {
      ...pool,
      agents: 1,
      async execute() {
        return { timedOut: true };
      },
    }),
  );
  assert.ok(pool.drivers.every((x) => x.closed));
});
