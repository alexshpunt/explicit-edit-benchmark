import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { submissionMetadata } from "../../scripts/benchmark-submit.mjs";
import { buildSubmission } from "../../scripts/benchmark-submission.mjs";
import { ingestSubmission, listAcceptedSubmissions } from "../../scripts/benchmark-ingestion.mjs";
import { exportNormalizedRun } from "../../scripts/normalized-run.mjs";
import { restoringFixture } from "../helpers/restoring-result-fixture.mjs";
import { bundle } from "../helpers/normalized-bundle.mjs";
import { tempDirectory } from "../helpers/temp.mjs";

async function normalizedFixture(t, reportFactory = restoringFixture) {
  const root = await tempDirectory("restoring-submission-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const seed = path.join(root, "seed");
  await bundle(seed, "seed");
  const configuration = JSON.parse(
    (await readFile(path.join(seed, "configurations.jsonl"), "utf8")).trim(),
  );
  const profile = JSON.parse((await readFile(path.join(seed, "profiles.jsonl"), "utf8")).trim());
  const report = reportFactory();
  const raw = path.join(root, "raw");
  const output = path.join(root, "normalized");
  await mkdir(path.join(raw, "teams", "custom"), { recursive: true });
  await writeFile(
    path.join(raw, "manifest.json"),
    JSON.stringify({
      contract: report.protocol,
      suite: {
        id: report.benchmark,
        protocol: report.protocol,
        agents: report.agents,
        graphWidth: report.graphWidth,
        workloadSha256: report.workloadSha256,
        graphSha256: report.graphSha256,
        scheduleSha256: report.scheduleSha256,
        batchSize: report.batchSize,
      },
      harnesses: {
        custom: {
          ...profile,
          kind: "custom",
          version: "1",
          configurationId: configuration.configurationId,
          configuration: Object.fromEntries(
            ["tools", "extensions", "rules", "runtimeFlags", "environment"].map((key) => [
              key,
              configuration[key],
            ]),
          ),
        },
      },
      oracleRecoveries: 5,
      retryFailures: 0,
      concurrency: report.agents,
      timeoutMs: null,
      verifierSha256: report.verifierSha256,
      tasks: report.schedule.flatMap((round) =>
        round.assignments.map((item) => ({ id: item.task, fixtureSha256: report.initial })),
      ),
    }),
  );
  await writeFile(
    path.join(raw, "summary.json"),
    JSON.stringify({ results: [{ profile: "custom" }] }),
  );
  await writeFile(path.join(raw, "teams", "custom", "report.json"), JSON.stringify(report));
  const manifest = await exportNormalizedRun(raw, output);
  return { root, output, manifest, store: path.join(root, "store") };
}

function historicalFixture() {
  let next = 1;
  const schedule = Array.from({ length: 28 }, (_, index) => ({
    id: `round-${String(index + 1).padStart(3, "0")}`,
    assignments: Array.from({ length: index < 15 ? 3 : 2 }, (__, agent) => ({
      agent,
      task: `task-${String(next++).padStart(3, "0")}`,
    })),
  }));
  const sha = "a".repeat(64);
  return {
    benchmark: "explicit-edit-multi-agent",
    protocol: "shared-project-rotating-v1",
    agents: 15,
    graphWidth: 15,
    batchSize: 1,
    initial: sha,
    workloadSha256: sha,
    graphSha256: sha,
    verifierSha256: sha,
    scheduleSha256: createHash("sha256").update(JSON.stringify(schedule)).digest("hex"),
    schedule,
    status: "driver_exit",
    totalTasks: 71,
    acceptedTasks: 0,
    totalRounds: 28,
    acceptedRounds: 0,
    executions: [],
    checks: [{ label: "initial", status: "pass" }],
    deliveries: 0,
    repairs: 0,
    elapsedMs: 100,
    terminal: { id: "round-001", category: "driver_exit" },
  };
}

test("historical schema three remains version one and cannot be submitted as version two", async (t) => {
  const { output, store, manifest } = await normalizedFixture(t, historicalFixture);
  const metadata = await submissionMetadata(output, "historical-local");
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(metadata.definitions.benchmark.version, "1");
  assert.equal(metadata.definitions.benchmark.contract, "shared-project-rotating-v1");
  const submission = await buildSubmission(output, metadata);
  const changed = structuredClone(submission);
  changed.definitions.benchmark.version = "2";
  await assert.rejects(ingestSubmission(store, { ownerId: "local-owner" }, changed));
  assert.deepEqual(await listAcceptedSubmissions(store), []);
  const result = await ingestSubmission(store, { ownerId: "local-owner" }, submission);
  assert.equal(result.created, true);
  const accepted = await listAcceptedSubmissions(store);
  assert.equal(accepted[0].bundleSchemaVersion, 3);
  assert.equal(accepted[0].definitions.benchmark.version, "1");
});
test("restoring metadata rejects schema, protocol and source-identity contradictions", async (t) => {
  const { output, manifest } = await normalizedFixture(t);
  for (const mutate of [
    (value) => {
      value.schemaVersion = 3;
    },
    (value) => {
      value.suite.protocol = "shared-project-rotating-v1";
    },
    (value) => {
      value.contract = "shared-project-rotating-v1";
    },
    (value) => {
      value.suite.id = "different-benchmark";
    },
    (value) => {
      value.suite.workloadSha256 = "b".repeat(64);
    },
    (value) => {
      value.verifierSha256 = "c".repeat(64);
    },
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed);
    await writeFile(path.join(output, "manifest.json"), JSON.stringify(changed));
    await assert.rejects(submissionMetadata(output, "contradictory"));
  }
});

test("local ingestion binds restoring declarations to the complete normalized workload and version", async (t) => {
  const { output, store } = await normalizedFixture(t);
  const metadata = await submissionMetadata(output, "restoring-invalid");
  const original = await buildSubmission(output, metadata);
  for (const [name, mutate] of [
    [
      "benchmark id",
      (value) => {
        value.definitions.benchmark.id = "other-benchmark";
      },
    ],
    [
      "benchmark hash",
      (value) => {
        value.definitions.benchmark.hash = "b".repeat(64);
      },
    ],
    [
      "historical version",
      (value) => {
        value.definitions.benchmark.version = "1";
      },
    ],
    [
      "unknown version",
      (value) => {
        value.definitions.benchmark.version = "3";
      },
    ],
    [
      "extra task",
      (value) => {
        value.definitions.taskSet.taskIds.push("task-004");
      },
    ],
    [
      "missing task",
      (value) => {
        value.definitions.taskSet.taskIds.pop();
      },
    ],
    [
      "task-set hash",
      (value) => {
        value.definitions.taskSet.hash = "c".repeat(64);
      },
    ],
    [
      "historical contract",
      (value) => {
        value.definitions.benchmark.contract = "shared-project-rotating-v1";
      },
    ],
    [
      "historical schema",
      (value) => {
        value.bundle.manifest.schemaVersion = 3;
      },
    ],
  ]) {
    await t.test(name, async () => {
      const changed = structuredClone(original);
      mutate(changed);
      const destination = path.join(store, name.replaceAll(" ", "-"));
      await assert.rejects(ingestSubmission(destination, { ownerId: "local-owner" }, changed));
      assert.deepEqual(await listAcceptedSubmissions(destination), []);
    });
  }
});
test("restoring schema four submits version two metadata and retains its local normalized evidence", async (t) => {
  const { root, output, manifest, store } = await normalizedFixture(t);
  const metadata = await submissionMetadata(output, "restoring-local");
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(metadata.purpose, "exploratory");
  assert.equal(metadata.definitions.benchmark.id, "explicit-edit-multi-agent");
  assert.equal(metadata.definitions.benchmark.version, "2");
  assert.equal(metadata.definitions.benchmark.contract, "shared-project-restoring-v2");
  assert.equal(metadata.definitions.benchmark.hash, manifest.suite.workloadSha256);
  assert.deepEqual(metadata.definitions.taskSet.taskIds, ["task-001", "task-002", "task-003"]);
  const submission = await buildSubmission(output, metadata);
  const result = await ingestSubmission(store, { ownerId: "local-owner" }, submission);
  assert.equal(result.created, true);
  const accepted = await listAcceptedSubmissions(store);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].bundleSchemaVersion, 4);
  assert.equal(accepted[0].definitions.benchmark.version, "2");
  assert.equal(accepted[0].verification, "unverified");
  const saved = JSON.parse(
    await readFile(
      path.join(root, "store", "accepted", result.submissionId, "manifest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(saved, manifest);
  assert.equal(saved.suite.observations[0].result.score.final.score, 53.125);
  assert.equal(saved.suite.observations[0].result.score.first.score, 50);
  assert.deepEqual(await ingestSubmission(store, { ownerId: "local-owner" }, submission), {
    submissionId: result.submissionId,
    created: false,
  });
});
