import assert from "node:assert/strict";

export const ROUND_SCORE_POLICY = Object.freeze({
  version: "renderer-round-score-v1",
  integrity: "zero-unattributed-preservation",
  buildWeight: 2,
  resultWeight: 4,
});

function weights(options) {
  const result = {
    buildWeight: options.buildWeight ?? ROUND_SCORE_POLICY.buildWeight,
    resultWeight: options.resultWeight ?? ROUND_SCORE_POLICY.resultWeight,
  };
  for (const key of ["buildWeight", "resultWeight"]) {
    if (Object.hasOwn(options, key)) result[key] = options[key];
    assert.ok(Number.isFinite(result[key]) && result[key] >= 1, "Invalid round bonus weight");
  }
  return result;
}

/** Grade only the measured candidate. Controller restoration never contributes
 * atoms or bonus evidence. Ratios avoid overflowing the product of valid weights.
 */
export function roundScore(
  { passedAtoms, totalAtoms, buildPassed, resultMatched, integrityPassed = true },
  options = {},
) {
  const { buildWeight, resultWeight } = weights(options);
  assert.ok(Number.isSafeInteger(totalAtoms) && totalAtoms > 0, "Empty or invalid editing round");
  assert.ok(
    Number.isSafeInteger(passedAtoms) && passedAtoms >= 0 && passedAtoms <= totalAtoms,
    "Invalid successful atomic edit count",
  );
  assert.equal(typeof buildPassed, "boolean", "Missing build outcome");
  assert.equal(typeof resultMatched, "boolean", "Missing output outcome");
  assert.equal(typeof integrityPassed, "boolean", "Invalid preservation outcome");
  assert.ok(!resultMatched || buildPassed, "Output match requires a successful build");
  const editFraction = passedAtoms / totalAtoms;
  const buildMultiplier = buildPassed ? buildWeight : 1;
  const resultMultiplier = resultMatched ? resultWeight : 1;
  const normalized = integrityPassed
    ? editFraction * (buildMultiplier / buildWeight) * (resultMultiplier / resultWeight)
    : 0;
  return {
    passedAtoms,
    totalAtoms,
    editFraction,
    integrityPassed,
    buildPassed,
    resultMatched,
    buildMultiplier,
    resultMultiplier,
    normalized,
    score: 100 * normalized,
  };
}

/** Equal round maxima and the complete planned denominator keep small stages
 * visible and prevent incomplete runs from gaining credit through missing rows.
 * The caller supplies exactly one final measured outcome per observed round.
 */
export function scoreRounds(rounds, plannedRounds, options = {}) {
  const effective = weights(options);
  assert.ok(Number.isSafeInteger(plannedRounds) && plannedRounds > 0, "Invalid planned rounds");
  assert.ok(Array.isArray(rounds) && rounds.length <= plannedRounds, "Excess round outcomes");
  const seen = new Set();
  let sum = 0;
  for (const outcome of rounds) {
    assert.ok(
      typeof outcome.round === "string" && outcome.round.length > 0,
      "Missing round identity",
    );
    assert.ok(!seen.has(outcome.round), "Repeated round outcome");
    seen.add(outcome.round);
    sum += roundScore(outcome, effective).normalized;
  }
  return {
    version: ROUND_SCORE_POLICY.version,
    ...effective,
    plannedRounds,
    observedRounds: rounds.length,
    complete: rounds.length === plannedRounds,
    score: (100 * sum) / plannedRounds,
  };
}
