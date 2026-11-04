import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { runChunkTeam } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-team.mjs";

function fakeDrivers() {
  let started = 0;
  let closed = 0;
  return {
    get started() {
      return started;
    },
    get closed() {
      return closed;
    },
    async createDriver(_agent, session) {
      started++;
      return {
        closed: false,
        ready: Promise.resolve(),
        async assertIdle() {
          return { sessionId: `team-${session}`, messageCount: 0 };
        },
        async terminate() {
          this.closed = true;
          closed++;
        },
      };
    },
  };
}

test("first-free workers share only one task until all its batches settle", async () => {
  const tasks = Array.from({ length: 3 }, (_, i) => ({
    id: `task-${i}`,
    batches: Array.from({ length: i === 1 ? 31 : 13 }, (_, j) => ({ id: `${i}-${j}` })),
  }));
  const drivers = fakeDrivers();
  let active = 0,
    max = 0,
    phase = 0;
  const finished = tasks.map(() => new Set());
  const result = await runChunkTeam(tasks, {
    ...drivers,
    agents: 10,
    async execute(_driver, batch, context) {
      const index = Number(context.task.at(-1));
      assert.equal(index, phase);
      active++;
      max = Math.max(active, max);
      await sleep(context.index % 4 === 0 ? 8 : 2);
      active--;
      finished[index].add(batch.id);
      if (finished[index].size === tasks[index].batches.length) phase++;
    },
  });
  assert.equal(drivers.started, 10);
  assert.equal(drivers.closed, 10);
  assert.equal(result.records.length, 10);
  assert.equal(phase, 3);
  assert.equal(max, 10);
  for (let i = 0; i < tasks.length; i++) assert.equal(finished[i].size, tasks[i].batches.length);
});

test("cancellation wakes idle workers and closes participants", async () => {
  const drivers = fakeDrivers();
  const controller = new AbortController();
  const tasks = [
    { id: "one", batches: [1] },
    { id: "two", batches: [2] },
  ];
  let calls = 0;
  const run = runChunkTeam(tasks, {
    ...drivers,
    agents: 10,
    signal: controller.signal,
    async execute(_driver, _batch, { signal }) {
      calls++;
      await sleep(10000, undefined, { signal });
    },
  });
  await sleep(20);
  controller.abort(Error("cancelled"));
  await assert.rejects(run);
  assert.equal(calls, 1);
  assert.equal(drivers.closed, drivers.started);
});
test("failure prevents advancing to another task and closes all participants", async () => {
  const drivers = fakeDrivers();
  const calls = [];
  const tasks = [
    { id: "first", batches: Array.from({ length: 20 }, (_, i) => i) },
    { id: "next", batches: [1] },
  ];
  await assert.rejects(
    runChunkTeam(tasks, {
      ...drivers,
      agents: 10,
      signal: AbortSignal.timeout(3000),
      async execute(_driver, _batch, context) {
        calls.push(context.task);
        if (context.index === 0) throw Error("first failed");
      },
    }),
    /first failed/,
  );
  assert.ok(calls.length >= 1 && calls.length <= 10);
  assert.ok(calls.every((task) => task === "first"));
  assert.equal(drivers.closed, drivers.started);
});
