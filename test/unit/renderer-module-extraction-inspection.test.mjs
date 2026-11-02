import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareHeaderExtraction } from "../../src/suites/explicit-edit-multi-agent/extraction/plan.mjs";
import { runExtractionRecovery } from "../../src/suites/explicit-edit-multi-agent/extraction/recovery.mjs";
import { runExtractionWave } from "../../src/suites/explicit-edit-multi-agent/extraction/wave.mjs";

function driver(agent, closed) {
  return {
    closed: false,
    async assertIdle() {
      return { sessionId: `session-${agent}`, messageCount: 0 };
    },
    async terminate() {
      this.closed = true;
      closed.add(agent);
    },
  };
}

test(
  "inspection refuses a changed candidate before dispatch and records interruption",
  { timeout: 3000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inspection-"));
    const output = path.join(root, "run");
    const initial = { "main.cpp": "#ifndef H0\n#define H0\nint f();\n#endif\n" };
    const plan = {
      ...prepareHeaderExtraction({
        initial,
        headers: [{ file: "f.h", guard: "H0", includes: [] }],
        modules: ["f.h"],
      }),
      version: "renderer-module-extraction-plan-v2",
      scope: "experimental-module-pairs",
      agents: 1,
    };
    const closed = new Set();
    let delivered = 0,
      inspected = false;
    try {
      await assert.rejects(
        runExtractionRecovery(plan, output, {
          createDriver: async (agent) => driver(agent, closed),
          execute: async () => {
            delivered++;
          },
          assess: async () => {
            throw new Error("unexpected assessment");
          },
          async inspect(request) {
            assert.equal(request.stage, "original");
            inspected = true;
            assert.match(request.candidateIdentity, /^[a-f0-9]{64}$/);
            assert.equal(
              await readFile(path.join(request.evidence, "source/main.cpp"), "utf8"),
              initial["main.cpp"],
            );
            await writeFile(path.join(output, "workspace/main.cpp"), "changed\n");
            return {
              runId: request.runId,
              sequence: request.sequence,
              candidateIdentity: request.candidateIdentity,
            };
          },
        }),
      );
      const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
      assert.equal(report.status, "interrupted");
      assert.equal(delivered, 0);
      assert.equal(inspected, true);
      assert.equal(closed.size, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("inspection rejects an approval tied to a different snapshot", { timeout: 3000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "inspection-approval-"));
  const output = path.join(root, "run");
  const initial = { "main.cpp": "#ifndef H0\n#define H0\nint f();\n#endif\n" };
  const plan = {
    ...prepareHeaderExtraction({
      initial,
      headers: [{ file: "f.h", guard: "H0", includes: [] }],
      modules: ["f.h"],
    }),
    version: "renderer-module-extraction-plan-v2",
    scope: "experimental-module-pairs",
    agents: 1,
  };
  const closed = new Set();
  let delivered = 0,
    inspected = false;
  try {
    await assert.rejects(
      runExtractionRecovery(plan, output, {
        createDriver: async (agent) => driver(agent, closed),
        execute: async () => {
          delivered++;
        },
        assess: async () => {
          throw new Error("unexpected assessment");
        },
        async inspect(request) {
          inspected = true;
          return {
            runId: request.runId,
            sequence: request.sequence,
            candidateIdentity: "0".repeat(64),
          };
        },
      }),
    );
    assert.equal(inspected, true);
    assert.equal(delivered, 0);
    assert.equal(closed.size, 1);
    const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
    assert.equal(report.status, "interrupted");
    assert.equal(report.inspections[0].status, "interrupted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "inspection approves each original round and each structural batch against fresh evidence",
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inspection-rounds-"));
    const output = path.join(root, "run");
    const bodies = ["int alpha() { return 1; }", "int beta() { return 2; }"];
    const initial = {
      "main.cpp":
        bodies.map((body, i) => `#ifndef H${i}\n#define H${i}\n${body}\n#endif\n`).join("") +
        "int main() { return 0; }\n",
    };
    const plan = {
      ...prepareHeaderExtraction({
        initial,
        headers: bodies.map((_, i) => ({ file: `f${i}.h`, guard: `H${i}`, includes: [] })),
        modules: ["f0.h", "f1.h"],
      }),
      version: "renderer-module-extraction-plan-v2",
      scope: "experimental-module-pairs",
      agents: 2,
    };
    const closed = new Set(),
      requests = [],
      deliveries = [];
    try {
      const report = await runExtractionRecovery(plan, output, {
        createDriver: async (agent) => driver(agent, closed),
        measure: async () => ({ buildPassed: true, resultMatched: true }),
        async inspect(request) {
          requests.push({ ...request, signal: undefined });
          const recorded = JSON.parse(await readFile(request.report, "utf8"));
          assert.equal(recorded.inspections.at(-1).candidateIdentity, request.candidateIdentity);
          assert.equal(recorded.inspections.at(-1).status, "awaiting");
          return {
            runId: request.runId,
            sequence: request.sequence,
            candidateIdentity: request.candidateIdentity,
          };
        },
        async execute(_driver, task, context) {
          deliveries.push(context.stage);
          const main = path.join(context.workspace, "main.cpp");
          if (context.stage === "original") {
            await writeFile(path.join(context.workspace, task.file), task.destination);
            if (task.id === plan.tasks.at(-1).id)
              await writeFile(main, plan.expected["main.cpp"] + bodies.join("\n") + "\n");
          } else {
            const body = bodies[plan.tasks.findIndex(({ id }) => id === task.id)];
            await writeFile(main, (await readFile(main, "utf8")).replace(body, ""));
          }
        },
      });
      assert.equal(report.status, "complete");
      assert.equal(report.passed, true);
      assert.deepEqual(
        requests.map(({ stage }) => stage),
        ["original", "original", "structural-correction", "structural-correction"],
      );
      assert.deepEqual(
        requests.map(({ sequence }) => sequence),
        [0, 1, 2, 3],
      );
      assert.equal(new Set(requests.map(({ runId }) => runId)).size, 1);
      assert.equal(new Set(requests.map(({ candidateIdentity }) => candidateIdentity)).size, 4);
      assert.deepEqual(deliveries, [
        "original",
        "original",
        "structural-correction",
        "structural-correction",
      ]);
      assert.equal(closed.size, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "inspection pauses before a build-correction participant is prompted",
  { timeout: 5000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "inspection-build-"));
    const output = path.join(root, "run");
    const initial = { "main.cpp": "#ifndef H0\n#define H0\nint f();\n#endif\n" };
    const plan = {
      ...prepareHeaderExtraction({
        initial,
        headers: [{ file: "f.h", guard: "H0", includes: [] }],
        modules: ["f.h"],
      }),
      version: "renderer-module-extraction-plan-v2",
      scope: "experimental-module-pairs",
      agents: 1,
    };
    const closed = new Set(),
      stages = [],
      deliveries = [];
    let measurements = 0;
    try {
      const report = await runExtractionRecovery(plan, output, {
        createDriver: async (agent) => driver(agent, closed),
        measure: async () =>
          ++measurements === 1
            ? { buildPassed: false, resultMatched: false }
            : { buildPassed: true, resultMatched: true },
        async inspect(request) {
          stages.push(request.stage);
          assert.equal(deliveries.length, stages.length - 1);
          return {
            runId: request.runId,
            sequence: request.sequence,
            candidateIdentity: request.candidateIdentity,
          };
        },
        async execute(_driver, task, context) {
          deliveries.push(context.stage);
          if (context.stage === "original") {
            await writeFile(path.join(context.workspace, task.file), task.destination);
            await writeFile(path.join(context.workspace, "main.cpp"), plan.expected["main.cpp"]);
          }
        },
      });
      assert.equal(report.status, "complete");
      assert.deepEqual(stages, ["original", "build-correction"]);
      assert.deepEqual(deliveries, ["original", "build-correction"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "cancel while approval is pending closes every participant and admits no work",
  { timeout: 3000 },
  async () => {
    const entered = Promise.withResolvers();
    const closed = new Set();
    const controller = new AbortController();
    let delivered = 0;
    const running = runExtractionWave([{ id: "a" }, { id: "b" }], {
      agents: 2,
      signal: controller.signal,
      createDriver: async (agent) => driver(agent, closed),
      beforeRound() {
        entered.resolve();
        return new Promise(() => {});
      },
      async execute() {
        delivered++;
      },
    });
    await entered.promise;
    controller.abort(new Error("cancelled"));
    await assert.rejects(running);
    assert.equal(delivered, 0);
    assert.equal(closed.size, 2);
  },
);

test("a lost participant stops the next delivery after approval", { timeout: 3000 }, async () => {
  const entered = Promise.withResolvers(),
    approval = Promise.withResolvers();
  const closed = new Set();
  let alive = true,
    delivered = 0;
  const running = runExtractionWave([{ id: "a" }, { id: "b" }], {
    agents: 2,
    createDriver: async (agent) => ({
      ...driver(agent, closed),
      async assertIdle() {
        if (!alive && agent === 0) throw new Error("lost");
        return { sessionId: `session-${agent}` };
      },
    }),
    async beforeRound() {
      entered.resolve();
      await approval.promise;
    },
    async execute() {
      delivered++;
    },
  });
  await entered.promise;
  alive = false;
  approval.resolve();
  await assert.rejects(running);
  assert.equal(delivered, 0);
  assert.equal(closed.size, 2);
});

test("inspection permits exactly one assigned task at a time", { timeout: 3000 }, async () => {
  const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `task-${index}` }));
  const pending = tasks.map(() => Promise.withResolvers());
  const entered = tasks.map(() => Promise.withResolvers());
  const deliveries = [],
    closed = new Set();
  const running = runExtractionWave(tasks, {
    agents: 2,
    createDriver: async (agent) => driver(agent, closed),
    async beforeRound({ round, participants, ids }) {
      assert.equal(participants.length, 2);
      assert.deepEqual(ids, [tasks[round].id]);
      entered[round].resolve();
      await pending[round].promise;
    },
    async execute(_driver, task) {
      deliveries.push(task.id);
    },
  });
  for (let round = 0; round < tasks.length; round++) {
    await entered[round].promise;
    assert.deepEqual(
      deliveries,
      tasks.slice(0, round).map(({ id }) => id),
    );
    pending[round].resolve();
  }
  await running;
  assert.deepEqual(
    deliveries,
    tasks.map(({ id }) => id),
  );
  assert.equal(closed.size, 2);
});
