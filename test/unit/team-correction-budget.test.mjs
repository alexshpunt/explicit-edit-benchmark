import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tempDirectory } from "../helpers/temp.mjs";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import test from "node:test";
import { validateOfficialPolicy } from "../../scripts/official-policy.mjs";
import { validateTeamSuite, validateTeamTables } from "../../scripts/normalized-team-protocol.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

function evidence(attemptCount, accepted, protocol = MULTI_AGENT_PROTOCOL) {
  const schedule = [
    { id: "round-001", assignments: [{ task: "task-001", agent: 0 }] },
    {
      id: "round-002",
      assignments: [
        { task: "task-002", agent: 0 },
        { task: "task-003", agent: 1 },
      ],
    },
    ...(accepted ? [] : [{ id: "round-003", assignments: [{ task: "task-004", agent: 1 }] }]),
  ];
  const suite = {
    protocol,
    schedule,
    observations: [
      {
        profileId: "team",
        status: accepted ? "pass" : "blocked",
        elapsedMs: 12,
        terminalCategory: accepted ? null : "blocked",
      },
    ],
  };
  const trials = schedule.map((barrier, index) => ({
    profileId: "team",
    trialId: barrier.id,
    taskId: barrier.id,
    taskIds: barrier.assignments.map((assignment) => assignment.task),
    firstExactPassed: index === 0,
    finalExactPassed: index === 0 || (index === 1 && accepted),
  }));
  const rounds = [
    {
      trialId: "round-001",
      barrierAttempt: 0,
      agent: 0,
      taskIds: ["task-001"],
      exactPassed: true,
      difference: null,
    },
    ...Array.from({ length: attemptCount }, (_, barrierAttempt) =>
      schedule[1].assignments.map(({ agent, task }) => ({
        trialId: "round-002",
        barrierAttempt,
        agent,
        taskIds: [task],
        exactPassed: accepted && barrierAttempt === attemptCount - 1,
        difference: accepted && barrierAttempt === attemptCount - 1 ? null : "other",
      })),
    ).flat(),
  ];
  return { suite, profiles: [{ profileId: "team" }], trials, rounds };
}

function validateEvidence(value) {
  validateTeamTables(value.suite, value.profiles, value.trials, value.rounds);
}

function fullSuite() {
  let task = 0;
  const schedule = Array.from({ length: 28 }, (_, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: Array.from({ length: index < 15 ? 3 : 2 }, (_, slot) => ({
      task: `task-${String(++task).padStart(3, "0")}`,
      agent: (index + slot) % 15,
    })),
  }));
  return {
    id: MULTI_AGENT_BENCHMARK,
    protocol: MULTI_AGENT_PROTOCOL,
    agents: 15,
    graphWidth: 15,
    workloadSha256: "a".repeat(64),
    graphSha256: "b".repeat(64),
    scheduleSha256: createHash("sha256").update(JSON.stringify(schedule)).digest("hex"),
    schedule,
    observations: [],
  };
}

await test("a joint sixth-attempt success is admissible without changing first-pass credit", () => {
  const value = evidence(6, true);
  validateEvidence(value);
  assert.equal(value.trials[1].firstExactPassed, false);
  assert.equal(value.trials[1].finalExactPassed, true);
  assert.equal(value.rounds.filter((round) => round.trialId === "round-002").length, 12);
});

await test("an editing block exhausts five corrections and preserves an unreached suffix", () => {
  const value = evidence(6, false);
  validateEvidence(value);
  assert.equal(value.trials[0].finalExactPassed, true);
  assert.equal(value.trials[1].finalExactPassed, false);
  assert.equal(value.trials[2].finalExactPassed, false);
  assert.ok(value.rounds.every((round) => round.trialId !== "round-003"));
});

await test("an editing block after three or four corrections is premature", () => {
  for (const attemptCount of [4, 5])
    assert.throws(() => validateEvidence(evidence(attemptCount, false)), /exhaust/i);
});

await test("a seventh delivery or a missing sixth-attempt peer cannot earn joint credit", () => {
  assert.throws(() => validateEvidence(evidence(7, true)));
  const incomplete = evidence(6, true);
  incomplete.rounds.pop();
  assert.throws(() => validateEvidence(incomplete), /Incomplete jointly graded barrier/);
});

await test("public maximal-team evidence uses five corrections without deadlines or restarts", () => {
  const policy = {
    oracleRecoveries: 5,
    retryFailures: 0,
    concurrency: 15,
    timeoutMs: null,
  };
  const suite = fullSuite();
  validateTeamSuite(suite, MULTI_AGENT_PROTOCOL, policy);
  for (const changed of [
    { oracleRecoveries: 3 },
    { oracleRecoveries: 6 },
    { retryFailures: 1 },
    { concurrency: 14 },
    { timeoutMs: 120_000 },
  ])
    assert.throws(() => validateTeamSuite(suite, MULTI_AGENT_PROTOCOL, { ...policy, ...changed }));
});

await test("historical schema-3 evidence keeps its exact four-attempt exhaustion boundary", () => {
  const value = evidence(4, false, "shared-project-rotating-v1");
  const suite = fullSuite();
  suite.protocol = value.suite.protocol;
  suite.observations = value.suite.observations;
  const trials = suite.schedule.map((barrier, index) => ({
    profileId: "team",
    trialId: barrier.id,
    taskId: barrier.id,
    taskIds: barrier.assignments.map((assignment) => assignment.task),
    firstExactPassed: index === 0,
    finalExactPassed: index === 0,
  }));
  const rounds = suite.schedule.slice(0, 2).flatMap((barrier, index) =>
    Array.from({ length: index === 0 ? 1 : 4 }, (_, barrierAttempt) =>
      barrier.assignments.map(({ task, agent }) => ({
        trialId: barrier.id,
        barrierAttempt,
        agent,
        taskIds: [task],
        exactPassed: index === 0,
        difference: index === 0 ? null : "other",
      })),
    ).flat(),
  );
  const policy = { oracleRecoveries: 3, retryFailures: 0, concurrency: 15, timeoutMs: null };
  validateTeamSuite(suite, suite.protocol, policy);
  validateTeamTables(suite, value.profiles, trials, rounds);
  assert.throws(() => validateTeamSuite(suite, suite.protocol, { ...policy, oracleRecoveries: 5 }));
  const modern = { ...suite, protocol: MULTI_AGENT_PROTOCOL };
  assert.throws(() => validateTeamSuite(modern, modern.protocol, policy));
  validateTeamSuite(modern, modern.protocol, { ...policy, oracleRecoveries: 5 });
  assert.throws(() => validateTeamTables(modern, value.profiles, trials, rounds), /exhaust/);
  assert.throws(() => validateEvidence(evidence(5, false, "shared-project-rotating-v1")));
});

await test("unknown or mismatched team protocols cannot borrow a recognized correction budget", () => {
  const suite = fullSuite();
  const policy = { oracleRecoveries: 5, retryFailures: 0, concurrency: 15, timeoutMs: null };
  assert.throws(() => validateTeamSuite(suite, "shared-project-rotating-v1", policy));
  for (const protocol of ["shared-project-rotating-v3", "unknown", undefined]) {
    assert.throws(
      () => validateTeamSuite({ ...suite, protocol }, protocol, policy),
      /Unsupported Multi-Agent protocol/,
    );
    const value = evidence(6, false);
    assert.throws(
      () =>
        validateTeamTables(
          { ...value.suite, protocol },
          value.profiles,
          value.trials,
          value.rounds,
        ),
      /Unsupported Multi-Agent protocol/,
    );
  }
});

await test("historical approvals stay readable but cannot supply the v2 correction budget", async () => {
  const historical = JSON.parse(
    await readFile(new URL("../../policies/official-runs/v1.json", import.meta.url), "utf8"),
  );
  validateOfficialPolicy(historical);
  const proposed = structuredClone(historical);
  const suite = proposed.suites[MULTI_AGENT_BENCHMARK];
  suite.runner.contract = MULTI_AGENT_PROTOCOL;
  assert.throws(() => validateOfficialPolicy(proposed), /5 corrections/);
  suite.runPolicy.oracleRecoveries = 5;
  validateOfficialPolicy(proposed);
  assert.deepEqual(proposed.runner, historical.runner);
  assert.deepEqual(proposed.runPolicy, historical.runPolicy);
  assert.deepEqual(proposed.fullRunPolicy, historical.fullRunPolicy);
  suite.runner.contract = "shared-project-rotating-v1";
  assert.throws(() => validateOfficialPolicy(proposed), /3 corrections/);
});

await test("a current preparation cannot reuse a proof from the old correction contract", async (t) => {
  const { runMultiAgentBatch } = await import("../../scripts/run-multi-agent-batch.mjs");
  const root = await tempDirectory("team-proof-policy-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparation = path.join(root, "preparation");
  const output = path.join(root, "output");
  await mkdir(preparation);
  await writeFile(
    path.join(preparation, "manifest.json"),
    JSON.stringify({ policy: MULTI_AGENT_POLICY, tasks: 71, graphWidth: 15 }),
  );
  for (const identity of [
    {},
    {
      protocol: "shared-project-rotating-v1",
      policy: { ...MULTI_AGENT_POLICY, oracleRecoveries: 3 },
    },
    { protocol: MULTI_AGENT_PROTOCOL, policy: { ...MULTI_AGENT_POLICY, oracleRecoveries: 3 } },
  ]) {
    await writeFile(
      path.join(preparation, "verification-15.json"),
      JSON.stringify({ status: "pass", ...identity }),
    );
    await assert.rejects(
      runMultiAgentBatch({ root: output, preparation, profiles: {}, safeAdapters: {} }),
      /Unsupported Multi-Agent proof/,
    );
    await assert.rejects(access(output), { code: "ENOENT" });
  }
});
await test("the measured runner rejects an old prepared budget before opening output or starting a driver", async (t) => {
  const root = await tempDirectory("team-correction-policy");
  t.after(() => rm(root, { recursive: true, force: true }));
  const preparation = path.join(root, "preparation");
  const output = path.join(root, "output");
  await mkdir(preparation);
  await writeFile(
    path.join(preparation, "manifest.json"),
    JSON.stringify({
      version: "renderer-concurrent-v2",
      policy: { ...MULTI_AGENT_POLICY, oracleRecoveries: 3 },
    }),
  );
  let drivers = 0;
  await assert.rejects(
    runConcurrent(preparation, output, {
      createDriver() {
        drivers++;
        throw Error("A driver must not start for a rejected preparation");
      },
    }),
    /Unsupported Multi-Agent preparation policy/,
  );
  assert.equal(drivers, 0);
  await assert.rejects(access(output), { code: "ENOENT" });
});
