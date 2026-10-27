import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { treeIdentity } from "../../src/suites/explicit-edit-multi-agent/generation/generator.mjs";
import {
  RESTORING_RUN_VERSION,
  restoringRunIdentity,
  createRestoringProof,
  validateRestoringProof,
} from "../../src/suites/explicit-edit-multi-agent/execution/restoring-proof.mjs";

const hash = (text) => createHash("sha256").update(text).digest("hex");
function fixture() {
  const initial = hash("initial"),
    final = hash("final");
  const identity = {
    protocol: "fixture-restoring-method",
    policy: { buildWeight: 2, resultWeight: 4 },
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

test("an unused participant adds no failed work or mandatory participation", () => {
  const { report, identity } = fixture();
  identity.maxAssignedParticipants = report.maxAssignedParticipants = 1;
  report.executions[1].agent = 0;
  report.executions[1].receipts[0].lifetime = "participant-0";
  const proof = createRestoringProof(report, identity);
  assert.equal(proof.referenceConcurrency.executors, 1);
  assert.equal(validateRestoringProof(proof, identity), true);
});
