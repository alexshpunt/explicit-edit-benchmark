import assert from "node:assert/strict";
import test from "node:test";
import { extractionScore } from "../../src/suites/explicit-edit-multi-agent/extraction/score.mjs";
import { FRESH_CHUNK_RECOVERY_POLICY } from "../../src/suites/explicit-edit-multi-agent/execution/chunk-recovery-teams.mjs";

const stage = (stage, differenceIds, buildPassed = true, resultMatched = true) => ({
  stage,
  differenceIds,
  integration: { buildPassed, resultMatched },
});
const score = (stages) =>
  extractionScore({ totalFiles: 19, stages, policy: FRESH_CHUNK_RECOVERY_POLICY });

test("an unchanged initial error is charged only once", () => {
  const result = score([stage("original", ["a"]), stage("structural-correction", ["a"])]);
  assert.equal(result.structural.final.rawBalance, 18);
  assert.equal(result.score, 100 * (18 / 19));
  assert.equal(result.policy.scorePolicy.unresolvedCorrectionPenalty, 0);
  assert.equal(result.structural.version, "renderer-canonical-score-v2");
});

test("a fixed error receives half credit, and new errors incur one penalty", () => {
  const result = score([stage("original", ["a", "b"]), stage("structural-correction", ["b", "c"])]);
  assert.equal(result.structural.final.rawBalance, 16.5);
});

test("the saved Terra checkpoints score 67.11 under the corrected policy", () => {
  const result = score([
    stage("original", ["extract-016"], false, false),
    stage("structural-correction", ["extract-016", "preservation:main.cpp"]),
  ]);
  assert.equal(result.structural.final.rawBalance, 17);
  assert.equal(result.score, 100 * (17 / 19) * 0.75);
  assert.equal(result.first.score, 100 * (18 / 19) * 0.5 * 0.5);
});

test("the historical policy keeps its original score", () => {
  const result = extractionScore({
    totalFiles: 19,
    stages: [
      stage("original", ["extract-016"], false, false),
      stage("structural-correction", ["extract-016", "preservation:main.cpp"]),
    ],
  });
  assert.equal(result.structural.final.rawBalance, 16);
  assert.equal(result.score, 100 * ((16 / 19) * 0.75));
  assert.equal(result.structural.version, "renderer-canonical-score-v1");
});

test("removing an error in a later integration stage gives no additional refund", () => {
  const result = score([
    stage("original", ["a"], false, false),
    stage("structural-correction", ["a"], false, false),
    stage("build-correction", [], true, true),
  ]);
  assert.equal(result.structural.final.rawBalance, 18);
});
test("errors introduced at later integration checkpoints each incur a penalty", () => {
  const result = score([
    stage("original", ["a"], false, false),
    stage("structural-correction", ["a"], false, false),
    stage("build-correction", ["a", "new"], true, false),
    stage("image-correction", ["a", "new", "later"]),
  ]);
  assert.equal(result.structural.final.rawBalance, 16);
});
