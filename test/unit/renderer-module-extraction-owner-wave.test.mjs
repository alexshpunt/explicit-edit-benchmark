import assert from "node:assert/strict";
import test from "node:test";
import { runExtractionWave } from "../../src/suites/explicit-edit-multi-agent/extraction/wave.mjs";

const tasks = Array.from({ length: 19 }, (_, i) => ({ id: `file-${i}`, file: `file-${i}.h` }));

function fixture() {
  const opened = [],
    closed = [],
    executed = [];
  return {
    opened,
    closed,
    executed,
    async createDriver(agent) {
      const driver = {
        agent,
        closed: false,
        history: [],
        async assertIdle() {
          return {
            sessionId: `owner-${agent}`,
            lifetime: `life-${agent}`,
            messageCount: this.history.length,
          };
        },
        async terminate() {
          this.closed = true;
          closed.push(agent);
        },
      };
      opened.push(driver);
      return driver;
    },
    async execute(driver, task, context) {
      assert.equal(driver.closed, false);
      assert.equal(driver.agent, context.agent);
      driver.history.push(task);
      executed.push({
        agent: context.agent,
        stage: task.recovery?.stage ?? "original",
        id: task.id,
      });
      return { session: context.session, history: driver.history.map(({ id }) => id) };
    },
  };
}

test("the shared barrier retains all ten original histories after nineteen original deliveries", async () => {
  const f = fixture();
  let barriers = 0;
  const result = await runExtractionWave(tasks, {
    ...f,
    agents: 10,
    async afterOriginal({ participants, recover }) {
      barriers++;
      assert.equal(f.executed.length, 19);
      assert.equal(f.closed.length, 0);
      assert.equal(participants.length, 10);
      assert.deepEqual(
        participants.map(({ participant }) => participant.messageCount),
        [2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
      );
      await recover(0, { ...tasks[10], recovery: { stage: "structural-correction" } });
      await recover(8, { ...tasks[18], recovery: { stage: "structural-correction" } });
      assert.equal(f.closed.length, 0);
    },
  });
  assert.equal(barriers, 1);
  assert.equal(f.opened.length, 10);
  assert.equal(f.closed.length, 10);
  assert.equal(result.deliveries.length, 21);
  assert.deepEqual(
    result.deliveries
      .slice(19)
      .map(({ agent, stage, receipt }) => ({ agent, stage, history: receipt.history })),
    [
      { agent: 0, stage: "structural-correction", history: ["file-0", "file-10", "file-10"] },
      { agent: 8, stage: "structural-correction", history: ["file-8", "file-18", "file-18"] },
    ],
  );
  assert.deepEqual(
    result.delivered,
    tasks.map(({ id }) => id),
  );
  assert.ok(result.records.every(({ closed }) => closed));
});

test("a file cannot receive a second recovery or move to another owner's context", async () => {
  const f = fixture();
  let barriers = 0;
  await runExtractionWave(tasks.slice(0, 2), {
    ...f,
    agents: 2,
    async afterOriginal({ recover }) {
      barriers++;
      const repair = { ...tasks[0], recovery: { stage: "structural-correction" } };
      await assert.rejects(recover(1, repair));
      await recover(0, repair);
      await assert.rejects(recover(0, repair));
    },
  });
  assert.equal(barriers, 1);
  assert.equal(f.executed.length, 3);
  assert.equal(f.closed.length, 2);
});

test(
  "an original refusal releases owners already waiting at the verification barrier",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    const refusal = Object.assign(new Error("fixture refusal"), { category: "provider_failure" });
    const peerDone = Promise.withResolvers();
    let barriers = 0;
    await assert.rejects(
      runExtractionWave(tasks.slice(0, 2), {
        ...f,
        agents: 2,
        async afterOriginal() {
          barriers++;
        },
        async execute(driver, task, context) {
          if (context.agent === 0) {
            await peerDone.promise;
            throw refusal;
          }
          const result = await f.execute(driver, task, context);
          peerDone.resolve();
          return result;
        },
      }),
      (error) => error === refusal,
    );
    assert.equal(barriers, 0);
    assert.equal(f.closed.length, 2);
  },
);

test(
  "a refused repair drains its independent peer and blocks further recovery admission",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    const refusal = Object.assign(new Error("fixture repair refusal"), {
      category: "provider_failure",
    });
    const peerStarted = Promise.withResolvers(),
      failed = Promise.withResolvers();
    await assert.rejects(
      runExtractionWave(tasks.slice(0, 3), {
        ...f,
        agents: 2,
        async execute(driver, task, context) {
          if (context.stage === "original") return f.execute(driver, task, context);
          if (context.agent === 0) {
            await peerStarted.promise;
            throw refusal;
          }
          peerStarted.resolve();
          await failed.promise;
          assert.equal(f.closed.length, 0);
          return f.execute(driver, task, context);
        },
        async afterOriginal({ recover }) {
          const result = await Promise.allSettled([
            recover(0, { ...tasks[0], recovery: { stage: "structural-correction" } }).catch(
              (error) => {
                failed.resolve();
                throw error;
              },
            ),
            recover(1, { ...tasks[1], recovery: { stage: "structural-correction" } }),
          ]);
          assert.equal(result[0].status, "rejected");
          assert.equal(result[1].status, "fulfilled");
          await assert.rejects(
            recover(0, { ...tasks[2], recovery: { stage: "structural-correction" } }),
            (error) => error === refusal,
          );
          throw refusal;
        },
      }),
      (error) => error === refusal,
    );
    assert.equal(f.executed.length, 4);
    assert.equal(f.closed.length, 2);
  },
);

test(
  "external cancellation releases the held barrier and joins verification cleanup",
  { timeout: 2000 },
  async () => {
    const f = fixture(),
      controller = new AbortController();
    let cleaned = false;
    await assert.rejects(
      runExtractionWave(tasks.slice(0, 2), {
        ...f,
        agents: 2,
        signal: controller.signal,
        async afterOriginal({ signal }) {
          try {
            await new Promise((resolve) => {
              signal.addEventListener("abort", resolve, { once: true });
              controller.abort(new Error("fixture cancellation"));
            });
            signal.throwIfAborted();
          } finally {
            cleaned = true;
          }
        },
      }),
    );
    assert.equal(cleaned, true);
    assert.equal(f.executed.length, 2);
    assert.equal(f.closed.length, 2);
  },
);

test(
  "a failure inside barrier verification closes every original process without new prompts",
  { timeout: 2000 },
  async () => {
    const f = fixture();
    const failure = new Error("fixture measurement failure");
    let barriers = 0;
    await assert.rejects(
      runExtractionWave(tasks.slice(0, 2), {
        ...f,
        agents: 2,
        async afterOriginal() {
          barriers++;
          throw failure;
        },
      }),
      (error) => error === failure,
    );
    assert.equal(barriers, 1);
    assert.equal(f.executed.length, 2);
    assert.equal(f.closed.length, 2);
  },
);
