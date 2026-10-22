import assert from "node:assert/strict";
import { test } from "node:test";
import { exportNormalizedRun, normalizeTeamReport } from "../../scripts/normalized-run.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tempDirectory } from "../helpers/temp.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { validateTeamTables } from "../../scripts/normalized-team-protocol.mjs";
import { validateNormalizedRun } from "../../scripts/validate-normalized-run.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

const profile = { profileId: "profile", modelId: "model", harnessId: "harness" };
const receipt = {
  exitCode: 0,
  timedOut: false,
  processSeconds: 2,
  toolCalls: 1,
  modelRounds: 1,
  eventErrors: 0,
  costUsd: 0.25,
  inputTokens: 8,
  outputTokens: 2,
  cacheReadTokens: 4,
  cacheWriteTokens: 0,
  totalTokens: 14,
};
async function jsonLines(file) {
  return (await readFile(file, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
function fixture() {
  const delivery = (task, atom, agent, attempt) => ({
    round: "round-001",
    tasks: [task],
    atomicId: `${task}-atom-${atom}`,
    agent,
    attempt,
    status: "settled",
    receipt: { ...receipt },
  });
  return {
    agents: 15,
    status: "driver_exit",
    totalTasks: 3,
    acceptedTasks: 2,
    totalRounds: 2,
    acceptedRounds: 1,
    schedule: [
      {
        id: "round-001",
        assignments: [
          { task: "task-001", agent: 0 },
          { task: "task-002", agent: 1 },
        ],
      },
      { id: "round-002", assignments: [{ task: "task-003", agent: 0 }] },
    ],
    checks: [
      { label: "round-001-attempt-1", status: "fail", category: "structure" },
      { label: "round-001-attempt-2", status: "pass" },
    ],
    executions: [
      delivery("task-001", "001", 12, 1),
      delivery("task-001", "002", 12, 1),
      delivery("task-002", "001", 4, 1),
      delivery("task-002", "001", 4, 2),
    ],
  };
}
function validate(report, projected) {
  validateTeamTables(
    {
      protocol: MULTI_AGENT_PROTOCOL,
      agents: report.agents,
      schedule: report.schedule,
      observations: [{ profileId: profile.profileId, status: report.status }],
    },
    [profile],
    projected.trials,
    projected.rounds,
  );
}

await test("atomic dispatch preserves actual order, repeated participants and retained completion across repair", () => {
  const report = fixture();
  const projected = normalizeTeamReport(report, profile, "fixture");
  validate(report, projected);
  assert.deepEqual(
    projected.rounds.map((item) => item.agent),
    [12, 12, 4, 4],
  );
  assert.deepEqual(
    projected.rounds.map((item) => item.atomicId),
    report.executions.map((item) => item.atomicId),
  );
  assert.deepEqual(
    projected.rounds.map((item) => item.barrierAttempt),
    [0, 0, 0, 1],
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.totalTokens, 0),
    56,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.costUsd, 0),
    1,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.toolCallCount, 0),
    4,
  );
  assert.equal(projected.trials[0].firstExactPassed, false);
  assert.equal(projected.trials[0].finalExactPassed, true);
  assert.deepEqual(projected.trials[0].taskIds, ["task-001", "task-002"]);
  assert.equal(projected.trials[1].infrastructureFailure, "not-reached");
});

await test("normalized reports reject a correction moved to a different participant", () => {
  const report = fixture();
  const projected = normalizeTeamReport(report, profile, "fixture");
  report.executions[3].agent = 14;
  assert.throws(
    () => normalizeTeamReport(report, profile, "fixture"),
    /Repair changed task executor/,
  );
  projected.rounds[3].agent = 14;
  assert.throws(() => validate(fixture(), projected), /Repair changed task executor/);
});
await test("a cross-parent batch keeps one native receipt and independent retained atom identities", () => {
  const report = fixture();
  const first = report.executions[0];
  first.tasks = ["task-001", "task-002"];
  first.atomicIds = report.executions.slice(0, 3).map((item) => item.atomicId);
  report.executions = [first, { ...report.executions[3], agent: first.agent }];
  const projected = normalizeTeamReport(report, profile, "fixture");
  validate(report, projected);
  assert.equal(projected.rounds.length, 2);
  assert.deepEqual(projected.rounds[0].atomicIds, first.atomicIds);
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.totalTokens, 0),
    28,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.costUsd, 0),
    0.5,
  );
  assert.equal(projected.trials[0].firstExactPassed, false);
  assert.equal(projected.trials[0].finalExactPassed, true);
  const duplicate = structuredClone(report);
  duplicate.executions.splice(1, 0, { ...report.executions[1], attempt: 1, agent: 3 });
  assert.throws(() => normalizeTeamReport(duplicate, profile, "fixture"));
});

await test("fifty atomic members retain one native usage receipt and unchanged group credit", () => {
  const report = fixture();
  const first = report.executions[0];
  first.atomicIds = Array.from(
    { length: 50 },
    (_, i) => `task-001-atom-${String(i + 1).padStart(3, "0")}`,
  );
  report.executions = [first, ...report.executions.slice(2)];
  const projected = normalizeTeamReport(report, profile, "fixture");
  validate(report, projected);
  assert.equal(projected.rounds.length, 3);
  assert.deepEqual(projected.rounds[0].atomicIds, first.atomicIds);
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.totalTokens, 0),
    42,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.costUsd, 0),
    0.75,
  );
  assert.equal(
    projected.rounds.reduce((sum, item) => sum + item.toolCallCount, 0),
    3,
  );
  assert.equal(projected.trials[0].firstExactPassed, false);
  assert.equal(projected.trials[0].finalExactPassed, true);
});
await test("batch membership rejects oversize, duplicates, foreign parents and a false representative", () => {
  for (const atomicIds of [
    null,
    [],
    ["task-001-atom-001", "task-001-atom-001"],
    ["task-001-atom-001", "task-003-atom-001"],
    ["task-001-atom-002"],
    Array.from({ length: 51 }, (_, i) => `task-001-atom-${String(i + 1).padStart(3, "0")}`),
  ]) {
    const report = fixture();
    report.executions[0].atomicIds = atomicIds;
    assert.throws(() => normalizeTeamReport(report, profile, "fixture"));
  }
});
await test("atomic IDs, parents, pool membership and within-attempt uniqueness fail closed", () => {
  const invalid = [
    (report) => {
      delete report.executions[1].atomicId;
    },
    (report) => {
      report.executions[1].atomicId = "";
    },
    (report) => {
      report.executions[1].atomicId = "task-002-atom-001";
    },
    (report) => {
      report.executions[1].atomicId = "task-001-../../secret";
    },
    (report) => {
      report.executions[1] = { ...report.executions[0], agent: 13 };
    },
    (report) => {
      report.executions[1].tasks = ["task-003"];
    },
    (report) => {
      report.executions[1].tasks.push("task-002");
    },
    (report) => {
      report.executions[1].agent = 15;
    },
    (report) => {
      report.executions[1].attempt = 7;
    },
  ];
  for (const mutate of invalid) {
    const report = fixture();
    mutate(report);
    assert.throws(() => normalizeTeamReport(report, profile, "fixture"));
  }
  const projected = normalizeTeamReport(fixture(), profile, "fixture");
  for (const mutate of [
    (rounds) => {
      delete rounds[1].atomicId;
    },
    (rounds) => {
      rounds[1].atomicId = rounds[0].atomicId;
    },
    (rounds) => {
      rounds[1].taskIds = ["task-003"];
    },
    (rounds) => {
      rounds[1].agent = 15;
    },
  ]) {
    const copy = structuredClone(projected);
    mutate(copy.rounds);
    assert.throws(() => validate(fixture(), copy));
  }
});

await test("failed atomic receipts remain native evidence without awarding joint credit", () => {
  const report = fixture();
  report.executions = report.executions.slice(0, 2);
  report.executions[1].status = "error";
  report.executions[1].receipt = {
    ...receipt,
    exitCode: null,
    eventErrors: 1,
    totalTokens: null,
    costUsd: null,
    providerFailure: "unavailable",
  };
  report.checks = [];
  report.acceptedTasks = 0;
  report.acceptedRounds = 0;
  report.status = "provider_failure";
  const projected = normalizeTeamReport(report, profile, "fixture");
  validate(report, projected);
  assert.equal(projected.rounds.length, 2);
  assert.equal(projected.rounds[1].providerFailure, "unavailable");
  assert.equal(projected.rounds[1].eventErrors, 1);
  assert.equal(projected.rounds[1].totalTokens, null);
  assert.equal(projected.rounds[1].inputTokens, null);
  assert.equal(projected.trials[0].finalExactPassed, false);
  report.checks = [{ label: "round-001-attempt-1", status: "pass" }];
  report.acceptedTasks = 2;
  report.acceptedRounds = 1;
  assert.throws(() => normalizeTeamReport(report, profile, "fixture"));
});

await test("atomic correction exhaustion stays at six joint attempts without per-atom score", () => {
  const report = fixture();
  report.status = "blocked";
  report.acceptedTasks = 0;
  report.acceptedRounds = 0;
  report.checks = [];
  report.executions = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    report.checks.push({
      label: `round-001-attempt-${attempt}`,
      status: "fail",
      category: "structure",
    });
    report.executions.push({
      round: "round-001",
      tasks: ["task-001"],
      atomicId: "task-001-atom-001",
      agent: 1,
      attempt,
      status: "settled",
      receipt,
    });
  }
  const projected = normalizeTeamReport(report, profile, "fixture");
  validate(report, projected);
  assert.equal(projected.rounds.length, 6);
  assert.equal(projected.trials.filter((trial) => trial.finalExactPassed).length, 0);
  projected.rounds.pop();
  assert.throws(() => validate(report, projected));
});

for (const batched of [false, true])
  await test(`the common exporter reads each ${batched ? "batch" : "atom"} native file exactly once`, async (t) => {
    const root = await tempDirectory("normalized-atomic-export-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const seed = path.join(root, "seed");
    await bundle(seed, "seed");
    const [configuration] = await jsonLines(path.join(seed, "configurations.jsonl"));
    const [seedProfile] = await jsonLines(path.join(seed, "profiles.jsonl"));
    const raw = path.join(root, "raw");
    await mkdir(raw);
    const report = fixture();
    if (batched) {
      const first = report.executions[0];
      first.atomicIds = report.executions.slice(0, 3).map((item) => item.atomicId);
      first.tasks = ["task-001", "task-002"];
      report.executions = [first, { ...report.executions[3], agent: first.agent }];
    }
    report.totalTasks = 71;
    report.totalRounds = 28;
    report.elapsedMs = 100;
    report.initial = "d".repeat(64);
    report.terminal = { category: "driver_exit" };
    let next = 4;
    for (let index = 0; index < 26; index++)
      report.schedule.push({
        id: `round-${String(index + 3).padStart(3, "0")}`,
        assignments: Array.from({ length: index < 16 ? 3 : 2 }, () => ({
          agent: 0,
          task: `task-${String(next++).padStart(3, "0")}`,
        })),
      });
    assert.equal(next, 72);
    const suite = {
      id: MULTI_AGENT_BENCHMARK,
      protocol: MULTI_AGENT_PROTOCOL,
      agents: 15,
      graphWidth: 15,
      workloadSha256: "b".repeat(64),
      graphSha256: "c".repeat(64),
      scheduleSha256: createHash("sha256").update(JSON.stringify(report.schedule)).digest("hex"),
    };
    Object.assign(report, suite);
    await writeFile(
      path.join(raw, "manifest.json"),
      JSON.stringify({
        contract: MULTI_AGENT_PROTOCOL,
        suite,
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
        verifierSha256: "e".repeat(64),
        tasks: report.schedule.flatMap((barrier) =>
          barrier.assignments.map((item) => ({ id: item.task, fixtureSha256: report.initial })),
        ),
      }),
    );
    await writeFile(
      path.join(raw, "summary.json"),
      JSON.stringify({ results: [{ profile: "custom", acceptedTasks: 2 }] }),
    );
    const directory = path.join(raw, "teams/custom");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report));
    for (const item of report.executions) {
      const delivery = path.join(
        directory,
        "deliveries",
        `agent-${item.agent}`,
        `${item.round}-${item.atomicId}-attempt-${item.attempt}`,
      );
      await mkdir(delivery, { recursive: true });
      await writeFile(
        path.join(delivery, "tool-calls.json"),
        JSON.stringify([
          { type: "tool_execution_start", toolName: "bash", args: { command: "cat source.cpp" } },
        ]),
      );
    }
    const output = path.join(root, "normalized");
    await exportNormalizedRun(raw, output, { runId: "atomic-export" });
    await validateNormalizedRun(output);
    const rounds = await jsonLines(path.join(output, "rounds.jsonl"));
    const calls = await jsonLines(path.join(output, "tool-calls.jsonl"));
    assert.deepEqual(
      rounds.map((item) => item.atomicId),
      report.executions.map((item) => item.atomicId),
    );
    assert.ok(rounds.every((item) => item.toolCallsObserved));
    assert.equal(calls.length, report.executions.length);
    assert.equal(new Set(calls.map((item) => item.roundId)).size, report.executions.length);
    assert.equal(
      rounds.reduce((sum, item) => sum + item.totalTokens, 0),
      14 * report.executions.length,
    );
  });
