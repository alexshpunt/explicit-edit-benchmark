import assert from "node:assert/strict";
import test from "node:test";
import { runFinalChunkTeams } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-final-teams.mjs";

function team(name, events) {
  return {
    agents: 2,
    async createDriver(agent) {
      events.push(`start:${name}`);
      return {
        ready: Promise.resolve(),
        closed: false,
        name,
        async assertIdle() {
          return { sessionId: `${name}-${agent}`, messageCount: 0 };
        },
        async terminate() {
          this.closed = true;
          events.push(`close:${name}`);
        },
      };
    },
    async execute() {},
  };
}

test("default team score uses the initial and final snapshots", async () => {
  const events = [];
  const result = await runFinalChunkTeams({
    otherTasks: [{ id: "other", batches: [1] }],
    mathTasks: [{ id: "math", batches: [2] }],
    other: team("other", events),
    math: team("math", events),
    repairTeam: team("repair", events),
    totalFiles: 2,
    async capture({ assessStructure, measureIntegration }) {
      return {
        ...(assessStructure ? { structure: { differenceIds: ["a"] } } : {}),
        ...(measureIntegration ? { integration: { buildPassed: true, resultMatched: true } } : {}),
      };
    },
    async repairStructural() {},
    async repairIntegration() {
      assert.fail("No correction");
    },
  });
  assert.equal(result.recovery.score.score, 50);
  assert.equal(result.recovery.score.policy.version, "renderer-chunk-final-snapshot-score-v1");
});
test("initial teams close before the independent structural repair team starts", async () => {
  const events = [];
  const result = await runFinalChunkTeams({
    otherTasks: [{ id: "other", batches: [1] }],
    mathTasks: [{ id: "math", batches: [2] }],
    other: team("other", events),
    math: team("math", events),
    repairTeam: team("repair", events),
    totalFiles: 2,
    async capture({ stage, assessStructure, measureIntegration }) {
      if (stage === "original")
        assert.equal(events.filter((x) => x.startsWith("close:")).length, 4);
      return {
        ...(assessStructure
          ? { structure: { differenceIds: stage === "original" ? ["x", "y"] : [] } }
          : {}),
        ...(measureIntegration ? { integration: { buildPassed: true, resultMatched: true } } : {}),
      };
    },
    async repairStructural({ participant }) {
      assert.equal(participant.driver.name, "repair");
      assert.equal(participant.driver.closed, false);
      events.push("repair");
    },
    async repairIntegration() {
      assert.fail("No integration correction");
    },
    score: (x) => x,
  });
  assert.equal(events.filter((x) => x === "repair").length, 2);
  assert.equal(events.filter((x) => x.startsWith("close:")).length, 6);
  assert.deepEqual(result.recovery.score.finalDifferences, []);
});
