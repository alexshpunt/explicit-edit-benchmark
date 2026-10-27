import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { treeIdentity } from "../generation/generator.mjs";
import { referenceConcurrency } from "../reference/execution-proof.mjs";
import { partitionAtomicQueues } from "./atomic-stream.mjs";
import { roundScore } from "../grading/round-score.mjs";

export const RESTORING_RUN_VERSION = "renderer-concurrent-restoring-run-v2";
export const RESTORING_PROOF_VERSION = "renderer-restoring-execution-proof-v2";
export const RESTORING_REFERENCE_POLICY = Object.freeze({
  version: "independent-restoring-reference-v2",
  batching: "separate-reference-delivery-limit",
  planning: "one-private-planner-per-executor",
  publication: "atomic-per-file-edits",
  coordination: "participant-owned-per-file-locks",
  barriers: "first-check-only",
  restoration: "canonical-end-of-current-round",
});
const inventory = (ids) =>
  createHash("sha256")
    .update(JSON.stringify([...ids].sort()))
    .digest("hex");

/** Bind source, execution policy and every original planned atom before execution. */
export function restoringRunIdentity(
  loaded,
  source,
  { protocol, policy, batchSize, buildWeight = 2, resultWeight = 4 },
) {
  const {
    manifest,
    graph,
    agents,
    schedule,
    scheduleSha256,
    contractHashes,
    atomicIntervals,
    atomicWorkload,
    plannedAtoms,
  } = loaded;
  const intervals = schedule.map(({ id }) => atomicIntervals.rounds.get(id));
  const identity = {
    ...source,
    protocol,
    policy: { ...policy, buildWeight, resultWeight },
    agents,
    batchSize,
    graphWidth: graph.width,
    workloadSha256: manifest.workloadSha256,
    graphSha256: manifest.graphSha256,
    scheduleSha256,
    contractHashes,
    atomic: manifest.atomic,
    initial: manifest.initial,
    expectedFinal: manifest.final,
    totalTasks: manifest.tasks,
    totalRounds: schedule.length,
    totalAtoms: atomicWorkload.nodes.length,
    atomicInventorySha256: inventory(atomicWorkload.nodes.map(({ id }) => id)),
    plannedAtoms,
    roundEndpoints: schedule.map(({ id }, index) => ({
      round: id,
      identity: treeIdentity(intervals[index].expectedTree),
    })),
    roundInventories: schedule.map(({ id }, index) => ({
      round: id,
      sha256: inventory(intervals[index].nodes.map((node) => node.id)),
    })),
    maxAssignedParticipants: Math.max(
      ...intervals.map(
        ({ nodes }) => partitionAtomicQueues(nodes, agents).filter((queue) => queue.length).length,
      ),
    ),
  };
  validateIdentity(identity);
  return identity;
}

function validateIdentity(identity) {
  assert.equal(identity.sourceClean, true, "Restoring proof requires clean committed source");
  assert.match(identity.sourceCommit, /^[a-f0-9]{40}$/);
  for (const key of [
    "verifierSha256",
    "runnerSha256",
    "workloadSha256",
    "graphSha256",
    "scheduleSha256",
    "atomicInventorySha256",
    "initial",
    "expectedFinal",
  ])
    assert.match(identity[key], /^[a-f0-9]{64}$/);
  for (const key of [
    "agents",
    "batchSize",
    "maxAssignedParticipants",
    "totalTasks",
    "totalRounds",
    "totalAtoms",
  ])
    assert.ok(
      Number.isSafeInteger(identity[key]) && identity[key] > 0,
      "Invalid restoring proof scope",
    );
  assert.ok(identity.maxAssignedParticipants <= identity.agents, "Invalid restoring occupancy");
  assert.equal(identity.plannedAtoms.length, identity.totalRounds);
  assert.equal(new Set(identity.plannedAtoms.map(({ round }) => round)).size, identity.totalRounds);
  assert.equal(
    identity.plannedAtoms.reduce((sum, { totalAtoms }) => sum + totalAtoms, 0),
    identity.totalAtoms,
  );
  assert.deepEqual(
    identity.roundEndpoints.map(({ round }) => round),
    identity.plannedAtoms.map(({ round }) => round),
  );
  assert.deepEqual(
    identity.roundInventories.map(({ round }) => round),
    identity.plannedAtoms.map(({ round }) => round),
  );
  for (const row of identity.plannedAtoms)
    roundScore(
      { passedAtoms: 0, totalAtoms: row.totalAtoms, buildPassed: false, resultMatched: false },
      identity.policy,
    );
  for (const row of identity.roundEndpoints) assert.match(row.identity, /^[a-f0-9]{64}$/);
  for (const row of identity.roundInventories) assert.match(row.sha256, /^[a-f0-9]{64}$/);
  assert.equal(identity.roundEndpoints.at(-1).identity, identity.expectedFinal);
}

function validateRounds(rounds, identity) {
  assert.equal(
    rounds.length,
    identity.totalRounds,
    "Reference did not restore every planned round",
  );
  for (const [index, row] of rounds.entries()) {
    const planned = identity.plannedAtoms[index];
    assert.equal(row.round, planned.round);
    assert.equal(row.firstAttempt, 1);
    assert.equal(row.finalAttempt, 1, "Reference retried a round");
    assert.equal(row.attempts.length, 1, "Reference retried a round");
    const attempt = row.attempts[0];
    assert.equal(attempt.attempt, 1);
    const measured = roundScore(attempt, identity.policy);
    assert.equal(measured.totalAtoms, planned.totalAtoms);
    assert.equal(measured.passedAtoms, planned.totalAtoms, "Reference lost original atom credit");
    for (const key of ["buildPassed", "resultMatched", "integrityPassed"])
      assert.equal(attempt[key], true);
    assert.equal(row.restoration.status, "pass");
    assert.equal(
      row.restoration.identity,
      identity.roundEndpoints[index].identity,
      "Reference restored a different endpoint",
    );
  }
}

function trace(execution) {
  const native = execution.receipt?.scriptedReference;
  return execution.receipts ?? native?.receipts ?? (native ? [native] : []);
}

function executionEvidence(executions, identity, referenceBatchSize) {
  assert.ok(
    Number.isSafeInteger(referenceBatchSize) && referenceBatchSize > 0,
    "Invalid reference delivery size",
  );
  assert.ok(executions.length > 0, "Missing original reference executions");
  const ids = [],
    byRound = new Map(identity.plannedAtoms.map(({ round }) => [round, []]));
  const participants = new Map();
  for (const execution of executions) {
    assert.equal(execution.attempt, 1, "Reference redelivered work");
    assert.equal(execution.status, "settled");
    assert.equal(execution.deliveryKind, undefined);
    assert.ok(!execution.repairIds?.length, "Reference delivered repairs");
    assert.ok(
      Number.isSafeInteger(execution.agent) &&
        execution.agent >= 0 &&
        execution.agent < identity.agents,
    );
    assert.ok(Array.isArray(execution.atomicIds) && execution.atomicIds.length > 0);
    assert.ok(
      execution.atomicIds.length <= referenceBatchSize,
      "Reference delivery exceeded the configured batch",
    );
    assert.ok(byRound.has(execution.round));
    byRound.get(execution.round).push(...execution.atomicIds);
    ids.push(...execution.atomicIds);
    const receipts = trace(execution);
    assert.equal(receipts.length, execution.atomicIds.length, "Missing original editor receipts");
    for (const receipt of receipts) {
      assert.ok(typeof receipt.lifetime === "string" && receipt.lifetime);
      if (participants.has(execution.agent))
        assert.equal(
          participants.get(execution.agent),
          receipt.lifetime,
          "Reference participant restarted",
        );
      else participants.set(execution.agent, receipt.lifetime);
    }
  }
  assert.equal(ids.length, identity.totalAtoms);
  assert.equal(new Set(ids).size, ids.length, "Reference repeated original atoms");
  assert.equal(
    inventory(ids),
    identity.atomicInventorySha256,
    "Reference original inventory differs",
  );
  for (const { round, sha256 } of identity.roundInventories)
    assert.equal(
      inventory(byRound.get(round)),
      sha256,
      "Reference delivered an atom in the wrong round",
    );
  assert.equal(
    new Set(participants.values()).size,
    participants.size,
    "Reference participants shared a lifetime",
  );
  const observed = referenceConcurrency(executions);
  assert.equal(observed.executors, participants.size);
  for (const key of [
    "maxWorking",
    "maxPlanning",
    "maxPublishing",
    "workIntervals",
    "planningIntervals",
    "publicationIntervals",
  ])
    assert.ok(
      Number.isSafeInteger(observed[key]) && observed[key] > 0,
      "Invalid reference concurrency evidence",
    );
  assert.ok(observed.maxWorking <= participants.size);
  assert.ok(
    observed.maxWorking >= Math.min(2, identity.maxAssignedParticipants),
    "Reference lacks observed independent execution overlap",
  );
  assert.ok(observed.workIntervals >= ids.length, "Reference trace misses original work");
  return observed;
}

/** Create a new proof from actual first-pass execution, never a historical proof. */
export function createRestoringProof(report, identity) {
  validateIdentity(identity);
  assert.equal(report.version, RESTORING_RUN_VERSION);
  assert.equal(report.mode, "reference");
  assert.equal(report.status, "complete");
  for (const key of Object.keys(identity))
    assert.deepEqual(report[key], identity[key], "Reference run identity differs");
  assert.equal(report.repairs, 0);
  assert.equal(report.deliveries, report.executions.length);
  validateRounds(report.rounds, identity);
  const referenceBatchSize =
    report.referenceBatchSize === undefined ? identity.batchSize : report.referenceBatchSize;
  const proof = {
    version: RESTORING_PROOF_VERSION,
    status: "pass",
    identity: structuredClone(identity),
    referenceExecution: RESTORING_REFERENCE_POLICY,
    referenceBatchSize,
    initialCheck: structuredClone(report.initialCheck),
    final: report.final,
    agentsClosed: [...report.agentsClosed],
    rounds: report.rounds.map((row) => ({
      round: row.round,
      firstAttempt: row.firstAttempt,
      finalAttempt: row.finalAttempt,
      attempts: row.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        ...roundScore(attempt, identity.policy),
      })),
      restoration: { status: row.restoration.status, identity: row.restoration.identity },
    })),
    executions: report.executions.map((execution) => ({
      round: execution.round,
      attempt: execution.attempt,
      status: execution.status,
      agent: execution.agent,
      atomicIds: [...execution.atomicIds],
      receipts: trace(execution).map(({ lifetime, events }) => ({ lifetime, events })),
    })),
    originalAtomicEdits: identity.totalAtoms,
    referenceConcurrency: executionEvidence(report.executions, identity, referenceBatchSize),
  };
  validateRestoringProof(proof, identity);
  return proof;
}

/** All authorization fields and derived evidence are rechecked at consumption. */
export function validateRestoringProof(proof, identity) {
  validateIdentity(identity);
  assert.equal(proof.version, RESTORING_PROOF_VERSION, "Unsupported restoring proof");
  assert.equal(proof.status, "pass");
  assert.deepEqual(
    proof.identity,
    identity,
    "Restoring proof belongs to different source or execution scope",
  );
  assert.deepEqual(proof.referenceExecution, RESTORING_REFERENCE_POLICY);
  assert.equal(proof.initialCheck.identity, identity.initial);
  for (const key of ["buildPassed", "resultMatched", "integrityPassed"])
    assert.equal(proof.initialCheck[key], true);
  assert.equal(proof.final, identity.expectedFinal);
  assert.deepEqual(proof.agentsClosed, Array(identity.agents).fill(true));
  validateRounds(proof.rounds, identity);
  assert.equal(proof.originalAtomicEdits, identity.totalAtoms);
  assert.deepEqual(
    proof.referenceConcurrency,
    executionEvidence(proof.executions, identity, proof.referenceBatchSize),
  );
  return true;
}
