import assert from "node:assert/strict";
import test from "node:test";
import { finalSnapshotScore } from "../../src/suites/explicit-edit-multi-agent/extraction/final-snapshot-score.mjs";

const input = (overrides = {}) => ({
  totalFiles: 19,
  initialDifferences: ["a", "b", "c"],
  finalDifferences: ["c", "new"],
  buildFirstPassed: true,
  preRecoveryBuildPassed: true,
  firstImageMatched: true,
  resultRecoveryAttempted: false,
  finalBuildPassed: true,
  finalImageMatched: true,
  ...overrides,
});

test("only initial and final differences determine structural credit", () => {
  const result = finalSnapshotScore(input());
  assert.equal(result.structural.rawBalance, 16);
  assert.deepEqual(result.structural.resolved, ["a", "b"]);
  assert.deepEqual(result.structural.unresolved, ["c"]);
  assert.deepEqual(result.structural.introduced, ["new"]);
  assert.equal(result.score, 100 * (16 / 19));
});

test("a fixed build with a first available matching image keeps full image credit", () => {
  const result = finalSnapshotScore(input({ buildFirstPassed: false }));
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.images.factor, 1);
  assert.equal(result.score, 100 * ((16 / 19) * 0.75));
});

test("a result recovery can fix a build after its dedicated attempt failed", () => {
  const result = finalSnapshotScore(
    input({
      buildFirstPassed: false,
      preRecoveryBuildPassed: false,
      firstImageMatched: null,
      resultRecoveryAttempted: true,
    }),
  );
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.images.factor, 0.75);
  assert.equal(result.score, 100 * ((16 / 19) * 0.75 * 0.75));
});

test("a final broken build makes both factors one half", () => {
  const result = finalSnapshotScore(
    input({
      buildFirstPassed: false,
      preRecoveryBuildPassed: false,
      firstImageMatched: null,
      resultRecoveryAttempted: true,
      finalBuildPassed: false,
      finalImageMatched: null,
    }),
  );
  assert.equal(result.build.factor, 0.5);
  assert.equal(result.images.factor, 0.5);
  assert.equal(result.images.available, false);
});

test("a result recovery that leaves incorrect images has the failure factor", () => {
  const result = finalSnapshotScore(
    input({
      firstImageMatched: false,
      resultRecoveryAttempted: true,
      finalImageMatched: false,
    }),
  );
  assert.equal(result.build.factor, 1);
  assert.equal(result.images.factor, 0.5);
});

test("score rejects missing, inconsistent, or duplicate evidence", () => {
  for (const bad of [
    { finalDifferences: null },
    { initialDifferences: ["a", "a"] },
    { totalFiles: 0 },
    { finalBuildPassed: false, finalImageMatched: true },
    { firstImageMatched: false, resultRecoveryAttempted: false },
    { firstImageMatched: null, resultRecoveryAttempted: false },
    { firstImageMatched: true, resultRecoveryAttempted: true },
  ])
    assert.throws(() => finalSnapshotScore(input(bad)));
});

test("structural balance is clamped only after applying penalties and refunds", () => {
  const result = finalSnapshotScore(
    input({ totalFiles: 1, initialDifferences: ["a", "b"], finalDifferences: ["b"] }),
  );
  assert.equal(result.structural.rawBalance, -0.5);
  assert.equal(result.structural.normalized, 0);
  assert.equal(result.score, 0);
});
