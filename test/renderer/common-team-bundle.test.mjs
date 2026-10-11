import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runConcurrent } from "../../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../../src/suites/explicit-edit-multi-agent/results.mjs";
import { suiteVerifier } from "../../scripts/run-multi-agent-batch.mjs";
import { exportNormalizedRun } from "../../scripts/normalized-run.mjs";
import { validateNormalizedRun } from "../../scripts/validate-normalized-run.mjs";
import { submissionMetadata } from "../../scripts/benchmark-submit.mjs";
import { buildSubmission } from "../../scripts/benchmark-submission.mjs";
import { ingestSubmission } from "../../scripts/benchmark-ingestion.mjs";
import { buildNormalizedReport } from "../../scripts/build-normalized-report.mjs";
import { buildPublicDatasetFromStore } from "../../scripts/build-public-dataset.mjs";

// This full reference proof requires an explicit prepared input and a new output.
// It never loads model credentials, starts inference, or uploads the local Dataset.
await test(
  "all 71 shared-project tasks flow through the common result and publication protocol",
  {
    skip: !process.env.RENDERER_TEAM_PREPARATION,
  },
  async () => {
    assert.ok(process.env.RENDERER_TEAM_OUTPUT, "Choose a new private output directory");
    const root = path.resolve(process.env.RENDERER_TEAM_OUTPUT);
    await mkdir(root, { mode: 0o700 });
    const preparation = path.join(root, "preparation");
    await cp(path.resolve(process.env.RENDERER_TEAM_PREPARATION), preparation, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    const directory = path.join(root, "teams", "reference");
    await mkdir(path.dirname(directory));
    const report = await runConcurrent(preparation, directory, { agents: 15 });
    assert.equal(report.status, "pass");
    assert.equal(report.acceptedTasks, 71);
    assert.equal(report.acceptedRounds, 28);
    assert.equal(report.repairs, 0);
    const input = JSON.parse(await readFile(path.join(preparation, "manifest.json"), "utf8"));
    const tasks = JSON.parse(await readFile(path.join(preparation, "tasks.json"), "utf8"));
    const json = (file, value) =>
      writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
    await json("manifest.json", {
      contract: MULTI_AGENT_PROTOCOL,
      oracleRecoveries: 3,
      retryFailures: 0,
      concurrency: 15,
      timeoutMs: null,
      verifierSha256: await suiteVerifier(),
      tasks: tasks.map((task) => ({ id: task.id, fixtureSha256: input.initial })),
      harnesses: {
        reference: {
          kind: "custom",
          version: "1",
          agentFamily: "scripted-reference",
          agentVersion: "1",
          harnessFamily: "scripted-reference",
          harnessVersion: "1",
          adapterVersion: "1",
          model: "reference/scripted",
          modelFamily: "reference/scripted",
          modelVersion: "1",
          thinking: "off",
          configurationLabels: ["model-free"],
          configuration: {
            tools: [],
            extensions: [],
            rules: [],
            runtimeFlags: [],
            environment: [],
          },
        },
      },
      suite: {
        id: MULTI_AGENT_BENCHMARK,
        protocol: MULTI_AGENT_PROTOCOL,
        agents: 15,
        graphWidth: 15,
        workloadSha256: input.workloadSha256,
        graphSha256: input.graphSha256,
        scheduleSha256: report.scheduleSha256,
      },
    });
    await json("summary.json", {
      results: [
        { profile: "reference", status: report.status, acceptedTasks: report.acceptedTasks },
      ],
    });
    const normalized = path.join(root, "normalized");
    await exportNormalizedRun(root, normalized);
    const manifest = await validateNormalizedRun(normalized);
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.counts.trials, 28);
    assert.equal(manifest.counts.rounds, 71);
    const projected = (await readFile(path.join(normalized, "trials.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(
      projected.filter((trial) => trial.finalExactPassed).flatMap((trial) => trial.taskIds).length,
      71,
    );
    const rounds = (await readFile(path.join(normalized, "rounds.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.ok(
      rounds.every(
        (round) => round.costUsd === null && round.totalTokens === null && !round.toolCallsObserved,
      ),
    );
    await buildNormalizedReport(normalized, path.join(normalized, "report"));
    const metadata = await submissionMetadata(normalized, manifest.runId);
    const store = path.join(root, "store");
    await ingestSubmission(
      store,
      { ownerId: "reference", verification: "verified" },
      await buildSubmission(normalized, metadata),
    );
    const output = path.join(root, "dataset");
    await buildPublicDatasetFromStore(output, store);
    const summary = JSON.parse(await readFile(path.join(output, "summary.json"), "utf8"));
    assert.equal(summary.observations, 71);
    assert.equal(summary.macroTaskExactRate, 1);
    assert.equal(summary.efficiency[0].durationSeconds, report.elapsedMs / 1000);
    assert.equal(summary.efficiency[0].costUsd, null);
    console.log(
      JSON.stringify({
        status: "pass",
        modelCalls: 0,
        acceptedTasks: 71,
        agents: 15,
        schemaVersion: 3,
        elapsedMs: report.elapsedMs,
      }),
    );
  },
);
