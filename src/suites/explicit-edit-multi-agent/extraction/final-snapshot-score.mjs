import assert from "node:assert/strict";
import { CANONICAL_SCORE_POLICY, canonicalIntegrationFactor } from "../grading/canonical-score.mjs";

export const FINAL_SNAPSHOT_SCORE_POLICY = Object.freeze({
  version: "renderer-chunk-final-snapshot-score-v1",
  structural: "initial-and-final-differences",
  resolvedInitialCredit: 0.5,
  initialDifferencePenalty: 1,
  newFinalDifferencePenalty: 1,
  integration: CANONICAL_SCORE_POLICY.integration,
});

function differenceIds(value) {
  assert.ok(Array.isArray(value));
  const ids = new Set();
  for (const id of value) {
    assert.ok(typeof id === "string" && id.length > 0);
    assert.ok(!ids.has(id));
    ids.add(id);
  }
  return [...ids].sort();
}

/** Score a finished chunk run from exactly two structural snapshots and actual
 * integration outcomes. Null image evidence means the build did not succeed.
 */
export function finalSnapshotScore({
  totalFiles,
  initialDifferences,
  finalDifferences,
  buildFirstPassed,
  preRecoveryBuildPassed,
  firstImageMatched,
  resultRecoveryAttempted,
  finalBuildPassed,
  finalImageMatched,
}) {
  assert.ok(
    Number.isSafeInteger(totalFiles) && totalFiles > 0 && totalFiles <= Number.MAX_SAFE_INTEGER / 2,
  );
  const initial = differenceIds(initialDifferences);
  const final = differenceIds(finalDifferences);
  for (const value of [
    buildFirstPassed,
    preRecoveryBuildPassed,
    resultRecoveryAttempted,
    finalBuildPassed,
  ])
    assert.equal(typeof value, "boolean");
  assert.ok(!buildFirstPassed || preRecoveryBuildPassed);
  assert.ok(
    preRecoveryBuildPassed ? typeof firstImageMatched === "boolean" : firstImageMatched === null,
  );
  assert.ok(finalBuildPassed ? typeof finalImageMatched === "boolean" : finalImageMatched === null);
  assert.equal(resultRecoveryAttempted, !preRecoveryBuildPassed || firstImageMatched === false);
  const before = new Set(initial);
  const after = new Set(final);
  const resolved = initial.filter((id) => !after.has(id));
  const unresolved = initial.filter((id) => after.has(id));
  const introduced = final.filter((id) => !before.has(id));
  const ticks = 2 * (totalFiles - initial.length - introduced.length) + resolved.length;
  assert.ok(Number.isSafeInteger(ticks));
  const rawBalance = ticks / 2;
  const structuralNormalized = Math.max(0, Math.min(1, ticks / (2 * totalFiles)));
  const build = {
    firstPassed: buildFirstPassed,
    correctionUsed: !buildFirstPassed && (preRecoveryBuildPassed || resultRecoveryAttempted),
    finalPassed: finalBuildPassed,
  };
  const images = {
    available: finalBuildPassed,
    firstPassed: firstImageMatched,
    correctionUsed: resultRecoveryAttempted,
    finalPassed: finalImageMatched,
  };
  const buildFactor = canonicalIntegrationFactor(build);
  const imageFactor = canonicalIntegrationFactor({
    firstPassed: firstImageMatched === true,
    correctionUsed: resultRecoveryAttempted,
    finalPassed: finalImageMatched === true,
  });
  const normalized = structuralNormalized * buildFactor * imageFactor;
  return {
    version: FINAL_SNAPSHOT_SCORE_POLICY.version,
    policy: FINAL_SNAPSHOT_SCORE_POLICY,
    structural: {
      totalFiles,
      initialDifferences: initial,
      finalDifferences: final,
      resolved,
      unresolved,
      introduced,
      rawBalance,
      normalized: structuralNormalized,
      score: 100 * structuralNormalized,
    },
    build: { ...build, factor: buildFactor },
    images: { ...images, factor: imageFactor },
    normalized,
    score: 100 * normalized,
  };
}
