import assert from "node:assert/strict";
import { finalSnapshotScore } from "./final-snapshot-score.mjs";

export const FRAGMENT_SCORE_POLICY = Object.freeze({
  version: "renderer-fragment-final-score-v1",
  unit: "assigned-fragment",
  structural: "initial-and-final-fungible-group-deficits",
  resolvedInitialCredit: 0.5,
  initialDifferencePenalty: 1,
  newFinalDifferencePenalty: 1,
  integration: Object.freeze({ unassisted: 1, corrected: 0.75, failed: 0.5 }),
});

function validate(snapshot) {
  assert.equal(snapshot?.version, "renderer-fragment-structure-v1");
  assert.ok(
    typeof snapshot.planIdentity === "string" && /^[0-9a-f]{64}$/.test(snapshot.planIdentity),
  );
  assert.ok(Number.isSafeInteger(snapshot.totalFragments) && snapshot.totalFragments > 0);
  assert.ok(
    Number.isSafeInteger(snapshot.failedFragments) &&
      snapshot.failedFragments >= 0 &&
      snapshot.failedFragments <= snapshot.totalFragments,
  );
  assert.ok(Array.isArray(snapshot.differenceIds) && Array.isArray(snapshot.preservationIds));
  assert.ok(
    snapshot.differenceIds.every(
      (id) => typeof id === "string" && /^(?:fragment:|preservation:|inventory:)/.test(id),
    ),
  );
  assert.equal(new Set(snapshot.differenceIds).size, snapshot.differenceIds.length);
  const fragments = snapshot.differenceIds.filter((id) => id.startsWith("fragment:"));
  const preservation = snapshot.differenceIds.filter((id) => !id.startsWith("fragment:"));
  assert.equal(fragments.length, snapshot.failedFragments);
  assert.deepEqual([...preservation].sort(), [...snapshot.preservationIds].sort());
}

/** Score two trustworthy assessments against the same private plan. */
export function fragmentSnapshotScore({ initial, final, ...integration }) {
  validate(initial);
  validate(final);
  assert.equal(final.totalFragments, initial.totalFragments);
  assert.equal(final.planIdentity, initial.planIdentity);
  const score = finalSnapshotScore({
    ...integration,
    totalFiles: initial.totalFragments,
    initialDifferences: initial.differenceIds,
    finalDifferences: final.differenceIds,
  });
  return {
    ...score,
    version: FRAGMENT_SCORE_POLICY.version,
    policy: FRAGMENT_SCORE_POLICY,
    planIdentity: initial.planIdentity,
    structural: { ...score.structural, totalFragments: initial.totalFragments },
  };
}
