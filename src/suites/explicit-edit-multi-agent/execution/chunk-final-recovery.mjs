import assert from "node:assert/strict";
import { runCorrectionSchedule } from "./correction-schedule.mjs";

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
  return runCorrectionSchedule({
    capture,
    onUpdate,
    signal,
    async score(input) {
      return score({ totalFiles, ...input });
    },
    async correctStructure({ state: initial, attempt }) {
      const repairIds = initial.structure.fileDifferenceIds ?? initial.structure.differenceIds;
      assert.ok(
        Array.isArray(repairIds) && repairIds.every((id) => typeof id === "string" && id.length),
      );
      assert.equal(new Set(repairIds).size, repairIds.length);
      assert.ok(repairIds.length > 0, "Structural differences have no repair assignment");
      let started = false,
        completed = false;
      await structuralWave(async () => {
        assert.equal(started, false);
        started = true;
        for (const id of repairIds)
          await attempt(id, (context) => repairStructural({ ...context, state: initial }));
        completed = true;
      });
      assert.ok(completed, "Structural wave did not complete");
    },
    correctIntegration: repairIntegration,
  });
}
