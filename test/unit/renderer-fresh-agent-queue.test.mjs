import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  runAgentQueue,
  runFreshAgentQueue,
} from "../../src/suites/explicit-edit-multi-agent/execution/fresh-agent-queue.mjs";

function drivers() {
  const created = [];
  return {
    created,
    async createDriver(item, session) {
      const driver = {
        item,
        session,
        closed: false,
        executions: 0,
        async terminate() {
          await delay(1);
          this.closed = true;
        },
      };
      created.push(driver);
      return driver;
    },
  };
}

test("every item gets its own agent, in queue order, within the live limit", async () => {
  const pool = drivers();
  let running = 0,
    peak = 0;
  const started = [];
  const { results, maxLive } = await runFreshAgentQueue([1, 2, 3, 4, 5, 6, 7], {
    maxAgents: 3,
    createDriver: pool.createDriver,
    async execute(driver, item) {
      started.push(item);
      driver.executions++;
      running++;
      peak = Math.max(peak, running);
      await delay(item % 2 ? 5 : 1);
      running--;
      return item === 4 ? { status: "timed-out" } : { status: "settled", receipt: { item } };
    },
  });
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(pool.created.length, 7);
  assert.ok(pool.created.every((driver) => driver.closed && driver.executions === 1));
  assert.equal(new Set(pool.created.map((driver) => driver.session)).size, 7);
  assert.ok(peak <= 3 && maxLive === 3);
  assert.equal(results[3].status, "timed-out");
  assert.deepEqual(results[6].receipt, { item: 7 });
});

test("a failure stops new deliveries, lets running ones finish and closes every agent", async () => {
  const pool = drivers();
  const finished = [];
  await assert.rejects(
    runFreshAgentQueue([1, 2, 3, 4, 5], {
      maxAgents: 2,
      createDriver: pool.createDriver,
      async execute(_driver, item) {
        if (item === 1) throw new Error("provider stopped");
        await delay(5);
        finished.push(item);
        return { status: "settled" };
      },
    }),
    /provider stopped/,
  );
  assert.deepEqual(finished, [2]);
  assert.equal(pool.created.length, 2);
  assert.ok(pool.created.every((driver) => driver.closed));
});

test("persistent agents take the next item and are replaced only after a timeout", async () => {
  const pool = drivers();
  const started = [],
    closed = [];
  const { results, maxLive, agents } = await runAgentQueue([1, 2, 3, 4, 5, 6, 7, 8], {
    lifecycle: "persistent",
    maxAgents: 2,
    createDriver: pool.createDriver,
    async execute(driver, item) {
      assert.equal(driver.closed, false);
      started.push(item);
      driver.executions++;
      await delay(item % 2 ? 4 : 1);
      if (item === 3) {
        // The deadline closes the participant, as the chunk delivery executor does.
        await driver.terminate();
        return { status: "timed-out" };
      }
      return { status: "settled" };
    },
    async onClosed(driver, item, result, deliveries) {
      closed.push({ session: driver.session, item, status: result.status, deliveries });
    },
  });
  assert.deepEqual(started, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(agents, 3);
  assert.equal(pool.created.length, 3);
  assert.ok(pool.created.every((driver) => driver.closed));
  assert.equal(
    pool.created.reduce((sum, driver) => sum + driver.executions, 0),
    8,
  );
  assert.equal(maxLive, 2);
  const timedOut = closed.find((entry) => entry.status === "timed-out");
  assert.equal(timedOut.item, 3);
  assert.equal(
    closed.reduce((sum, entry) => sum + entry.deliveries, 0),
    8,
  );
  const third = results.filter((result) => result.session === 3);
  assert.ok(third.length > 0 && third.every((result) => result.index > 2));
});

test("a persistent agent whose driver failed to start is not reused", async () => {
  let attempts = 0;
  const closed = [];
  await assert.rejects(
    runAgentQueue([1, 2, 3], {
      lifecycle: "persistent",
      maxAgents: 1,
      async createDriver() {
        attempts++;
        throw new Error("startup failed");
      },
      async execute() {
        assert.fail("No driver started");
      },
      async onClosed(driver, item) {
        closed.push({ driver, item });
      },
    }),
    /startup failed/,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(closed, [{ driver: undefined, item: 1 }]);
});

test("an unknown lifecycle is rejected", async () => {
  await assert.rejects(
    runAgentQueue([1], {
      lifecycle: "forever",
      maxAgents: 1,
      createDriver: async () => ({}),
      execute: async () => ({}),
    }),
    /Unknown agent lifecycle/,
  );
});
