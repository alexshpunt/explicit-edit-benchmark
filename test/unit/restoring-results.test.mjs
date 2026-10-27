import assert from "node:assert/strict";
import test from "node:test";
import {
  multiAgentResult,
  validateMultiAgentResult,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import {
  RESTORING_MULTI_AGENT_RESULT_VERSION,
  restoringMultiAgentResult,
} from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";

test("restored editing exhaustion continues and final scores use equal full round maxima", () => {
  const result = multiAgentResult(restoringFixture());
  assert.equal(result.schemaVersion, RESTORING_MULTI_AGENT_RESULT_VERSION);
  assert.equal(result.status, "complete");
  assert.equal(result.score.final.score, 53.125);
  assert.equal(result.score.first.score, 50);
  assert.equal(result.rounds[0].final.passedAtoms, 1);
  assert.equal(result.rounds[0].final.score, 6.25);
  assert.equal(result.rounds[0].attempts, 6);
  assert.equal(result.progress.observedRounds, 2);
  assert.equal(result.execution.deliveries, 8);
  assert.deepEqual(validateMultiAgentResult(result), result);
});

test("a runtime stop keeps all planned round maxima in both score denominators", () => {
  const raw = restoringFixture();
  raw.status = "driver_exit";
  raw.terminal = { id: "round-002", category: "driver_exit" };
  raw.rounds.pop();
  raw.executions.pop();
  raw.deliveries--;
  const result = restoringMultiAgentResult(raw);
  assert.equal(result.score.final.score, 3.125);
  assert.equal(result.score.first.score, 0);
  assert.equal(result.score.final.plannedRounds, 2);
  assert.equal(result.score.final.complete, false);
});

test("operational failures retain safe provider categories and incomplete closure is not completion", () => {
  const raw = restoringFixture();
  raw.status = "driver_exit";
  raw.terminal = { id: "round-002", category: "provider_failure" };
  const result = restoringMultiAgentResult(raw);
  assert.equal(result.terminal.failureCategory, "provider_failure");
  const unfinished = restoringFixture();
  unfinished.agentsClosed[0] = false;
  assert.throws(() => restoringMultiAgentResult(unfinished));
});
test("raw results require explicit preservation evidence on every attempt", () => {
  const raw = restoringFixture();
  delete raw.rounds[0].attempts[0].integrityPassed;
  assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
});

test("restoration endpoints and delivered original inventories match the trusted round plan", () => {
  for (const mutate of [
    (raw) => (raw.rounds[0].restoration.identity = "b".repeat(64)),
    (raw) => {
      raw.executions[0].atomicId = "task-001-forged";
      raw.executions[0].atomicIds = ["task-001-forged"];
    },
  ]) {
    const raw = restoringFixture();
    mutate(raw);
    assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
  }
});

test("an operationally lost workspace retains a missing final identity without inventing source", () => {
  const raw = restoringFixture();
  raw.status = "infrastructure";
  raw.final = null;
  raw.terminal = { id: "round-002", category: "infrastructure" };
  const result = restoringMultiAgentResult(raw);
  assert.equal(result.identity.final, null);
  assert.equal(result.score.final.score, 53.125);
  assert.equal(result.terminal.failureCategory, "infrastructure");
  const complete = restoringFixture();
  complete.final = null;
  assert.throws(() => restoringMultiAgentResult(complete), { code: "ERR_ASSERTION" });
});
test("the integrity veto retains independent raw atom and build evidence", () => {
  const raw = restoringFixture();
  raw.rounds[0].attempts[5].integrityPassed = false;
  const result = restoringMultiAgentResult(raw);
  assert.equal(result.rounds[0].final.passedAtoms, 1);
  assert.equal(result.rounds[0].final.integrityPassed, false);
  assert.equal(result.score.final.score, 50);
});

for (const { name, mutate } of [
  { name: "score", mutate: (value) => value.score.final.score++ },
  { name: "first score", mutate: (value) => value.score.first.score++ },
  { name: "round score", mutate: (value) => (value.rounds[0].final.normalized = 1) },
  { name: "planned denominator", mutate: (value) => value.plannedAtoms.pop() },
  { name: "weight", mutate: (value) => (value.policy.buildWeight = 0) },
  { name: "source identity", mutate: (value) => (value.identity.runnerSha256 = "b".repeat(64)) },
  { name: "old protocol", mutate: (value) => (value.protocol = MULTI_AGENT_PROTOCOL) },
  { name: "extra protected source", mutate: (value) => (value.rounds[0].body = "private source") },
])
  test(`safe restoring result refuses a changed ${name}`, () => {
    const result = restoringMultiAgentResult(restoringFixture());
    mutate(result);
    assert.throws(() => validateMultiAgentResult(result));
  });

test("raw restoring evidence refuses early exhaustion, inflated atoms and historical relabelling", () => {
  for (const mutate of [
    (raw) => raw.rounds[0].attempts.pop(),
    (raw) => (raw.rounds[0].attempts[5].passedAtoms = 3),
    (raw) => (raw.plannedAtoms[0].totalAtoms = 3),
    (raw) => raw.rounds.reverse(),
    (raw) => (raw.version = "renderer-concurrent-run-v1"),
    (raw) => (raw.protocol = MULTI_AGENT_PROTOCOL),
    (raw) => (raw.executions[0].atomicIds = ["task-001-a", "task-001-b"]),
  ]) {
    const raw = restoringFixture();
    mutate(raw);
    assert.throws(() => multiAgentResult(raw));
  }
});

test("comparison identities separate maximum occupancy, batch and valid weight configurations", () => {
  const original = restoringMultiAgentResult(restoringFixture());
  for (const mutate of [
    (raw) => {
      raw.agents = 3;
      raw.agentsClosed.push(true);
    },
    (raw) => (raw.batchSize = 2),
    (raw) => (raw.policy.resultWeight = 5),
    (raw) => (raw.verifierSha256 = "c".repeat(64)),
    (raw) => (raw.runnerSha256 = "d".repeat(64)),
  ]) {
    const raw = restoringFixture();
    mutate(raw);
    assert.notEqual(restoringMultiAgentResult(raw).comparisonKey, original.comparisonKey);
  }
});
