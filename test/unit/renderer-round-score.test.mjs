import assert from "node:assert/strict";
import test from "node:test";
import {
  ROUND_SCORE_POLICY,
  roundScore,
  scoreRounds,
} from "../../src/suites/explicit-edit-multi-agent/grading/round-score.mjs";

const outcome = (passedAtoms, totalAtoms, buildPassed = true, resultMatched = true) => ({
  passedAtoms,
  totalAtoms,
  buildPassed,
  resultMatched,
});

test("round credit rewards build and exact output without zeroing correct edits", () => {
  assert.equal(ROUND_SCORE_POLICY.buildWeight, 2);
  assert.equal(ROUND_SCORE_POLICY.resultWeight, 4);
  assert.equal(roundScore(outcome(8, 10, false, false)).score, 10);
  assert.equal(roundScore(outcome(8, 10, true, false)).score, 20);
  assert.equal(roundScore(outcome(8, 10)).score, 80);
  assert.equal(roundScore(outcome(0, 10)).score, 0);
  assert.equal(roundScore(outcome(10, 10)).score, 100);
});

test("rounds have equal maximum weight regardless of their atomic edit counts", () => {
  const result = scoreRounds(
    [
      { round: "small", ...outcome(1, 1) },
      { round: "large", ...outcome(500, 1000) },
    ],
    2,
  );
  assert.equal(result.score, 75);
  assert.equal(result.observedRounds, 2);
  assert.equal(result.plannedRounds, 2);
  assert.equal(result.complete, true);
  assert.equal(result.buildWeight, 2);
  assert.equal(result.resultWeight, 4);
});

test("unobserved rounds stay in the full planned denominator", () => {
  const result = scoreRounds([{ round: "first", ...outcome(5, 5) }], 4);
  assert.equal(result.score, 25);
  assert.equal(result.observedRounds, 1);
  assert.equal(result.complete, false);
  assert.equal(scoreRounds([], 4).score, 0);
});

test("custom weights retain the 100 point maximum and the failure baseline", () => {
  const weights = { buildWeight: 3, resultWeight: 5 };
  assert.equal(roundScore(outcome(5, 5), weights).score, 100);
  assert.equal(roundScore(outcome(5, 5, true, false), weights).score, 20);
  assert.ok(Math.abs(roundScore(outcome(5, 5, false, false), weights).score - 100 / 15) < 1e-12);
  assert.equal(
    scoreRounds([{ round: "only", ...outcome(3, 4, false, false) }], 1, {
      buildWeight: 1,
      resultWeight: 1,
    }).score,
    75,
  );
  assert.equal(
    roundScore(outcome(1, 1), { buildWeight: Number.MAX_VALUE, resultWeight: Number.MAX_VALUE })
      .score,
    100,
  );
});

test("invalid weights and inconsistent output evidence cannot produce a score", () => {
  for (const value of [0, -1, 0.5, NaN, Infinity, "2", null]) {
    assert.throws(() => roundScore(outcome(1, 1), { buildWeight: value }));
    assert.throws(() => roundScore(outcome(1, 1), { resultWeight: value }));
  }
  assert.throws(() => roundScore(outcome(1, 1, false, true)));
  assert.throws(() => roundScore(outcome(1, 1, 1, true)));
  assert.throws(() => roundScore(outcome(1, 1, true, "pass")));
});

test("atomic counts are bounded integers and empty editing rounds cannot be scored", () => {
  for (const [passed, total] of [
    [-1, 1],
    [2, 1],
    [0.5, 1],
    [1, 1.5],
    [0, 0],
    [0, Infinity],
  ])
    assert.throws(() => roundScore(outcome(passed, total)));
});

test("repeated round attempts cannot be counted as additional rounds", () => {
  const first = { round: "same", ...outcome(1, 1) };
  assert.throws(() => scoreRounds([first, first], 2));
  assert.throws(() => scoreRounds([first], 0));
  assert.throws(() => scoreRounds([first], 0.5));
  assert.throws(() => scoreRounds([first, { ...first, round: "other" }], 1));
  assert.throws(() => scoreRounds([{ ...first, round: "" }], 1));
});

test("unattributed protected source damage vetoes the round without rewriting atom evidence", () => {
  const measured = { round: "damaged", ...outcome(10, 10), integrityPassed: false };
  const result = roundScore(measured);
  assert.equal(result.passedAtoms, 10);
  assert.equal(result.editFraction, 1);
  assert.equal(result.integrityPassed, false);
  assert.equal(result.score, 0);
  assert.equal(scoreRounds([measured], 1).score, 0);
  assert.throws(() => roundScore({ ...measured, integrityPassed: "false" }));
});

test("aggregate score is derived from evidence rather than a supplied score", () => {
  const result = scoreRounds(
    [{ round: "only", ...outcome(1, 4, false, false), score: 100, normalized: 1 }],
    1,
  );
  assert.equal(result.score, 3.125);
});
