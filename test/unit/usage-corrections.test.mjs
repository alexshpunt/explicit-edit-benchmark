import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUsageOnlyCorrection,
  validateCorrectionRequests,
} from "../../scripts/usage-corrections.mjs";

function evidence() {
  return {
    manifest: {
      runId: "run",
      policy: { timeoutMs: 1000 },
      files: {
        "rounds.jsonl": { bytes: 10, sha256: "old" },
        "trials.jsonl": { bytes: 20, sha256: "same" },
      },
    },
    tables: {
      "profiles.jsonl": "profile\n",
      "configurations.jsonl": "configuration\n",
      "trials.jsonl": "trial\n",
      "tool-calls.jsonl": "call\n",
    },
    rounds: [
      {
        roundId: "r1",
        trialId: "t1",
        exactPassed: true,
        seconds: 2,
        costUsd: null,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        totalTokens: null,
      },
    ],
  };
}
function corrected() {
  const next = evidence();
  next.manifest.files["rounds.jsonl"] = { bytes: 12, sha256: "new" };
  Object.assign(next.rounds[0], {
    costUsd: 0.1,
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 7,
    totalTokens: 17,
  });
  return next;
}

test("usage corrections allow only token and cost changes and their round digest", () => {
  assert.deepEqual(assertUsageOnlyCorrection(evidence(), corrected()), {
    inputTokens: 2,
    outputTokens: 3,
    cacheReadTokens: 5,
    cacheWriteTokens: 7,
    totalTokens: 17,
    costUsd: 0.1,
  });
  for (const mutate of [
    (next) => {
      next.rounds[0].exactPassed = false;
    },
    (next) => {
      next.rounds[0].seconds = 3;
    },
    (next) => {
      next.rounds[0].roundId = "different";
    },
    (next) => {
      next.rounds.pop();
    },
    (next) => {
      next.manifest.runId = "different";
    },
    (next) => {
      next.tables["profiles.jsonl"] = "different";
    },
    (next) => {
      next.manifest.files["trials.jsonl"].sha256 = "different";
    },
    (next) => {
      next.rounds[0].totalTokens = 99;
    },
    (next) => {
      next.rounds[0].costUsd = -1;
    },
  ]) {
    const next = corrected();
    mutate(next);
    assert.throws(() => assertUsageOnlyCorrection(evidence(), next));
  }
});

test("correction requests pin the exact contributor, commit, hashes and totals", () => {
  const request = {
    candidate: 133,
    author: "alice",
    candidateCommit: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    roundsSha256: "c".repeat(64),
    totalTokens: 17,
    costUsd: 0.1,
  };
  assert.deepEqual(validateCorrectionRequests([request]), [request]);
  for (const changes of [
    { candidateCommit: "main" },
    { manifestSha256: "bad" },
    { author: "../alice" },
    { totalTokens: -1 },
    { costUsd: -1 },
    { extra: "field" },
  ]) {
    assert.throws(() => validateCorrectionRequests([{ ...request, ...changes }]));
  }
  assert.throws(() => validateCorrectionRequests([request, request]));
});
