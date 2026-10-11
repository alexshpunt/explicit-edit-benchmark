import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { runRequestChain } from "../../src/suites/explicit-edit-multi-agent/execution/request-chain.mjs";

const steps = ["first", "second", "third"].map((id) => ({ id, prompt: id }));
const callbacks = {
  identity: () => "current",
  execute: async ({ signal }) => {
    await delay(30, undefined, { signal });
  },
  grade: async () => ({ status: "pass" }),
};

test("a disabled chain deadline keeps every request while finite deadlines still stop the trial", async () => {
  const unlimited = await runRequestChain(steps, {
    ...callbacks,
    trialTimeoutMs: null,
    attemptTimeoutMs: 200,
  });
  assert.equal(unlimited.status, "pass");
  assert.equal(unlimited.passedPrefix, 3);

  const limited = await runRequestChain(steps, {
    ...callbacks,
    trialTimeoutMs: 20,
    attemptTimeoutMs: 200,
  });
  assert.equal(limited.status, "timeout");
  assert.equal(limited.passedPrefix, 0);
  assert.equal(limited.steps[1].status, "unattempted");
});

test("a disabled chain deadline still enforces attempt timeout and rejects invalid limits", async () => {
  const report = await runRequestChain(steps, {
    ...callbacks,
    trialTimeoutMs: null,
    attemptTimeoutMs: 10,
  });
  assert.equal(report.status, "timeout");
  assert.equal(report.attempts.length, 1);
  assert.equal(report.steps[1].status, "unattempted");

  for (const trialTimeoutMs of [0, -1, Infinity, NaN, "none"])
    await assert.rejects(runRequestChain(steps, { ...callbacks, trialTimeoutMs }), /time limits/);
  for (const attemptTimeoutMs of [0, -1, Infinity, NaN, "none"])
    await assert.rejects(
      runRequestChain(steps, { ...callbacks, trialTimeoutMs: null, attemptTimeoutMs }),
      /time limits/,
    );
});
