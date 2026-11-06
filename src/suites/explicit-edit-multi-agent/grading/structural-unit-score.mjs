import assert from "node:assert/strict";
import { finalSnapshotScore } from "../extraction/final-snapshot-score.mjs";
import { CANONICAL_SCORE_POLICY } from "./canonical-score.mjs";
import { LINE_DIFFERENCE_POLICY } from "./line-differences.mjs";
import { STRUCTURAL_UNIT_POLICY } from "./structural-units.mjs";

export const STRUCTURAL_UNIT_SCORE_POLICY = Object.freeze({
  version: "renderer-structural-unit-score-v1",
  units: STRUCTURAL_UNIT_POLICY.version,
  structural: "initial-and-final-unit-differences",
  resolvedInitialCredit: 0.5,
  initialDifferencePenalty: 1,
  newFinalDifferencePenalty: 1,
  integration: CANONICAL_SCORE_POLICY.integration,
});

/** The same balance over line differences: one missing or extra line has weight 1. */
export const LINE_DIFFERENCE_SCORE_POLICY = Object.freeze({
  ...STRUCTURAL_UNIT_SCORE_POLICY,
  version: "renderer-line-difference-score-v1",
  units: LINE_DIFFERENCE_POLICY.version,
  structural: "initial-and-final-line-differences",
});

const policies = new Map([
  [STRUCTURAL_UNIT_POLICY.version, STRUCTURAL_UNIT_SCORE_POLICY],
  [LINE_DIFFERENCE_POLICY.version, LINE_DIFFERENCE_SCORE_POLICY],
]);
const scoreVersions = new Set([...policies.values()].map(({ version }) => version));

function validate(comparison) {
  assert.ok(policies.has(comparison?.version), "Unknown comparison version");
  assert.ok(Number.isSafeInteger(comparison.totalUnits) && comparison.totalUnits > 0);
  for (const key of ["startIdentity", "referenceIdentity"])
    assert.match(comparison[key], /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(comparison.differenceIds));
}

/** One round from its initial and final unit comparisons and actual integration outcomes. */
export function structuralUnitScore({ initial, final, ...integration }) {
  validate(initial);
  validate(final);
  const policy = policies.get(initial.version);
  for (const key of ["version", "totalUnits", "startIdentity", "referenceIdentity"])
    assert.equal(final[key], initial[key], "Comparisons belong to different rounds");
  const score = finalSnapshotScore({
    ...integration,
    totalFiles: initial.totalUnits,
    initialDifferences: initial.differenceIds,
    finalDifferences: final.differenceIds,
  });
  const { totalFiles: _files, ...structural } = score.structural;
  return {
    ...score,
    version: policy.version,
    policy,
    startIdentity: initial.startIdentity,
    referenceIdentity: initial.referenceIdentity,
    structural: { totalUnits: initial.totalUnits, ...structural },
  };
}

/** Planned rounds without a measured result count as zero. */
export function structuralUnitRunScore(rounds, plannedRounds) {
  assert.ok(Number.isSafeInteger(plannedRounds) && plannedRounds > 0);
  assert.ok(Array.isArray(rounds) && rounds.length <= plannedRounds);
  let sum = 0;
  for (const round of rounds) {
    assert.ok(scoreVersions.has(round?.version), "Unknown round score version");
    assert.equal(round.version, rounds[0].version, "Rounds use different scores");
    assert.ok(round.normalized >= 0 && round.normalized <= 1);
    sum += round.normalized;
  }
  return {
    version: rounds[0]?.version ?? STRUCTURAL_UNIT_SCORE_POLICY.version,
    plannedRounds,
    observedRounds: rounds.length,
    complete: rounds.length === plannedRounds,
    normalized: sum / plannedRounds,
    score: (100 * sum) / plannedRounds,
  };
}
