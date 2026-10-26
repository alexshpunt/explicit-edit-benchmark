import assert from "node:assert/strict";
import { suiteVerifier } from "../source-identity.mjs";

export const REFERENCE_EXECUTION_POLICY = {
  version: "independent-reference-edits-v2",
  planning: "one-private-planner-per-executor",
  publication: "atomic-per-file-edits",
  coordination: "participant-owned-per-file-locks",
  barriers: "first-check-only",
  recovery: "none",
};

function overlap(intervals) {
  const events = intervals.flatMap(([start, end, actor]) => [
    [start, 1, actor],
    [end, -1, actor],
  ]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const active = new Map();
  let maximum = 0;
  for (const [, delta, actor] of events) {
    const count = (active.get(actor) ?? 0) + delta;
    if (count) active.set(actor, count);
    else active.delete(actor);
    maximum = Math.max(maximum, active.size);
  }
  return maximum;
}

/** Evidence comes from inside each isolated editor, not dispatch queue length.
 * These intervals establish an observed overlapping execution, not every possible
 * interleaving. Semantic acceptance still belongs to the unchanged full grader.
 */
export function referenceConcurrency(executions) {
  const work = [],
    planning = [],
    writes = [];
  const actors = new Set();
  for (const delivery of executions) {
    const native = delivery.receipt?.scriptedReference;
    const receipts = delivery.receipts ?? native?.receipts ?? (native ? [native] : []);
    for (const receipt of receipts) {
      const actor = receipt.lifetime;
      assert.ok(typeof actor === "string" && actor, "Missing reference executor identity");
      actors.add(actor);
      const open = new Map();
      for (const event of receipt.events ?? []) {
        assert.ok(Number.isFinite(event.at), "Invalid reference event time");
        const phase = event.phase.replace(/-(?:start|end)$/, "");
        const key = JSON.stringify([phase, event.file ?? null]);
        if (event.phase.endsWith("-start")) open.set(key, event.at);
        else if (event.phase.endsWith("-end")) {
          const start = open.get(key);
          assert.ok(start !== undefined && event.at >= start, "Unmatched reference event");
          open.delete(key);
          const target =
            phase === "execute"
              ? work
              : phase === "plan"
                ? planning
                : phase === "publish"
                  ? writes
                  : undefined;
          target?.push([start, event.at, actor]);
        }
      }
      assert.equal(open.size, 0, "Incomplete reference work trace");
    }
  }
  return {
    executors: actors.size,
    maxWorking: overlap(work),
    maxPlanning: overlap(planning),
    maxPublishing: overlap(writes),
    workIntervals: work.length,
    planningIntervals: planning.length,
    publicationIntervals: writes.length,
  };
}

function validateFirstPass(evidence, rounds, edits) {
  assert.equal(
    evidence?.version,
    "reference-first-pass-v1",
    "Missing first-pass reference evidence",
  );
  assert.equal(evidence.repairs, 0, "Reference used repair blocks");
  assert.equal(evidence.repairDeliveries, 0, "Reference delivered repair work");
  assert.ok(Number.isSafeInteger(rounds) && rounds > 0, "Invalid reference round count");
  assert.equal(evidence.barriers?.length, rounds, "Reference barrier coverage differs");
  const ids = evidence.barriers.map((barrier) => {
    assert.ok(
      typeof barrier.round === "string" && barrier.round,
      "Missing reference round identity",
    );
    assert.equal(barrier.attempt, 1, "Reference retried a barrier");
    assert.equal(barrier.status, "accepted", "Reference barrier did not pass");
    return barrier.round;
  });
  assert.equal(new Set(ids).size, rounds, "Reference repeated a barrier");
  assert.ok(!ids.includes("initial"), "Invalid reference barrier identity");
  assert.deepEqual(
    evidence.checks?.map((check) => check.contractId),
    ["initial", ...ids],
    "Reference check coverage differs",
  );
  assert.ok(
    evidence.checks.every((check) => check.status === "pass"),
    "Reference contains a failed check",
  );
  assert.ok(
    Number.isSafeInteger(evidence.originalDeliveries) && evidence.originalDeliveries > 0,
    "Missing original reference deliveries",
  );
  assert.ok(
    Number.isSafeInteger(evidence.originalAtomicEdits) &&
      evidence.originalAtomicEdits >= evidence.originalDeliveries,
    "Invalid original reference inventory",
  );
  if (edits !== undefined)
    assert.equal(evidence.originalAtomicEdits, edits, "Reference original inventory differs");
}

/** Derive authorizing evidence from the actual complete report, not a mode flag. */
export function referenceFirstPass(report) {
  assert.equal(report.repairs, 0, "Reference used repair blocks");
  assert.equal(report.acceptedRounds, report.totalRounds, "Reference schedule is incomplete");
  assert.ok(
    Array.isArray(report.executions) && report.executions.length > 0,
    "Missing reference executions",
  );
  const atoms = [];
  for (const execution of report.executions) {
    assert.equal(execution.attempt, 1, "Reference repeated a delivery");
    assert.equal(execution.status, "settled", "Reference delivery did not settle");
    assert.equal(execution.deliveryKind, undefined, "Reference delivered repair work");
    assert.ok(!execution.repairIds?.length, "Reference contains repair identities");
    assert.ok(
      Array.isArray(execution.atomicIds) && execution.atomicIds.length > 0,
      "Missing original reference coverage",
    );
    atoms.push(...execution.atomicIds);
  }
  assert.equal(new Set(atoms).size, atoms.length, "Reference repeated original work");
  const evidence = {
    version: "reference-first-pass-v1",
    repairs: report.repairs,
    repairDeliveries: 0,
    originalDeliveries: report.executions.length,
    originalAtomicEdits: atoms.length,
    barriers: report.atomicBarriers.map(({ round, attempt, status }) => ({
      round,
      attempt,
      status,
    })),
    checks: report.checks.map(({ contractId, status }) => ({ contractId, status })),
  };
  validateFirstPass(evidence, report.acceptedRounds, report.atomic?.edits);
  return evidence;
}
export function validateReferenceExecution(proof, agents) {
  assert.deepEqual(
    proof.referenceExecution,
    REFERENCE_EXECUTION_POLICY,
    "Reference proof used an obsolete or protected editor",
  );
  assert.equal(proof.repairs, 0, "Reference used repair blocks");
  validateFirstPass(
    proof.referenceFirstPass,
    proof.acceptedRounds,
    proof.acceptedAtomicEdits ?? proof.atomic?.edits,
  );
  const observed = proof.referenceConcurrency;
  assert.equal(observed?.executors, agents, "Reference proof lacks distinct executors");
  for (const field of [
    "maxWorking",
    "maxPlanning",
    "maxPublishing",
    "workIntervals",
    "planningIntervals",
    "publicationIntervals",
  ])
    assert.ok(
      Number.isSafeInteger(observed[field]) && observed[field] > 0,
      "Invalid reference concurrency count",
    );
  const edits = proof.acceptedAtomicEdits ?? proof.atomic?.edits;
  if (edits !== undefined)
    assert.ok(
      observed.workIntervals >= edits,
      "Reference trace does not cover the atomic inventory",
    );
  if (agents === 15) {
    assert.equal(
      observed.maxWorking,
      agents,
      "Reference proof did not overlap the full participant pool",
    );
    assert.ok(observed.maxPlanning > 1, "Reference planning was serialized");
    assert.ok(observed.maxPublishing > 1, "Reference publication was serialized");
  }
  assert.ok(
    observed.workIntervals > 0 &&
      observed.planningIntervals > 0 &&
      observed.publicationIntervals > 0,
    "Reference execution evidence is empty",
  );
}

export async function validateCurrentReferenceExecution(proof, agents) {
  validateReferenceExecution(proof, agents);
  assert.equal(
    proof.referenceSourceSha256,
    await suiteVerifier(),
    "Reference proof belongs to different suite source",
  );
}
