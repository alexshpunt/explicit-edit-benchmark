import assert from "node:assert/strict";
import test from "node:test";
import { CANONICAL_SCORE_POLICY } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-score.mjs";
import {
  EXTRACTION_RECOVERY_POLICY,
  extractionScore,
} from "../../src/suites/explicit-edit-multi-agent/extraction/score.mjs";

const stage = (stage, differenceIds = [], buildPassed = true, resultMatched = true) => ({
  stage,
  differenceIds,
  integration: { buildPassed, resultMatched },
});

test("a successful whole-file extraction receives the existing unassisted Score", () => {
  const input = Object.freeze({
    totalFiles: 19,
    stages: Object.freeze([
      Object.freeze({
        stage: "original",
        differenceIds: Object.freeze([]),
        integration: Object.freeze({ buildPassed: true, resultMatched: true }),
      }),
    ]),
  });
  const result = extractionScore(input);
  assert.equal(result.version, "renderer-module-extraction-score-v1");
  assert.equal(result.policy, EXTRACTION_RECOVERY_POLICY);
  assert.equal(result.structural.totalHunks, 19);
  assert.equal(result.first.score, 100);
  assert.equal(result.normalized, 1);
  assert.equal(result.score, 100);
  assert.deepEqual(result.build, {
    firstPassed: true,
    correctionUsed: false,
    dedicatedCorrectionUsed: false,
    finalPassed: true,
    factor: 1,
  });
  assert.deepEqual(result.images, {
    available: true,
    firstPassed: true,
    correctionUsed: false,
    dedicatedCorrectionUsed: false,
    finalPassed: true,
    factor: 1,
  });
  assert.equal(Object.isFrozen(EXTRACTION_RECOVERY_POLICY), true);
  assert.equal(EXTRACTION_RECOVERY_POLICY.scorePolicy, CANONICAL_SCORE_POLICY);
  assert.deepEqual(JSON.parse(JSON.stringify(EXTRACTION_RECOVERY_POLICY)), {
    version: "renderer-module-extraction-recovery-v1",
    structuralWaves: 1,
    buildAgents: 1,
    buildAttempts: 1,
    imageAgents: 1,
    imageAttempts: 1,
    scorePolicy: CANONICAL_SCORE_POLICY,
  });
});

test("a failed build retains structural credit and records images as unattempted", () => {
  const result = extractionScore({
    totalFiles: 19,
    stages: [stage("original", ["scene.cpp", "shape.cpp", "scene.h"], false, false)],
  });
  assert.equal(result.structural.first.rawBalance, 16);
  assert.equal(result.structural.correctionComplete, false);
  assert.equal(result.first.structural, result.structural.first);
  assert.equal(result.first.buildFactor, 0.5);
  assert.equal(result.first.imageFactor, 0.5);
  assert.equal(result.first.normalized, (16 / 19) * 0.5 * 0.5);
  assert.equal(result.score, 100 * (16 / 19) * 0.5 * 0.5);
  assert.deepEqual(result.images, {
    available: false,
    firstPassed: null,
    correctionUsed: false,
    dedicatedCorrectionUsed: false,
    finalPassed: false,
    factor: 0.5,
  });
  assert.equal(result.build.correctionUsed, false);
  assert.equal(result.build.dedicatedCorrectionUsed, false);
});

test("structural recovery cannot erase a recorded build failure or invent a build wave", () => {
  const result = extractionScore({
    totalFiles: 4,
    stages: [stage("original", ["broken.cpp"], false, false), stage("structural-correction")],
  });
  assert.equal(result.first.score, 18.75);
  assert.equal(result.structural.final.rawBalance, 3.5);
  assert.equal(result.structural.final.normalized, 3.5 / 4);
  assert.equal(result.build.firstPassed, false);
  assert.equal(result.build.correctionUsed, true);
  assert.equal(result.build.dedicatedCorrectionUsed, false);
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.images.firstPassed, true);
  assert.equal(result.images.correctionUsed, false);
  assert.equal(result.images.dedicatedCorrectionUsed, false);
  assert.equal(result.images.factor, 1);
  assert.deepEqual(result.structural.laterDifferences, []);
  assert.equal(result.score, 65.625);
});

test("structural fixes receive half credit without extending the target-file denominator", () => {
  const result = extractionScore({
    totalFiles: 4,
    stages: [stage("original", ["header.h"]), stage("structural-correction")],
  });
  assert.equal(result.first.score, 75);
  assert.equal(result.structural.totalHunks, 4);
  assert.equal(result.structural.final.rawBalance, 3.5);
  assert.equal(result.score, 87.5);
});

test("unresolved and new structural differences keep the existing penalties", () => {
  const result = extractionScore({
    totalFiles: 10,
    stages: [
      stage("original", ["a", "b"], false, false),
      stage("structural-correction", ["b", "c"], false, false),
      stage("build-correction", ["c", "d"], true, false),
      stage("image-correction", ["c"]),
    ],
  });
  assert.equal(result.structural.totalHunks, 10);
  assert.equal(result.structural.afterCorrection.rawBalance, 6.5);
  assert.equal(result.structural.final.rawBalance, 5.5);
  assert.deepEqual(
    result.structural.ledger.map(({ change }) => change),
    [-2, -1.5, -1, 0],
  );
  assert.deepEqual(result.structural.ledger[1].resolved, ["a"]);
  assert.deepEqual(result.structural.ledger[1].unresolved, ["b"]);
  assert.deepEqual(result.structural.ledger[1].introduced, ["c"]);
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.build.dedicatedCorrectionUsed, true);
  assert.equal(result.images.firstPassed, false);
  assert.equal(result.images.factor, 0.75);
  assert.equal(result.images.dedicatedCorrectionUsed, true);
  assert.equal(result.score, (100 * 5.5 * 0.75 * 0.75) / 10);
});

test("an initially failed image can be corrected by a real structural wave", () => {
  const result = extractionScore({
    totalFiles: 4,
    stages: [stage("original", ["wrong.cpp"], true, false), stage("structural-correction")],
  });
  assert.equal(result.build.factor, 1);
  assert.equal(result.images.firstPassed, false);
  assert.equal(result.images.correctionUsed, true);
  assert.equal(result.images.dedicatedCorrectionUsed, false);
  assert.equal(result.images.factor, 0.75);
  assert.equal(result.score, 100 * (3.5 / 4) * 0.75);
});

test("a first actual image pass after build recovery stays unassisted", () => {
  const result = extractionScore({
    totalFiles: 19,
    stages: [stage("original", [], false, false), stage("build-correction")],
  });
  assert.equal(result.first.score, 25);
  assert.equal(result.build.factor, 0.75);
  assert.equal(result.build.dedicatedCorrectionUsed, true);
  assert.equal(result.images.firstPassed, true);
  assert.equal(result.images.factor, 1);
  assert.equal(result.images.correctionUsed, false);
  assert.equal(result.score, 75);
});

test("a final build regression overrides an earlier successful build and observed images", () => {
  const result = extractionScore({
    totalFiles: 4,
    stages: [stage("original", [], true, false), stage("image-correction", [], false, false)],
  });
  assert.equal(result.first.score, 50);
  assert.equal(result.build.firstPassed, true);
  assert.equal(result.build.correctionUsed, false);
  assert.equal(result.build.finalPassed, false);
  assert.equal(result.build.factor, 0.5);
  assert.equal(result.images.available, false);
  assert.equal(result.images.firstPassed, false);
  assert.equal(result.images.correctionUsed, true);
  assert.equal(result.images.finalPassed, false);
  assert.equal(result.images.factor, 0.5);
  assert.equal(result.score, 25);
});

test("failed build recovery never fabricates a rendered image observation", () => {
  const result = extractionScore({
    totalFiles: 4,
    stages: [stage("original", [], false, false), stage("build-correction", [], false, false)],
  });
  assert.equal(result.images.firstPassed, null);
  assert.equal(result.images.available, false);
  assert.equal(result.images.correctionUsed, false);
  assert.equal(result.images.factor, 0.5);
  assert.equal(result.build.correctionUsed, true);
  assert.equal(result.build.factor, 0.5);
  assert.equal(result.score, 25);
});

test("stage identities enforce the bounded recovery order and failed-stage admission", () => {
  const invalid = [
    [],
    [stage("structural-correction")],
    [stage("original"), stage("original")],
    [stage("original"), stage("unknown")],
    [stage("original"), stage("structural-correction")],
    [stage("original", ["a"], false, false), stage("build-correction")],
    [stage("original", [], false, false), stage("image-correction")],
    [stage("original"), stage("build-correction")],
    [stage("original"), stage("image-correction")],
    [stage("original", [], false, false), stage("build-correction"), stage("build-correction")],
    [stage("original", [], true, false), stage("image-correction"), stage("build-correction")],
  ];
  for (const stages of invalid)
    assert.throws(() => extractionScore({ totalFiles: 4, stages }), assert.AssertionError);
});

test("malformed measurements and difference identities cannot enter a Score", () => {
  for (const checkpoint of [
    null,
    {},
    { ...stage("original"), integration: null },
    { ...stage("original"), integration: { buildPassed: 1, resultMatched: true } },
    stage("original", [], false, true),
    stage("original", ["a", "a"]),
    stage("original", [""]),
    stage("original", [4]),
  ])
    assert.throws(
      () => extractionScore({ totalFiles: 4, stages: [checkpoint] }),
      assert.AssertionError,
    );
  for (const totalFiles of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(
      () => extractionScore({ totalFiles, stages: [stage("original")] }),
      assert.AssertionError,
    );
});
