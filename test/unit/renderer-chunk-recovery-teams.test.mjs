import assert from "node:assert/strict";
import test from "node:test";
import { runChunkRecoveryTeams } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-recovery-teams.mjs";

function team(phase, log) {
  return {
    agents: 2,
    async createDriver(agent) {
      log.push(`start:${phase}:${agent}`);
      return {
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
    },
    async execute(driver) {
      assert.equal(driver.closed, false);
    },
  };
}
function input(log, capture) {
  return {
    otherTasks: [{ id: "one", batches: [1] }],
    mathTasks: [{ id: "math", batches: [2] }],
    other: team("other", log),
    math: team("math", log),
    repairTeam: team("repair", log),
    totalFiles: 2,
    capture,
    repairIntegration: async () => assert.fail("Unexpected integration repair"),
  };
}
function snapshot(ids) {
  return {
    structure: { differenceIds: ids },
    integration: { buildPassed: true, resultMatched: true },
  };
}

test("a fresh repair team starts only after both original teams closed", async () => {
  const log = [];
  let fixed = false;
  const result = await runChunkRecoveryTeams({
    ...input(log, async () => {
      if (!fixed) assert.equal(log.filter((x) => x.startsWith("close:")).length, 4);
      return snapshot(fixed ? [] : ["one"]);
    }),
    async repairStructural({ participant, participants, id }) {
      assert.equal(id, "one");
      assert.equal(participant.driver.phase, "repair");
      assert.ok(participants.every((p) => !p.driver.closed));
      fixed = true;
    },
  });
  assert.equal(result.recovery.score.score, 75);
  assert.equal(result.recovery.score.policy.structuralParticipants, "fresh-team");
  assert.notEqual(result.recovery.score.policy.version, "renderer-module-extraction-recovery-v2");
  assert.equal(log.filter((x) => x.startsWith("close:")).length, 6);
  assert.ok(
    log.findIndex((x) => x.startsWith("start:repair")) >
      log.findLastIndex((x) => x.startsWith("close:math")),
  );
});

test("a passing original candidate does not start a repair team", async () => {
  const log = [];
  await runChunkRecoveryTeams({
    ...input(log, async () => snapshot([])),
    repairStructural: async () => assert.fail("No repair"),
  });
  assert.ok(!log.some((x) => x.startsWith("start:repair")));
});

test("cancelling a correction closes the fresh team and produces no score", async () => {
  const log = [];
  const controller = new AbortController();
  await assert.rejects(
    runChunkRecoveryTeams({
      ...input(log, async () => snapshot(["one"])),
      signal: controller.signal,
      repairStructural: async ({ signal }) => {
        controller.abort(Error("cancelled"));
        signal.throwIfAborted();
      },
    }),
    /cancelled/,
  );
  assert.equal(log.filter((x) => x.startsWith("close:")).length, 6);
});
test("a repair failure closes the independent team and leaves no final score", async () => {
  const log = [];
  await assert.rejects(
    runChunkRecoveryTeams({
      ...input(log, async () => snapshot(["one"])),
      repairStructural: async () => {
        throw Error("repair failed");
      },
    }),
    /repair failed/,
  );
  assert.equal(log.filter((x) => x.startsWith("close:")).length, 6);
});
