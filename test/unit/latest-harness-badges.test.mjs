import assert from "node:assert/strict";
import test from "node:test";

import { completeRunEvidence, harnessFamilyGroups } from "../../scripts/build-public-dataset.mjs";

function row(version, taskIds, passed) {
  return {
    harnessFamily: "pi-agent-ide",
    harnessVersion: version,
    benchmarkTaskCount: 226,
    trialSamples: taskIds.map((taskId) => ({
      taskId,
      firstExactPassed: passed,
      finalExactPassed: passed,
    })),
  };
}

test("badge score aggregates every complete version in a harness family", () => {
  const completeTasks = Array.from({ length: 226 }, (_, index) => `task-${index}`);
  const groups = harnessFamilyGroups([
    row("0.5.0", completeTasks, true),
    row("0.5.1", completeTasks, false),
  ]);
  const badge = groups["pi-agent-ide"];
  assert.equal(badge.coverage, 1);
  assert.equal(badge.taskCount, 226);
  assert.equal(badge.score, 0.5);
});

test("badge evidence excludes an incomplete run entirely", () => {
  const taskIds = ["task-0", "task-1"];
  const index = {
    runs: ["full", "partial"].map((runId) => ({
      runId,
      definitions: { taskSet: { taskIds } },
    })),
  };
  const profiles = [
    { runId: "full", profileId: "profile" },
    { runId: "partial", profileId: "profile" },
  ];
  const trials = [
    ...taskIds.map((taskId) => ({ runId: "full", profileId: "profile", taskId })),
    { runId: "partial", profileId: "profile", taskId: "task-0" },
  ];
  const evidence = completeRunEvidence(index, profiles, trials, []);
  assert.deepEqual(
    evidence.index.runs.map((run) => run.runId),
    ["full"],
  );
  assert.equal(evidence.trials.length, 2);
});
