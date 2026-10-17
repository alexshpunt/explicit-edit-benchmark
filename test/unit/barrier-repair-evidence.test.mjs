import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { tempDirectory } from "../helpers/temp.mjs";
import { exportNormalizedRun, normalizeTeamReport } from "../../scripts/normalized-run.mjs";
import {
  teamDeliveryDirectory,
  validateTeamTables,
} from "../../scripts/normalized-team-protocol.mjs";
import { validateNormalizedRun } from "../../scripts/validate-normalized-run.mjs";
import { aggregateExactConfigurations } from "../../scripts/result-aggregation.mjs";
import {
  multiAgentResult,
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const profile = {
  profileId: "custom",
  modelId: "example/model",
  harnessId: "custom",
  configurationHash: hash("configuration"),
  runId: "repair-run",
};
const receipt = {
  exitCode: 0,
  timedOut: false,
  eventErrors: 0,
  providerFailure: null,
  processSeconds: 1,
  toolCalls: 1,
  toolCallsObserved: true,
  modelRounds: 1,
  costUsd: 0.25,
  inputTokens: 8,
  outputTokens: 2,
  cacheReadTokens: 4,
  cacheWriteTokens: 0,
  totalTokens: 14,
};
function fixture() {
  let next = 1;
  const schedule = Array.from({ length: 28 }, (_, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: Array.from({ length: index > 0 && index <= 15 ? 3 : 2 }, (_, agent) => ({
      agent,
      task: `task-${String(next++).padStart(3, "0")}`,
    })),
  }));
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
    totalTasks: 71,
    totalRounds: 28,
    acceptedTasks: 2,
    acceptedRounds: 1,
    deliveries: 3,
    repairs: 1,
    checks: [
      { label: "initial", contractId: "initial", status: "pass" },
      { label: "round-001-attempt-1", contractId: "round-001", status: "fail", category: "build" },
      { label: "round-001-attempt-2", contractId: "round-001", status: "pass" },
    ],
    executions: [
      {
        round: "round-001",
        attempt: 1,
        agent: 12,
        tasks: ["task-001"],
        atomicId: "task-001-atom-001",
        status: "settled",
        receipt: { ...receipt },
      },
      {
        round: "round-001",
        attempt: 1,
        agent: 12,
        tasks: ["task-002"],
        atomicId: "task-002-atom-001",
        status: "settled",
        receipt: { ...receipt },
      },
      {
        round: "round-001",
        attempt: 2,
        agent: 14,
        tasks: ["task-002", "task-001"],
        deliveryKind: "barrier-repair",
        status: "settled",
        receipt: { ...receipt },
      },
    ],
    elapsedMs: 100,
    policy: { ...MULTI_AGENT_POLICY },
    terminal: { id: "round-002", category: "driver_exit" },
    usage: null,
  };
}
function suite(raw) {
  return {
    id: MULTI_AGENT_BENCHMARK,
    protocol: MULTI_AGENT_PROTOCOL,
    agents: 15,
    graphWidth: 15,
    workloadSha256: raw.workloadSha256,
    graphSha256: raw.graphSha256,
    scheduleSha256: raw.scheduleSha256,
    schedule: raw.schedule,
    observations: [
      {
        profileId: profile.profileId,
        status: raw.status,
        elapsedMs: raw.elapsedMs,
        terminalCategory: raw.status,
      },
    ],
  };
}
function validate(raw, projected) {
  validateTeamTables(suite(raw), [profile], projected.trials, projected.rounds);
}
async function jsonLines(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

await test("one global repair accepts retained atomic outputs with joint credit and once-only metrics", () => {
  const raw = fixture();
  const projected = normalizeTeamReport(raw, profile, raw.initial);
  validate(raw, projected);
  assert.deepEqual(
    projected.rounds.map((item) => item.deliveryKind),
    [undefined, undefined, "barrier-repair"],
  );
  assert.ok(!Object.hasOwn(projected.rounds[2], "atomicId"));
  assert.equal(projected.trials[0].firstExactPassed, false);
  assert.equal(projected.trials[0].finalExactPassed, true);
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.totalTokens, 0),
    42,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.costUsd, 0),
    0.75,
  );
  assert.equal(multiAgentResult(raw).progress.acceptedTasks, 2);
  const [aggregate] = aggregateExactConfigurations(
    {
      runs: [
        {
          runId: profile.runId,
          contract: MULTI_AGENT_PROTOCOL,
          suite: suite(raw),
          definitions: {
            benchmark: { id: MULTI_AGENT_BENCHMARK, version: "1" },
            taskSet: {
              taskIds: raw.schedule.flatMap((barrier) =>
                barrier.assignments.map((item) => item.task),
              ),
            },
          },
        },
      ],
    },
    [profile],
    projected.trials.map((item) => ({ ...item, runId: profile.runId })),
    projected.rounds.map((item) => ({ ...item, runId: profile.runId })),
  );
  assert.equal(aggregate.taskCount, 71);
  assert.equal(aggregate.score, 0.25 * (2 / 71));
  assert.equal(aggregate.recoveryRounds, 1);
});

await test("global repairs reject invalid kinds, atom IDs, budgets, parents, duplicate or mixed attempts", () => {
  for (const mutate of [
    (raw) => {
      raw.executions[2].deliveryKind = "atomic";
    },
    (raw) => {
      raw.executions[2].atomicId = "task-001-atom-001";
    },
    (raw) => {
      raw.executions[2].atomicId = undefined;
    },
    (raw) => {
      raw.executions[2].attempt = 1;
    },
    (raw) => {
      raw.executions[2].attempt = 7;
    },
    (raw) => {
      raw.executions[2].tasks = ["task-001"];
    },
    (raw) => {
      raw.executions[2].tasks = ["task-001", "task-001"];
    },
    (raw) => {
      raw.executions[2].tasks = ["task-001", "task-003"];
    },
    (raw) => {
      raw.executions[2].agent = 15;
    },
    (raw) => {
      raw.executions.push(structuredClone(raw.executions[2]));
      raw.deliveries++;
      raw.repairs++;
    },
    (raw) => {
      raw.executions.push({ ...raw.executions[0], attempt: 2 });
      raw.deliveries++;
      raw.repairs++;
    },
    (raw) => {
      raw.executions.splice(1, 1);
      raw.deliveries--;
    },
    (raw) => {
      raw.executions[0].status = "error";
    },
    (raw) => {
      raw.checks[1].status = "unknown";
    },
  ]) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => normalizeTeamReport(raw, profile, raw.initial));
    assert.throws(() => multiAgentResult(raw));
  }
  const raw = fixture();
  const projected = normalizeTeamReport(raw, profile, raw.initial);
  for (const mutate of [
    (rows) => {
      rows[2].deliveryKind = "unknown";
    },
    (rows) => {
      rows[2].atomicId = "task-001-atom-001";
    },
    (rows) => {
      rows[2].barrierAttempt = 0;
    },
    (rows) => {
      rows[2].taskIds = ["task-001"];
    },
    (rows) => {
      rows.push({ ...rows[2], roundId: "duplicate" });
    },
    (rows) => {
      rows.push({
        ...rows[0],
        barrierAttempt: 1,
        roundId: "mixed",
        exactPassed: true,
        difference: "pass",
      });
    },
  ]) {
    const copy = structuredClone(projected);
    mutate(copy.rounds);
    assert.throws(() => validate(raw, copy));
  }
});

await test("global repair cannot earn credit with native errors or continue after acceptance or a stopped barrier", () => {
  for (const mutate of [
    (raw) => {
      raw.executions[2].status = "error";
    },
    (raw) => {
      raw.executions[2].receipt.eventErrors = 1;
    },
    (raw) => {
      raw.executions[2].receipt.providerFailure = "unavailable";
    },
    (raw) => {
      raw.executions[2].receipt.exitCode = 1;
    },
    (raw) => {
      raw.executions[2].receipt.timedOut = true;
    },
    (raw) => {
      raw.executions.push({ ...raw.executions[2], attempt: 3 });
      raw.deliveries++;
      raw.repairs++;
    },
    (raw) => {
      raw.executions.push({
        ...raw.executions[0],
        round: "round-003",
        tasks: ["task-006"],
        atomicId: "task-006-atom-001",
      });
      raw.deliveries++;
    },
  ]) {
    const raw = fixture();
    mutate(raw);
    assert.throws(() => normalizeTeamReport(raw, profile, raw.initial));
    assert.throws(() => multiAgentResult(raw));
  }
});

await test("global repair exhaustion consumes the existing correction budget and native stops keep evidence", () => {
  const raw = fixture();
  raw.status = "blocked";
  raw.acceptedTasks = 0;
  raw.acceptedRounds = 0;
  raw.terminal = { id: "round-001", category: "blocked", failure: { category: "build" } };
  raw.executions = raw.executions.slice(0, 2);
  raw.checks = raw.checks.slice(0, 2);
  for (let attempt = 2; attempt <= 6; attempt++) {
    raw.executions.push({ ...fixture().executions[2], attempt });
    raw.checks.push({
      label: `round-001-attempt-${attempt}`,
      contractId: "round-001",
      status: "fail",
      category: "build",
    });
  }
  raw.deliveries = 7;
  raw.repairs = 5;
  const projected = normalizeTeamReport(raw, profile, raw.initial);
  validate(raw, projected);
  assert.equal(multiAgentResult(raw).execution.repairs, 5);
  for (const status of ["cancelled", "driver_exit", "provider_failure"]) {
    const stopped = fixture();
    stopped.status = status;
    stopped.acceptedTasks = 0;
    stopped.acceptedRounds = 0;
    stopped.checks.pop();
    stopped.terminal = { id: "round-001", category: status };
    stopped.executions[2].status = "error";
    stopped.executions[2].receipt = {
      ...receipt,
      exitCode: 1,
      eventErrors: 1,
      providerFailure: status === "provider_failure" ? "unavailable" : null,
    };
    const preserved = normalizeTeamReport(stopped, profile, stopped.initial);
    validate(stopped, preserved);
    assert.equal(preserved.rounds[2].eventErrors, 1);
    assert.equal(preserved.trials[0].finalExactPassed, false);
    assert.equal(multiAgentResult(stopped).status, status);
  }
});

await test("common export validates repair rows and reads immutable atomic and repair artifact directories once", async (t) => {
  const root = await tempDirectory("barrier-repair-export-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  await bundle(seed, "seed");
  const [configuration] = await jsonLines(path.join(seed, "configurations.jsonl"));
  const [seedProfile] = await jsonLines(path.join(seed, "profiles.jsonl"));
  const raw = fixture();
  const directory = path.join(root, "raw");
  const team = path.join(directory, "teams/custom");
  await mkdir(team, { recursive: true });
  const { observations: _observations, schedule: _schedule, ...identity } = suite(raw);
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      contract: MULTI_AGENT_PROTOCOL,
      suite: identity,
      harnesses: {
        custom: {
          ...seedProfile,
          kind: "custom",
          version: "1",
          configurationId: configuration.configurationId,
          configuration: Object.fromEntries(
            ["tools", "extensions", "rules", "runtimeFlags", "environment"].map((field) => [
              field,
              configuration[field],
            ]),
          ),
        },
      },
      oracleRecoveries: 5,
      retryFailures: 0,
      concurrency: 15,
      timeoutMs: null,
      verifierSha256: hash("verifier"),
      tasks: raw.schedule.flatMap((barrier) =>
        barrier.assignments.map((item) => ({ id: item.task, fixtureSha256: raw.initial })),
      ),
    }),
  );
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify({ results: [{ profile: "custom", acceptedTasks: 2 }] }),
  );
  await writeFile(path.join(team, "report.json"), JSON.stringify(raw));
  const originals = new Map();
  for (const execution of raw.executions) {
    const delivery = path.join(
      team,
      "deliveries",
      `agent-${execution.agent}`,
      teamDeliveryDirectory(execution.round, execution.attempt, execution.atomicId),
    );
    await mkdir(delivery, { recursive: true });
    const file = path.join(delivery, "tool-calls.json");
    const content = JSON.stringify([
      { type: "tool_execution_start", toolName: "bash", args: { command: "cat source.cpp" } },
    ]);
    await writeFile(file, content);
    originals.set(file, hash(content));
  }
  assert.ok([...originals.keys()].some((file) => file.includes("round-001-attempt-2")));
  assert.ok(
    [...originals.keys()].some((file) => file.includes("round-001-task-001-atom-001-attempt-1")),
  );
  const output = path.join(root, "normalized");
  await exportNormalizedRun(directory, output);
  await validateNormalizedRun(output);
  const rows = await jsonLines(path.join(output, "rounds.jsonl"));
  const calls = await jsonLines(path.join(output, "tool-calls.jsonl"));
  assert.equal(rows[2].deliveryKind, "barrier-repair");
  assert.ok(!Object.hasOwn(rows[2], "atomicId"));
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((item) => item.roundId)).size, 3);
  for (const [file, digest] of originals) assert.equal(hash(await readFile(file)), digest);
});
