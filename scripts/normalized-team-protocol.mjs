import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ATOMIC_DISPATCH_POLICY } from "../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_MAX_ATTEMPTS,
  atomicDeliveryIds,
  latestStreamDeliveries,
  validateAtomicParents,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";

const statuses = new Set([
  "pass",
  "blocked",
  "provider_failure",
  "driver_exit",
  "infrastructure",
  "cancelled",
  "timeout",
]);
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function keys(value, expected) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(
    Object.keys(value).sort(),
    [...expected].sort(),
    "Unexpected team protocol fields",
  );
}

/** Validate the public hashes of the atomic workload, private bindings and dispatch contract.
 * Only hashes leave the controller; prepared token plans and expected source stay private.
 */
export function validateAtomicIdentity(atomic) {
  assert.ok(atomic && typeof atomic === "object", "Missing atomic stream identity");
  keys(atomic, ["version", "workloadSha256", "batchesSha256", "dispatchPolicySha256", "edits"]);
  assert.equal(atomic.version, ATOMIC_DISPATCH_POLICY.version, "Unsupported atomic stream version");
  for (const field of ["workloadSha256", "batchesSha256", "dispatchPolicySha256"])
    assert.match(atomic[field], /^[a-f0-9]{64}$/, `Invalid atomic identity: ${field}`);
  assert.equal(
    atomic.dispatchPolicySha256,
    digest(ATOMIC_DISPATCH_POLICY),
    "Atomic dispatch policy changed",
  );
  assert.ok(Number.isSafeInteger(atomic.edits) && atomic.edits > 0, "Invalid atomic edit count");
}
/** Name one native delivery directory without allowing atom IDs to escape its artifact root. */
export function teamDeliveryDirectory(round, attempt, atomicId) {
  assert.match(round, /^round-\d{3}$/);
  assert.ok(Number.isInteger(attempt) && attempt >= 1 && attempt <= MULTI_AGENT_MAX_ATTEMPTS);
  if (atomicId === undefined) return `${round}-attempt-${attempt}`;
  assert.ok(typeof atomicId === "string");
  assert.match(atomicId, /^task-\d{3}[-_:][A-Za-z0-9][A-Za-z0-9._:-]*$/);
  return `${round}-${atomicId}-attempt-${attempt}`;
}

/** Bind an atomic delivery to exactly one original task in its joint grading barrier. */
export function validateAtomicDelivery(atomicId, taskIds, barrierTasks) {
  assert.ok(
    Array.isArray(taskIds) && taskIds.length === 1,
    "Atomic delivery needs one parent task",
  );
  const task = taskIds[0];
  assert.ok(barrierTasks.includes(task), "Atomic delivery has an unscheduled parent task");
  assert.ok(typeof atomicId === "string", "Missing atomic delivery ID");
  assert.match(atomicId, /^task-\d{3}[-_:][A-Za-z0-9][A-Za-z0-9._:-]*$/);
  assert.ok(
    atomicId.startsWith(`${task}-`) ||
      atomicId.startsWith(`${task}_`) ||
      atomicId.startsWith(`${task}:`),
    "Atomic delivery ID contradicts its parent task",
  );
}

/** Bind one task-scoped atomic delivery to its barrier. */
export function validateStreamDelivery(delivery, taskIds, barrierTasks) {
  validateAtomicParents(delivery, taskIds, barrierTasks);
}

function failedNativeReceipt(delivery) {
  return Boolean(
    delivery.providerFailure ||
    delivery.timedOut ||
    delivery.eventErrors ||
    (delivery.exitCode !== null && delivery.exitCode !== 0),
  );
}
/** Validate the maximal-team protocol, fixed policy and workload/schedule bindings. */
export function validateTeamSuite(suite, contract, policy) {
  keys(suite, [
    "id",
    "protocol",
    "agents",
    "graphWidth",
    "workloadSha256",
    "graphSha256",
    "scheduleSha256",
    "schedule",
    "observations",
    ...(Object.hasOwn(suite, "atomic") ? ["atomic"] : []),
  ]);
  if (Object.hasOwn(suite, "atomic")) validateAtomicIdentity(suite.atomic);
  assert.equal(suite.id, MULTI_AGENT_BENCHMARK);
  assert.equal(suite.protocol, MULTI_AGENT_PROTOCOL, "Unsupported Multi-Agent protocol");
  assert.equal(contract, MULTI_AGENT_PROTOCOL);
  assert.equal(suite.agents, 15);
  assert.equal(suite.graphWidth, 15);
  assert.deepEqual(policy, {
    oracleRecoveries: MULTI_AGENT_POLICY.oracleRecoveries,
    retryFailures: 0,
    concurrency: 15,
    timeoutMs: null,
  });
  for (const field of ["workloadSha256", "graphSha256", "scheduleSha256"])
    assert.match(suite[field], /^[a-f0-9]{64}$/);
  assert.ok(Array.isArray(suite.schedule) && suite.schedule.length === 28);
  const tasks = new Set();
  for (const [index, barrier] of suite.schedule.entries()) {
    keys(barrier, ["id", "assignments"]);
    assert.equal(barrier.id, `round-${String(index + 1).padStart(3, "0")}`);
    assert.ok(Array.isArray(barrier.assignments) && barrier.assignments.length > 0);
    for (const assignment of barrier.assignments) {
      keys(assignment, [
        "task",
        "agent",
        ...["zone", "slot"].filter((field) => Object.hasOwn(assignment, field)),
      ]);
      assert.match(assignment.task, /^task-\d{3}$/);
      assert.ok(!tasks.has(assignment.task), "Duplicate scheduled task");
      tasks.add(assignment.task);
      assert.ok(
        Number.isInteger(assignment.agent) && assignment.agent >= 0 && assignment.agent < 15,
      );
      if (Object.hasOwn(assignment, "zone")) assert.match(assignment.zone, /^[a-zA-Z0-9._/-]+$/);
      if (Object.hasOwn(assignment, "slot"))
        assert.ok(
          Number.isInteger(assignment.slot) && assignment.slot >= 0 && assignment.slot < 15,
        );
    }
  }
  assert.deepEqual(
    [...tasks].sort(),
    Array.from({ length: 71 }, (_, index) => `task-${String(index + 1).padStart(3, "0")}`),
  );
  assert.equal(digest(suite.schedule), suite.scheduleSha256, "Team schedule digest mismatch");
  assert.ok(Array.isArray(suite.observations));
  const profiles = new Set();
  for (const observation of suite.observations) {
    keys(observation, ["profileId", "status", "elapsedMs", "terminalCategory"]);
    assert.ok(typeof observation.profileId === "string" && !profiles.has(observation.profileId));
    profiles.add(observation.profileId);
    assert.ok(statuses.has(observation.status));
    assert.ok(Number.isFinite(observation.elapsedMs) && observation.elapsedMs >= 0);
    assert.equal(
      observation.terminalCategory,
      observation.status === "pass" ? null : observation.status,
    );
  }
}

/** Verify joint task credit and participant delivery links without per-agent scores. */
export function validateTeamTables(suite, profiles, trials, rounds) {
  assert.equal(suite.protocol, MULTI_AGENT_PROTOCOL, "Unsupported Multi-Agent protocol");
  const maxAttempts = MULTI_AGENT_MAX_ATTEMPTS;
  const atomic = rounds.some(
    (item) => Object.hasOwn(item, "atomicId") || Object.hasOwn(item, "deliveryKind"),
  );
  assert.deepEqual(
    suite.observations.map((item) => item.profileId).sort(),
    profiles.map((item) => item.profileId).sort(),
  );
  for (const observation of suite.observations) {
    const selected = trials.filter((trial) => trial.profileId === observation.profileId);
    assert.equal(selected.length, suite.schedule.length, "Incomplete team barrier table");
    let stopped = false;
    let failed;
    for (const barrier of suite.schedule) {
      const trial = selected.find((item) => item.taskId === barrier.id);
      assert.ok(trial, "Missing scheduled barrier");
      assert.deepEqual(
        trial.taskIds,
        barrier.assignments.map((item) => item.task),
      );
      const deliveries = rounds.filter((item) => item.trialId === trial.trialId);
      if (stopped) assert.equal(deliveries.length, 0, "Team continued after an unaccepted barrier");
      const attempts = new Map();
      const owners = new Map();
      for (const delivery of deliveries) {
        assert.ok(
          Number.isInteger(delivery.barrierAttempt) &&
            delivery.barrierAttempt >= 0 &&
            delivery.barrierAttempt < maxAttempts,
        );
        assert.ok(
          Number.isInteger(delivery.agent) && delivery.agent >= 0 && delivery.agent < suite.agents,
          "Participant outside team pool",
        );
        if (atomic) {
          validateStreamDelivery(delivery, delivery.taskIds, trial.taskIds);
          for (const id of atomicDeliveryIds(delivery)) {
            if (owners.has(id))
              assert.equal(owners.get(id), delivery.agent, "Repair changed task executor");
            else owners.set(id, delivery.agent);
          }
        } else {
          const assigned = barrier.assignments
            .filter((item) => item.agent === delivery.agent)
            .map((item) => item.task);
          assert.ok(assigned.length > 0, "Unscheduled participant");
          assert.deepEqual(delivery.taskIds, assigned);
        }
        assert.notEqual(delivery.difference, "eof", "Team grading has no EOF-only success");
        const group = attempts.get(delivery.barrierAttempt) ?? [];
        assert.ok(
          !group.some((item) =>
            atomic
              ? atomicDeliveryIds(item).some((id) => atomicDeliveryIds(delivery).includes(id))
              : item.agent === delivery.agent,
          ),
          "Duplicate participant delivery",
        );
        group.push(delivery);
        attempts.set(delivery.barrierAttempt, group);
      }
      const ordered = [...attempts.keys()].sort((a, b) => a - b);
      assert.ok(
        ordered.every((attempt, index) => attempt === index),
        "Non-contiguous team corrections",
      );
      const participantCount = new Set(barrier.assignments.map((item) => item.agent)).size;
      for (const [attempt, group] of attempts) {
        assert.ok(
          group.every(
            (item) =>
              item.exactPassed === group[0].exactPassed && item.difference === group[0].difference,
          ),
          "Contradictory joint grade",
        );
        if (!atomic && (attempt < ordered.at(-1) || group[0].difference !== "unknown"))
          assert.equal(group.length, participantCount, "Incomplete jointly graded barrier");
        if (group[0].exactPassed)
          assert.equal(attempt, ordered.at(-1), "Corrections after joint acceptance");
      }
      if (atomic) {
        assert.equal(trial.firstExactPassed, attempts.get(0)?.[0].exactPassed ?? false);
        assert.equal(
          trial.finalExactPassed,
          attempts.get(ordered.at(-1))?.[0].exactPassed ?? false,
        );
        if (trial.finalExactPassed) {
          const latest = latestStreamDeliveries(deliveries);
          assert.ok(
            trial.taskIds.every((task) =>
              deliveries.some(
                (item) => Object.hasOwn(item, "atomicId") && item.taskIds.includes(task),
              ),
            ),
            "Joint accepted barrier lacks parent task deliveries",
          );
          assert.ok(
            [...latest.values()].every((item) => !failedNativeReceipt(item)),
            "Joint accepted barrier has failed native receipts",
          );
        }
      }
      if (!trial.finalExactPassed) {
        stopped = true;
        failed ??= { deliveries, attempts };
      }
    }
    if (observation.status === "pass") assert.ok(!stopped, "Passing team has unaccepted tasks");
    else assert.ok(stopped, "Stopped team has completed the workload");
    if (observation.status === "blocked") {
      assert.equal(
        failed.attempts.size,
        maxAttempts,
        `Editing block did not exhaust ${MULTI_AGENT_POLICY.oracleRecoveries} corrections`,
      );
      assert.ok(
        failed.deliveries.every((item) => item.difference === "other"),
        "Editing block lacks failed grading evidence",
      );
    }
  }
}
