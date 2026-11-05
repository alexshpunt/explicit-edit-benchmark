import assert from "node:assert/strict";
import { runChunkTeam } from "./chunk-team.mjs";
import { runChunkRecovery } from "./chunk-recovery.mjs";
import { EXTRACTION_RECOVERY_POLICY } from "../extraction/score.mjs";

export const FRESH_CHUNK_RECOVERY_POLICY = Object.freeze({
  ...EXTRACTION_RECOVERY_POLICY,
  version: "renderer-chunk-extraction-recovery-v1",
  structuralParticipants: "fresh-team",
});

/** Close the original teams before measuring, then use a fresh team for repair. */
export async function runChunkRecoveryTeams({
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
  signal,
}) {
  assert.equal(typeof repairStructural, "function");
  assert.equal(typeof capture, "function");
  assert.ok(repairTeam && typeof repairTeam.createDriver === "function");
  const otherResult = await runChunkTeam(otherTasks, { ...other, signal });
  const mathResult = await runChunkTeam(mathTasks, { ...math, signal });
  assert.ok([...otherResult.records, ...mathResult.records].every(({ closed }) => closed));
  let participants = null;
  let waveSignal;
  let next = 0;
  const repairResults = [];
  const activeSignal = () =>
    waveSignal && signal ? AbortSignal.any([waveSignal, signal]) : (waveSignal ?? signal);
  const recovery = await runChunkRecovery({
    totalFiles,
    signal,
    onUpdate,
    repairIntegration,
    async capture(context) {
      const currentSignal = activeSignal();
      currentSignal?.throwIfAborted();
      if (participants) {
        const cancelled = Promise.withResolvers();
        const abort = () => cancelled.reject(currentSignal.reason);
        currentSignal?.addEventListener("abort", abort, { once: true });
        if (currentSignal?.aborted) abort();
        try {
          await Promise.race([
            Promise.all(participants.map(({ driver }) => driver.assertIdle())),
            cancelled.promise,
          ]);
        } finally {
          currentSignal?.removeEventListener("abort", abort);
        }
      }
      currentSignal?.throwIfAborted();
      return capture({ ...context, signal: currentSignal });
    },
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
              participants = null;
              waveSignal = undefined;
            }
          },
        }),
      );
    },
    async repairStructural(context) {
      assert.ok(participants?.length, "Fresh repair participants are unavailable");
      const participant = participants[next++ % participants.length];
      const currentSignal = activeSignal();
      currentSignal?.throwIfAborted();
      await repairStructural({ ...context, participant, participants, signal: currentSignal });
    },
  });
  recovery.score = { ...recovery.score, policy: FRESH_CHUNK_RECOVERY_POLICY };
  return { other: otherResult, math: mathResult, repair: repairResults.at(-1) ?? null, recovery };
}
