import assert from "node:assert/strict";
import test from "node:test";
import { runChunkRecoveryTeams } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-recovery-teams.mjs";

function team(phase, log) {
  return {
    agents: 2,
    async createDriver(agent) {
      const driver = {
        closed: false,
        phase,
        agent,
        ready: Promise.resolve(),
        async assertIdle() {
          return { sessionId: `${phase}-${agent}`, messageCount: 0 };
        },
        async terminate() {
          this.closed = true;
          log.push(`close:${phase}:${agent}`);
        },
      };
      return driver;
    },
    async execute(driver, batch) {
      assert.equal(driver.closed, false);
      log.push(`original:${phase}:${batch.id}`);
    },
  };
}

test("a failed structural correction closes both teams and propagates the failure", async () => {
  const log = [];
  await assert.rejects(
    runChunkRecoveryTeams({
      otherTasks: [{ id: "one", batches: [{ id: "first" }] }],
      mathTasks: [{ id: "math", batches: [{ id: "second" }] }],
      other: team("other", log),
      math: team("math", log),
      totalFiles: 2,
      capture: async () => ({
        structure: { differenceIds: ["preservation:main.cpp"] },
        integration: { buildPassed: true, resultMatched: true },
      }),
      repairStructural: async ({ participant }) => {
        assert.equal(participant.driver.phase, "other");
        throw Error("repair failure");
      },
      repairIntegration: async () => {},
    }),
    /repair failure/,
  );
  assert.equal(log.filter((x) => x.startsWith("close:")).length, 4);
});
test("both original teams remain live for the shared structural recovery", async () => {
  const log = [];
  let fixed = false;
  const result = await runChunkRecoveryTeams({
    otherTasks: [{ id: "one", batches: [{ id: "one-batch" }] }],
    mathTasks: [{ id: "math", batches: [{ id: "math-batch" }] }],
    other: team("other", log),
    math: team("math", log),
    totalFiles: 2,
    capture: async () => ({
      structure: { differenceIds: fixed ? [] : ["one"] },
      integration: { buildPassed: true, resultMatched: true },
    }),
    repairStructural: async ({ participant, id, participants }) => {
      assert.equal(id, "one");
      assert.equal(participant.driver.phase, "other");
      assert.ok(participants.every(({ driver }) => !driver.closed));
      log.push("repair");
      fixed = true;
    },
    repairIntegration: async () => assert.fail("Integration passed"),
  });
  assert.equal(result.recovery.score.score, 75);
  assert.equal(log.filter((x) => x.startsWith("close:")).length, 4);
  assert.ok(log.indexOf("repair") < log.findIndex((x) => x.startsWith("close:")));
});
