import assert from "node:assert/strict";
import { runChunkTeam } from "./chunk-team.mjs";
import { runChunkRecovery } from "./chunk-recovery.mjs";

/** Keep both original teams alive until the structural recovery wave finishes.
 * Ownership is limited to participants who received a batch of the affected task;
 * it is not a claim that an individual edit was successful.
 */
export async function runChunkRecoveryTeams({
  otherTasks,
  mathTasks,
  other,
  math,
  totalFiles,
  capture,
  repairStructural,
  repairIntegration,
  onUpdate,
  signal,
}) {
  assert.equal(typeof repairStructural, "function");
  const known = new Set([...otherTasks, ...mathTasks].map(({ id }) => id));
  let mathResult;
  let recovery;
  const otherResult = await runChunkTeam(otherTasks, {
    ...other,
    signal,
    async onDrained(first) {
      mathResult = await runChunkTeam(mathTasks, {
        ...math,
        signal: first.signal,
        async onDrained(second) {
          const participants = [
            ...first.participants.map((participant) => ({ ...participant, phase: "other" })),
            ...second.participants.map((participant) => ({ ...participant, phase: "math" })),
          ];
          const recoverySignal = AbortSignal.any([first.signal, second.signal]);
          recovery = await runChunkRecovery({
            totalFiles,
            capture,
            onUpdate,
            signal: recoverySignal,
            repairIntegration,
            async repairStructural(context) {
              const participant = participants.find(({ tasks }) => tasks.includes(context.id));
              assert.ok(
                participant || !known.has(context.id),
                "No original task participant is live",
              );
              await repairStructural({
                ...context,
                participant: participant ?? participants[0],
                participants,
              });
            },
          });
        },
      });
    },
  });
  return { other: otherResult, math: mathResult, recovery };
}
