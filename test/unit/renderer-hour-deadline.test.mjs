import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { overallDeadline } from "../../src/suites/explicit-edit-multi-agent/execution/overall-deadline.mjs";
import { runRequestChain } from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";
import { GradeFailure } from "../../src/suites/explicit-edit-multi-agent/grading/failure.mjs";

test("an explicitly untimed chain uses no timer and still retains all four checked attempts", async () => {
  let timers = 0;
  let edits = 0;
  const hook = createHook({
    init(_id, type) {
      if (type === "Timeout") timers++;
    },
  });
  hook.enable();
  let report;
  try {
    report = await runRequestChain([{ id: "one", prompt: "edit" }], {
      attemptTimeoutMs: null,
      trialTimeoutMs: null,
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      identity: async () => String(edits),
      execute: async () => {
        edits++;
      },
      grade: async () => {
        throw new GradeFailure("structure", "private detail");
      },
    });
  } finally {
    hook.disable();
  }
  assert.equal(timers, 0);
  assert.equal(report.status, "blocked");
  assert.equal(report.attempts.length, 4);
  assert.deepEqual(
    report.attempts.map(({ before, after }) => [before, after]),
    [
      ["0", "1"],
      ["1", "2"],
      ["2", "3"],
      ["3", "4"],
    ],
  );
});

test("an untimed attempt still honors a finite chain deadline and user cancellation", async () => {
  for (const cancelled of [false, true]) {
    const user = new AbortController();
    const timer = cancelled ? setTimeout(() => user.abort(), 20) : undefined;
    try {
      const report = await runRequestChain([{ id: "one", prompt: "edit" }], {
        signal: user.signal,
        attemptTimeoutMs: null,
        trialTimeoutMs: cancelled ? null : 20,
        identity: async () => "retained",
        execute: async ({ signal }) => delay(1000, null, { signal }),
        grade: async () => {
          throw Error("Cancelled work must not be graded");
        },
      });
      assert.equal(report.status, cancelled ? "cancelled" : "timeout");
      assert.equal(report.attempts[0].after, "retained");
    } finally {
      clearTimeout(timer);
    }
  }
});

test("an overall deadline includes preparation before the chain and reports timeout, not cancellation", async () => {
  const deadline = overallDeadline(undefined, 30);
  try {
    await delay(40);
    let executions = 0;
    const report = await runRequestChain([{ id: "one", prompt: "edit" }], {
      signal: deadline.signal,
      trialTimeoutMs: null,
      identity: async () => "unchanged",
      execute: async () => {
        executions++;
      },
      grade: async () => ({ status: "pass" }),
    });
    assert.equal(report.status, "timeout");
    assert.equal(executions, 0);
    assert.equal(report.steps[0].status, "unattempted");
  } finally {
    deadline.close();
  }
});

test("active work obeys the overall cap while an explicit user abort stays cancelled", async () => {
  for (const cancelled of [false, true]) {
    const user = new AbortController();
    const deadline = overallDeadline(user.signal, cancelled ? 1000 : 20);
    const timer = cancelled ? setTimeout(() => user.abort(), 20) : undefined;
    try {
      const report = await runRequestChain([{ id: "one", prompt: "edit" }], {
        signal: deadline.signal,
        attemptTimeoutMs: 1000,
        trialTimeoutMs: null,
        identity: async () => "retained",
        execute: async ({ signal }) => delay(1000, null, { signal }),
        grade: async () => {
          throw Error("Must not grade timed-out work");
        },
      });
      assert.equal(report.status, cancelled ? "cancelled" : "timeout");
      assert.equal(report.attempts[0].after, "retained");
    } finally {
      clearTimeout(timer);
      deadline.close();
    }
  }
  assert.throws(() => overallDeadline(undefined, 3600001), /60|hour|limit/i);
});
