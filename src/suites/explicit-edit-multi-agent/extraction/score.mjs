import assert from "node:assert/strict";
import {
  CANONICAL_SCORE_POLICY,
  canonicalIntegrationFactor,
  canonicalStructuralScore,
} from "../grading/canonical-score.mjs";

export const EXTRACTION_RECOVERY_POLICY = Object.freeze({
  version: "renderer-module-extraction-recovery-v2",
  structuralWaves: 1,
  structuralAttemptsPerFile: 1,
  structuralParticipants: "original-live-owners",
  overlappingRepairs: "serialize-refresh-skip",
  buildAgents: 1,
  buildAttempts: 1,
  imageAgents: 1,
  imageAttempts: 1,
  scorePolicy: CANONICAL_SCORE_POLICY,
});

const stageOrder = ["original", "structural-correction", "build-correction", "image-correction"];
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Score one measured shared extraction using the existing extraction policy. */
export function scoreExtractionSnapshot({ structure, integration }) {
  assert.ok(record(structure) && Array.isArray(structure.files));
  assert.ok(Array.isArray(structure.differenceIds));
  assert.ok(["pass", "fail"].includes(structure.status));
  assert.equal(
    structure.status === "pass",
    structure.differenceIds.length === 0,
    "Structural status and differences disagree",
  );
  return extractionScore({
    totalFiles: structure.files.length,
    stages: [{ stage: "original", differenceIds: structure.differenceIds, integration }],
  });
}
/** Score actual measured checkpoints without adding recovery work to the denominator.
 * A build-failed checkpoint has no image observation. Its first later rendered
 * result can therefore pass unassisted, while the recovered build keeps its cost.
 * @param {{totalFiles: number, stages: {stage: string, differenceIds: string[], integration: {buildPassed: boolean, resultMatched: boolean}}[], policy?: typeof EXTRACTION_RECOVERY_POLICY}} input
 */
export function extractionScore({ totalFiles, stages, policy = EXTRACTION_RECOVERY_POLICY }) {
  assert.ok(Array.isArray(stages) && stages.length > 0, "Missing measured extraction stages");
  let previous = -1;
  for (const [index, checkpoint] of stages.entries()) {
    assert.ok(record(checkpoint));
    const ordinal = stageOrder.indexOf(checkpoint.stage);
    assert.ok(ordinal > previous, "Extraction recovery stages must follow their budgets");
    assert.ok(index !== 0 || ordinal === 0, "The original extraction measurement is required");
    assert.ok(Array.isArray(checkpoint.differenceIds), "Missing extraction differences");
    const integration = checkpoint.integration;
    assert.ok(record(integration));
    assert.equal(typeof integration.buildPassed, "boolean", "Missing build measurement");
    assert.equal(typeof integration.resultMatched, "boolean", "Missing image measurement");
    assert.ok(
      integration.buildPassed || !integration.resultMatched,
      "Images cannot pass without a build",
    );
    if (checkpoint.stage === "structural-correction")
      assert.ok(stages[0].differenceIds.length > 0, "Successful structure needs no correction");
    if (checkpoint.stage === "build-correction")
      assert.equal(
        stages[index - 1].integration.buildPassed,
        false,
        "Successful compilation needs no correction",
      );
    if (checkpoint.stage === "image-correction") {
      assert.equal(
        stages[index - 1].integration.buildPassed,
        true,
        "Image correction requires a buildable candidate",
      );
      assert.equal(
        stages[index - 1].integration.resultMatched,
        false,
        "Successful images need no correction",
      );
    }
    previous = ordinal;
  }
  const original = stages[0];
  const final = stages.at(-1);
  const correction = stages.find(({ stage }) => stage === "structural-correction");
  const structural = canonicalStructuralScore({
    totalHunks: totalFiles,
    policy: policy.scorePolicy,
    initialDifferences: original.differenceIds,
    correctionDifferences: correction?.differenceIds ?? null,
    laterDifferences: stages
      .filter(({ stage }) => stage === "build-correction" || stage === "image-correction")
      .map(({ stage, differenceIds }) => ({ stage, differences: differenceIds })),
  });
  const build = {
    firstPassed: original.integration.buildPassed,
    correctionUsed: !original.integration.buildPassed && stages.length > 1,
    dedicatedCorrectionUsed: stages.some(({ stage }) => stage === "build-correction"),
    finalPassed: final.integration.buildPassed,
  };
  const imageIndex = stages.findIndex(({ integration }) => integration.buildPassed);
  const firstImages = imageIndex < 0 ? null : stages[imageIndex].integration.resultMatched;
  const images = {
    available: final.integration.buildPassed,
    firstPassed: firstImages,
    correctionUsed: firstImages === false && imageIndex < stages.length - 1,
    dedicatedCorrectionUsed: stages.some(({ stage }) => stage === "image-correction"),
    finalPassed: final.integration.resultMatched,
  };
  const buildFactor = canonicalIntegrationFactor(build);
  const imageFactor = images.available
    ? canonicalIntegrationFactor({ ...images, firstPassed: firstImages === true })
    : CANONICAL_SCORE_POLICY.integration.failed;
  const firstBuildFactor = canonicalIntegrationFactor({
    firstPassed: original.integration.buildPassed,
    correctionUsed: false,
    finalPassed: original.integration.buildPassed,
  });
  const firstImageFactor = canonicalIntegrationFactor({
    firstPassed: original.integration.resultMatched,
    correctionUsed: false,
    finalPassed: original.integration.resultMatched,
  });
  const firstNormalized = structural.first.normalized * firstBuildFactor * firstImageFactor;
  const normalized = structural.final.normalized * buildFactor * imageFactor;
  return {
    version: "renderer-module-extraction-score-v1",
    policy,
    structural,
    build: { ...build, factor: buildFactor },
    images: { ...images, factor: imageFactor },
    first: {
      structural: structural.first,
      buildFactor: firstBuildFactor,
      imageFactor: firstImageFactor,
      normalized: firstNormalized,
      score: 100 * firstNormalized,
    },
    normalized,
    score: 100 * normalized,
  };
}
