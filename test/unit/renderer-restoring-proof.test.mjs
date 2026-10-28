import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import * as restoringProof from "../../src/suites/explicit-edit-multi-agent/execution/restoring-proof.mjs";
import { RESTORING_MULTI_AGENT_POLICY } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

const {
  RESTORING_RUN_VERSION,
  restoringRunIdentity,
  createRestoringProof,
  validateRestoringProof,
  validateRestoringTaskProof,
} = restoringProof;

const hash = (text) => createHash("sha256").update(text).digest("hex");
function bulkReferenceFixture() {
  const { identity, report } = fixture();
  identity.totalAtoms = 4;
  identity.atomicInventorySha256 = hash(JSON.stringify(["a", "b", "c", "d"]));
  identity.plannedAtoms[0].totalAtoms = 3;
  identity.roundInventories[0].sha256 = hash(JSON.stringify(["a", "b", "d"]));
  Object.assign(report, identity, { referenceBatchSize: 100 });
  Object.assign(report.rounds[0].attempts[0], { passedAtoms: 3, totalAtoms: 3 });
  const extra = structuredClone(report.executions[0].receipts[0]);
  extra.events = extra.events.map((event) => ({
    ...event,
    at: event.at + 7,
    ...(event.file ? { file: "d.h" } : {}),
  }));
  report.executions[0].atomicIds.push("d");
  report.executions[0].receipts.push(extra);
  report.executions[2].receipts[0].events = report.executions[2].receipts[0].events.map(
    (event) => ({ ...event, at: event.at + 10 }),
  );
  return { identity, report };
}

test("reference batches may exceed the measured batch without changing its authorization", () => {
  const { identity, report } = bulkReferenceFixture();
  const proof = createRestoringProof(report, identity);
  assert.equal(proof.version, "renderer-restoring-execution-proof-v2");
  assert.equal(proof.referenceBatchSize, 100);
  assert.equal(proof.identity.batchSize, 1);
  assert.equal(proof.originalAtomicEdits, 4);
  assert.equal(proof.executions.length, 3);
  assert.equal(proof.referenceConcurrency.executors, 2);
  assert.equal(validateRestoringProof(JSON.parse(JSON.stringify(proof)), identity), true);
  assert.throws(() => validateRestoringProof(proof, { ...identity, batchSize: 100 }));
});

test("reference batching still bounds every delivery and retains every original receipt", () => {
  for (const size of [0, -1, 1.5, null, "100", Number.MAX_SAFE_INTEGER + 1, 1]) {
    const { identity, report } = bulkReferenceFixture();
    report.referenceBatchSize = size;
    assert.throws(() => createRestoringProof(report, identity));
  }
  for (const change of [
    (proof) => {
      proof.referenceBatchSize = 1;
    },
    (proof) => {
      delete proof.referenceBatchSize;
    },
    (proof) => {
      proof.executions[0].receipts.pop();
    },
    (proof) => {
      proof.executions[0].atomicIds[1] = "b";
    },
    (proof) => {
      proof.executions[0].round = "round-002";
    },
  ]) {
    const { identity, report } = bulkReferenceFixture();
    const proof = createRestoringProof(report, identity);
    change(proof);
    assert.throws(() => validateRestoringProof(proof, identity));
  }
});
function fixture() {
  const initial = hash("initial"),
    final = hash("final");
  const identity = {
    protocol: "fixture-restoring-method",
    policy: { ...RESTORING_MULTI_AGENT_POLICY, buildWeight: 2, resultWeight: 4 },
    graphWidth: 2,
    atomic: { version: "fixture-atomic-v1" },
    sourceCommit: "a".repeat(40),
    sourceClean: true,
    verifierSha256: hash("verifier"),
    runnerSha256: hash("runner"),
    workloadSha256: hash("workload"),
    graphSha256: hash("graph"),
    scheduleSha256: hash("schedule"),
    atomicInventorySha256: hash(JSON.stringify(["a", "b", "c"])),
    agents: 2,
    batchSize: 1,
    maxAssignedParticipants: 2,
    initial,
    expectedFinal: final,
    totalTasks: 2,
    totalAtoms: 3,
    totalRounds: 2,
    plannedAtoms: [
      { round: "round-001", totalAtoms: 2 },
      { round: "round-002", totalAtoms: 1 },
    ],
    roundEndpoints: [
      { round: "round-001", identity: hash("middle") },
      { round: "round-002", identity: final },
    ],
    roundInventories: [
      { round: "round-001", sha256: hash(JSON.stringify(["a", "b"])) },
      { round: "round-002", sha256: hash(JSON.stringify(["c"])) },
    ],
    contractHashes: { initial: hash("initial-contract") },
  };
  const rows = identity.plannedAtoms.map(({ round, totalAtoms }, index) => ({
    round,
    firstAttempt: 1,
    finalAttempt: 1,
    attempts: [
      {
        attempt: 1,
        passedAtoms: totalAtoms,
        totalAtoms,
        buildPassed: true,
        resultMatched: true,
        integrityPassed: true,
      },
    ],
    restoration: { status: "pass", identity: identity.roundEndpoints[index].identity },
  }));
  const execution = (id, agent, start) => ({
    round: id === "c" ? "round-002" : "round-001",
    attempt: 1,
    agent,
    atomicIds: [id],
    status: "settled",
    receipts: [
      {
        lifetime: `participant-${agent}`,
        events: [
          { phase: "execute-start", at: start },
          { phase: "plan-start", at: start + 1 },
          { phase: "plan-end", at: start + 3 },
          { phase: "publish-start", at: start + 4, file: `${id}.h` },
          { phase: "publish-end", at: start + 5, file: `${id}.h` },
          { phase: "execute-end", at: start + 6 },
        ],
      },
    ],
  });
  return {
    identity,
    report: {
      ...identity,
      version: RESTORING_RUN_VERSION,
      mode: "reference",
      status: "complete",
      initialCheck: {
        identity: initial,
        buildPassed: true,
        resultMatched: true,
        integrityPassed: true,
      },
      final,
      rounds: rows,
      repairs: 0,
      deliveries: 3,
      agentsClosed: [true, true],
      executions: [execution("a", 0, 0), execution("b", 1, 1), execution("c", 0, 10)],
    },
  };
}

test("dirty source is rejected while deriving execution identity, before reference work", () => {
  const { identity } = fixture();
  const nodes = ["a", "b"].map((id) => ({ id, dependencies: [] }));
  const tree = { "main.cpp": "int main() {}\n" };
  const loaded = {
    manifest: {
      initial: identity.initial,
      final: treeIdentity(tree),
      workloadSha256: identity.workloadSha256,
      graphSha256: identity.graphSha256,
      tasks: 1,
      atomic: {},
    },
    graph: { width: 2 },
    agents: 2,
    schedule: [{ id: "round-001" }],
    scheduleSha256: identity.scheduleSha256,
    contractHashes: identity.contractHashes,
    atomicIntervals: { rounds: new Map([["round-001", { nodes, expectedTree: tree }]]) },
    atomicWorkload: { nodes },
    plannedAtoms: [{ round: "round-001", totalAtoms: 2 }],
  };
  const source = Object.fromEntries(
    ["sourceCommit", "sourceClean", "verifierSha256", "runnerSha256"].map((key) => [
      key,
      identity[key],
    ]),
  );
  const options = { protocol: identity.protocol, policy: identity.policy, batchSize: 1 };
  assert.equal(restoringRunIdentity(loaded, source, options).sourceClean, true);
  assert.throws(
    () => restoringRunIdentity(loaded, { ...source, sourceClean: false }, options),
    (error) => error.code === "ERR_ASSERTION" && error.actual === false && error.expected === true,
  );
});
test("restoring proof binds every planned round and derives original inventory and concurrency", () => {
  const { report, identity } = fixture();
  const proof = createRestoringProof(report, identity);
  assert.equal(
    validateRestoringProof(JSON.parse(JSON.stringify(proof)), identity),
    proof.status === "pass",
  );
  assert.equal(proof.referenceConcurrency.maxWorking, 2);
  assert.equal(proof.originalAtomicEdits, 3);
  assert.equal(proof.rounds.length, 2);
});

test("historical, partial, corrected or incorrectly restored runs cannot authorize new execution", () => {
  for (const change of [
    (r) => {
      r.version = "historical-run";
    },
    (r) => {
      r.status = "infrastructure";
    },
    (r) => {
      r.mode = "measured";
    },
    (r) => {
      r.rounds.pop();
    },
    (r) => {
      r.rounds[0].attempts.push({ ...r.rounds[0].attempts[0], attempt: 2 });
      r.rounds[0].finalAttempt = 2;
    },
    (r) => {
      r.rounds[0].attempts[0].integrityPassed = false;
    },
    (r) => {
      delete r.rounds[0].attempts[0].integrityPassed;
    },
    (r) => {
      [r.executions[0].atomicIds[0], r.executions[2].atomicIds[0]] = ["c", "a"];
    },
    (r) => {
      r.rounds[0].restoration.identity = hash("wrong endpoint");
    },
    (r) => {
      r.executions[2].atomicIds = ["a"];
    },
    (r) => {
      r.agentsClosed[1] = false;
    },
    (r) => {
      r.initialCheck.resultMatched = false;
    },
  ]) {
    const { report, identity } = fixture();
    change(report);
    assert.throws(() => createRestoringProof(report, identity));
  }
});

test("proof authorization rejects source, commit, protocol, scope and weight mismatches", () => {
  const { report, identity } = fixture();
  const proof = createRestoringProof(report, identity);
  for (const [key, value] of [
    ["sourceCommit", "b".repeat(40)],
    ["runnerSha256", hash("another runner")],
    ["verifierSha256", hash("another verifier")],
    ["sourceClean", false],
    ["protocol", "another method"],
    ["batchSize", 2],
    ["policy", { buildWeight: 3, resultWeight: 4 }],
  ])
    assert.throws(() => validateRestoringProof(proof, { ...identity, [key]: value }));
  const changed = structuredClone(proof);
  changed.rounds[0].attempts[0].passedAtoms = 0;
  assert.throws(() => validateRestoringProof(changed, identity));
});

function profileIdentity(identity) {
  return {
    ...structuredClone(identity),
    sourceCommit: "b".repeat(40),
    runnerSha256: hash("current runner"),
    verifierSha256: hash("current verifier"),
    agentLifecycle: "per-delivery",
    maxConcurrentAgents: 30,
    batchSize: 10,
    policy: {
      ...identity.policy,
      participants: "fresh-session-per-original-delivery",
      idle: "round-local-recovery-contexts",
    },
  };
}

test("a validated retained workload authorizes a fresh execution profile without certifying its runner", () => {
  const { report, identity } = fixture();
  const proof = createRestoringProof(report, identity);
  const current = profileIdentity(identity);
  assert.equal(typeof validateRestoringTaskProof, "function");
  assert.deepEqual(validateRestoringTaskProof(proof, current), {
    kind: "retained-task-feasibility",
    sourceCommit: identity.sourceCommit,
    runnerSha256: identity.runnerSha256,
    verifierSha256: identity.verifierSha256,
  });
  assert.equal(validateRestoringProof(proof, identity), true);
  assert.throws(() => validateRestoringProof(proof, current));
  current.agentLifecycle = "persistent";
  current.maxConcurrentAgents = 1;
  current.maxAssignedParticipants = 1;
  current.policy = { ...identity.policy };
  assert.equal(validateRestoringTaskProof(proof, current).kind, "retained-task-feasibility");
});

test("retained task authorization binds all workload and scoring fields", () => {
  const { report, identity } = fixture();
  const proof = createRestoringProof(report, identity);
  for (const [key, value] of [
    ["protocol", "another-method"],
    ["agents", 3],
    ["graphWidth", 3],
    ["workloadSha256", hash("other workload")],
    ["graphSha256", hash("other graph")],
    ["scheduleSha256", hash("other schedule")],
    ["contractHashes", { initial: hash("other contract") }],
    ["atomic", { version: "different-atomic-v1" }],
    ["initial", hash("other initial")],
    ["expectedFinal", hash("other final")],
    ["totalTasks", 3],
    ["totalRounds", 3],
    ["totalAtoms", 4],
    ["atomicInventorySha256", hash("other atoms")],
    [
      "plannedAtoms",
      [
        { round: "round-001", totalAtoms: 1 },
        { round: "round-002", totalAtoms: 2 },
      ],
    ],
    [
      "roundEndpoints",
      [{ round: "round-001", identity: hash("other middle") }, identity.roundEndpoints[1]],
    ],
    [
      "roundInventories",
      [{ round: "round-001", sha256: hash("other round atoms") }, identity.roundInventories[1]],
    ],
    ["sourceClean", false],
  ]) {
    const current = profileIdentity(identity);
    current[key] = value;
    assert.throws(() => validateRestoringTaskProof(proof, current), { code: "ERR_ASSERTION" });
  }
  for (const [field, value] of [
    ["buildWeight", 3],
    ["resultWeight", 5],
    ["grading", "changed-grade"],
    ["integrity", "changed-integrity"],
    ["oracleRecoveries", 6],
    ["attemptTimeoutMs", 1],
    ["trialTimeoutMs", 1],
    ["assignment", "changed-assignment"],
  ]) {
    const current = profileIdentity(identity);
    current.policy[field] = value;
    assert.throws(() => validateRestoringTaskProof(proof, current), { code: "ERR_ASSERTION" });
  }
});

test("retained task authorization cannot omit immutable scope metadata", () => {
  for (const field of ["graphWidth", "contractHashes", "atomic"]) {
    const { report, identity } = fixture();
    const proof = createRestoringProof(report, identity);
    const current = profileIdentity(identity);
    delete proof.identity[field];
    delete current[field];
    assert.throws(() => validateRestoringTaskProof(proof, current), { code: "ERR_ASSERTION" });
  }
});

test("retained task authorization fully revalidates the old execution evidence", () => {
  for (const change of [
    (proof) => {
      proof.status = "failed";
    },
    (proof) => {
      proof.rounds.pop();
    },
    (proof) => {
      proof.rounds[0].attempts[0].integrityPassed = false;
    },
    (proof) => {
      proof.rounds[0].attempts.push({ ...proof.rounds[0].attempts[0], attempt: 2 });
    },
    (proof) => {
      proof.agentsClosed[1] = false;
    },
    (proof) => {
      proof.executions[1].receipts[0].lifetime = "participant-0";
    },
    (proof) => {
      proof.executions[2].receipts[0].lifetime = "replacement-participant";
    },
    (proof) => {
      proof.executions[1].receipts[0].events = proof.executions[1].receipts[0].events.map(
        (event) => ({ ...event, at: event.at + 100 }),
      );
    },
    (proof) => {
      proof.initialCheck.buildPassed = false;
    },
    (proof) => {
      proof.identity.sourceClean = false;
    },
    (proof) => {
      proof.executions[0].atomicIds = ["c"];
    },
    (proof) => {
      proof.identity = null;
    },
  ]) {
    const { report, identity } = fixture();
    const proof = createRestoringProof(report, identity);
    change(proof);
    assert.throws(() => validateRestoringTaskProof(proof, profileIdentity(identity)));
  }
});

test("task authorization requires an explicit complete and valid execution profile", () => {
  const { report, identity } = fixture();
  const proof = createRestoringProof(report, identity);
  assert.throws(() => validateRestoringTaskProof(proof, identity));
  for (const [mode, cap] of [
    ["unknown", 30],
    ["per-delivery", 0],
    ["per-delivery", -1],
    ["per-delivery", 1.5],
    ["per-delivery", Number.MAX_SAFE_INTEGER + 1],
    ["per-delivery", undefined],
    [undefined, 30],
  ]) {
    const current = profileIdentity(identity);
    current.agentLifecycle = mode;
    current.maxConcurrentAgents = cap;
    assert.throws(() => validateRestoringTaskProof(proof, current));
  }
});

test("execution profiles bind a worker cap independently of the task graph team", () => {
  const { identity } = fixture();
  const nodes = Array.from({ length: 40 }, (_, index) => ({
    id: `atom-${index}`,
    dependencies: [],
  }));
  const tree = { "main.cpp": "int main() {}\n" };
  const loaded = {
    manifest: {
      initial: identity.initial,
      final: treeIdentity(tree),
      workloadSha256: identity.workloadSha256,
      graphSha256: identity.graphSha256,
      tasks: 1,
      atomic: identity.atomic,
    },
    graph: { width: 2 },
    agents: 2,
    schedule: [{ id: "round-001" }],
    scheduleSha256: identity.scheduleSha256,
    contractHashes: identity.contractHashes,
    atomicIntervals: { rounds: new Map([["round-001", { nodes, expectedTree: tree }]]) },
    atomicWorkload: { nodes },
    plannedAtoms: [{ round: "round-001", totalAtoms: 40 }],
  };
  const source = Object.fromEntries(
    ["sourceCommit", "sourceClean", "verifierSha256", "runnerSha256"].map((key) => [
      key,
      identity[key],
    ]),
  );
  const options = { protocol: identity.protocol, policy: identity.policy, batchSize: 1 };
  const legacy = restoringRunIdentity(loaded, source, options);
  assert.equal(legacy.maxAssignedParticipants, 2);
  assert.equal(Object.hasOwn(legacy, "agentLifecycle"), false);
  assert.equal(Object.hasOwn(legacy, "maxConcurrentAgents"), false);
  const fresh = restoringRunIdentity(loaded, source, {
    ...options,
    agentLifecycle: "per-delivery",
    maxConcurrentAgents: 30,
  });
  assert.equal(fresh.agents, 2);
  assert.equal(fresh.agentLifecycle, "per-delivery");
  assert.equal(fresh.maxConcurrentAgents, 30);
  assert.equal(fresh.maxAssignedParticipants, 30);
  const persistent = restoringRunIdentity(loaded, source, {
    ...options,
    agentLifecycle: "persistent",
    maxConcurrentAgents: 1,
  });
  assert.equal(persistent.maxAssignedParticipants, 1);
  for (const profile of [
    { agentLifecycle: "per-delivery" },
    { maxConcurrentAgents: 30 },
    { agentLifecycle: "invalid", maxConcurrentAgents: 30 },
    { agentLifecycle: "per-delivery", maxConcurrentAgents: 0 },
  ])
    assert.throws(() => restoringRunIdentity(loaded, source, { ...options, ...profile }));
});

test("an unused participant adds no failed work or mandatory participation", () => {
  const { report, identity } = fixture();
  identity.maxAssignedParticipants = report.maxAssignedParticipants = 1;
  report.executions[1].agent = 0;
  report.executions[1].receipts[0].lifetime = "participant-0";
  const proof = createRestoringProof(report, identity);
  assert.equal(proof.referenceConcurrency.executors, 1);
  assert.equal(validateRestoringProof(proof, identity), true);
});
