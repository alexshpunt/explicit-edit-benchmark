import assert from "node:assert/strict";
import test from "node:test";

import {
  applyHistoricalContributorAttribution,
  canonicalizeModelProviderRows,
  completeRunEvidence,
  datasetCommunityProjection,
  familyGroupScores,
  latestHarnessGroups,
  modelLeaderboard,
} from "../../scripts/build-public-dataset.mjs";

function row(version, taskIds, passed) {
  return {
    harnessFamily: "pi-agent-ide",
    harnessVersion: version,
    benchmarkTaskCount: 226,
    taskCount: taskIds.length,
    complete: taskIds.length === 226,
    coverage: taskIds.length / 226,
    firstExactRate: Number(passed),
    finalExactRate: Number(passed),
    qualityScore: Number(passed),
    score: Number(passed) * (taskIds.length / 226),
    observations: taskIds.length,
  };
}

test("public projections repair Luna provider identity and configuration references", () => {
  const registry = {
    models: [
      {
        id: "gpt-5.6-luna",
        providerAliases: [{ from: "agent-proxy", to: "openai-codex" }],
      },
    ],
  };
  const configuration = {
    modelFamily: "gpt-5.6-luna",
    provider: "agent-proxy",
    configurationHash: "old-hash",
  };
  const profile = {
    modelFamily: "gpt-5.6-luna",
    provider: "agent-proxy",
    configurationHash: "old-hash",
  };

  const canonical = canonicalizeModelProviderRows([profile], [configuration], registry);

  assert.equal(canonical.profiles[0].provider, "openai-codex");
  assert.equal(canonical.configurations[0].provider, "openai-codex");
  assert.match(canonical.configurations[0].configurationHash, /^[a-f0-9]{64}$/u);
  assert.equal(
    canonical.profiles[0].configurationHash,
    canonical.configurations[0].configurationHash,
  );
});

test("published model rows keep providers separate", () => {
  const groups = {
    "mimo-v2.5\txiaomi": { score: 0.4 },
    "mimo-v2.5\topencode-go": { score: 0.9 },
  };
  const rows = [
    { modelFamily: "mimo-v2.5", provider: "xiaomi", harnessFamily: "pi", rankingEligible: true },
    {
      modelFamily: "mimo-v2.5",
      provider: "opencode-go",
      harnessFamily: "codex",
      rankingEligible: true,
    },
  ];

  assert.deepEqual(
    modelLeaderboard(groups, rows).map(({ modelFamily, provider, score }) => ({
      modelFamily,
      provider,
      score,
    })),
    [
      { modelFamily: "mimo-v2.5", provider: "opencode-go", score: 0.9 },
      { modelFamily: "mimo-v2.5", provider: "xiaomi", score: 0.4 },
    ],
  );
});

test("model routes are grouped by provider before the model family summary", () => {
  const rows = [
    {
      modelFamily: "mimo-v2.5",
      provider: "xiaomi",
      agentFamily: "agent",
      harnessFamily: "harness",
      thinking: "low",
      complete: true,
      rankingEligible: true,
      score: 0.4,
    },
    {
      modelFamily: "mimo-v2.5",
      provider: "opencode-go",
      agentFamily: "agent",
      harnessFamily: "harness",
      thinking: "low",
      complete: true,
      rankingEligible: true,
      score: 0.9,
    },
  ];

  const groups = familyGroupScores(rows);

  assert.equal(groups.modelRoute["mimo-v2.5\txiaomi"].score, 0.4);
  assert.equal(groups.modelRoute["mimo-v2.5\topencode-go"].score, 0.9);
  assert.equal(groups.modelFamily["mimo-v2.5"].score, 0.65);
});

test("task-family groups use slices from globally complete configurations", () => {
  const identity = {
    modelFamily: "model",
    agentFamily: "agent",
    harnessFamily: "harness",
    harnessVersion: "1.0.0",
    thinking: "low",
  };
  const eligible = { ...identity, complete: true, score: 0.8 };
  const taskFamilySlice = {
    ...identity,
    complete: false,
    score: 0.6,
    qualityScore: 0.75,
    coverage: 0.8,
  };

  const groups = familyGroupScores([taskFamilySlice], [eligible], "qualityScore");

  assert.equal(groups.harnessFamily.harness.score, 0.75);
  assert.equal(groups.harnessFamily.harness.completeConfigurationCount, 1);
});

test("historical attribution credits only runs backed by a confirmed Dataset PR", () => {
  const runs = [
    { runId: "confirmed", ownerId: "alice" },
    { runId: "already-current", submittedBy: { accountId: "current" } },
    { runId: "unknown", ownerId: "owner/repository" },
  ];
  const registry = {
    confirmed: {
      platform: "huggingface",
      accountId: "alice",
      profileUrl: "https://huggingface.co/alice",
      submissionUrl: "https://huggingface.co/datasets/example/data/discussions/7",
    },
    "already-current": {
      platform: "huggingface",
      accountId: "historical",
      profileUrl: "https://huggingface.co/historical",
      submissionUrl: "https://huggingface.co/datasets/example/data/discussions/8",
    },
  };

  assert.deepEqual(applyHistoricalContributorAttribution(runs, registry), [
    {
      runId: "confirmed",
      ownerId: "alice",
      submittedBy: {
        platform: "huggingface",
        accountId: "alice",
        profileUrl: "https://huggingface.co/alice",
      },
      submissionUrl: "https://huggingface.co/datasets/example/data/discussions/7",
    },
    { runId: "already-current", submittedBy: { accountId: "current" } },
    { runId: "unknown", ownerId: "owner/repository" },
  ]);
});

test("community projection credits only confirmed people and lists every accepted harness", () => {
  const runs = [
    {
      runId: "run-a",
      submittedBy: {
        platform: "huggingface",
        accountId: "alice",
        profileUrl: "https://huggingface.co/alice",
      },
    },
    { runId: "run-b", ownerId: "owner/repository" },
    {
      runId: "run-c",
      submittedBy: {
        platform: "github",
        accountId: "bob",
        profileUrl: "https://github.com/bob",
      },
    },
  ];
  const profiles = [
    { runId: "run-a", configurationHash: "config-a", harnessFamily: "pi-default" },
    { runId: "run-b", configurationHash: "config-b", harnessFamily: "custom" },
    { runId: "run-c", configurationHash: "config-a", harnessFamily: "pi-default" },
  ];

  const projection = datasetCommunityProjection(runs, profiles);

  assert.deepEqual(
    projection.contributors.map((item) => [item.accountId, item.acceptedRuns, item.configurations]),
    [
      ["alice", 1, 1],
      ["bob", 1, 1],
    ],
  );
  assert.deepEqual(
    projection.harnesses.map((item) => [item.harnessFamily, item.acceptedRuns]),
    [
      ["custom", 1],
      ["pi-default", 2],
    ],
  );
});

test("badge score uses the latest complete harness version", () => {
  const completeTasks = Array.from({ length: 226 }, (_, index) => `task-${index}`);
  const groups = latestHarnessGroups([
    row("0.5.0", completeTasks, true),
    row("0.5.1", completeTasks, false),
  ]);
  const badge = groups["pi-agent-ide"];
  assert.equal(badge.harnessVersion, "0.5.1");
  assert.equal(badge.coverage, 1);
  assert.equal(badge.taskCount, 226);
  assert.equal(badge.score, 0);
});

test("badge score excludes quarantined configurations", () => {
  const completeTasks = Array.from({ length: 226 }, (_, index) => `task-${index}`);
  const groups = latestHarnessGroups([
    { ...row("0.5.1", completeTasks, true), rankingEligible: true },
    { ...row("0.5.1", completeTasks, false), rankingEligible: false },
  ]);

  assert.equal(groups["pi-agent-ide"].score, 1);
  assert.equal(groups["pi-agent-ide"].completeConfigurationCount, 1);
});

test("badge evidence excludes an incomplete run entirely", () => {
  const taskIds = ["task-0", "task-1"];
  const index = {
    runs: ["full", "partial"].map((runId) => ({
      runId,
      definitions: { taskSet: { taskIds } },
    })),
  };
  const profiles = [
    { runId: "full", profileId: "profile" },
    { runId: "partial", profileId: "profile" },
  ];
  const trials = [
    ...taskIds.map((taskId) => ({ runId: "full", profileId: "profile", taskId })),
    { runId: "partial", profileId: "profile", taskId: "task-0" },
  ];
  const evidence = completeRunEvidence(index, profiles, trials, []);
  assert.deepEqual(
    evidence.index.runs.map((run) => run.runId),
    ["full"],
  );
  assert.equal(evidence.trials.length, 2);
});
