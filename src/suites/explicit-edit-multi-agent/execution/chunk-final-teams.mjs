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
  score = finalSnapshotScore,
  signal,
}) {
  assert.equal(typeof repairStructural, "function");
  assert.ok(repairTeam && typeof repairTeam.createDriver === "function");
  const otherResult = await runChunkTeam(otherTasks, { ...other, signal });
  const mathResult = await runChunkTeam(mathTasks, { ...math, signal });
  assert.ok([...otherResult.records, ...mathResult.records].every(({ closed }) => closed));
  let participants,
    waveSignal,
    next = 0;
  const repairResults = [];
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
    },
    async repairStructural(context) {
      assert.ok(participants?.length, "Fresh repair participants are unavailable");
      const participant = participants[next++ % participants.length];
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
      await repairStructural({ ...context, participant, participants, signal: activeSignal });
    },
  });
  return { other: otherResult, math: mathResult, repair: repairResults.at(-1) ?? null, recovery };
}
