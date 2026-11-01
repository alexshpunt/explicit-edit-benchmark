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
