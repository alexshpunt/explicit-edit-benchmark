import assert from "node:assert/strict";
import test from "node:test";
import { fragmentSnapshotScore } from "../../src/suites/explicit-edit-multi-agent/extraction/fragment-score.mjs";
const snapshot = (differenceIds, failedFragments) => ({
  version: "renderer-fragment-structure-v1",
  planIdentity: "a".repeat(64),
  totalFragments: 10,
  failedFragments,
  differenceIds,
  preservationIds: differenceIds.filter((x) => x.startsWith("preservation:")),
});
const factors = {
  buildFirstPassed: true,
  preRecoveryBuildPassed: true,
  firstImageMatched: true,
  resultRecoveryAttempted: false,
  finalBuildPassed: true,
  finalImageMatched: true,
};
test("fragment score charges initial errors, half refunds and new errors", () => {
  const result = fragmentSnapshotScore({
    initial: snapshot(["fragment:a:1", "fragment:b:1"], 2),
    final: snapshot(["fragment:b:1", "fragment:c:1", "preservation:main.cpp"], 2),
    ...factors,
  });
  assert.equal(result.structural.rawBalance, 6.5);
  assert.equal(result.score, 65);
  assert.equal(result.policy.version, "renderer-fragment-final-score-v1");
});
test("a perfect fragment extraction scores 100", () => {
  assert.equal(
    fragmentSnapshotScore({ initial: snapshot([], 0), final: snapshot([], 0), ...factors }).score,
    100,
  );
});
test("fragment counts and deficit identifiers cannot disagree", () => {
  assert.throws(() =>
    fragmentSnapshotScore({
      initial: snapshot(["fragment:a:1"], 2),
      final: snapshot([], 0),
      ...factors,
    }),
  );
  assert.throws(() =>
    fragmentSnapshotScore({
      initial: snapshot([], 0),
      final: { ...snapshot([], 0), totalFragments: 11 },
      ...factors,
    }),
  );
  assert.throws(() =>
    fragmentSnapshotScore({
      initial: snapshot([], 0),
      final: { ...snapshot([], 0), planIdentity: "b".repeat(64) },
      ...factors,
    }),
  );
});
