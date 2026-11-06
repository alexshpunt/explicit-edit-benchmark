import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { runFreshAgentQueue } from "../../src/suites/explicit-edit-multi-agent/execution/fresh-agent-queue.mjs";

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
