import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MULTI_AGENT_BENCHMARK,
  multiAgentCorrectionBudget,
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

/** Validate a recognized maximal-team protocol, its exact correction policy and
 * workload/schedule bindings, including historical v1 evidence.
 */
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
  ]);
  assert.equal(suite.id, MULTI_AGENT_BENCHMARK);
  const oracleRecoveries = multiAgentCorrectionBudget(suite.protocol);
  assert.equal(contract, suite.protocol);
  assert.equal(suite.agents, 15);
  assert.equal(suite.graphWidth, 15);
  assert.deepEqual(policy, {
    oracleRecoveries,
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

/** Verify joint task credit and participant delivery links against the recorded
 * protocol's correction budget, without inventing per-agent scores.
 */
export function validateTeamTables(suite, profiles, trials, rounds) {
  const oracleRecoveries = multiAgentCorrectionBudget(suite.protocol);
  const maxAttempts = oracleRecoveries + 1;
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
      for (const delivery of deliveries) {
        assert.ok(
          Number.isInteger(delivery.barrierAttempt) &&
            delivery.barrierAttempt >= 0 &&
            delivery.barrierAttempt < maxAttempts,
        );
        const assigned = barrier.assignments
          .filter((item) => item.agent === delivery.agent)
          .map((item) => item.task);
        assert.ok(assigned.length > 0, "Unscheduled participant");
        assert.deepEqual(delivery.taskIds, assigned);
        assert.notEqual(delivery.difference, "eof", "Team grading has no EOF-only success");
        const group = attempts.get(delivery.barrierAttempt) ?? [];
        assert.ok(
          !group.some((item) => item.agent === delivery.agent),
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
        if (attempt < ordered.at(-1) || group[0].difference !== "unknown")
          assert.equal(group.length, participantCount, "Incomplete jointly graded barrier");
        if (group[0].exactPassed)
          assert.equal(attempt, ordered.at(-1), "Corrections after joint acceptance");
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
        `Editing block did not exhaust ${oracleRecoveries} corrections`,
      );
      assert.ok(
        failed.deliveries.every((item) => item.difference === "other"),
        "Editing block lacks failed grading evidence",
      );
    }
  }
}
