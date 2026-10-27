import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { tempDirectory } from "../helpers/temp.mjs";
import { normalizeTeamReport, exportNormalizedRun } from "../../scripts/normalized-run.mjs";
import { validateNormalizedRun } from "../../scripts/validate-normalized-run.mjs";
import { buildNormalizedReport } from "../../scripts/build-normalized-report.mjs";
import { buildOfficialManifest } from "../../scripts/official-result.mjs";
import { suiteVerifier } from "../../src/suites/explicit-edit-multi-agent/source-identity.mjs";
import { suiteRunOptions, officialSuiteRunOptions } from "../../scripts/benchmark-suites.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { RESTORING_MULTI_AGENT_PROTOCOL } from "../../src/suites/explicit-edit-multi-agent/restoring-results.mjs";

const profile = { profileId: "custom", modelId: "example/model", harnessId: "custom" };
const sha = "a".repeat(64);
async function rawRun(t, changed = (value) => value) {
  const root = await tempDirectory("restoring-normalized-");
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
  changed(report);
  const suite = {
    id: report.benchmark,
    protocol: report.protocol,
    agents: report.agents,
    graphWidth: report.graphWidth,
    workloadSha256: report.workloadSha256,
    graphSha256: report.graphSha256,
    scheduleSha256: report.scheduleSha256,
    batchSize: report.batchSize,
  };
  const adapter = {
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
  };
  await writeFile(
    path.join(raw, "manifest.json"),
    JSON.stringify({
      contract: report.protocol,
      suite,
      harnesses: { custom: adapter },
      oracleRecoveries: 5,
      retryFailures: 0,
      concurrency: report.agents,
      timeoutMs: null,
      verifierSha256: report.verifierSha256,
      tasks: report.schedule.flatMap((round) =>
        round.assignments.map((item) => ({ id: item.task, fixtureSha256: sha })),
      ),
    }),
  );
  await writeFile(
    path.join(raw, "summary.json"),
    JSON.stringify({ results: [{ profile: "custom" }] }),
  );
  const directory = path.join(raw, "teams/custom");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "report.json"),
    JSON.stringify({ ...report, secret: "private-marker-not-exported" }),
  );
  return { root, raw, report, output: path.join(root, "normalized") };
}

test("restoring normalization continues after exhausted rounds and keeps independent final scores", () => {
  const { trials, rounds } = normalizeTeamReport(restoringFixture(), profile, sha);
  assert.equal(trials.length, 2);
  assert.equal(rounds.length, 8);
  assert.deepEqual(
    trials.map((item) => item.finalScore),
    [6.25, 100],
  );
  assert.deepEqual(
    trials.map((item) => item.firstScore),
    [0, 100],
  );
  assert.deepEqual(
    trials.map((item) => item.finalExactPassed),
    [false, true],
  );
  assert.equal(
    rounds.reduce((sum, item) => sum + (item.modelRoundCount ?? 0), 0),
    8,
  );
});

test("schema four exports, validates and reports equal-round score without task weighting", async (t) => {
  const { raw, root, output } = await rawRun(t);
  const manifest = await exportNormalizedRun(raw, output);
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.suite.observations[0].result.score.final.score, 53.125);
  assert.equal(manifest.suite.observations[0].result.score.first.score, 50);
  assert.deepEqual(await validateNormalizedRun(output), manifest);
  await buildNormalizedReport(output, path.join(root, "report"));
  const csv = (await readFile(path.join(root, "report/results.csv"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => line.split(","));
  const row = Object.fromEntries(csv[0].map((name, index) => [name, csv[1][index]]));
  assert.equal(Number(row.final_score), 53.125);
  assert.equal(Number(row.first_score), 50);
  for (const file of [
    "manifest.json",
    "profiles.jsonl",
    "configurations.jsonl",
    "trials.jsonl",
    "rounds.jsonl",
    "tool-calls.jsonl",
  ])
    assert.equal(
      (await readFile(path.join(output, file), "utf8")).includes("private-marker-not-exported"),
      false,
    );
  await assert.rejects(
    buildOfficialManifest(output, {
      repository: "test/caller",
      runId: "123",
      producerAttempt: 1,
      invocation: "benchmark",
      policyId: "official-runs-v1",
      callerSha: "a".repeat(40),
      runnerSha: "b".repeat(40),
      workflowRef: "test/caller/.github/workflows/run.yml@main",
      runnerOs: "Linux",
      runnerArch: "X64",
      runnerImage: "ubuntu22",
    }),
  );
});

test("interrupted schema four runs preserve the full denominator and unobserved zero rows", async (t) => {
  const { raw, output } = await rawRun(t, (report) => {
    report.status = "driver_exit";
    report.terminal = { id: "round-002", category: "driver_exit" };
    report.rounds.pop();
    report.executions.pop();
    report.deliveries--;
  });
  const manifest = await exportNormalizedRun(raw, output);
  assert.equal(manifest.suite.observations[0].result.score.final.score, 3.125);
  const trials = (await readFile(path.join(output, "trials.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(trials[1].finalScore, 0);
  assert.equal(trials[1].rounds, 0);
  await validateNormalizedRun(output);
});

test("schema four rejects rewritten score, protocol and row evidence even after digest updates", async (t) => {
  const { raw, output } = await rawRun(t);
  await exportNormalizedRun(raw, output);
  const originalManifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  for (const mutate of [
    (value) => value.suite.observations[0].result.score.final.score++,
    (value) => (value.suite.protocol = MULTI_AGENT_PROTOCOL),
    (value) => (value.schemaVersion = 3),
  ]) {
    const changed = structuredClone(originalManifest);
    mutate(changed);
    await writeFile(path.join(output, "manifest.json"), JSON.stringify(changed));
    await assert.rejects(validateNormalizedRun(output));
  }
  const trials = (await readFile(path.join(output, "trials.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  trials[0].finalScore = 100;
  const content = trials.map((value) => JSON.stringify(value)).join("\n") + "\n";
  await writeFile(path.join(output, "trials.jsonl"), content);
  originalManifest.files["trials.jsonl"] = {
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(originalManifest));
  await assert.rejects(validateNormalizedRun(output));
});

test("maximum-N restoring CLI scope is explicit and unsupported official publication stays closed", async () => {
  assert.deepEqual(
    suiteRunOptions(MULTI_AGENT_BENCHMARK, { concurrency: "15", protocol: MULTI_AGENT_PROTOCOL }),
    { suite: MULTI_AGENT_BENCHMARK, concurrency: "15", protocol: MULTI_AGENT_PROTOCOL },
  );
  assert.throws(() =>
    suiteRunOptions(MULTI_AGENT_BENCHMARK, {
      concurrency: "9007199254740992",
      protocol: RESTORING_MULTI_AGENT_PROTOCOL,
    }),
  );
  assert.deepEqual(
    suiteRunOptions(MULTI_AGENT_BENCHMARK, {
      concurrency: "2",
      protocol: RESTORING_MULTI_AGENT_PROTOCOL,
    }),
    { suite: MULTI_AGENT_BENCHMARK, concurrency: "2", protocol: RESTORING_MULTI_AGENT_PROTOCOL },
  );
  assert.throws(() => suiteRunOptions(MULTI_AGENT_BENCHMARK, { concurrency: "2" }));
  assert.throws(() => suiteRunOptions(MULTI_AGENT_BENCHMARK, { protocol: "unknown" }));
  assert.throws(() =>
    suiteRunOptions(MULTI_AGENT_BENCHMARK, {
      concurrency: "2",
      protocol: RESTORING_MULTI_AGENT_PROTOCOL,
      task: "task-001",
    }),
  );
  await assert.rejects(
    officialSuiteRunOptions(
      {
        workflows: [{ sha: "b".repeat(40), runnerSha: "b".repeat(40), status: "active" }],
        suites: { [MULTI_AGENT_BENCHMARK]: { runner: { verifierSha256: await suiteVerifier() } } },
      },
      MULTI_AGENT_BENCHMARK,
      {
        concurrency: "2",
        protocol: RESTORING_MULTI_AGENT_PROTOCOL,
        runnerSha: "b".repeat(40),
      },
    ),
  );
});
