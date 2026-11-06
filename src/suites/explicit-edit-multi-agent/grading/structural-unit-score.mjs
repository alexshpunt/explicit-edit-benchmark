import assert from "node:assert/strict";
import { finalSnapshotScore } from "../extraction/final-snapshot-score.mjs";
import { CANONICAL_SCORE_POLICY } from "./canonical-score.mjs";
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

function validate(comparison) {
  assert.equal(comparison?.version, STRUCTURAL_UNIT_POLICY.version);
  assert.ok(Number.isSafeInteger(comparison.totalUnits) && comparison.totalUnits > 0);
  for (const key of ["startIdentity", "referenceIdentity"])
    assert.match(comparison[key], /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(comparison.differenceIds));
}

/** One round from its initial and final unit comparisons and actual integration outcomes. */
export function structuralUnitScore({ initial, final, ...integration }) {
  validate(initial);
  validate(final);
  for (const key of ["totalUnits", "startIdentity", "referenceIdentity"])
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
    version: STRUCTURAL_UNIT_SCORE_POLICY.version,
    policy: STRUCTURAL_UNIT_SCORE_POLICY,
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
    assert.equal(round?.version, STRUCTURAL_UNIT_SCORE_POLICY.version);
    assert.ok(round.normalized >= 0 && round.normalized <= 1);
    sum += round.normalized;
  }
  return {
    version: STRUCTURAL_UNIT_SCORE_POLICY.version,
    plannedRounds,
    observedRounds: rounds.length,
    complete: rounds.length === plannedRounds,
    normalized: sum / plannedRounds,
    score: (100 * sum) / plannedRounds,
  };
}
