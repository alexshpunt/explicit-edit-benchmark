import assert from "node:assert/strict";
import test from "node:test";
import { runExtractionWave } from "../../src/suites/explicit-edit-multi-agent/extraction/wave.mjs";

const tasks = Array.from({ length: 10 }, (_, index) => ({
  id: `module-${index}`,
  file: `module_${index}.cpp`,
  fragments: [{ text: `int f${index}() { return ${index}; }` }],
}));

function participant(index, closed, ready) {
  return {
    closed: false,
    ready,
    async assertIdle() {
      return { sessionId: `session-${index}`, messageCount: 0 };
    },
    async terminate() {
      this.closed = true;
      closed.add(index);
    },
  };
}

test(
  "ten agents receive one complete module each only after all ten are ready",
  { timeout: 2000 },
  async () => {
    const created = new Set(),
      registered = new Set(),
      closed = new Set();
    const allCreated = Promise.withResolvers();
    const received = [];
    const result = await runExtractionWave(tasks, {
      async createDriver(agent) {
        created.add(agent);
        if (created.size === 10) allCreated.resolve();
        return participant(agent, closed, allCreated.promise);
      },
      onParticipant(record) {
        registered.add(record.agent);
      },
      async execute(driver, task, { agent }) {
        assert.equal(registered.size, 10);
        assert.equal(driver.closed, false);
        received.push({ agent, task });
        return { status: "complete" };
      },
    });
    assert.equal(result.records.length, 10);
    assert.equal(result.deliveries.length, 10);
    assert.equal(closed.size, 10);
    assert.deepEqual(
      received.map(({ agent }) => agent).sort((a, b) => a - b),
      [...created],
    );
    assert.deepEqual(received.map(({ task }) => task.id).sort(), tasks.map(({ id }) => id).sort());
    for (const { task } of received)
      assert.deepEqual(
        task,
        tasks.find(({ id }) => id === task.id),
      );
  },
);

test(
  "a provider refusal during startup closes the other agents without releasing the wave",
  { timeout: 2000 },
  async () => {
    const closed = new Set();
    let deliveries = 0;
    const refusal = Object.assign(new Error("fixture refusal"), { category: "provider_failure" });
    await assert.rejects(
      runExtractionWave(tasks, {
        async createDriver(agent) {
          return participant(agent, closed, agent === 8 ? Promise.reject(refusal) : undefined);
        },
        async execute() {
          deliveries++;
        },
      }),
      (error) => error === refusal,
    );
    assert.equal(deliveries, 0);
    assert.equal(closed.size, 10);
  },
);

test("nineteen complete file tasks use ten fixed participant queues without splitting a file", async () => {
  const tasks = Array.from({ length: 19 }, (_unused, index) => ({
    id: `whole-file-${index}`,
    file: `module_${Math.floor(index / 2)}.${index % 2 ? "cpp" : "h"}`,
    fragments: [{ text: `complete body ${index}` }],
  }));
  let ready = 0;
  const received = new Map(),
    stopped = new Set();
  const result = await runExtractionWave(tasks, {
    agents: 10,
    createDriver: async (agent) => ({
      closed: false,
      assertIdle: async () => ({ sessionId: `static-${agent}`, messageCount: 0 }),
      async terminate() {
        this.closed = true;
        stopped.add(agent);
      },
    }),
    onParticipant() {
      ready++;
    },
    async execute(_driver, task, { agent }) {
      assert.equal(ready, 10);
      if (!received.has(agent)) received.set(agent, []);
      received.get(agent).push(task);
      return { task: task.id };
    },
  });
  assert.equal(result.records.length, 10);
  assert.equal(stopped.size, 10);
  assert.equal(result.deliveries.length, 19);
  for (let agent = 0; agent < 10; agent++)
    assert.deepEqual(
      received.get(agent),
      tasks.filter((_task, index) => index % 10 === agent),
    );
  assert.deepEqual(
    new Set(result.deliveries.flatMap((delivery) => delivery.ids)),
    new Set(tasks.map((task) => task.id)),
  );
  assert.ok(
    result.deliveries.every(
      (delivery) => delivery.ids.length === 1 && delivery.receipt.task === delivery.ids[0],
    ),
  );
});

test("one participant receives the header and implementation as separate whole assignments", async () => {
  const tasks = [
    { id: "pair-header", file: "pair.h", fragments: [{ text: "header body" }] },
    { id: "pair-implementation", file: "pair.cpp", fragments: [{ text: "implementation body" }] },
  ];
  const received = [];
  let opened = 0;
  const result = await runExtractionWave(tasks, {
    agents: 1,
    createDriver: async () => {
      opened++;
      return {
        closed: false,
        assertIdle: async () => ({ sessionId: "single-pair", messageCount: 0 }),
        async terminate() {
          this.closed = true;
        },
      };
    },
    async execute(_driver, task) {
      received.push(task);
      return { task: task.id };
    },
  });
  assert.equal(opened, 1);
  assert.deepEqual(received, tasks);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].closed, true);
  assert.equal(result.deliveries.length, 2);
  assert.deepEqual(
    result.deliveries.map((delivery) => delivery.session),
    [0, 0],
  );
});

test(
  "a refusal drains the healthy in-flight file and stops later files in both fixed queues",
  { timeout: 2000 },
  async () => {
    const files = Array.from({ length: 4 }, (_unused, index) => ({ id: `file-${index}` }));
    const bothStarted = Promise.withResolvers(),
      failureReported = Promise.withResolvers();
    const started = [],
      closed = new Set();
    const refusal = Object.assign(new Error("fixture refused"), { category: "provider_failure" });
    await assert.rejects(
      runExtractionWave(files, {
        agents: 2,
        createDriver: async (agent) => participant(agent, closed),
        onDelivery(record) {
          if (record.event === "end" && record.status === "error") failureReported.resolve();
        },
        async execute(_driver, task, { agent }) {
          started.push(task.id);
          if (started.length === 2) bothStarted.resolve();
          await bothStarted.promise;
          if (agent === 0) throw refusal;
          await failureReported.promise;
          return { status: "complete", file: task.id };
        },
      }),
      (error) => {
        assert.equal(error, refusal);
        assert.deepEqual(error.roundPool.delivered, ["file-1"]);
        assert.equal(error.roundPool.deliveries.length, 2);
        assert.deepEqual(
          error.roundPool.deliveries.map((receipt) => receipt.status),
          ["error", "settled"],
        );
        assert.equal(error.roundPool.deliveries[1].receipt.file, "file-1");
        assert.ok(error.roundPool.records.every((record) => record.closed));
        return true;
      },
    );
    assert.deepEqual(started, ["file-0", "file-1"]);
    assert.equal(closed.size, 2);
  },
);
