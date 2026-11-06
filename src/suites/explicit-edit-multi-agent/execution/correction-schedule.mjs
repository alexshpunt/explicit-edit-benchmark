import assert from "node:assert/strict";

/** The common round schedule of every protocol: one structural correction when the
 * original work disagrees, one build correction when the build fails, and one result
 * correction when the build still fails or the images differ. Structure is scored
 * only from the original and final captures.
 */
export async function runCorrectionSchedule({
  capture,
  correctStructure,
  correctIntegration,
  score,
  onUpdate = async () => {},
  signal,
}) {
  for (const callback of [capture, correctStructure, correctIntegration, score, onUpdate])
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
  async function attempt(stage, id, operation) {
    check();
    const row = { stage, id, status: "running" };
    attempts.push(row);
    await onUpdate({ stages, attempts });
    try {
      const outcome = await operation({ stage, id, signal });
      check();
      assert.ok(!(outcome?.timedOut && outcome?.unissued));
      row.status = outcome?.timedOut ? "timed-out" : outcome?.unissued ? "unissued" : "settled";
    } catch (error) {
      row.status = "error";
      await onUpdate({ stages, attempts });
      throw error;
    }
    await onUpdate({ stages, attempts });
  }
  const initial = await snapshot("original", true, false);
  if (initial.structure.differenceIds.length)
    await correctStructure({
      state: initial,
      attempt: (id, operation) => attempt("structural-correction", id, operation),
      signal,
    });
  let current = await snapshot("build-check", false, true);
  const buildFirstPassed = current.integration.buildPassed;
  if (!buildFirstPassed) {
    const state = current;
    await attempt("build-correction", "build", (context) =>
      correctIntegration({ ...context, state }),
    );
    current = await snapshot("build-recheck", false, true);
  }
  const preRecoveryBuildPassed = current.integration.buildPassed;
  const firstImageMatched = preRecoveryBuildPassed ? current.integration.resultMatched : null;
  const resultRecoveryAttempted = !preRecoveryBuildPassed || firstImageMatched === false;
  if (resultRecoveryAttempted) {
    const state = current;
    await attempt("image-correction", "images", (context) =>
      correctIntegration({ ...context, state }),
    );
  }
  const final = await snapshot("final", true, true);
  check();
  const result = await score({
    initialDifferences: initial.structure.differenceIds,
    finalDifferences: final.structure.differenceIds,
    initial: initial.structure,
    final: final.structure,
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
