import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  incrementalCommitOperations,
  isDeferredHubError,
  listOpenOfficialCandidates,
} from "../../scripts/official-acceptance.mjs";

test("only rate limits and server failures are deferred", () => {
  assert.equal(isDeferredHubError({ status: 429 }), true);
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
