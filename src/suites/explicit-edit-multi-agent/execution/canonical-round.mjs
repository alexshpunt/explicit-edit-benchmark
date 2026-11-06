import { compareStructuralUnits } from "../grading/structural-units.mjs";
import { structuralUnitScore } from "../grading/structural-unit-score.mjs";
import { runCorrectionSchedule } from "./correction-schedule.mjs";

/** Coordinate the original wave and the common correction schedule of one round.
 * executeWave must not resolve until every owned participant namespace has closed.
 * capture returns the sealed unit input of the candidate; measure returns its
 * integration outcome. This function never repairs source.
 */
export async function runCanonicalRound({
  prepared,
  executeWave,
  capture,
  measure,
  onStage = async () => {},
  onUpdate = async () => {},
  signal,
}) {
  signal?.throwIfAborted();
  await executeWave({ stage: "original", comparison: null, integration: null, signal });
  return runCorrectionSchedule({
    signal,
    onUpdate,
    async capture({ stage, assessStructure, measureIntegration, index }) {
      const candidate = await capture({ stage, index, signal });
      signal?.throwIfAborted();
      const structure = assessStructure
        ? await compareStructuralUnits(prepared, candidate.units.tree, {
            extraUnits: candidate.units.extraUnits,
          })
        : null;
      const integration = measureIntegration ? await measure(candidate, { stage, signal }) : null;
      signal?.throwIfAborted();
      const row = { stage, structure, integration };
      await onStage(row, { candidate });
      return row;
    },
    async correctStructure({ state, attempt }) {
      await attempt("structural", () =>
        executeWave({
          stage: "structural-correction",
          comparison: state.structure,
          integration: null,
          signal,
        }),
      );
    },
    correctIntegration: ({ stage, state }) =>
      executeWave({ stage, comparison: null, integration: state.integration, signal }),
    score: (input) => structuralUnitScore(input),
  });
}
