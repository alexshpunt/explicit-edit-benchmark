import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAggregateRun,
  createAggregateState,
  materializeAggregateState,
  verifyAggregateState,
} from "../../scripts/aggregate-state.mjs";
import { aggregateLeaderboard, aggregateToolUsage } from "../../scripts/result-aggregation.mjs";

function evidence(runId, passed) {
  const run = {
    runId,
    contract: "contract-v1",
    taskSetSha256: "a".repeat(64),
    verifierSha256: "b".repeat(64),
    policy: { oracleRecoveries: 1, retryFailures: 0, timeoutMs: 1000 },
    definitions: {
      benchmark: { id: "explicit-edit", version: "1" },
      runner: { id: "runner", version: "1" },
      taskSet: { taskIds: ["replace-all-10-plain"] },
    },
  };
  return {
    run,
    profiles: [
      {
        runId,
        profileId: "profile",
        modelFamily: "model",
        modelVersion: "model",
        harnessId: "pi-default",
        harnessFamily: "pi-default",
        harnessVersion: "1",
        configurationHash: "config",
        thinking: "low",
      },
    ],
    trials: [
      {
        runId,
        trialId: `trial-${runId}`,
        profileId: "profile",
        taskId: "replace-all-10-plain",
        rounds: 2,
        firstExactPassed: passed,
        finalExactPassed: true,
        infrastructureFailure: null,
      },
    ],
    rounds: [
      {
        runId,
        roundId: `round-${runId}-1`,
        trialId: `trial-${runId}`,
        seconds: 2,
        costUsd: 0.1,
        totalTokens: 10,
        timedOut: false,
      },
      {
        runId,
        roundId: `round-${runId}-2`,
        trialId: `trial-${runId}`,
        seconds: 3,
        costUsd: 0.2,
        totalTokens: 20,
        timedOut: true,
      },
    ],
    toolCalls: [
      { runId, roundId: `round-${runId}-1`, tool: "read" },
      { runId, roundId: `round-${runId}-1`, tool: "read" },
      { runId, roundId: `round-${runId}-2`, tool: "edit" },
    ],
  };
}

function sourceIndex(runs) {
  return {
    schemaVersion: 1,
    submissions: runs.map(({ run }) => ({
      runId: run.runId,
      submissionId: `submission-${run.runId}`,
    })),
  };
}

test("incremental aggregate state matches recovery from canonical evidence", () => {
  const first = evidence("run-a", false);
  const second = evidence("run-b", true);
  const firstIndex = sourceIndex([first]);
  let incremental = createAggregateState({ sourceIndex: firstIndex, ...first });
  const completeIndex = sourceIndex([first, second]);
  incremental = appendAggregateRun(incremental, {
    previousSourceIndex: firstIndex,
    sourceIndex: completeIndex,
    ...second,
  });
  const rebuilt = createAggregateState({
    sourceIndex: completeIndex,
    run: [first.run, second.run],
    profiles: [...first.profiles, ...second.profiles],
    trials: [...first.trials, ...second.trials],
    rounds: [...first.rounds, ...second.rounds],
    toolCalls: [...first.toolCalls, ...second.toolCalls],
  });
  assert.deepEqual(incremental, rebuilt);

  const restored = materializeAggregateState(incremental);
  const index = { runs: restored.runs };
  const expectedIndex = { runs: [first.run, second.run] };
  assert.deepEqual(
    aggregateLeaderboard(index, restored.profiles, restored.trials, restored.rounds),
    aggregateLeaderboard(
      expectedIndex,
      [...first.profiles, ...second.profiles],
      [...first.trials, ...second.trials],
      [...first.rounds, ...second.rounds],
    ),
  );
  assert.deepEqual(
    aggregateToolUsage(
      index,
      restored.profiles,
      restored.trials,
      restored.rounds,
      restored.toolCalls,
    ),
    aggregateToolUsage(
      expectedIndex,
      [...first.profiles, ...second.profiles],
      [...first.trials, ...second.trials],
      [...first.rounds, ...second.rounds],
      [...first.toolCalls, ...second.toolCalls],
    ),
  );
});

test("aggregate state is bound to source index and rejects conflicting runs", () => {
  const first = evidence("run-a", true);
  const index = sourceIndex([first]);
  const state = createAggregateState({ sourceIndex: index, ...first });
  assert.doesNotThrow(() => verifyAggregateState(state, index));
  assert.throws(() => verifyAggregateState(state, { ...index, submissions: [] }), /source index/i);
  assert.throws(
    () =>
      appendAggregateRun(state, {
        previousSourceIndex: index,
        sourceIndex: index,
        ...evidence("run-a", false),
      }),
    /different evidence/i,
  );
});
