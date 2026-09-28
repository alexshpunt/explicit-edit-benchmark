import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAggregateState } from "../../scripts/aggregate-state.mjs";
import { verifyIncrementalDatasetState } from "../../scripts/huggingface-contributions.mjs";
import {
  acceptOfficialCandidates,
  incrementalCommitOperations,
  isDeferredHubError,
  listOpenOfficialCandidates,
} from "../../scripts/official-acceptance.mjs";

test("incremental acceptance requires source, Dataset, and aggregate state to agree", () => {
  const sourceIndex = { submissions: [{ runId: "run-1", submissionId: "submission-1" }] };
  const run = {
    runId: "run-1",
    submissionId: "submission-1",
    manifestSha256: "a".repeat(64),
  };
  const aggregateState = createAggregateState({
    sourceIndex,
    run,
    profiles: [],
    trials: [],
    rounds: [],
    toolCalls: [],
  });

  assert.equal(
    verifyIncrementalDatasetState(sourceIndex, { runs: [run] }, aggregateState),
    undefined,
  );
  assert.throws(
    () =>
      verifyIncrementalDatasetState(
        sourceIndex,
        { runs: [{ ...run, manifestSha256: "b".repeat(64) }] },
        aggregateState,
      ),
    /Dataset index does not match aggregate state/,
  );
});
test("only rate limits and server failures are deferred", () => {
  assert.equal(isDeferredHubError({ status: 429 }), true);
  assert.equal(isDeferredHubError({ status: 409 }), true);
  assert.equal(isDeferredHubError({ response: { status: 503 } }), true);
  assert.equal(isDeferredHubError(Error("Hub request failed (502)")), true);
  assert.equal(isDeferredHubError({ status: 401 }), false);
  assert.equal(isDeferredHubError(Error("invalid signature")), false);
});

test("official candidate listing keeps the execution identity for durable duplicate filtering", async () => {
  const executionId = "a".repeat(64);
  const candidates = await listOpenOfficialCandidates("owner/dataset", async () => ({
    ok: true,
    json: async () => ({
      discussions: [
        {
          num: 45,
          isPullRequest: true,
          status: "open",
          title: `Contribute official benchmark execution ${executionId}`,
        },
        { num: 44, isPullRequest: true, status: "open", title: "ordinary contribution" },
      ],
    }),
  }));
  assert.deepEqual(candidates, [{ number: 45, executionId }]);
});

test("already accepted official candidates receive a receipt and are closed", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "official-duplicate-"));
  const executionId = "a".repeat(64);
  const parentCommit = "b".repeat(40);
  const sourceIndex = { submissions: [{ runId: "run-1", submissionId: "submission-1" }] };
  const run = {
    runId: "run-1",
    submissionId: "submission-1",
    manifestSha256: "c".repeat(64),
    official: { executionId },
  };
  const aggregateState = createAggregateState({
    sourceIndex,
    run,
    profiles: [],
    trials: [],
    rounds: [],
    toolCalls: [],
  });
  const documents = {
    "source/index.json": sourceIndex,
    "dataset-index.json": { runs: [run] },
    "aggregate-state.json": aggregateState,
  };
  const closed = [];
  const hub = {
    async *listCommits() {
      yield { oid: parentCommit };
    },
    async downloadFile({ path: filePath }) {
      return new Blob([JSON.stringify(documents[filePath])]);
    },
  };

  try {
    const result = await acceptOfficialCandidates({
      repository: "owner/dataset",
      candidateNumbers: [{ number: 44, executionId }],
      accessToken: "dataset-token",
      discussionAccessToken: "discussion-token",
      workspaceDirectory: workspace,
      hub,
      close: async (...args) => closed.push(args),
    });

    assert.equal(result.changed, false);
    assert.equal(result.datasetRevision, parentCommit);
    assert.deepEqual(result.addedRuns, []);
    assert.equal(result.commitOid, null);
    assert.equal(result.accepted[0].candidateClosed, true);
    assert.deepEqual(closed, [
      [
        "owner/dataset",
        44,
        "discussion-token",
        `Execution ${executionId} was already accepted on Dataset main at ${parentCommit}.`,
      ],
    ]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("incremental commit contains only new source, shards, and compact views", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "incremental-commit-"));
  try {
    await Promise.all([
      mkdir(path.join(root, "source", "accepted", "new-submission"), { recursive: true }),
      mkdir(path.join(root, "data", "trials"), { recursive: true }),
      writeFile(path.join(root, "aggregate-state.json"), "{}\n"),
    ]);
    await Promise.all([
      writeFile(path.join(root, "source", "index.json"), "{}\n"),
      writeFile(path.join(root, "source", "accepted", "new-submission", "manifest.json"), "{}\n"),
      writeFile(path.join(root, "data", "trials", "new-run.jsonl.gz"), "new"),
      writeFile(path.join(root, "views.json"), "{}\n"),
    ]);
    const operations = await incrementalCommitOperations(root);
    const paths = operations.map((item) => item.path).sort();
    assert.deepEqual(paths, [
      "aggregate-state.json",
      "data/trials/new-run.jsonl.gz",
      "source/accepted/new-submission/manifest.json",
      "source/index.json",
      "views.json",
    ]);
    assert.ok(operations.every((item) => item.operation === "addOrUpdate"));
    assert.ok(paths.every((item) => !item.includes("old-run")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
