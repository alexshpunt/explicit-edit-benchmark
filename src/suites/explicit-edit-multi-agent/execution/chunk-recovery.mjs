import assert from "node:assert/strict";
import { extractionScore, EXTRACTION_RECOVERY_POLICY } from "../extraction/score.mjs";

/** Run bounded recovery against a shared candidate. Callers own participant
 * lifetimes, private evidence, feedback construction, and serialized persistence.
 * Each capture receives a unique index; unmeasured captures refresh structural
 * evidence without creating an integration checkpoint or spending a repair.
 */
export async function runChunkRecovery({
  totalFiles,
  policy = EXTRACTION_RECOVERY_POLICY,
  capture,
  repairStructural,
  structuralWave = async (run) => run(),
  repairIntegration,
  onUpdate = async () => {},
  signal,
}) {
  for (const callback of [capture, repairStructural, structuralWave, repairIntegration, onUpdate])
    assert.equal(typeof callback, "function");
  assert.ok(Number.isSafeInteger(totalFiles) && totalFiles > 0);
  const stages = [];
  const attempts = [];
  let index = 0;
  const check = () => signal?.throwIfAborted();
  async function snapshot(stage, measured) {
    check();
    const result = await capture({ stage, measured, index: index++, signal });
    check();
    assert.ok(Array.isArray(result.structure?.differenceIds));
    if (measured) {
      assert.equal(typeof result.integration?.buildPassed, "boolean");
      assert.equal(typeof result.integration?.resultMatched, "boolean");
      stages.push({ stage, ...result });
      await onUpdate({ stages, attempts });
    }
    return result;
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

  let state = await snapshot("original", true);
  const pending = [...state.structure.differenceIds];
  if (pending.length) {
    let waveStarted = false;
    let waveCompleted = false;
    await structuralWave(async () => {
      assert.equal(waveStarted, false, "Structural wave can run only once");
      waveStarted = true;
      for (const id of pending) {
        check();
        if (!state.structure.differenceIds.includes(id)) {
          attempts.push({ stage: "structural-correction", id, status: "skipped" });
          await onUpdate({ stages, attempts });
          continue;
        }
        await repair("structural-correction", id, repairStructural, state);
        state = await snapshot("structural-correction", false);
      }
      waveCompleted = true;
    });
    assert.ok(waveCompleted, "Structural wave did not complete");
    state = await snapshot("structural-correction", true);
  }
  if (!state.integration.buildPassed) {
    await repair("build-correction", "build", repairIntegration, state);
    state = await snapshot("build-correction", true);
  }
  if (state.integration.buildPassed && !state.integration.resultMatched) {
    await repair("image-correction", "images", repairIntegration, state);
    await snapshot("image-correction", true);
  }
  check();
  const score = extractionScore({
    totalFiles,
    policy,
    stages: stages.map(({ stage, structure, integration }) => ({
      stage,
      differenceIds: structure.differenceIds,
      integration,
    })),
  });
  return { stages, attempts, score };
}
