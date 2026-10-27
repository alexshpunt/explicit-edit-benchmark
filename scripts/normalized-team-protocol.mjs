import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ATOMIC_DISPATCH_POLICY } from "../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_MAX_ATTEMPTS,
  atomicDeliveryIds,
  streamDeliveryWorkIds,
  latestStreamDeliveries,
  validateAtomicParents,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";

import {
  RESTORING_MULTI_AGENT_PROTOCOL,
  RESTORING_MULTI_AGENT_POLICY,
  validateRestoringMultiAgentResult,
} from "../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
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

function validateRestoringSuite(suite, contract, policy) {
  keys(suite, [
    "id",
    "protocol",
    "agents",
    "graphWidth",
    "workloadSha256",
    "graphSha256",
    "scheduleSha256",
    "batchSize",
    "schedule",
    "observations",
    "policy",
    "plannedAtoms",
    ...(suite.atomic ? ["atomic"] : []),
  ]);
  assert.equal(suite.id, MULTI_AGENT_BENCHMARK);
  assert.equal(contract, RESTORING_MULTI_AGENT_PROTOCOL);
  for (const field of ["agents", "graphWidth", "batchSize"])
    assert.ok(Number.isSafeInteger(suite[field]) && suite[field] > 0);
  assert.deepEqual(policy, {
    oracleRecoveries: RESTORING_MULTI_AGENT_POLICY.oracleRecoveries,
    retryFailures: 0,
    concurrency: suite.agents,
    timeoutMs: null,
  });
  for (const field of ["workloadSha256", "graphSha256", "scheduleSha256"])
    assert.match(suite[field], /^[a-f0-9]{64}$/);
  assert.equal(digest(suite.schedule), suite.scheduleSha256);
  if (suite.atomic) validateAtomicIdentity(suite.atomic);
  assert.ok(Array.isArray(suite.schedule) && suite.schedule.length > 0);
  assert.ok(
    Array.isArray(suite.plannedAtoms) && suite.plannedAtoms.length === suite.schedule.length,
  );
  const tasks = new Set();
  for (const [index, round] of suite.schedule.entries()) {
    keys(round, ["id", "assignments"]);
    assert.equal(round.id, `round-${String(index + 1).padStart(3, "0")}`);
    assert.equal(round.id, suite.plannedAtoms[index].round);
    assert.ok(Array.isArray(round.assignments) && round.assignments.length > 0);
    for (const item of round.assignments) {
      keys(item, [
        "task",
        "agent",
        ...["zone", "slot"].filter((field) => Object.hasOwn(item, field)),
      ]);
      assert.match(item.task, /^task-\d{3,}$/);
      assert.ok(!tasks.has(item.task));
      tasks.add(item.task);
      assert.ok(Number.isSafeInteger(item.agent) && item.agent >= 0 && item.agent < suite.agents);
      if (Object.hasOwn(item, "slot"))
        assert.ok(Number.isSafeInteger(item.slot) && item.slot >= 0 && item.slot < suite.agents);
      if (Object.hasOwn(item, "zone")) assert.match(item.zone, /^[a-zA-Z0-9._/-]+$/);
    }
  }
  assert.ok(Array.isArray(suite.observations) && suite.observations.length > 0);
  const profiles = new Set();
  let sourceIdentity;
  for (const observation of suite.observations) {
    keys(observation, ["profileId", "result"]);
    assert.ok(typeof observation.profileId === "string" && !profiles.has(observation.profileId));
    profiles.add(observation.profileId);
    const result = validateRestoringMultiAgentResult(observation.result);
    for (const field of ["agents", "graphWidth", "batchSize"])
      assert.equal(result.configuration[field], suite[field]);
    for (const field of ["workloadSha256", "graphSha256", "scheduleSha256"])
      assert.equal(result.identity[field], suite[field]);
    assert.deepEqual(result.policy, suite.policy);
    assert.deepEqual(result.plannedAtoms, suite.plannedAtoms);
    assert.equal(result.progress.totalTasks, tasks.size);
    if (suite.atomic) assert.equal(result.progress.totalAtoms, suite.atomic.edits);
    const { final: _candidate, ...identity } = result.identity;
    if (sourceIdentity)
      assert.deepEqual(identity, sourceIdentity, "Profiles have different source contracts");
    sourceIdentity = identity;
  }
}

function validateRestoringTables(suite, profiles, trials, rounds) {
  assert.equal(profiles.length, suite.observations.length);
  assert.equal(trials.length, profiles.length * suite.schedule.length);
  for (const profile of profiles) {
    const result = suite.observations.find((item) => item.profileId === profile.profileId)?.result;
    assert.ok(result, "Missing restoring profile observation");
    let deliveries = 0,
      repairs = 0;
    const originalAtoms = new Map();
    for (const barrier of suite.schedule) {
      const matching = trials.filter(
        (item) => item.profileId === profile.profileId && item.taskId === barrier.id,
      );
      assert.equal(matching.length, 1);
      const trial = matching[0];
      assert.deepEqual(
        trial.taskIds,
        barrier.assignments.map((item) => item.task),
      );
      const measured = result.rounds.find((item) => item.round === barrier.id);
      assert.equal(trial.firstScore, measured?.first.score ?? 0);
      assert.equal(trial.finalScore, measured?.final.score ?? 0);
      assert.equal(trial.firstExactPassed, measured?.first.normalized === 1);
      assert.equal(trial.finalExactPassed, measured?.final.normalized === 1);
      const participantRows = rounds.filter((item) => item.trialId === trial.trialId);
      assert.equal(participantRows.length, trial.rounds);
      const work = new Set();
      const attempts = new Set();
      let previous = 0;
      for (const row of participantRows) {
        assert.ok(row.agent < suite.agents);
        const attempt = row.barrierAttempt + 1;
        assert.ok(attempt >= previous && attempt <= 6);
        previous = attempt;
        attempts.add(attempt);
        if (measured) assert.ok(attempt <= measured.attempts && !failedNativeReceipt(row));
        const expectedPass = measured?.final.normalized === 1 && attempt === measured.attempts;
        assert.equal(row.exactPassed, expectedPass);
        assert.equal(row.normalizedPassed, expectedPass);
        validateStreamDelivery(row, row.taskIds, trial.taskIds, {
          batchSize: suite.batchSize,
          availableParents: suite.schedule
            .slice(0, suite.schedule.indexOf(barrier) + 1)
            .flatMap((item) => item.assignments.map((entry) => entry.task)),
        });
        for (const id of streamDeliveryWorkIds(row)) {
          const key = `${attempt}:${id}`;
          assert.ok(!work.has(key), "Duplicate delivery work");
          work.add(key);
        }
        if (row.deliveryKind)
          assert.ok(attempt > 1 && row.atomicId.startsWith(`repair-${barrier.id}-`));
        if (attempt === 1) {
          assert.ok(!row.deliveryKind);
          const coverage = originalAtoms.get(barrier.id) ?? new Set();
          for (const id of atomicDeliveryIds(row)) {
            assert.ok(!coverage.has(id));
            coverage.add(id);
          }
          originalAtoms.set(barrier.id, coverage);
        }
        deliveries++;
        repairs += Number(attempt > 1);
      }
      if (measured) {
        assert.equal(originalAtoms.get(barrier.id)?.size, measured.final.totalAtoms);
        assert.deepEqual(
          [...attempts],
          Array.from({ length: measured.attempts }, (_, index) => index + 1),
        );
      } else {
        const position = suite.schedule.indexOf(barrier);
        assert.ok(position >= result.rounds.length);
        if (participantRows.length) assert.equal(position, result.rounds.length);
      }
    }
    assert.equal(deliveries, result.execution.deliveries);
    assert.equal(repairs, result.execution.repairs);
  }
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
  assert.match(atomicId, /^(?:task-\d{3}[-_:]|repair-round-\d{3}-)[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  if (atomicId.startsWith("repair-"))
    assert.ok(atomicId.startsWith(`repair-${round}-`), "Repair artifact has another barrier");
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

/** Bind current work or a retained-state correction to disclosed public tasks. */
export function validateStreamDelivery(delivery, taskIds, barrierTasks, options) {
  validateAtomicParents(delivery, taskIds, barrierTasks, options);
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
  if (suite.protocol === RESTORING_MULTI_AGENT_PROTOCOL)
    return validateRestoringSuite(suite, contract, policy);
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
    ...(Object.hasOwn(suite, "batchSize") ? ["batchSize"] : []),
  ]);
  if (Object.hasOwn(suite, "batchSize"))
    assert.ok(
      Number.isSafeInteger(suite.batchSize) && suite.batchSize > 0,
      "Invalid delivery size",
    );
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
  if (suite.protocol === RESTORING_MULTI_AGENT_PROTOCOL)
    return validateRestoringTables(suite, profiles, trials, rounds);
  assert.equal(suite.protocol, MULTI_AGENT_PROTOCOL, "Unsupported Multi-Agent protocol");
  const maxAttempts = MULTI_AGENT_MAX_ATTEMPTS;
  const atomic = rounds.some(
    (item) => Object.hasOwn(item, "atomicId") || Object.hasOwn(item, "deliveryKind"),
  );
  assert.deepEqual(
    suite.observations.map((item) => item.profileId).sort(),
    profiles.map((item) => item.profileId).sort(),
  );
  const batchSize = suite.batchSize ?? ATOMIC_DISPATCH_POLICY.defaultBatchSize;
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid delivery size");
  for (const observation of suite.observations) {
    const availableParents = [];
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
      availableParents.push(...trial.taskIds);
      const attempts = new Map();
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
          validateStreamDelivery(delivery, delivery.taskIds, trial.taskIds, {
            availableParents,
            batchSize,
          });
          if (delivery.deliveryKind) {
            assert.ok(delivery.barrierAttempt > 0, "Initial delivery cannot be a barrier repair");
            assert.ok(
              delivery.atomicId.startsWith(`repair-${barrier.id}-`),
              "Repair artifact has another barrier",
            );
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
              ? item.atomicId === delivery.atomicId ||
                streamDeliveryWorkIds(item).some((id) =>
                  streamDeliveryWorkIds(delivery).includes(id),
                )
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
              deliveries.some((item) =>
                atomicDeliveryIds(item).some((id) => id.slice(0, 8) === task),
              ),
            ),
            "Joint accepted barrier lacks parent task deliveries",
          );
          assert.ok(
            [...latest.values(), ...(attempts.get(ordered.at(-1)) ?? [])].every(
              (item) => !failedNativeReceipt(item),
            ),
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
