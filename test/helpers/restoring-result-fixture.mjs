import { createHash } from "node:crypto";
import { MULTI_AGENT_BENCHMARK } from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import {
  RESTORING_MULTI_AGENT_PROTOCOL,
  RESTORING_MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = "a".repeat(64);
export function restoringFixture() {
  const schedule = [
    {
      id: "round-001",
      assignments: [
        { task: "task-001", agent: 0 },
        { task: "task-002", agent: 1 },
      ],
    },
    { id: "round-002", assignments: [{ task: "task-003", agent: 0 }] },
  ];
  const attempts = Array.from({ length: 6 }, (_, index) => ({
    attempt: index + 1,
    passedAtoms: index === 5 ? 1 : 0,
    totalAtoms: 2,
    buildPassed: false,
    resultMatched: false,
    integrityPassed: true,
  }));
  const delivery = (round, attempt, agent, atom, tasks, repair = false) => ({
    round,
    attempt,
    agent,
    atomicId: atom,
    atomicIds: repair ? [] : [atom],
    tasks,
    ...(repair ? { deliveryKind: "barrier-repair", repairIds: [atom] } : {}),
    status: "settled",
    receipt: { exitCode: 0, toolCalls: 0, toolCallsObserved: true, modelRounds: 1, eventErrors: 0 },
  });
  const executions = [
    delivery("round-001", 1, 0, "task-001-a", ["task-001"]),
    delivery("round-001", 1, 1, "task-002-a", ["task-002"]),
    ...Array.from({ length: 5 }, (_, index) =>
      delivery("round-001", index + 2, index % 2, `repair-round-001-${index + 1}`, [], true),
    ),
    delivery("round-002", 1, 0, "task-003-a", ["task-003"]),
  ];
  return {
    version: "renderer-concurrent-restoring-run-v2",
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: RESTORING_MULTI_AGENT_PROTOCOL,
    mode: "measured",
    status: "complete",
    policy: { ...RESTORING_MULTI_AGENT_POLICY, buildWeight: 2, resultWeight: 4 },
    agents: 2,
    batchSize: 1,
    graphWidth: 15,
    model: "example/model",
    thinking: "high",
    harness: "baseline-agent",
    runtime: { agent: "pi", version: "1.3.0", platform: "linux", architecture: "x64" },
    workloadSha256: sha,
    graphSha256: sha,
    scheduleSha256: hash(schedule),
    initial: sha,
    expectedFinal: sha,
    final: sha,
    verifierSha256: sha,
    runnerSha256: sha,
    contractHashes: { initial: sha, "round-001": sha, "round-002": sha },
    schedule,
    totalTasks: 3,
    totalRounds: 2,
    totalAtoms: 3,
    roundEndpoints: schedule.map(({ id }) => ({ round: id, identity: sha })),
    roundInventories: schedule.map(({ id }) => ({
      round: id,
      sha256: hash(
        executions
          .filter((item) => item.round === id && item.attempt === 1)
          .flatMap((item) => item.atomicIds)
          .sort(),
      ),
    })),
    plannedAtoms: [
      { round: "round-001", totalAtoms: 2 },
      { round: "round-002", totalAtoms: 1 },
    ],
    rounds: [
      {
        round: "round-001",
        attempts,
        firstAttempt: 1,
        finalAttempt: 6,
        restoration: { status: "pass", identity: sha },
      },
      {
        round: "round-002",
        attempts: [
          {
            attempt: 1,
            passedAtoms: 1,
            totalAtoms: 1,
            buildPassed: true,
            resultMatched: true,
            integrityPassed: true,
          },
        ],
        firstAttempt: 1,
        finalAttempt: 1,
        restoration: { status: "pass", identity: sha },
      },
    ],
    executions,
    deliveries: executions.length,
    repairs: 5,
    agentsClosed: [true, true],
    elapsedMs: 100,
    usage: null,
    terminal: null,
  };
}
