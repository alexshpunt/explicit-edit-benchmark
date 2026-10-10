import assert from "node:assert/strict";
import test from "node:test";
import { createAggregateState, materializeAggregateState } from "../../scripts/aggregate-state.mjs";
import { aggregateExactConfigurations } from "../../scripts/result-aggregation.mjs";
import { submissionMetadata } from "../../scripts/benchmark-submit.mjs";
import { buildSubmission } from "../../scripts/benchmark-submission.mjs";
import { ingestSubmission } from "../../scripts/benchmark-ingestion.mjs";
import { buildNormalizedReport } from "../../scripts/build-normalized-report.mjs";
import { buildPublicDatasetFromStore } from "../../scripts/build-public-dataset.mjs";
import { normalizeTeamReport } from "../../scripts/normalized-run.mjs";
import { exportNormalizedRun } from "../../scripts/normalized-run.mjs";
import { validateNormalizedRun } from "../../scripts/validate-normalized-run.mjs";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { tempDirectory } from "../helpers/temp.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { buildOfficialManifest, validateOfficialManifest } from "../../scripts/official-result.mjs";
import { loadOfficialPolicy } from "../../scripts/official-policy.mjs";
import { suiteVerifier } from "../../scripts/run-multi-agent-batch.mjs";
import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { officialTransportMetadata } from "../../scripts/official-delivery.mjs";
import { acceptOfficialCandidates } from "../../scripts/official-acceptance.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";

function fixture() {
  const assignments = [
    { agent: 0, task: "task-001" },
    { agent: 0, task: "task-002" },
    { agent: 1, task: "task-003" },
  ];
  const execution = (agent, attempt, receipt) => ({
    round: "round-001",
    agent,
    attempt,
    tasks: assignments.filter((item) => item.agent === agent).map((item) => item.task),
    status: "settled",
    receipt,
  });
  const metrics = {
    exitCode: 0,
    timedOut: false,
    processSeconds: 2,
    toolCalls: 1,
    modelRounds: 3,
    eventErrors: 0,
    providerFailure: null,
    costUsd: 0.25,
    inputTokens: 8,
    outputTokens: 2,
    cacheReadTokens: 4,
    cacheWriteTokens: 0,
    totalTokens: 14,
    failedToolCalls: 0,
    invalidToolCalls: 0,
  };
  return {
    status: "blocked",
    totalTasks: 4,
    acceptedTasks: 3,
    totalRounds: 2,
    acceptedRounds: 1,
    agents: 2,
    schedule: [
      { id: "round-001", assignments },
      { id: "round-002", assignments: [{ agent: 0, task: "task-004" }] },
    ],
    checks: [
      { label: "initial", status: "pass" },
      { label: "round-001-attempt-1", status: "fail", category: "structure" },
      { label: "round-001-attempt-2", status: "pass" },
      ...[1, 2, 3, 4].map((attempt) => ({
        label: `round-002-attempt-${attempt}`,
        status: "fail",
        category: "structure",
      })),
    ],
    executions: [
      execution(0, 1, metrics),
      execution(1, 1, metrics),
      execution(0, 2, metrics),
      execution(1, 2, metrics),
      ...[1, 2, 3, 4].map((attempt) => ({
        round: "round-002",
        attempt,
        agent: 0,
        tasks: ["task-004"],
        status: "settled",
        receipt: {
          ...metrics,
          costUsd: null,
          totalTokens: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
        },
      })),
    ],
  };
}
const profile = { profileId: "custom", modelId: "example/model", harnessId: "custom" };
const initial = "a".repeat(64);

test("barrier task credit remains joint while each native delivery is recorded exactly once", () => {
  const { trials, rounds } = normalizeTeamReport(fixture(), profile, initial);
  assert.equal(trials.length, 2);
  assert.equal(rounds.length, 8);
  assert.deepEqual(trials[0].taskIds, ["task-001", "task-002", "task-003"]);
  assert.equal(trials[0].firstExactPassed, false);
  assert.equal(trials[0].finalExactPassed, true);
  assert.equal(trials[1].finalExactPassed, false);
  assert.equal(
    trials.reduce((sum, trial) => sum + (trial.finalExactPassed ? trial.taskIds.length : 0), 0),
    3,
  );
  assert.equal(
    rounds.reduce((sum, round) => sum + (round.costUsd ?? 0), 0),
    1,
  );
  assert.equal(
    rounds.reduce((sum, round) => sum + (round.totalTokens ?? 0), 0),
    56,
  );
  assert.equal(
    rounds.reduce((sum, round) => sum + round.toolCallCount, 0),
    8,
  );
  assert.deepEqual(
    rounds.slice(0, 4).map((round) => [round.agent, round.barrierAttempt]),
    [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ],
  );
  assert.deepEqual(rounds[0].taskIds, ["task-001", "task-002"]);
  assert.ok(rounds.slice(4).every((round) => round.costUsd === null && round.totalTokens === null));
});

test("an unsettled barrier cannot earn task credit and later work remains not reached", () => {
  const report = fixture();
  report.status = "driver_exit";
  report.acceptedTasks = 0;
  report.acceptedRounds = 0;
  report.checks = [{ label: "initial", status: "pass" }];
  report.executions = [
    { ...report.executions[0], status: "error", receipt: { exitCode: 1, providerFailure: null } },
  ];
  const { trials, rounds } = normalizeTeamReport(report, profile, initial);
  assert.equal(trials[0].finalExactPassed, false);
  assert.equal(trials[1].rounds, 0);
  assert.equal(trials[1].infrastructureFailure, "not-reached");
  assert.equal(rounds[0].difference, "unknown");
  assert.equal(rounds[0].inputTokens, null);
  assert.equal(rounds[0].toolCallCount, null);
});

test("team normalization refuses contradictory accepted progress or duplicate scheduled tasks", () => {
  const inflated = fixture();
  inflated.acceptedTasks = 4;
  assert.throws(
    () => normalizeTeamReport(inflated, profile, initial),
    /accepted.*tasks|joint.*progress/i,
  );
  const duplicate = fixture();
  duplicate.schedule[1].assignments[0].task = "task-001";
  assert.throws(() => normalizeTeamReport(duplicate, profile, initial), /duplicate.*task/i);
});

await test("the common exporter and validator carry a team bundle without duplicating statistics or leaking raw evidence", async (t) => {
  const root = await tempDirectory("normalized-team-");
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
  const report = fixture();
  report.agents = 15;
  report.totalTasks = 71;
  report.totalRounds = 28;
  report.elapsedMs = 12345;
  report.initial = initial;
  report.terminal = { category: "blocked", id: "round-002", message: "raw-secret-marker" };
  report.schedule[1].assignments = [4, 5, 6].map((number) => ({
    agent: 0,
    task: `task-${String(number).padStart(3, "0")}`,
  }));
  for (const item of report.executions.filter((item) => item.round === "round-002"))
    item.tasks = report.schedule[1].assignments.map((assignment) => assignment.task);
  let next = 7;
  for (let index = 0; index < 26; index++) {
    report.schedule.push({
      id: `round-${String(index + 3).padStart(3, "0")}`,
      assignments: Array.from({ length: index < 13 ? 3 : 2 }, () => ({
        agent: index % 15,
        task: `task-${String(next++).padStart(3, "0")}`,
      })),
    });
  }
  assert.equal(next, 72);
  const scheduleSha256 = createHash("sha256").update(JSON.stringify(report.schedule)).digest("hex");
  const suite = {
    id: MULTI_AGENT_BENCHMARK,
    protocol: MULTI_AGENT_PROTOCOL,
    agents: 15,
    graphWidth: 15,
    workloadSha256: "b".repeat(64),
    graphSha256: "c".repeat(64),
    scheduleSha256,
  };
  Object.assign(report, {
    workloadSha256: suite.workloadSha256,
    graphSha256: suite.graphSha256,
    scheduleSha256,
    graphWidth: 15,
  });
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
      contract: MULTI_AGENT_PROTOCOL,
      suite,
      harnesses: { custom: adapter },
      oracleRecoveries: 3,
      retryFailures: 0,
      concurrency: 15,
      timeoutMs: null,
      verifierSha256: await suiteVerifier(),
      tasks: report.schedule.flatMap((barrier) =>
        barrier.assignments.map((item) => ({ id: item.task, fixtureSha256: initial })),
      ),
    }),
  );
  await writeFile(
    path.join(raw, "summary.json"),
    JSON.stringify({ results: [{ profile: "custom", acceptedTasks: 3 }] }),
  );
  const directory = path.join(raw, "teams/custom");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report));
  for (const item of report.executions) {
    const delivery = path.join(
      directory,
      "deliveries",
      `agent-${item.agent}`,
      `${item.round}-attempt-${item.attempt}`,
    );
    await mkdir(delivery, { recursive: true });
    await writeFile(
      path.join(delivery, "tool-calls.json"),
      JSON.stringify([
        {
          type: "tool_execution_start",
          toolName: "bash",
          args: { command: "echo raw-secret-marker" },
        },
      ]),
    );
  }
  const output = path.join(root, "normalized");
  const manifest = await exportNormalizedRun(raw, output);
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(manifest.policy.concurrency, 15);
  assert.equal(manifest.policy.timeoutMs, null);
  assert.equal(manifest.taskSetSha256, suite.workloadSha256);
  assert.equal(manifest.counts.trials, 28);
  assert.equal(manifest.counts.rounds, 8);
  assert.equal(manifest.counts.toolCalls, 8);
  await validateNormalizedRun(output);
  const policy = JSON.parse(
    await readFile(new URL("../../policies/official-runs/v1.json", import.meta.url), "utf8"),
  );
  const signing = {
    signerSha: policy.workflows[0].sha,
    runnerSha: policy.workflows[0].runnerSha,
  };
  const officialOptions = {
    policyId: "official-runs-v1",
    repository: "alice/caller",
    runId: "123",
    producerAttempt: 1,
    invocation: "benchmark",
    callerSha: "a".repeat(40),
    workflowRef: "alice/caller/.github/workflows/run.yml@main",
    runnerSha: signing.runnerSha,
    runnerOs: "Linux",
    runnerArch: "X64",
    runnerImage: "ubuntu22",
  };
  const official = await buildOfficialManifest(output, officialOptions);
  assert.equal(official.lifecycle.state, "full-measurement");
  assert.equal(official.lifecycle.plannedTrials, 28);
  assert.equal(official.lifecycle.observedTrials, 2);
  assert.equal(official.lifecycle.infrastructureFailures, 0);
  assert.equal(official.normalized.tasks.length, 71);
  const officialFile = path.join(root, "official-manifest.json");
  await writeFile(officialFile, JSON.stringify(official));
  const policyFile = path.join(root, "official-policy.json");
  await writeFile(policyFile, JSON.stringify(policy));
  await assert.rejects(
    validateOfficialManifest(officialFile, output, policyFile, signing.signerSha),
    /no approved release policy/,
  );
  const approved = {
    runner: {
      contract: MULTI_AGENT_PROTOCOL,
      taskSetSha256: suite.workloadSha256,
      verifierSha256: manifest.verifierSha256,
      tasks: official.normalized.tasks,
    },
    graphSha256: suite.graphSha256,
    scheduleSha256,
    runPolicy: { partialRuns: true, ...manifest.policy },
  };
  policy.suites = { [MULTI_AGENT_BENCHMARK]: approved };
  await writeFile(policyFile, JSON.stringify(policy));
  await validateOfficialManifest(officialFile, output, policyFile, signing.signerSha);
  await assert.rejects(
    validateOfficialManifest(officialFile, output, policyFile, "d".repeat(40)),
    /Unknown signer/,
  );
  for (const field of ["taskSetSha256", "verifierSha256"]) {
    const changed = structuredClone(policy);
    changed.suites[MULTI_AGENT_BENCHMARK].runner[field] = "e".repeat(64);
    await writeFile(policyFile, JSON.stringify(changed));
    await assert.rejects(
      validateOfficialManifest(officialFile, output, policyFile, signing.signerSha),
      /does not match/,
    );
  }
  for (const field of ["graphSha256", "scheduleSha256"]) {
    const changed = structuredClone(policy);
    changed.suites[MULTI_AGENT_BENCHMARK][field] = "e".repeat(64);
    await writeFile(policyFile, JSON.stringify(changed));
    await assert.rejects(
      validateOfficialManifest(officialFile, output, policyFile, signing.signerSha),
      /does not match/,
    );
  }
  const wrongFixture = structuredClone(policy);
  wrongFixture.suites[MULTI_AGENT_BENCHMARK].runner.tasks[0].fixtureSha256 = "e".repeat(64);
  await writeFile(policyFile, JSON.stringify(wrongFixture));
  await assert.rejects(
    validateOfficialManifest(officialFile, output, policyFile, signing.signerSha),
    /task identity/,
  );
  for (const [field, value] of Object.entries({
    concurrency: 14,
    timeoutMs: 3600000,
    oracleRecoveries: 4,
    retryFailures: 1,
  })) {
    const changed = structuredClone(policy);
    changed.suites[MULTI_AGENT_BENCHMARK].runPolicy[field] = value;
    await writeFile(policyFile, JSON.stringify(changed));
    await assert.rejects(loadOfficialPolicy(policyFile), /15 agents/);
  }
  const revoked = structuredClone(policy);
  revoked.workflows[0].status = "revoked";
  await writeFile(policyFile, JSON.stringify(revoked));
  await assert.rejects(
    validateOfficialManifest(officialFile, output, policyFile, signing.signerSha),
    /Revoked signer/,
  );
  await writeFile(policyFile, JSON.stringify(policy));
  // Controlled attestation and Hub boundaries; the archive, policy and acceptance are real.
  const signed = path.join(root, "signed");
  await mkdir(signed);
  await cp(output, path.join(signed, "normalized"), { recursive: true });
  await writeFile(path.join(signed, "official-manifest.json"), JSON.stringify(official));
  await writeFile(
    path.join(signed, "execution-plan.json"),
    JSON.stringify({ modelRegistry: policy.modelRegistry, canonicalModel: { id: "test/model" } }),
  );
  await writeFile(path.join(signed, "installed-dependencies.json"), "{}");
  const artifact = path.join(signed, "official-result.tar.gz");
  execFileSync("tar", [
    "-czf",
    artifact,
    "-C",
    signed,
    "official-manifest.json",
    "execution-plan.json",
    "installed-dependencies.json",
    ...[
      "manifest.json",
      "profiles.jsonl",
      "configurations.jsonl",
      "trials.jsonl",
      "rounds.jsonl",
      "tool-calls.jsonl",
    ].map((name) => `normalized/${name}`),
  ]);
  const transport = await officialTransportMetadata({
    artifact,
    manifest: path.join(signed, "official-manifest.json"),
    signerWorkflowSha: signing.signerSha,
  });
  transport.submitter = "alice";
  const sourceIndex = { schemaVersion: 1, submissions: [] };
  const documents = {
    "source/index.json": JSON.stringify(sourceIndex),
    "dataset-index.json": JSON.stringify({ schemaVersion: 1, runs: [] }),
    "aggregate-state.json": JSON.stringify(
      createAggregateState({
        sourceIndex,
        run: [],
        profiles: [],
        trials: [],
        rounds: [],
        toolCalls: [],
      }),
    ),
    [`candidates/official/${transport.executionId}/official-result.tar.gz`]:
      await readFile(artifact),
    [`candidates/official/${transport.executionId}/attestation.jsonl`]: "controlled-attestation\n",
    [`candidates/official/${transport.executionId}/transport.json`]: JSON.stringify(transport),
  };
  const parentCommit = "b".repeat(40);
  const published = new Map();
  const receipts = [];
  let verifiedAttestations = 0;
  const acceptedOfficial = await acceptOfficialCandidates({
    repository: "alice/dataset",
    candidateNumbers: [42],
    accessToken: "test-token",
    workspaceDirectory: path.join(root, "official-acceptance"),
    policyFile,
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        isPullRequest: true,
        status: "open",
        title: `Contribute official benchmark execution ${transport.executionId}`,
        events: [{ type: "commit", data: { oid: "c".repeat(40) } }],
      }),
    }),
    hub: {
      async *listCommits() {
        yield { oid: parentCommit };
      },
      async downloadFile({ path: file }) {
        assert.ok(Object.hasOwn(documents, file), `Unexpected download: ${file}`);
        return new Blob([documents[file]]);
      },
      async commit({ parentCommit: actualParent, operations }) {
        assert.equal(actualParent, parentCommit);
        for (const item of operations) published.set(item.path, await readFile(item.content));
        return { commit: { oid: "d".repeat(40) } };
      },
    },
    attestationVerifier: async ({ artifact: file, attestation, signerSha, repository }) => {
      assert.equal(
        createHash("sha256")
          .update(await readFile(file))
          .digest("hex"),
        transport.artifactSha256,
      );
      assert.equal(await readFile(attestation, "utf8"), "controlled-attestation\n");
      assert.equal(signerSha, signing.signerSha);
      assert.equal(repository, "alice/caller");
      verifiedAttestations += 1;
    },
    close: async (...args) => receipts.push(args),
  });
  assert.deepEqual(acceptedOfficial.rejected, []);
  assert.deepEqual(acceptedOfficial.deferred, []);
  assert.equal(acceptedOfficial.changed, true);
  assert.equal(verifiedAttestations, 1);
  assert.equal(acceptedOfficial.accepted[0].candidateClosed, true);
  assert.equal(receipts.length, 1);
  const officialIndex = JSON.parse(published.get("dataset-index.json").toString("utf8"));
  assert.equal(officialIndex.runs[0].suite.id, MULTI_AGENT_BENCHMARK);
  assert.equal(officialIndex.runs[0].official.executionId, transport.executionId);
  const officialSummary = JSON.parse(published.get("summary.json").toString("utf8"));
  assert.equal(officialSummary.observations, 71);
  assert.equal(officialSummary.efficiency[0].durationSeconds, 12.345);
  const officialLeaderboard = published.get("leaderboard.json").toString("utf8");
  assert.ok(officialLeaderboard.includes(String(3 / 71)));
  const metadata = await submissionMetadata(output, manifest.runId);
  assert.equal(metadata.definitions.benchmark.id, MULTI_AGENT_BENCHMARK);
  assert.equal(metadata.definitions.benchmark.contract, MULTI_AGENT_PROTOCOL);
  assert.equal(metadata.definitions.taskSet.taskIds.length, 71);
  const store = path.join(root, "store");
  const accepted = await ingestSubmission(
    store,
    { ownerId: "alice", verification: "verified" },
    await buildSubmission(output, metadata),
  );
  assert.equal(accepted.created, true);
  await buildNormalizedReport(output, path.join(output, "report"));
  assert.match(await readFile(path.join(output, "report/report.md"), "utf8"), /3\/71 \(4\.2%\)/);
  const publicDirectory = path.join(root, "dataset");
  await buildPublicDatasetFromStore(publicDirectory, store);
  const publicIndex = JSON.parse(
    await readFile(path.join(publicDirectory, "dataset-index.json"), "utf8"),
  );
  assert.deepEqual(publicIndex.runs[0].suite, manifest.suite);
  const publicSummary = JSON.parse(
    await readFile(path.join(publicDirectory, "summary.json"), "utf8"),
  );
  assert.equal(publicSummary.observations, 71);
  assert.equal(publicSummary.efficiency[0].durationSeconds, 12.345);
  assert.equal(publicSummary.efficiency[0].costUsd, 1);
  const leaderboard = JSON.parse(
    await readFile(path.join(publicDirectory, "leaderboard.json"), "utf8"),
  );
  assert.ok(JSON.stringify(leaderboard).includes(String(3 / 71)));
  const trials = (await readFile(path.join(output, "trials.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.equal(
    trials.filter((trial) => trial.finalExactPassed).flatMap((trial) => trial.taskIds).length,
    3,
  );
  assert.equal(trials.flatMap((trial) => trial.taskIds).length, 71);
  const table = async (name) =>
    (await readFile(path.join(output, name), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), runId: manifest.runId }));
  const [aggregate] = aggregateExactConfigurations(
    {
      runs: [
        {
          ...manifest,
          definitions: {
            benchmark: { id: MULTI_AGENT_BENCHMARK, version: "1" },
            taskSet: { taskIds: trials.flatMap((trial) => trial.taskIds) },
          },
        },
      ],
    },
    await table("profiles.jsonl"),
    await table("trials.jsonl"),
    await table("rounds.jsonl"),
  );
  assert.equal(aggregate.taskCount, 71);
  assert.equal(aggregate.score, 3 / 71);
  assert.equal(aggregate.finalExactPasses, 3);
  assert.equal(aggregate.recoveryRounds, 4);
  assert.equal(aggregate.cost.total, 1);
  assert.equal(aggregate.tokens.total, 56);
  assert.equal(aggregate.durationSummary.coveredRun, 12.345);
  assert.equal(aggregate.configurationTaskCells.length, 71);
  const cached = materializeAggregateState(
    createAggregateState({
      sourceIndex: { submissions: [{ runId: manifest.runId }] },
      run: manifest,
      profiles: await table("profiles.jsonl"),
      trials: await table("trials.jsonl"),
      rounds: await table("rounds.jsonl"),
      toolCalls: await table("tool-calls.jsonl"),
    }),
  );
  const [rebuilt] = aggregateExactConfigurations(
    { runs: cached.runs },
    cached.profiles,
    cached.trials,
    cached.rounds,
  );
  for (const field of ["score", "recoveryRounds", "finalExactPasses", "taskCount"])
    assert.equal(rebuilt[field], aggregate[field], `Cached team ${field} changed`);
  assert.equal(rebuilt.cost.total, aggregate.cost.total);
  assert.equal(rebuilt.durationSummary.coveredRun, aggregate.durationSummary.coveredRun);
  // A stopped matrix must not claim that later model-harness configurations ran.
  const rawManifest = JSON.parse(await readFile(path.join(raw, "manifest.json"), "utf8"));
  rawManifest.harnesses.unstarted = { ...adapter, model: "unstarted-model" };
  await writeFile(path.join(raw, "manifest.json"), JSON.stringify(rawManifest));
  const stoppedOutput = path.join(root, "stopped-matrix");
  const stopped = await exportNormalizedRun(raw, stoppedOutput);
  await validateNormalizedRun(stoppedOutput);
  assert.equal(stopped.counts.profiles, 1);
  assert.deepEqual(
    stopped.suite.observations.map((item) => item.profileId),
    ["custom"],
  );
  assert.ok(
    !(await readFile(path.join(stoppedOutput, "profiles.jsonl"), "utf8")).includes(
      "unstarted-model",
    ),
  );
  for (const status of ["cancelled", "provider_failure"]) {
    const interrupted = structuredClone(report);
    interrupted.status = status;
    interrupted.terminal = { category: status, message: "raw-secret-marker" };
    interrupted.checks = interrupted.checks.filter((item) => !item.label.startsWith("round-002"));
    interrupted.executions = interrupted.executions.filter(
      (item) => item.round !== "round-002" || item.attempt === 1,
    );
    if (status === "provider_failure")
      interrupted.executions.find((item) => item.round === "round-002").receipt.providerFailure =
        "rate-limit";
    await writeFile(path.join(directory, "report.json"), JSON.stringify(interrupted));
    const interruptedOutput = path.join(root, status);
    await exportNormalizedRun(raw, interruptedOutput);
    await validateNormalizedRun(interruptedOutput);
    const stoppedOfficial = await buildOfficialManifest(interruptedOutput, officialOptions);
    assert.equal(stoppedOfficial.lifecycle.observedTrials, 2);
    assert.equal(stoppedOfficial.lifecycle.infrastructureFailures, 1);
    assert.equal(stoppedOfficial.lifecycle.state, "full-measurement");
    await writeFile(officialFile, JSON.stringify(stoppedOfficial));
    await validateOfficialManifest(officialFile, interruptedOutput, policyFile, signing.signerSha);
    const interruptedTable = async (name) =>
      (await readFile(path.join(interruptedOutput, `${name}.jsonl`), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ ...JSON.parse(line), runId: manifest.runId }));
    const interruptedManifest = await validateNormalizedRun(interruptedOutput);
    const [interruptedAggregate] = aggregateExactConfigurations(
      { runs: [interruptedManifest] },
      await interruptedTable("profiles"),
      await interruptedTable("trials"),
      await interruptedTable("rounds"),
    );
    assert.equal(interruptedAggregate.score, 3 / 71);
    assert.equal(interruptedAggregate.infrastructureFailures, 1);
    assert.equal(
      interruptedAggregate.providerFailureRate,
      status === "provider_failure" ? 1 / 2 : 0,
    );
  }
  const bootstrap = structuredClone(report);
  Object.assign(bootstrap, {
    status: "infrastructure",
    acceptedTasks: 0,
    acceptedRounds: 0,
    executions: [],
    checks: [{ label: "initial", status: "pass" }],
    terminal: { category: "infrastructure", message: "raw-secret-marker" },
  });
  await writeFile(path.join(directory, "report.json"), JSON.stringify(bootstrap));
  const bootstrapOutput = path.join(root, "bootstrap");
  const bootstrapManifest = await exportNormalizedRun(raw, bootstrapOutput);
  await validateNormalizedRun(bootstrapOutput);
  const bootstrapOfficial = await buildOfficialManifest(bootstrapOutput, officialOptions);
  assert.equal(bootstrapOfficial.lifecycle.state, "infrastructure-failure");
  assert.equal(bootstrapOfficial.lifecycle.observedTrials, 0);
  assert.equal(bootstrapOfficial.lifecycle.infrastructureFailures, 1);
  await writeFile(officialFile, JSON.stringify(bootstrapOfficial));
  await validateOfficialManifest(officialFile, bootstrapOutput, policyFile, signing.signerSha);
  const bootstrapStore = path.join(root, "bootstrap-store");
  await ingestSubmission(
    bootstrapStore,
    { ownerId: "alice", verification: "verified" },
    await buildSubmission(
      bootstrapOutput,
      await submissionMetadata(bootstrapOutput, bootstrapManifest.runId),
    ),
  );
  const bootstrapDataset = path.join(root, "bootstrap-dataset");
  await buildPublicDatasetFromStore(bootstrapDataset, bootstrapStore);
  const bootstrapSummary = JSON.parse(
    await readFile(path.join(bootstrapDataset, "summary.json"), "utf8"),
  );
  assert.equal(bootstrapSummary.efficiency.length, 1);
  assert.equal(bootstrapSummary.efficiency[0].rounds, 0);
  assert.equal(bootstrapSummary.efficiency[0].durationSeconds, 12.345);
  assert.equal(bootstrapSummary.efficiency[0].costUsd, null);
  assert.equal(bootstrapSummary.efficiency[0].totalTokens, null);
  const bootstrapTable = async (name) =>
    (await readFile(path.join(bootstrapOutput, `${name}.jsonl`), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => ({ ...JSON.parse(line), runId: bootstrapManifest.runId }));
  const [bootstrapAggregate] = aggregateExactConfigurations(
    { runs: [bootstrapManifest] },
    await bootstrapTable("profiles"),
    await bootstrapTable("trials"),
    await bootstrapTable("rounds"),
  );
  assert.equal(bootstrapAggregate.infrastructureFailures, 1);
  assert.equal(bootstrapAggregate.providerFailureRate, null);
  assert.equal(bootstrapAggregate.score, 0);
  for (const file of ["manifest.json", ...Object.keys(manifest.files)])
    assert.ok(!(await readFile(path.join(output, file), "utf8")).includes("raw-secret-marker"));
});
