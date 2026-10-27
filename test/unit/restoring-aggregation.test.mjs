import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { tempDirectory } from "../helpers/temp.mjs";
import { normalizeTeamReport, exportNormalizedRun } from "../../scripts/normalized-run.mjs";
import { restoringMultiAgentResult } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";
import {
  aggregateExactConfigurations,
  aggregateLeaderboard,
} from "../../scripts/result-aggregation.mjs";
import {
  buildPublicDataset,
  buildDerivedDatasetFromAggregateState,
} from "../../scripts/build-public-dataset.mjs";
import { createAggregateState } from "../../scripts/aggregate-state.mjs";

const sha = "a".repeat(64);
const profile = {
  profileId: "custom",
  modelId: "example/model",
  harnessId: "custom",
  modelFamily: "example/model",
  modelVersion: "1",
  harnessFamily: "custom",
  harnessVersion: "1",
  configurationLabels: [],
};
function evidence(raw = restoringFixture(), runId = "restoring") {
  const result = restoringMultiAgentResult(raw);
  const normalized = normalizeTeamReport(raw, profile, sha);
  const run = {
    runId,
    bundleSchemaVersion: 4,
    contract: raw.protocol,
    verifierSha256: sha,
    policy: { concurrency: raw.agents },
    definitions: {
      benchmark: { id: raw.benchmark, version: "2" },
      taskSet: { taskIds: ["task-001", "task-002", "task-003"] },
    },
    suite: {
      protocol: raw.protocol,
      scheduleSha256: raw.scheduleSha256,
      schedule: raw.schedule,
      observations: [{ profileId: profile.profileId, result }],
    },
  };
  return {
    run,
    profiles: [{ ...profile, runId }],
    trials: normalized.trials.map((row) => ({ ...row, runId })),
    rounds: normalized.rounds.map((row) => ({ ...row, runId })),
  };
}
function aggregate(data, fn = aggregateExactConfigurations) {
  return fn({ runs: [data.run] }, data.profiles, data.trials, data.rounds);
}

test("restoring aggregation uses final equal-round score and retains first independently", () => {
  const data = evidence();
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const [row] = aggregate(data, fn);
    assert.equal(row.score, 0.53125);
    assert.equal(row.qualityScore, 0.53125);
    assert.equal(row.firstScore, 0.5);
    assert.equal(row.finalScore, 0.53125);
    assert.equal(row.firstExactRate, null);
    assert.equal(row.finalExactRate, null);
    assert.equal(row.taskCount, 2);
    assert.equal(row.benchmarkTaskCount, 2);
    assert.equal(row.coverage, 1);
    assert.equal(row.durationSummary.coveredRun, 0.1);
    assert.deepEqual(
      row.configurationTaskCells.map((cell) => [cell.taskId, cell.firstScore, cell.finalScore]),
      [
        ["round-001", 0, 0.0625],
        ["round-002", 1, 1],
      ],
    );
  }
});

test("unobserved restoring rounds remain zeros without a second coverage penalty or idle inference", () => {
  const raw = restoringFixture();
  raw.status = "driver_exit";
  raw.terminal = { id: "round-002", category: "driver_exit" };
  raw.rounds.pop();
  raw.executions.pop();
  raw.deliveries--;
  const data = evidence(raw);
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const [row] = aggregate(data, fn);
    assert.equal(row.score, 0.03125);
    assert.equal(row.firstScore, 0);
    assert.equal(row.finalScore, 0.03125);
    assert.equal(row.coverage, 1);
    assert.equal(row.taskCount, 2);
    assert.equal(row.infrastructureFailures, 1);
    assert.equal(row.durationSummary.coveredRun, 0.1);
  }
  assert.equal(data.rounds.length, 7);
});

test("restoring comparison groups separate weights, occupancy, source and runner identities", () => {
  const inputs = [evidence()];
  for (const [name, mutate] of [
    [
      "weights",
      (raw) => {
        raw.policy.buildWeight = 4;
      },
    ],
    [
      "occupancy",
      (raw) => {
        raw.agents = 3;
        raw.agentsClosed.push(true);
      },
    ],
    [
      "source",
      (raw) => {
        raw.contractHashes.initial = "b".repeat(64);
      },
    ],
    [
      "runner",
      (raw) => {
        raw.runnerSha256 = "b".repeat(64);
      },
    ],
  ]) {
    const raw = restoringFixture();
    mutate(raw);
    inputs.push(evidence(raw, name));
  }
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const rows = fn(
      { runs: inputs.map((data) => data.run) },
      inputs.flatMap((data) => data.profiles),
      inputs.flatMap((data) => data.trials),
      inputs.flatMap((data) => data.rounds),
    );
    assert.equal(rows.length, 5);
    assert.equal(new Set(rows.map((row) => row.restoringComparisonKey)).size, 5);
    assert.deepEqual(
      rows.map((row) => row.score).sort(),
      [0.515625, 0.53125, 0.53125, 0.53125, 0.53125],
    );
  }
});

test("different maximum occupancy schedules keep their own planned round coverage", () => {
  const raw = restoringFixture();
  raw.agents = 1;
  raw.agentsClosed = [true];
  raw.schedule = ["task-001", "task-002", "task-003"].map((task, index) => ({
    id: `round-00${index + 1}`,
    assignments: [{ task, agent: 0 }],
  }));
  raw.scheduleSha256 = createHash("sha256").update(JSON.stringify(raw.schedule)).digest("hex");
  raw.totalRounds = 3;
  raw.plannedAtoms = raw.schedule.map((row) => ({ round: row.id, totalAtoms: 1 }));
  raw.roundEndpoints = raw.schedule.map(({ id }) => ({ round: id, identity: sha }));
  raw.roundInventories = ["task-001-a", "task-002-a", "task-003-a"].map((id, index) => ({
    round: raw.schedule[index].id,
    sha256: createHash("sha256")
      .update(JSON.stringify([id]))
      .digest("hex"),
  }));
  for (const attempt of raw.rounds[0].attempts) attempt.totalAtoms = 1;
  raw.rounds[1].round = "round-003";
  raw.rounds.splice(1, 0, { ...structuredClone(raw.rounds[1]), round: "round-002" });
  raw.contractHashes["round-003"] = sha;
  raw.executions = [
    ...raw.executions.filter((row) => row.tasks[0] !== "task-002"),
    { ...raw.executions[1], round: "round-002" },
  ];
  for (const row of raw.executions) {
    row.agent = 0;
    if (row.tasks[0] === "task-003") row.round = "round-003";
  }
  raw.executions.sort((a, b) => a.round.localeCompare(b.round) || a.attempt - b.attempt);
  const inputs = [evidence(raw, "one"), evidence()];
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const rows = fn(
      { runs: inputs.map((data) => data.run) },
      inputs.flatMap((data) => data.profiles),
      inputs.flatMap((data) => data.trials),
      inputs.flatMap((data) => data.rounds),
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.coverage),
      [1, 1],
    );
    assert.deepEqual(rows.map((row) => row.taskCount).sort(), [2, 3]);
  }
});

test("repeated restoring runs average observation scores without weighting by atom or task count", () => {
  const raw = restoringFixture();
  raw.rounds[0].attempts.at(-1).passedAtoms = 0;
  const inputs = [evidence(), evidence(raw, "repeat")];
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const [row] = fn(
      { runs: inputs.map((data) => data.run) },
      inputs.flatMap((data) => data.profiles),
      inputs.flatMap((data) => data.trials),
      inputs.flatMap((data) => data.rounds),
    );
    assert.equal(row.score, 0.515625);
    assert.equal(row.firstScore, 0.5);
    assert.equal(row.finalScore, 0.515625);
  }
});

test("historical team task-weighted scoring stays separate from restoring round scoring", () => {
  const data = evidence();
  const legacy = structuredClone(data);
  legacy.run.runId = "legacy";
  legacy.run.bundleSchemaVersion = 3;
  legacy.run.contract = "shared-project-v1";
  legacy.run.definitions.benchmark.version = "1";
  legacy.run.suite.protocol = "shared-project-v1";
  legacy.run.suite.observations = [
    { profileId: profile.profileId, elapsedMs: 100, status: "pass" },
  ];
  for (const table of [legacy.profiles, legacy.trials, legacy.rounds])
    for (const row of table) row.runId = "legacy";
  for (const fn of [aggregateExactConfigurations, aggregateLeaderboard]) {
    const rows = fn(
      { runs: [data.run, legacy.run] },
      [...data.profiles, ...legacy.profiles],
      [...data.trials, ...legacy.trials],
      [...data.rounds, ...legacy.rounds],
    );
    assert.equal(rows.length, 2);
    assert.equal(rows.find((row) => row.restoringComparisonKey).score, 0.53125);
    assert.equal(rows.find((row) => !row.restoringComparisonKey).score, 1 / 3);
  }
});
async function normalizedBundle(t) {
  const root = await tempDirectory("restoring-aggregation-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  await bundle(seed, "seed");
  const configuration = JSON.parse(
    (await readFile(path.join(seed, "configurations.jsonl"), "utf8")).trim(),
  );
  const seedProfile = JSON.parse(
    (await readFile(path.join(seed, "profiles.jsonl"), "utf8")).trim(),
  );
  const raw = path.join(root, "raw");
  await mkdir(raw);
  const report = restoringFixture();
  const suite = Object.fromEntries(
    [
      "protocol",
      "agents",
      "graphWidth",
      "workloadSha256",
      "graphSha256",
      "scheduleSha256",
      "batchSize",
    ].map((key) => [key, report[key]]),
  );
  suite.id = report.benchmark;
  const adapter = {
    ...seedProfile,
    kind: "custom",
    version: "1",
    configurationId: configuration.configurationId,
    configuration: Object.fromEntries(
      ["tools", "extensions", "rules", "runtimeFlags", "environment"].map((key) => [
        key,
        configuration[key],
      ]),
    ),
  };
  await writeFile(
    path.join(raw, "manifest.json"),
    JSON.stringify({
      contract: report.protocol,
      suite,
      harnesses: { custom: adapter },
      oracleRecoveries: 5,
      retryFailures: 0,
      concurrency: 2,
      timeoutMs: null,
      verifierSha256: sha,
      tasks: ["task-001", "task-002", "task-003"].map((id) => ({ id, fixtureSha256: sha })),
    }),
  );
  await writeFile(
    path.join(raw, "summary.json"),
    JSON.stringify({ results: [{ profile: "custom" }] }),
  );
  await mkdir(path.join(raw, "teams/custom"), { recursive: true });
  await writeFile(path.join(raw, "teams/custom/report.json"), JSON.stringify(report));
  const output = path.join(root, "normalized");
  await exportNormalizedRun(raw, output);
  return { root, output };
}

test("public dataset regeneration preserves restoring scores, comparison identity and wall-clock timing", async (t) => {
  const { root, output } = await normalizedBundle(t);
  const publicRoot = path.join(root, "public");
  const index = await buildPublicDataset(publicRoot, [output]);
  const tables = {};
  for (const table of ["profiles", "trials", "rounds", "tool-calls"])
    tables[table] = (await readFile(path.join(output, table + ".jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), runId: index.runs[0].runId }));
  const state = createAggregateState({
    sourceIndex: { schemaVersion: 1, submissions: [] },
    run: index.runs,
    profiles: tables.profiles,
    trials: tables.trials,
    rounds: tables.rounds,
    toolCalls: tables["tool-calls"],
  });
  await buildDerivedDatasetFromAggregateState(publicRoot, index, state);
  const leaderboard = JSON.parse(await readFile(path.join(publicRoot, "leaderboard.json"), "utf8"));
  assert.equal(leaderboard.rows[0].score, 0.53125);
  assert.equal(leaderboard.rows[0].firstScore, 0.5);
  assert.equal(leaderboard.rows[0].finalScore, 0.53125);
  assert.match(leaderboard.rows[0].restoringComparisonKey, /^[a-f0-9]{64}$/);
  const summary = JSON.parse(await readFile(path.join(publicRoot, "summary.json"), "utf8"));
  assert.equal(summary.efficiency[0].durationSeconds, 0.1);
  assert.equal(summary.efficiency[0].rounds, 8);
  assert.equal(summary.observations, 0);
  assert.equal(summary.macroTaskExactRate, null);
  assert.equal(summary.restoring[0].firstScore, 0.5);
  assert.equal(summary.restoring[0].finalScore, 0.53125);
  assert.deepEqual(leaderboard.scoring.protocols["shared-project-restoring-v2"].range, [0, 1]);
  const details = JSON.parse(
    gunzipSync(
      await readFile(path.join(publicRoot, index.explorerDetails[index.runs[0].runId].path)),
    ),
  );
  assert.deepEqual(
    details.trials.map((row) => row.finalScore),
    [6.25, 100],
  );
  const views = JSON.parse(await readFile(path.join(publicRoot, "views.json"), "utf8"));
  assert.equal(Object.values(views.groups.modelRoute)[0].firstScore, 0.5);
  assert.equal(Object.values(views.groups.modelRoute)[0].finalScore, 0.53125);
});
