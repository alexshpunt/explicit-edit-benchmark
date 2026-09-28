import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptCommunityCandidates,
  listOpenCommunityCandidates,
} from "../../scripts/community-acceptance-cli.mjs";

test("community candidate listing excludes official and unrelated pull requests", async () => {
  const candidates = await listOpenCommunityCandidates("owner/dataset", async () => ({
    ok: true,
    json: async () => ({
      discussions: [
        {
          num: 78,
          isPullRequest: true,
          status: "open",
          title: "Contribute benchmark observation explicit-edit-run",
        },
        {
          num: 79,
          isPullRequest: true,
          status: "open",
          title: `Contribute official benchmark execution ${"a".repeat(64)}`,
        },
        { num: 80, isPullRequest: false, status: "open", title: "Question" },
      ],
    }),
  }));

  assert.deepEqual(candidates, [{ number: 78, runId: "explicit-edit-run" }]);
});

test("community batch accepts valid candidates and leaves invalid candidates for correction", async () => {
  const calls = [];
  const result = await acceptCommunityCandidates({
    repository: "owner/dataset",
    candidates: [
      { number: 78, runId: "valid" },
      { number: 79, runId: "invalid" },
      { number: 80, runId: "deferred" },
    ],
    accessToken: "dataset-token",
    discussionAccessToken: "discussion-token",
    workspaceDirectory: "/tmp/community-test",
    accept: async (options) => {
      calls.push({
        candidateRevision: options.candidateRevision,
        accessToken: options.accessToken,
        discussionAccessToken: options.discussionAccessToken,
      });
      if (options.candidateRevision === "79") throw Error("invalid normalized bundle");
      if (options.candidateRevision === "80")
        throw Object.assign(Error("Hub failed 503"), { status: 503 });
      return {
        runId: "valid",
        commitOid: "b".repeat(40),
        candidateCommit: "a".repeat(40),
        candidateClosed: true,
        closeError: null,
        operationCount: 19,
        index: { runs: [] },
      };
    },
  });

  assert.deepEqual(
    calls,
    ["78", "79", "80"].map((candidateRevision) => ({
      candidateRevision,
      accessToken: "dataset-token",
      discussionAccessToken: "discussion-token",
    })),
  );
  assert.equal(result.changed, true);
  assert.equal(result.datasetRevision, "b".repeat(40));
  assert.deepEqual(result.addedRuns, ["valid"]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].index, undefined);
  assert.deepEqual(
    result.rejected.map((item) => item.candidate),
    [79],
  );
  assert.deepEqual(
    result.deferred.map((item) => item.candidate),
    [80],
  );
});
