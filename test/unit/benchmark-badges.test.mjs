import assert from "node:assert/strict";
import test from "node:test";

import { aggregateLeaderboard } from "../../scripts/result-aggregation.mjs";
import { datasetBenchmarkCounts } from "../../scripts/build-public-dataset.mjs";
import { syncBenchmarkBadges } from "../../scripts/sync-readme-community.mjs";

const original = "explicit-edit/explicit-edit";
const team = "explicit-edit-multi-agent";

function run(runId, benchmarkId) {
  return {
    runId,
    contract: benchmarkId,
    definitions: { benchmark: { id: benchmarkId, version: "1" } },
    submittedBy: {
      platform: "huggingface",
      accountId: "alice",
      profileUrl: "https://huggingface.co/alice",
    },
  };
}

test("published benchmark counts separate shared models, harnesses and contributors by run", () => {
  const runs = [run("old-a", original), run("old-b", original), run("team-a", team)];
  const profiles = runs.map(({ runId }) => ({
    runId,
    profileId: "same-id",
    modelFamily: "model",
    provider: "provider",
    agentFamily: "agent",
    harnessFamily: "pi",
    configurationHash: "same-config",
  }));
  const trials = [
    { runId: "old-a", taskId: "one" },
    { runId: "old-b", taskId: "one" },
    { runId: "team-a", taskId: "barrier", taskIds: ["one", "two", "three"] },
  ];
  const deliveries = trials.map((trial) => ({
    ...trial,
    profileId: "same-id",
    trialId: trial.runId,
    rounds: 1,
    firstExactPassed: true,
    finalExactPassed: true,
  }));
  const rows = aggregateLeaderboard({ runs }, profiles, deliveries, []);
  assert.ok(rows[0].runIds.includes("team-a"));
  assert.equal(rows[0].runId, undefined);
  const counts = datasetBenchmarkCounts(runs, profiles, deliveries, []);
  assert.deepEqual(counts[original], {
    suites: 1,
    runs: 2,
    contributors: 1,
    observations: 2,
    models: 1,
    configurations: 1,
    harnesses: 1,
  });
  assert.deepEqual(counts[team], {
    suites: 1,
    runs: 1,
    contributors: 1,
    observations: 3,
    models: 1,
    configurations: 1,
    harnesses: 1,
  });
  assert.deepEqual(datasetBenchmarkCounts([], [], [], []), {});
});

test("README counters update only their suite block and unpublished suites stay zero", () => {
  const source = [
    "before",
    `<!-- benchmark-badges:${team}:start -->`,
    "team stale",
    `<!-- benchmark-badges:${team}:end -->`,
    "between",
    `<!-- benchmark-badges:${original}:start -->`,
    "old stale",
    `<!-- benchmark-badges:${original}:end -->`,
    "after",
  ].join("\n");
  const community = {
    benchmarks: {
      [original]: {
        suites: 1,
        runs: 160,
        contributors: 6,
        observations: 40249,
        models: 34,
        configurations: 177,
        harnesses: 36,
      },
    },
  };
  const updated = syncBenchmarkBadges(source, community);
  const teamBlock = updated.split("between")[0];
  const oldBlock = updated.split("between")[1];
  assert.match(teamBlock, /badge\/runs-0-blue/);
  assert.match(teamBlock, /badge\/contributors-0-blue/);
  assert.doesNotMatch(teamBlock, /160|40249/);
  assert.match(oldBlock, /badge\/runs-160-blue/);
  assert.match(oldBlock, /badge\/observations-40249-blue/);
  assert.match(teamBlock, /filter.benchmark=explicit-edit-multi-agent/);
  assert.match(oldBlock, /filter.benchmark=explicit-edit%2Fexplicit-edit/);
  assert.ok(updated.startsWith("before\n"));
  assert.ok(updated.endsWith("\nafter"));
  assert.equal(syncBenchmarkBadges(updated, community), updated);
  assert.equal(syncBenchmarkBadges(updated, { contributors: [] }), updated);
  assert.throws(
    () => syncBenchmarkBadges(source, { benchmarks: { [team]: { runs: -1 } } }),
    /Invalid benchmark count/,
  );
});
