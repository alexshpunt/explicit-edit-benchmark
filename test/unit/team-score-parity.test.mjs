import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTeamReport } from "../../scripts/normalized-run.mjs";
import {
  aggregateExactConfigurations,
  aggregateLeaderboard,
} from "../../scripts/result-aggregation.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_VERSION,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

// Unequal barriers expose accidental barrier-weighting; the workload still has 71 tasks.
const taskIds = Array.from(
  { length: 71 },
  (_, index) => `task-${String(index + 1).padStart(3, "0")}`,
);
const schedule = [taskIds.slice(0, 1), taskIds.slice(1, 3), taskIds.slice(3)].map(
  (tasks, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: tasks.map((task) => ({ agent: 0, task })),
  }),
);
const profile = {
  runId: "team-score",
  profileId: "example",
  modelId: "example/model",
  harnessId: "custom",
  configurationHash: "a".repeat(64),
};

function evidence(acceptedAttempts) {
  const report = {
    status: acceptedAttempts.every(Boolean) ? "pass" : "driver_exit",
    agents: 15,
    totalTasks: 71,
    totalRounds: schedule.length,
    acceptedTasks: 0,
    acceptedRounds: 0,
    schedule,
    checks: [{ label: "initial", status: "pass" }],
    executions: [],
  };
  for (const [index, attemptCount] of acceptedAttempts.entries()) {
    const barrier = schedule[index];
    for (let attempt = 1; attempt <= attemptCount; attempt++) {
      report.checks.push({
        label: `${barrier.id}-attempt-${attempt}`,
        status: attempt === attemptCount ? "pass" : "fail",
        category: attempt === attemptCount ? undefined : "structure",
      });
      report.executions.push({
        round: barrier.id,
        agent: 0,
        attempt,
        tasks: barrier.assignments.map((item) => item.task),
        status: "settled",
        receipt: { exitCode: 0, processSeconds: 1 },
      });
    }
    if (attemptCount) {
      report.acceptedTasks += barrier.assignments.length;
      report.acceptedRounds++;
    }
  }
  const run = {
    runId: profile.runId,
    contract: MULTI_AGENT_PROTOCOL,
    definitions: {
      benchmark: { id: MULTI_AGENT_BENCHMARK, version: MULTI_AGENT_VERSION },
      taskSet: { taskIds },
    },
    suite: {
      observations: [{ profileId: profile.profileId, status: report.status, elapsedMs: 1000 }],
    },
  };
  const normalized = normalizeTeamReport(report, profile, "b".repeat(64));
  return {
    index: { runs: [run] },
    trials: normalized.trials.map((trial) => ({ ...trial, runId: profile.runId })),
    rounds: normalized.rounds.map((round) => ({ ...round, runId: profile.runId })),
  };
}

for (const [name, attempts, firstTasks, finalTasks] of [
  ["first-pass team completion earns full Score", [1, 1, 1], 71, 71],
  ["recovery-only team completion earns 25 percent, not 100 percent", [2, 2, 2], 0, 71],
  ["unequal barriers weight canonical tasks, not barrier count", [1, 2, 1], 69, 71],
  ["a stopped prefix keeps weighted credit and an unreached suffix earns none", [1, 2, 0], 1, 3],
  ["a team without an accepted barrier earns zero Score", [0, 0, 0], 0, 0],
]) {
  test(name, () => {
    const { index, trials, rounds } = evidence(attempts);
    const [exact] = aggregateExactConfigurations(index, [profile], trials, rounds);
    const [leaderboard] = aggregateLeaderboard(index, [profile], trials, rounds);
    const expected = (0.75 * firstTasks + 0.25 * finalTasks) / 71;
    assert.equal(exact.taskCount, 71);
    assert.equal(exact.benchmarkTaskCount, 71);
    assert.equal(exact.firstExactPasses, firstTasks);
    assert.equal(exact.finalExactPasses, finalTasks);
    assert.equal(exact.durationSummary.coveredRun, 1);
    for (const row of [exact, leaderboard]) {
      assert.ok(Math.abs(row.score - expected) < 1e-12);
      assert.equal(row.coverage, 1);
      assert.equal(row.firstExactRate, firstTasks / 71);
      assert.equal(row.finalExactRate, finalTasks / 71);
    }
  });
}

test("original single-task trials retain the same first/eventual Score", () => {
  const { index, trials } = evidence([1, 2, 0]);
  delete index.runs[0].suite;
  const original = trials.flatMap((barrier) =>
    barrier.taskIds.map((taskId) => ({ ...barrier, taskId, taskIds: undefined })),
  );
  const [aggregate] = aggregateExactConfigurations(index, [profile], original, []);
  assert.equal(aggregate.firstExactPasses, 1);
  assert.equal(aggregate.finalExactPasses, 3);
  assert.ok(Math.abs(aggregate.score - 1.5 / 71) < 1e-12);
});
