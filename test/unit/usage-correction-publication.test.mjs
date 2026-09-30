import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import { ingestSubmission } from "../../scripts/benchmark-ingestion.mjs";
import { buildSubmission } from "../../scripts/benchmark-submission.mjs";
import { buildPublicDatasetFromStore } from "../../scripts/build-public-dataset.mjs";
import { correctUsage } from "../../scripts/usage-corrections.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const parent = "a".repeat(40);
const candidateCommit = "b".repeat(40);
const published = "c".repeat(40);

async function bundle(directory, runId) {
  await mkdir(directory, { recursive: true });
  const configuration = {
    configurationId: "test",
    agentFamily: "test-agent",
    agentVersion: "1",
    modelFamily: "test/model",
    modelVersion: "1",
    provider: null,
    harnessFamily: "test-harness",
    harnessVersion: "1",
    adapterVersion: "1",
    model: "test/model",
    thinking: "low",
    transport: null,
    harnessKind: "custom",
    tools: [],
    extensions: [],
    rules: [],
    runtimeFlags: [],
    environment: [],
    configurationLabels: [],
  };
  const configurationHash = digest(JSON.stringify(configuration));
  const profile = {
    profileId: "p",
    modelId: "m",
    harnessId: "h",
    model: "test/model",
    thinking: "low",
    harnessVersion: "1",
    harnessKind: "custom",
    transport: null,
    sourceCommit: null,
    agentFamily: "test-agent",
    agentVersion: "1",
    modelFamily: "test/model",
    modelVersion: "1",
    provider: null,
    harnessFamily: "test-harness",
    adapterVersion: "1",
    configurationHash,
    configurationLabels: [],
  };
  const trial = {
    trialId: "t",
    taskId: "replace-all-10-plain",
    profileId: "p",
    modelId: "m",
    harnessId: "h",
    fixtureSha256: "d".repeat(64),
    firstExactPassed: true,
    finalExactPassed: true,
    rounds: 1,
    infrastructureFailure: null,
  };
  const round = {
    roundId: "r",
    trialId: "t",
    round: 0,
    exactPassed: true,
    normalizedPassed: true,
    difference: "pass",
    timedOut: false,
    providerFailure: null,
    exitCode: 0,
    seconds: 2,
    toolCallCount: 0,
    modelRoundCount: 1,
    eventErrors: 0,
    toolCallsObserved: true,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    failedToolCalls: 0,
    invalidToolCalls: 0,
  };
  const tables = {
    "profiles.jsonl": [profile],
    "configurations.jsonl": [{ ...configuration, configurationHash }],
    "trials.jsonl": [trial],
    "rounds.jsonl": [round],
    "tool-calls.jsonl": [],
  };
  const manifest = {
    schemaVersion: 2,
    runId,
    contract: "test-contract",
    taskSetSha256: "d".repeat(64),
    policy: { oracleRecoveries: 0, retryFailures: 0, concurrency: 1, timeoutMs: 1000 },
    counts: { profiles: 1, configurations: 1, trials: 1, rounds: 1, toolCalls: 0 },
    completeness: {
      eofClassification: "complete",
      unknownDifferences: 0,
      toolCallCoverage: "complete",
      unobservedToolCallRounds: 0,
    },
    files: {},
  };
  for (const [name, values] of Object.entries(tables)) {
    const content = values.map((row) => JSON.stringify(row)).join("\n") + "\n";
    manifest.files[name] = { bytes: Buffer.byteLength(content), sha256: digest(content) };
    await writeFile(path.join(directory, name), content);
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const metadata = {
    schemaVersion: 1,
    ownerId: "alice",
    clientRunId: runId,
    purpose: "community",
    definitions: {
      benchmark: {
        id: "test-benchmark",
        version: "1",
        contract: "test-contract",
        kind: "experimental",
        hash: "d".repeat(64),
      },
      taskSet: { hash: "d".repeat(64), taskIds: [trial.taskId] },
      harnesses: [{ id: "h", name: "Test", version: "1", sourceHash: "d".repeat(64) }],
      runner: { id: "test-runner", name: "Test", version: "1" },
    },
  };
  await writeFile(path.join(directory, "submission.json"), JSON.stringify(metadata) + "\n");
  return metadata;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-correction-"));
  const repository = "owner/dataset";
  const snapshot = path.join(root, "snapshot");
  const store = path.join(root, "store");
  const requests = [];
  for (const candidate of [1, 2, 3]) {
    const runId = `test-run-${candidate}`;
    const previous = path.join(root, `old-${candidate}`);
    const next = path.join(root, `new-${candidate}`);
    const metadata = await bundle(previous, runId);
    await ingestSubmission(
      store,
      {
        ownerId: "alice",
        submittedBy: {
          platform: "huggingface",
          accountId: "alice",
          profileUrl: "https://huggingface.co/alice",
        },
        submissionUrl: `https://huggingface.co/datasets/${repository}/discussions/${candidate}`,
        verification: "unverified",
      },
      await buildSubmission(previous, metadata),
    );
    await cp(previous, next, { recursive: true });
    const round = JSON.parse(await readFile(path.join(next, "rounds.jsonl"), "utf8"));
    Object.assign(round, {
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      totalTokens: 17,
      costUsd: 0.1,
    });
    const content = JSON.stringify(round) + "\n";
    await writeFile(path.join(next, "rounds.jsonl"), content);
    const manifest = JSON.parse(await readFile(path.join(next, "manifest.json"), "utf8"));
    manifest.files["rounds.jsonl"] = { bytes: Buffer.byteLength(content), sha256: digest(content) };
    const manifestContent = JSON.stringify(manifest, null, 2) + "\n";
    await writeFile(path.join(next, "manifest.json"), manifestContent);
    if (candidate < 3)
      requests.push({
        candidate,
        author: "alice",
        candidateCommit,
        manifestSha256: digest(manifestContent),
        roundsSha256: digest(content),
        totalTokens: 17,
        costUsd: 0.1,
      });
  }
  await buildPublicDatasetFromStore(snapshot, store);
  const mutations = [];
  const hub = {
    async *listCommits() {
      yield { oid: parent };
    },
    async downloadFile(options) {
      const match = options.path.match(/^candidates\/test-run-(\d)\/(.+)$/u);
      const file = match
        ? path.join(root, `new-${match[1]}`, match[2])
        : path.join(snapshot, options.path);
      assert.equal(options.revision, match ? candidateCommit : parent);
      return new Blob([await readFile(file)]);
    },
    async commit(options) {
      mutations.push({ type: "commit", options });
      return { commit: { oid: published } };
    },
  };
  const fetchImpl = async (url, options) => {
    if (options?.method === "POST") {
      mutations.push({ type: "comment", url, options });
      return { ok: true };
    }
    const number = Number(url.split("/").at(-1));
    return {
      ok: true,
      json: async () => ({
        isPullRequest: true,
        status: "open",
        title: `Contribute benchmark observation test-run-${number}`,
        author: { name: "alice" },
        events: [{ type: "commit", data: { oid: candidateCommit } }],
      }),
    };
  };
  const options = {
    repository,
    requests,
    accessToken: "test-token",
    workspaceDirectory: path.join(root, "work"),
    hub,
    fetchImpl,
  };
  return { root, options, mutations, snapshot };
}

test("dry run prepares corrected views without publishing or commenting", async () => {
  const f = await fixture();
  try {
    const result = await correctUsage(f.options);
    assert.equal(result.changed, false);
    assert.equal(result.observationCount, 3);
    assert.equal(result.corrected.length, 2);
    assert.deepEqual(f.mutations, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("production replaces a batch in one parent-checked commit before posting receipts", async () => {
  const f = await fixture();
  try {
    const result = await correctUsage({
      ...f.options,
      dryRun: false,
      expectedDatasetRevision: parent,
    });
    assert.equal(result.changed, true);
    assert.equal(result.datasetRevision, published);
    assert.deepEqual(
      f.mutations.map((item) => item.type),
      ["commit", "comment", "comment"],
    );
    const options = f.mutations[0].options;
    assert.equal(options.parentCommit, parent);
    assert.ok(options.operations.every((item) => item.operation === "addOrUpdate"));
    assert.ok(options.operations.every((item) => !item.path.startsWith("candidates/")));
    assert.ok(options.operations.every((item) => !item.path.includes("test-run-3.jsonl.gz")));
    const index = JSON.parse(
      await options.operations.find((item) => item.path === "dataset-index.json").content.text(),
    );
    const previous = JSON.parse(
      await readFile(path.join(f.snapshot, "dataset-index.json"), "utf8"),
    );
    assert.deepEqual(
      index.runs.map((run) => [run.runId, run.submissionId]),
      previous.runs.map((run) => [run.runId, run.submissionId]),
    );
    assert.deepEqual(index.runs[2], previous.runs[2]);
    const state = JSON.parse(
      await options.operations.find((item) => item.path === "aggregate-state.json").content.text(),
    );
    assert.equal(state.contributions[0].trials[0].metrics.totalTokens.total, 17);
    assert.equal(state.contributions[0].trials[0].metrics.costUsd.total, 0.1);
    const shard = options.operations.find(
      (item) => item.path === "data/rounds/test-run-1.jsonl.gz",
    );
    assert.equal(
      JSON.parse(gunzipSync(Buffer.from(await shard.content.arrayBuffer())).toString("utf8"))
        .totalTokens,
      17,
    );
    assert.ok(f.mutations.slice(1).every((item) => item.url.endsWith("/comment")));
    assert.ok(result.corrected.every((item) => item.receiptPosted));
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("publication conflicts post no receipts, while receipt failures retain the Dataset commit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      correctUsage({
        ...f.options,
        dryRun: false,
        expectedDatasetRevision: parent,
        hub: {
          ...f.options.hub,
          commit: async () => {
            throw Error("parent conflict");
          },
        },
      }),
      /parent conflict/,
    );
    assert.deepEqual(f.mutations, []);
    const result = await correctUsage({
      ...f.options,
      dryRun: false,
      expectedDatasetRevision: parent,
      fetchImpl: async (url, options) =>
        options?.method === "POST"
          ? { ok: false, status: 503, text: async () => "temporarily unavailable" }
          : f.options.fetchImpl(url, options),
    });
    assert.equal(result.changed, true);
    assert.equal(result.datasetRevision, published);
    assert.equal(f.mutations.length, 1);
    assert.ok(
      result.corrected.every(
        (item) => item.receiptPosted === false && item.receiptError.includes("503"),
      ),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a bad second bundle or contributor aborts the entire batch before external writes", async () => {
  const f = await fixture();
  try {
    for (const override of [
      { manifestSha256: "f".repeat(64) },
      { author: "mallory" },
      { totalTokens: 99 },
      { candidateCommit: "f".repeat(40) },
    ]) {
      await assert.rejects(
        correctUsage({
          ...f.options,
          dryRun: false,
          expectedDatasetRevision: parent,
          requests: [f.options.requests[0], { ...f.options.requests[1], ...override }],
        }),
      );
      assert.deepEqual(f.mutations, []);
    }
    await assert.rejects(
      correctUsage({ ...f.options, dryRun: false, expectedDatasetRevision: "f".repeat(40) }),
      /Dataset changed since review/,
    );
    assert.deepEqual(f.mutations, []);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
