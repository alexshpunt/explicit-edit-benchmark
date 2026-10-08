import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeHuggingFaceCandidate,
  downloadHuggingFaceCandidate,
} from "../../scripts/huggingface-contributions.mjs";

const candidateFiles = [
  "manifest.json",
  "profiles.jsonl",
  "configurations.jsonl",
  "trials.jsonl",
  "rounds.jsonl",
  "tool-calls.jsonl",
  "submission.json",
];

test("accepted community candidates receive a receipt before they are closed", async () => {
  let request;
  await closeHuggingFaceCandidate(
    "owner/dataset",
    78,
    "test-token",
    "Accepted run in Dataset commit abc.",
    async (url, options) => {
      request = { url, options };
      return { ok: true };
    },
  );

  assert.equal(
    request.url,
    "https://huggingface.co/api/datasets/owner/dataset/discussions/78/status",
  );
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    status: "closed",
    comment: "Accepted run in Dataset commit abc.",
  });
});
test("community acceptance downloads only one immutable candidate bundle", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "community-candidate-"));
  const runId = "explicit-edit-test-run";
  const candidateCommit = "a".repeat(40);
  const downloads = [];
  const hub = {
    async downloadFile(options) {
      downloads.push(options);
      return new Blob([options.path]);
    },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      isPullRequest: true,
      status: "open",
      title: `Contribute benchmark observation ${runId}`,
      author: { name: "alice", type: "user" },
      events: [{ type: "commit", data: { oid: candidateCommit } }],
    }),
  });

  try {
    const result = await downloadHuggingFaceCandidate({
      hub,
      repo: { type: "dataset", name: "owner/dataset" },
      repository: "owner/dataset",
      candidateNumber: 78,
      accessToken: "test-token",
      directory,
      fetchImpl,
    });

    assert.deepEqual(result, {
      candidateCommit,
      runId,
      submittedBy: {
        platform: "huggingface",
        accountId: "alice",
        profileUrl: "https://huggingface.co/alice",
      },
      submissionUrl: "https://huggingface.co/datasets/owner/dataset/discussions/78",
    });
    assert.deepEqual(
      downloads.map((item) => item.path),
      candidateFiles.map((name) => `candidates/${runId}/${name}`),
    );
    assert.ok(downloads.every((item) => item.revision === candidateCommit));
    assert.deepEqual((await readdir(directory)).sort(), candidateFiles.toSorted());
    assert.equal(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
      `candidates/${runId}/manifest.json`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
