import assert from "node:assert/strict";

/** Run one structural wave, one build correction and one final result repair.
 * Structural evidence is collected only before and after all editing stages.
 */
export async function runFinalChunkRecovery({
  totalFiles,
  capture,
  structuralWave,
  repairStructural,
  repairIntegration,
  score,
  onUpdate = async () => {},
  signal,
}) {
  assert.ok(Number.isSafeInteger(totalFiles) && totalFiles > 0);
  for (const callback of [
    capture,
    structuralWave,
    repairStructural,
    repairIntegration,
    score,
    onUpdate,
  ])
    assert.equal(typeof callback, "function");
  const stages = [];
  const attempts = [];
  let index = 0;
  const check = () => signal?.throwIfAborted();
  async function snapshot(stage, assessStructure, measureIntegration) {
    check();
    const state = await capture({
      stage,
      assessStructure,
      measureIntegration,
      index: index++,
      signal,
    });
    check();
    if (assessStructure) {
      assert.ok(Array.isArray(state.structure?.differenceIds));
      assert.ok(state.structure.differenceIds.every((id) => typeof id === "string" && id.length));
      assert.equal(
        new Set(state.structure.differenceIds).size,
        state.structure.differenceIds.length,
      );
    }
    if (measureIntegration) {
      assert.equal(typeof state.integration?.buildPassed, "boolean");
      assert.equal(typeof state.integration?.resultMatched, "boolean");
      assert.ok(state.integration.buildPassed || !state.integration.resultMatched);
    }
    stages.push({ stage, ...state });
    await onUpdate({ stages, attempts });
    return state;
  }
  async function repair(stage, id, operation, state) {
    check();
    const attempt = { stage, id, status: "running" };
    attempts.push(attempt);
    await onUpdate({ stages, attempts });
    try {
      await operation({ stage, id, state, signal });
      check();
      attempt.status = "settled";
    } catch (error) {
      attempt.status = "error";
      await onUpdate({ stages, attempts });
      throw error;
    }
    await onUpdate({ stages, attempts });
  }
  const initial = await snapshot("original", true, false);
  if (initial.structure.differenceIds.length) {
    let started = false,
      completed = false;
    await structuralWave(async () => {
      assert.equal(started, false);
      started = true;
      for (const id of initial.structure.differenceIds)
        await repair("structural-correction", id, repairStructural, initial);
      completed = true;
    });
    assert.ok(completed, "Structural wave did not complete");
  }
  let current = await snapshot("build-check", false, true);
  const buildFirstPassed = current.integration.buildPassed;
  if (!buildFirstPassed) {
    await repair("build-correction", "build", repairIntegration, current);
    current = await snapshot("build-recheck", false, true);
  }
  const preRecoveryBuildPassed = current.integration.buildPassed;
  const firstImageMatched = preRecoveryBuildPassed ? current.integration.resultMatched : null;
  const resultRecoveryAttempted = !preRecoveryBuildPassed || firstImageMatched === false;
  if (resultRecoveryAttempted)
    await repair("image-correction", "images", repairIntegration, current);
  const final = await snapshot("final", true, true);
  check();
  const result = await score({
    totalFiles,
    initialDifferences: initial.structure.differenceIds,
    finalDifferences: final.structure.differenceIds,
    buildFirstPassed,
    preRecoveryBuildPassed,
    firstImageMatched,
    resultRecoveryAttempted,
    finalBuildPassed: final.integration.buildPassed,
    finalImageMatched: final.integration.buildPassed ? final.integration.resultMatched : null,
  });
  check();
  return { stages, attempts, score: result };
}
