import assert from "node:assert/strict";
import test from "node:test";
import {
  multiAgentResult,
  validateMultiAgentResult,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import {
  RESTORING_MULTI_AGENT_RESULT_VERSION,
  RESTORING_MULTI_AGENT_POLICY,
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

function twoAttemptFixture() {
  const raw = restoringFixture();
  raw.policy = { ...RESTORING_MULTI_AGENT_POLICY, buildWeight: 2, resultWeight: 4 };
  raw.rounds[0].attempts = [
    raw.rounds[0].attempts[0],
    { ...raw.rounds[0].attempts.at(-1), attempt: 2 },
  ];
  raw.rounds[0].finalAttempt = 2;
  raw.executions = raw.executions.filter(({ attempt }) => attempt <= 2);
  raw.deliveries = raw.executions.length;
  raw.repairs = 1;
  return raw;
}

test("new restoring evidence permits one correction and keeps old six-attempt results separate", () => {
  const current = restoringMultiAgentResult(twoAttemptFixture());
  const legacy = restoringMultiAgentResult(restoringFixture());
  assert.equal(current.policy.version, "renderer-restoring-policy-v3");
  assert.equal(current.policy.oracleRecoveries, 1);
  assert.equal(current.rounds[0].attempts, 2);
  assert.equal(current.score.final.score, 53.125);
  assert.equal(current.score.first.score, 50);
  assert.equal(legacy.policy.version, "renderer-restoring-policy-v2");
  assert.equal(legacy.policy.oracleRecoveries, 5);
  assert.equal(legacy.rounds[0].attempts, 6);
  assert.notEqual(current.comparisonKey, legacy.comparisonKey);
});

test("new restoring evidence rejects a third attempt and incomplete exhaustion", () => {
  for (const attempts of [1, 3, 6]) {
    const raw = restoringFixture();
    raw.policy = { ...RESTORING_MULTI_AGENT_POLICY, buildWeight: 2, resultWeight: 4 };
    raw.rounds[0].attempts = raw.rounds[0].attempts.slice(0, attempts);
    raw.rounds[0].finalAttempt = attempts;
    raw.executions = raw.executions.filter(({ attempt }) => attempt <= attempts);
    raw.deliveries = raw.executions.length;
    raw.repairs = attempts - 1;
    assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
  }
});

test("an interrupted new-policy round cannot contain a third delivery attempt", () => {
  const raw = twoAttemptFixture();
  raw.status = "cancelled";
  raw.terminal = { id: "round-002", category: "cancelled" };
  raw.rounds.pop();
  raw.executions.at(-1).attempt = 3;
  assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
});

test("policy versions cannot be relabelled with another recovery budget", () => {
  for (const [version, oracleRecoveries] of [
    ["renderer-restoring-policy-v2", 1],
    ["renderer-restoring-policy-v3", 5],
    ["renderer-restoring-policy-v4", 1],
  ]) {
    const raw = twoAttemptFixture();
    Object.assign(raw.policy, { version, oracleRecoveries });
    assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
  }
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

function freshFixture() {
  const raw = restoringFixture();
  raw.agentLifecycle = "per-delivery";
  raw.maxConcurrentAgents = 30;
  raw.policy.participants = "fresh-session-per-original-delivery";
  raw.policy.idle = "round-local-recovery-contexts";
  raw.participants = [
    { agent: 0, sessionId: "private-first-session" },
    { agent: 1, sessionId: "private-second-session" },
    { agent: 29, sessionId: "private-last-session" },
  ];
  raw.agentsClosed = [true, true, true];
  raw.executions[0].agent = 29;
  return raw;
}

test("fresh delivery results retain lifecycle and concurrency without exporting session identities", () => {
  const result = restoringMultiAgentResult(freshFixture());
  assert.equal(result.configuration.agentLifecycle, "per-delivery");
  assert.equal(result.configuration.maxConcurrentAgents, 30);
  assert.equal(result.configuration.agents, 2);
  assert.equal(result.execution.agentsClosed, true);
  assert.equal(result.score.final.score, 53.125);
  assert.equal(Object.hasOwn(result, "participants"), false);
  assert.ok(!JSON.stringify(result).includes("private-first-session"));
  assert.deepEqual(validateMultiAgentResult(result), result);
});

test("an explicit persistent cap can use fewer processes without changing the planned schedule", () => {
  const raw = restoringFixture();
  raw.agentLifecycle = "persistent";
  raw.maxConcurrentAgents = 1;
  raw.participants = [{ agent: 0, sessionId: "private-session" }];
  raw.agentsClosed = [true];
  for (const execution of raw.executions) execution.agent = 0;
  const result = restoringMultiAgentResult(raw);
  assert.equal(result.configuration.agents, 2);
  assert.equal(result.configuration.maxConcurrentAgents, 1);
  assert.equal(result.execution.agentsClosed, true);
  assert.deepEqual(result.plannedAtoms, raw.plannedAtoms);
});

test("an explicit persistent pool need not start slots without assigned work", () => {
  const raw = restoringFixture();
  raw.agentLifecycle = "persistent";
  raw.maxConcurrentAgents = 2;
  raw.participants = [{ agent: 0, sessionId: "private-session" }];
  raw.agentsClosed = [true];
  for (const execution of raw.executions) execution.agent = 0;
  assert.equal(restoringMultiAgentResult(raw).execution.agentsClosed, true);
  raw.participants.push({ ...raw.participants[0] });
  raw.agentsClosed.push(true);
  assert.throws(() => restoringMultiAgentResult(raw));
});
test("result identity binds fresh lifecycle and the independent concurrency limit", () => {
  const original = restoringMultiAgentResult(freshFixture());
  const changed = freshFixture();
  changed.maxConcurrentAgents = 31;
  assert.notEqual(restoringMultiAgentResult(changed).comparisonKey, original.comparisonKey);
  assert.notEqual(
    original.comparisonKey,
    restoringMultiAgentResult(restoringFixture()).comparisonKey,
  );
  original.configuration.maxConcurrentAgents = 31;
  assert.throws(() => validateMultiAgentResult(original), { code: "ERR_ASSERTION" });
});

test("fresh results reject missing, invalid or contradictory lifecycle evidence", () => {
  for (const mutate of [
    (raw) => delete raw.agentLifecycle,
    (raw) => delete raw.maxConcurrentAgents,
    (raw) => (raw.agentLifecycle = "unknown"),
    (raw) => (raw.maxConcurrentAgents = 0),
    (raw) => (raw.maxConcurrentAgents = 1.5),
    (raw) => (raw.maxConcurrentAgents = Number.MAX_SAFE_INTEGER + 1),
    (raw) => (raw.executions[0].agent = 30),
    (raw) => raw.agentsClosed.pop(),
    (raw) => (raw.agentsClosed[1] = false),
    (raw) => delete raw.participants,
    (raw) => (raw.participants = []),
    (raw) => (raw.policy.participants = "maximum-occupancy-persistent-processes"),
    (raw) => (raw.mode = "reference"),
  ]) {
    const raw = freshFixture();
    mutate(raw);
    assert.throws(() => restoringMultiAgentResult(raw), { code: "ERR_ASSERTION" });
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
