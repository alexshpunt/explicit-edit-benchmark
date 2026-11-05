import assert from "node:assert/strict";
import { runChunkTeam } from "./chunk-team.mjs";
import { runFinalChunkRecovery } from "./chunk-final-recovery.mjs";
import { finalSnapshotScore } from "../extraction/final-snapshot-score.mjs";

/** Original groups finish before a fresh team receives the initial error list. */
export async function runFinalChunkTeams({
  otherTasks,
  mathTasks,
  other,
  math,
  repairTeam,
  totalFiles,
  capture,
  repairStructural,
  repairIntegration,
  onUpdate,
  onTeamCompleted = async () => {},
  score = finalSnapshotScore,
  signal,
}) {
  assert.equal(typeof repairStructural, "function");
  assert.ok(repairTeam && typeof repairTeam.createDriver === "function");
  assert.equal(typeof onTeamCompleted, "function");
  const otherResult = await runChunkTeam(otherTasks, { ...other, signal });
  await onTeamCompleted("other", otherResult);
  const mathResult = await runChunkTeam(mathTasks, { ...math, signal });
  await onTeamCompleted("math", mathResult);
  assert.ok([...otherResult.records, ...mathResult.records].every(({ closed }) => closed));
  let participants,
    waveSignal,
    next = 0;
  const repairResults = [];
  const repairTimeouts = [];
  const repairUnissued = [];
  const recovery = await runFinalChunkRecovery({
    totalFiles,
    capture,
    signal,
    onUpdate,
    repairIntegration,
    score,
    async structuralWave(run) {
      repairResults.push(
        await runChunkTeam([{ id: "structural-wave", batches: [0] }], {
          ...repairTeam,
          signal,
          async execute() {},
          async onDrained(drained) {
            participants = drained.participants;
            waveSignal = drained.signal;
            try {
              await run();
            } finally {
              participants = undefined;
              waveSignal = undefined;
            }
          },
        }),
      );
      const result = repairResults.at(-1);
      result.timeouts.push(...repairTimeouts);
      result.unissued.push(...repairUnissued);
      if (repairTimeouts.length || repairUnissued.length) result.status = "partial";
      await onTeamCompleted("structural-correction", result);
    },
    async repairStructural(context) {
      assert.ok(Array.isArray(participants), "Fresh repair team is unavailable");
      const surviving = participants.filter(({ driver }) => !driver.closed);
      if (!surviving.length) {
        repairUnissued.push({ task: context.id });
        return { unissued: true };
      }
      const participant = surviving[next++ % surviving.length];
      const activeSignal = signal ? AbortSignal.any([signal, waveSignal]) : waveSignal;
      activeSignal.throwIfAborted();
      const cancelled = Promise.withResolvers();
      const abort = () => cancelled.reject(activeSignal.reason);
      activeSignal.addEventListener("abort", abort, { once: true });
      if (activeSignal.aborted) abort();
      try {
        await Promise.race([participant.driver.assertIdle(), cancelled.promise]);
      } finally {
        activeSignal.removeEventListener("abort", abort);
      }
      activeSignal.throwIfAborted();
      const outcome = await repairStructural({
        ...context,
        participant,
        participants: surviving,
        signal: activeSignal,
      });
      if (outcome?.timedOut) {
        assert.equal(participant.driver.closed, true, "Timed-out participant remains active");
        repairTimeouts.push({
          task: context.id,
          agent: participant.agent,
          session: participant.session,
        });
      }
      return outcome;
    },
  });
  return { other: otherResult, math: mathResult, repair: repairResults.at(-1) ?? null, recovery };
}
