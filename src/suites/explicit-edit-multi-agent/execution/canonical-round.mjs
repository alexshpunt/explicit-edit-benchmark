import assert from "node:assert/strict";
import { compareCanonicalDiff } from "../grading/canonical-diff.mjs";
import { canonicalRoundScore } from "../grading/canonical-score.mjs";

/** Coordinate four independently budgeted waves. executeWave must not resolve
 * until every owned participant namespace has closed. Capture and integration
 * operate on actual candidate evidence; this function never repairs source.
 */
export async function runCanonicalRound({
  prepared,
  executeWave,
  capture,
  measure,
  onStage = async () => {},
  signal,
}) {
  const stages = [],
    measurements = [];
  async function wave(stage, previous, integration = null) {
    signal?.throwIfAborted();
    await executeWave({
      stage,
      comparison: previous?.row.comparison ?? null,
      integration,
      signal,
    });
    signal?.throwIfAborted();
    const candidate = await capture({ stage, signal });
    signal?.throwIfAborted();
    const comparison = compareCanonicalDiff(prepared, candidate.snapshot);
    const row = { stage, comparison };
    stages.push(row);
    await onStage(row, { candidate });
    signal?.throwIfAborted();
    return { row, candidate };
  }
  async function verify(current) {
    signal?.throwIfAborted();
    const result = await measure(current.candidate, { stage: current.row.stage, signal });
    signal?.throwIfAborted();
    assert.equal(typeof result.buildPassed, "boolean", "Missing build measurement");
    assert.equal(typeof result.resultMatched, "boolean", "Missing image measurement");
    assert.ok(result.buildPassed || !result.resultMatched, "Images cannot pass without a build");
    measurements.push({
      stage: current.row.stage,
      buildPassed: result.buildPassed,
      resultMatched: result.resultMatched,
    });
    return result;
  }

  let current = await wave("original", null);
  if (current.row.comparison.differenceIds.length)
    current = await wave("structural-correction", current);

  let integration = await verify(current);
  let build = {
    firstPassed: integration.buildPassed,
    correctionUsed: false,
    finalPassed: integration.buildPassed,
  };
  if (!integration.buildPassed) {
    current = await wave("build-correction", current, integration);
    integration = await verify(current);
    build = { ...build, correctionUsed: true, finalPassed: integration.buildPassed };
  }

  let images = integration.buildPassed
    ? {
        firstPassed: integration.resultMatched,
        correctionUsed: false,
        finalPassed: integration.resultMatched,
      }
    : null;
  if (images && !images.firstPassed) {
    current = await wave("image-correction", current, integration);
    integration = await verify(current);
    build = { ...build, finalPassed: integration.buildPassed };
    images = { ...images, correctionUsed: true, finalPassed: integration.resultMatched };
  }

  const structure = {
    totalHunks: prepared.totalHunks,
    initialDifferences: stages[0].comparison.differenceIds,
    correctionDifferences:
      stages.find(({ stage }) => stage === "structural-correction")?.comparison.differenceIds ??
      null,
    laterDifferences: stages
      .filter(({ stage }) => stage === "build-correction" || stage === "image-correction")
      .map(({ stage, comparison }) => ({ stage, differences: comparison.differenceIds })),
  };
  return {
    stages,
    measurements,
    structure,
    build,
    images,
    score: canonicalRoundScore({ structure, build, images }),
  };
}
