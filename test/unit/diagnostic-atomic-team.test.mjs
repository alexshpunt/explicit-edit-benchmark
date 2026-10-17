import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  multiAgentResult,
  validateMultiAgentResult,
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_POLICY,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { normalizeTeamReport } from "../../scripts/normalized-run.mjs";
import { aggregateExactConfigurations } from "../../scripts/result-aggregation.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function fixture() {
  let next = 1;
  const schedule = Array.from({ length: 28 }, (_, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: Array.from({ length: index > 0 && index <= 15 ? 3 : 2 }, (_, agent) => ({
      agent,
      task: `task-${String(next++).padStart(3, "0")}`,
    })),
  }));
  assert.equal(next, 72);
  const delivery = (task, atom, agent, attempt) => ({
    round: "round-001",
    attempt,
    agent,
    tasks: [task],
    atomicId: `${task}-atom-${atom}`,
    status: "settled",
    receipt: { exitCode: 0, eventErrors: 0, timedOut: false, providerFailure: null, costUsd: 0.25 },
  });
  return {
    version: "renderer-concurrent-run-v1",
    benchmark: MULTI_AGENT_BENCHMARK,
    protocol: MULTI_AGENT_PROTOCOL,
    mode: "scripted",
    status: "driver_exit",
    agents: 15,
    graphWidth: 15,
    workloadSha256: hash("workload"),
    graphSha256: hash("graph"),
    scheduleSha256: hash(JSON.stringify(schedule)),
    initial: hash("initial"),
    contractHashes: Object.fromEntries(
      ["initial", ...schedule.map((item) => item.id)].map((id) => [id, hash(id)]),
    ),
    schedule,
    totalRounds: 28,
    totalTasks: 71,
    acceptedRounds: 1,
    acceptedTasks: 2,
    deliveries: 4,
    repairs: 1,
    checks: [
      { label: "initial", contractId: "initial", status: "pass" },
      {
        label: "round-001-attempt-1",
        contractId: "round-001",
        status: "fail",
        category: "structure",
      },
      { label: "round-001-attempt-2", contractId: "round-001", status: "pass" },
    ],
    executions: [
      delivery("task-001", "001", 12, 1),
      delivery("task-001", "002", 12, 1),
      delivery("task-002", "001", 4, 1),
      delivery("task-002", "001", 14, 2),
    ],
    elapsedMs: 100,
    policy: { ...MULTI_AGENT_POLICY },
    terminal: { category: "driver_exit", message: "PRIVATE_SECRET" },
    usage: null,
  };
}

await test("diagnostic atomic export accepts repeated agents and retained completion without per-atom credit", () => {
  const raw = fixture();
  const original = structuredClone(raw);
  const result = multiAgentResult(raw);
  assert.deepEqual(raw, original);
  validateMultiAgentResult(result);
  assert.equal(result.progress.acceptedTasks, 2);
  assert.equal(result.progress.totalTasks, 71);
  assert.equal(result.progress.completion, 2 / 71);
  assert.equal(result.execution.deliveries, 4);
  assert.equal(result.execution.repairs, 1);
  assert.equal(result.usage, null);
  assert.ok(!JSON.stringify(result).includes("atomicId"));
  assert.ok(!JSON.stringify(result).includes("PRIVATE_SECRET"));
});

await test("diagnostic atomic validation rejects duplicates, missing IDs, wrong parents and agents outside the pool", () => {
  for (const mutate of [
    (raw) => {
      raw.executions[1] = { ...raw.executions[0], agent: 13 };
    },
    (raw) => {
      delete raw.executions[1].atomicId;
    },
    (raw) => {
      raw.executions[1].atomicId = "task-002-atom-001";
    },
    (raw) => {
      raw.executions[1].atomicId = "task-001-../../private";
    },
    (raw) => {
      raw.executions[1].tasks = ["task-003"];
    },
    (raw) => {
      raw.executions[1].tasks.push("task-002");
    },
    (raw) => {
      raw.executions[1].agent = 15;
    },
    (raw) => {
      raw.executions[1].agent = -1;
    },
    (raw) => {
      raw.executions[1].agent = 1.5;
    },
    (raw) => {
      raw.executions[1].status = "unknown";
    },
  ]) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => multiAgentResult(raw));
  }
});

await test("native errors and an absent settled opportunity cannot earn a passing atomic barrier", () => {
  for (const mutate of [
    (raw) => {
      raw.executions.at(-1).status = "error";
    },
    (raw) => {
      raw.executions[0].status = "error";
    },
    (raw) => {
      raw.executions.at(-1).receipt.eventErrors = 1;
    },
    (raw) => {
      raw.executions[0].receipt.eventErrors = 1;
    },
    (raw) => {
      raw.executions.at(-1).receipt.exitCode = 1;
    },
    (raw) => {
      raw.executions.at(-1).receipt.providerFailure = "unavailable";
    },
    (raw) => {
      raw.executions.at(-1).receipt.timedOut = true;
    },
    (raw) => {
      raw.executions.pop();
      raw.deliveries--;
      raw.repairs--;
    },
    (raw) => {
      raw.executions.at(-1).attempt = 3;
    },
  ]) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => multiAgentResult(raw));
  }
});

await test("accepted prefix cannot include atomic work after acceptance or beyond the first stopped barrier", () => {
  for (const round of ["round-001", "round-003"]) {
    const raw = fixture();
    raw.executions.push({ ...raw.executions.at(-1), round, attempt: 3 });
    raw.deliveries++;
    raw.repairs++;
    assert.throws(() => multiAgentResult(raw));
  }
});

await test("atomic failure exhaustion uses six barrier attempts while infrastructure stops retain truthful prefix", () => {
  const raw = fixture();
  raw.status = "blocked";
  raw.terminal = { id: "round-002", category: "blocked", failure: { category: "structure" } };
  for (let attempt = 1; attempt <= 6; attempt++) {
    raw.checks.push({
      label: `round-002-attempt-${attempt}`,
      contractId: "round-002",
      status: "fail",
      category: "structure",
    });
    raw.executions.push({
      round: "round-002",
      attempt,
      agent: 10,
      tasks: ["task-003"],
      atomicId: "task-003-atom-001",
      status: "settled",
      receipt: { exitCode: 0 },
    });
  }
  raw.deliveries = raw.executions.length;
  raw.repairs = raw.executions.filter((item) => item.attempt > 1).length;
  assert.equal(multiAgentResult(raw).progress.acceptedTasks, 2);
  raw.checks.pop();
  assert.throws(() => multiAgentResult(raw));
  for (const status of ["provider_failure", "driver_exit", "cancelled"]) {
    const stopped = fixture();
    stopped.status = status;
    stopped.terminal = { id: "round-002", category: status, message: "PRIVATE_SECRET" };
    stopped.executions.push({
      round: "round-002",
      attempt: 1,
      agent: 12,
      tasks: ["task-003"],
      atomicId: "task-003-atom-001",
      status: "error",
      receipt: {
        exitCode: null,
        eventErrors: 1,
        providerFailure: status === "provider_failure" ? "unavailable" : null,
      },
    });
    stopped.deliveries++;
    const result = multiAgentResult(stopped);
    assert.equal(result.status, status);
    assert.equal(result.progress.acceptedTasks, 2);
    assert.equal(result.terminal.failureCategory, null);
  }
});

await test("shared Score denominator remains 71 original tasks rather than atomic delivery count", () => {
  const raw = fixture();
  const diagnostic = multiAgentResult(raw);
  const profile = {
    profileId: "custom",
    modelId: "example/model",
    harnessId: "custom",
    configurationHash: hash("configuration"),
    runId: "atomic-run",
  };
  const normalized = normalizeTeamReport(raw, profile, raw.initial);
  const [aggregate] = aggregateExactConfigurations(
    {
      runs: [
        {
          runId: "atomic-run",
          contract: MULTI_AGENT_PROTOCOL,
          suite: {
            id: MULTI_AGENT_BENCHMARK,
            protocol: MULTI_AGENT_PROTOCOL,
            observations: [
              { profileId: profile.profileId, status: raw.status, elapsedMs: raw.elapsedMs },
            ],
          },
          definitions: {
            benchmark: { id: MULTI_AGENT_BENCHMARK, version: "1" },
            taskSet: {
              taskIds: raw.schedule.flatMap((round) => round.assignments.map((item) => item.task)),
            },
          },
        },
      ],
    },
    [profile],
    normalized.trials.map((trial) => ({ ...trial, runId: profile.runId })),
    normalized.rounds.map((round) => ({ ...round, runId: profile.runId })),
  );
  assert.equal(aggregate.taskCount, 71);
  assert.equal(aggregate.finalExactPasses, diagnostic.progress.acceptedTasks);
  assert.equal(aggregate.firstExactPasses, 0);
  assert.equal(aggregate.score, 0.25 * (2 / 71));
});
