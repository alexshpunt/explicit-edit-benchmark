import assert from "node:assert/strict";
import { test } from "node:test";
import { runBatchedRequestChain } from "../../src/suites/explicit-edit-multi-agent/tasks/request-batches.mjs";
import {
  runRequestChain,
  ExecutionFailure,
} from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";
import { summarizeChain } from "../../scripts/multi-agent/experiments/chain-report.mjs";

const steps = ["first", "second", "future"].map((id, index) => ({
  id,
  prompt: `Do ${id}`,
  phase: "structure",
  group: index < 2 ? "current" : "next",
}));
const messages = {
  build: "The project does not build.",
  behavior: "The rendered images do not match.",
  structure: "The batch requirements are not met.",
};
const privateError =
  "/trusted/answer.cpp:6414 SECRET_OWNER expected brace; replace body with saved source";

test("three coarse oracle recoveries keep edits and session, never replay requests or expose diagnostics", async () => {
  let state = 0;
  const calls = [];
  const grades = [];
  const report = await runBatchedRequestChain(steps, {
    oracleRecoveries: 3,
    feedbackMode: "coarse",
    identity: () => String(state),
    execute: async (delivery) => {
      calls.push({ ...delivery, state });
      state++;
      return { sessionId: "same", lifetime: "same" };
    },
    grade: async ({ index, attempt }) => {
      grades.push({ index, attempt, state });
      if (index === 0 && attempt < 4)
        throw new GradeFailure(["build", "behavior", "structure"][attempt - 1], privateError);
      return { status: "pass" };
    },
  });
  assert.equal(report.status, "pass");
  assert.equal(report.passedRequests, 3);
  assert.equal(report.passedBatches, 2);
  assert.deepEqual(
    calls.map(({ index, repair, state }) => [index, repair, state]),
    [
      [0, false, 0],
      [1, false, 1],
      [1, true, 2],
      [1, true, 3],
      [1, true, 4],
      [2, false, 5],
    ],
  );
  assert.deepEqual(
    grades.map(({ state }) => state),
    [2, 3, 4, 5, 6],
  );
  for (const [index, message] of Object.values(messages).entries()) {
    assert.ok(calls[index + 2].prompt.includes(message));
    assert.match(calls[index + 2].prompt, /current workspace|already delivered/);
  }
  for (const call of calls)
    assert.doesNotMatch(call.prompt, /trusted|SECRET_OWNER|6414|saved source|expected brace/);
  assert.equal(report.batchReport.attempts[0].grade.message, privateError);
  assert.deepEqual(report.batchReport.policy, { oracleRecoveries: 3, feedbackMode: "coarse" });
  assert.equal(summarizeChain(report.batchReport).counts.repairedPass, 1);
});

test("four failed attempts block the batch without delivering the suffix, and evidence enforces its budget", async () => {
  const calls = [];
  const report = await runBatchedRequestChain(steps, {
    oracleRecoveries: 3,
    feedbackMode: "coarse",
    identity: () => String(calls.length),
    execute: async ({ prompt }) => {
      calls.push(prompt);
    },
    grade: async () => {
      throw new GradeFailure("build", privateError);
    },
  });
  assert.equal(report.status, "blocked");
  assert.equal(report.passedRequests, 0);
  assert.equal(calls.length, 5);
  assert.equal(report.requests[2].status, "unattempted");
  assert.equal(report.batchReport.attempts.length, 4);
  assert.equal(summarizeChain(report.batchReport).counts.failedAttempts, 4);
  const legacy = structuredClone(report.batchReport);
  delete legacy.policy;
  assert.throws(() => summarizeChain(legacy), /attempt|block/i);
  const exceeded = structuredClone(report.batchReport);
  exceeded.attempts.push({ ...exceeded.attempts.at(-1), attempt: 5 });
  assert.throws(() => summarizeChain(exceeded), /attempt/i);
});

test("no recoveries means one attempt, while runtime failures never receive oracle feedback", async () => {
  for (const oracleRecoveries of [0, 3]) {
    const report = await runRequestChain(steps, {
      oracleRecoveries,
      feedbackMode: "coarse",
      identity: () => "unchanged",
      execute: async () => {
        if (oracleRecoveries) throw new ExecutionFailure("provider_failure", privateError);
      },
      grade: async () => {
        throw new GradeFailure("behavior", privateError);
      },
    });
    assert.equal(report.attempts.length, 1);
    assert.equal(report.status, oracleRecoveries ? "provider_failure" : "blocked");
    assert.equal(report.steps[1].status, "unattempted");
    assert.equal(summarizeChain(report).counts.attempts, 1);
  }
  for (const options of [
    { oracleRecoveries: -1 },
    { oracleRecoveries: 1.5 },
    { feedbackMode: "raw" },
  ])
    await assert.rejects(runRequestChain(steps, options), /oracle|feedback|policy/i);
});
