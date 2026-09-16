import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateGroupScore,
  aggregateLeaderboard,
  aggregateToolUsage,
  canonicalModelFamily,
  describeDistribution,
  filterOptions,
  parseJsonLines,
  taskFamily,
  toolTrialCounts,
} from "../../scripts/result-aggregation.mjs";

const index = {
  runs: [
    {
      runId: "run-a",
      submissionId: "submission-a",
      contract: "edit-v1",
      definitions: {
        runner: { id: "explicit-edit-benchmark", version: "0.1.0" },
        benchmark: { id: "org/edit", version: "1" },
        taskSet: { taskIds: ["replace-all-10-plain", "language-replace-10-typescript-plain"] },
      },
    },
  ],
};
const profiles = [
  {
    runId: "run-a",
    profileId: "profile-a",
    modelFamily: "acme/model",
    modelVersion: "2026-09",
    agentFamily: "pi",
    agentVersion: "1.2.3",
    harnessFamily: "ide",
    harnessVersion: "4.5.6",
    provider: "acme",
    configurationHash: "same-config",
    configurationLabels: ["tools/read"],
    thinking: "low",
  },
];
const trials = [
  {
    runId: "run-a",
    trialId: "trial-pass",
    taskId: "replace-all-10-plain",
    profileId: "profile-a",
    rounds: 2,
    firstExactPassed: true,
    finalExactPassed: true,
  },
  {
    runId: "run-a",
    trialId: "trial-fail",
    taskId: "language-replace-10-typescript-plain",
    profileId: "profile-a",
    rounds: 1,
    finalExactPassed: true,
  },
];
const rounds = [
  { runId: "run-a", trialId: "trial-pass", seconds: 2, costUsd: 0.1, totalTokens: 100 },
  { runId: "run-a", trialId: "trial-pass", seconds: 3, costUsd: 0.2, totalTokens: 200 },
  { runId: "run-a", trialId: "trial-fail", seconds: 5, costUsd: null, totalTokens: null },
];

/** Compare the named fields recursively, so a result may carry extra detail. */
function assertMatchesObject(actual, expected) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `expected an array, received ${JSON.stringify(actual)}`);
    assert.equal(actual.length, expected.length);
    expected.forEach((item, position) => assertMatchesObject(actual[position], item));
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(
      actual && typeof actual === "object",
      `expected an object, received ${JSON.stringify(actual)}`,
    );
    for (const [key, value] of Object.entries(expected)) assertMatchesObject(actual[key], value);
    return;
  }
  assert.deepEqual(actual, expected);
}

/** Compare two numbers with a tolerance instead of exact float equality. */
function assertCloseTo(actual, expected, digits = 2) {
  assert.ok(
    Math.abs(actual - expected) < 0.5 * 10 ** -digits,
    `expected ${actual} to be within ${digits} digits of ${expected}`,
  );
}

await test("leaderboard data: parses JSONL with blank lines", () => {
  assert.deepEqual(parseJsonLines('{"id":1}\n\n {"id":2}\n'), [{ id: 1 }, { id: 2 }]);
});

await test("leaderboard data: normalizes qualified and unqualified model identities", () => {
  assert.equal(canonicalModelFamily("deepseek/deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(canonicalModelFamily("deepseek-v4-flash"), "deepseek-v4-flash");
  assert.equal(canonicalModelFamily("zai/glm-5.3-flash"), "glm-5.3-flash");
  assert.equal(canonicalModelFamily("openai/gpt-5.6-luna"), "gpt-5.6-luna");
});

await test("leaderboard data: assigns useful task families", () => {
  assert.equal(taskFamily("language-insert-1-python-plain"), "Language edits");
  assert.equal(taskFamily("delete-subset-100-unicode"), "Subset edits");
  assert.equal(taskFamily("move-block-10-plain"), "Block edits");
});

await test("leaderboard data: aggregates exact pass rate and complete per-trial efficiency coverage", () => {
  const [row] = aggregateLeaderboard(index, profiles, trials, rounds);
  assertMatchesObject(row, {
    observations: 2,
    recoveryRounds: 1,
    submissionIds: ["submission-a"],
    firstExactRate: 0.5,
    finalExactRate: 1,
    recoveryGain: 0.5,
    score: 0.625,
    taskCount: 2,
    benchmarkTaskCount: 2,
    coverage: 1,
    complete: true,
    modelFamily: "acme/model",
    modelVersion: "2026-09",
    agentFamily: "pi",
    agentVersion: "1.2.3",
    harnessFamily: "ide",
    harnessVersion: "4.5.6",
    provider: "acme",
    contract: "edit-v1",
    configurationHash: "same-config",
    duration: { total: 10, observations: 2 },
    durationSummary: {
      averageCase: 5,
      coveredRun: 10,
      totalObserved: 10,
      coveredTasks: 2,
    },
    cost: { total: 0.30000000000000004, observations: 1 },
    tokens: { total: 300, observations: 1 },
  });
});

await test("leaderboard data: unions partial runs by exact configuration and balances tasks instead of observations", () => {
  const secondRun = { ...index.runs[0], runId: "run-b" };
  const secondProfile = { ...profiles[0], runId: "run-b" };
  const repeatedTask = {
    runId: "run-b",
    trialId: "trial-repeat",
    taskId: "replace-all-10-plain",
    profileId: "profile-a",
    rounds: 0,
    firstExactPassed: false,
    finalExactPassed: false,
  };
  const [row] = aggregateLeaderboard(
    { runs: [...index.runs, secondRun] },
    [...profiles, secondProfile],
    [...trials, repeatedTask],
    rounds,
  );
  assertMatchesObject(row, {
    observations: 3,
    taskCount: 2,
    benchmarkTaskCount: 2,
    firstExactRate: 0.25,
    finalExactRate: 0.75,
    recoveryGain: 0.5,
    score: 0.375,
    qualityScore: 0.375,
    runIds: ["run-a", "run-b"],
  });
});

await test("leaderboard data: ranks complete evidence ahead of a higher-scoring partial configuration", () => {
  const partialProfile = {
    ...profiles[0],
    profileId: "profile-partial",
    configurationHash: "partial-config",
    transport: "different-transport",
  };
  const partialTrial = {
    ...trials[0],
    profileId: "profile-partial",
    trialId: "trial-partial",
  };
  const rows = aggregateLeaderboard(
    index,
    [...profiles, partialProfile],
    [...trials, partialTrial],
    rounds,
  );
  assert.deepEqual(
    rows.map((row) => [row.configurationHash, row.complete, row.score]),
    [
      ["same-config", true, 0.625],
      ["partial-config", false, 0.5],
    ],
  );
});

await test("leaderboard data: macro-averages benchmark families and versions when benchmark is All", () => {
  const otherRun = {
    runId: "run-other",
    contract: "search-v1",
    definitions: {
      runner: { id: "explicit-edit-benchmark", version: "0.1.0" },
      benchmark: { id: "org/search", version: "1" },
    },
  };
  const otherProfile = { ...profiles[0], runId: otherRun.runId };
  const otherTrial = {
    runId: otherRun.runId,
    trialId: "search-fail",
    taskId: "search-one",
    profileId: "profile-a",
    rounds: 0,
    firstExactPassed: false,
    finalExactPassed: false,
  };
  const [row] = aggregateLeaderboard(
    { runs: [...index.runs, otherRun] },
    [...profiles, otherProfile],
    [...trials, otherTrial],
    rounds,
  );
  assertMatchesObject(row, {
    benchmarkId: "All · 2 families",
    benchmarkVersion: "2 versions",
    score: 0.3125,
    complete: true,
    benchmarkFamilyCount: 2,
    benchmarkVersionCount: 2,
  });
});

await test("leaderboard data: does not penalize a complete configuration for reasoning modes used by another configuration", () => {
  const unrelatedProfile = {
    ...profiles[0],
    profileId: "profile-high-other-harness",
    harnessFamily: "other-harness",
    harnessVersion: "1.0.0",
    configurationHash: "other-config",
    thinking: "high",
  };
  const unrelatedTrial = {
    ...trials[0],
    profileId: unrelatedProfile.profileId,
    trialId: "trial-high-other-harness",
  };
  const rows = aggregateLeaderboard(
    index,
    [...profiles, unrelatedProfile],
    [...trials, unrelatedTrial],
    rounds,
  );
  const complete = rows.find((row) => row.harnessFamily === "ide");
  assertMatchesObject(complete, { coverage: 1, score: 0.625, complete: true });
});

await test("leaderboard data: macro-averages reasoning modes into one configuration when reasoning is All", () => {
  const highProfile = {
    ...profiles[0],
    profileId: "profile-high-same-version",
    configurationHash: "high-reasoning-config",
    thinking: "high",
  };
  const highTrial = {
    ...trials[0],
    profileId: highProfile.profileId,
    trialId: "trial-high-same-version",
    firstExactPassed: false,
    finalExactPassed: false,
  };
  const [row] = aggregateLeaderboard(
    index,
    [...profiles, highProfile],
    [...trials, highTrial],
    rounds,
  );
  assertMatchesObject(row, {
    thinking: "All · 2 modes",
    qualityScore: 0.3125,
    score: 0.234375,
    observations: 3,
    configurationHashes: ["high-reasoning-config", "same-config"],
  });
  assert.equal(
    aggregateLeaderboard(index, [...profiles, highProfile], [...trials, highTrial], rounds, {
      reasoning: ["low"],
    })[0].thinking,
    "low",
  );
});

await test("leaderboard data: filters and sorts exact configurations by reasoning", () => {
  const highProfile = {
    ...profiles[0],
    profileId: "profile-high",
    configurationHash: "high-config",
    thinking: "high",
    agentVersion: "1.10.0",
  };
  const highTrial = { ...trials[0], profileId: "profile-high", trialId: "trial-high" };
  const highRounds = rounds.slice(0, 2).map((round) => ({
    ...round,
    trialId: "trial-high",
  }));
  const sorted = aggregateLeaderboard(
    index,
    [...profiles, highProfile],
    [...trials, highTrial],
    [...rounds, ...highRounds],
    { sortBy: "reasoning", sortDirection: "asc" },
  );
  assert.deepEqual(
    sorted.map((row) => row.thinking),
    ["high", "low"],
  );
  const versionSorted = aggregateLeaderboard(
    index,
    [...profiles, highProfile],
    [...trials, highTrial],
    [...rounds, ...highRounds],
    { sortBy: "agentVersion", sortDirection: "asc" },
  );
  assert.deepEqual(
    versionSorted.map((row) => row.agentVersion),
    ["1.2.3", "1.10.0"],
  );
  assert.equal(
    aggregateLeaderboard(index, [...profiles, highProfile], [...trials, highTrial], rounds, {
      reasoning: ["high"],
    }).length,
    1,
  );
});

await test("leaderboard data: filters trials before aggregation and exposes sorted choices", () => {
  const rows = aggregateLeaderboard(index, profiles, trials, rounds, {
    taskFamily: ["Replace all"],
    harness: ["ide"],
  });
  assert.equal(rows.length, 1);
  assertMatchesObject(rows[0], { observations: 1, firstExactRate: 1, finalExactRate: 1 });
  assert.equal(
    aggregateLeaderboard(index, profiles, trials, rounds, {
      agentVersion: ["pi\t1.2.3"],
      harnessVersion: ["ide\t4.5.6"],
    }).length,
    1,
  );
  assert.deepEqual(filterOptions(index, profiles, trials), {
    benchmarks: ["org/edit"],
    runners: ["explicit-edit-benchmark"],
    providers: ["acme"],
    models: ["model"],
    agents: ["pi"],
    agentVersions: ["pi\t1.2.3"],
    harnesses: ["ide"],
    harnessVersions: ["ide\t4.5.6"],
    benchmarkVersions: ["org/edit\t1"],
    reasoning: ["low"],
    taskFamilies: ["Language edits", "Replace all"],
  });
  assert.equal(
    aggregateLeaderboard(index, profiles, trials, rounds, { model: ["model"] }).length,
    1,
  );
  assert.deepEqual(
    aggregateLeaderboard(index, profiles, trials, rounds, { model: ["other-model"] }),
    [],
  );
});

await test("leaderboard data: scales a one-task perfect result by benchmark coverage", () => {
  const completeTrials = Array.from({ length: 226 }, (_, taskIndex) => ({
    runId: "run-a",
    trialId: `baseline-${taskIndex}`,
    taskId: `task-${taskIndex}`,
    profileId: "profile-a",
    rounds: 0,
    firstExactPassed: false,
    finalExactPassed: false,
  }));
  const partialProfile = {
    ...profiles[0],
    profileId: "profile-partial",
    configurationHash: "partial-config",
    transport: "partial",
  };
  const partialTrial = {
    ...completeTrials[0],
    trialId: "partial-pass",
    profileId: partialProfile.profileId,
    firstExactPassed: true,
    finalExactPassed: true,
  };
  const completeIndex = {
    runs: [
      {
        ...index.runs[0],
        definitions: {
          ...index.runs[0].definitions,
          taskSet: { taskIds: Array.from({ length: 226 }, (_, task) => `task-${task}`) },
        },
      },
    ],
  };
  const row = aggregateLeaderboard(
    completeIndex,
    [...profiles, partialProfile],
    [...completeTrials, partialTrial],
    [],
  ).find((candidate) => candidate.configurationHash === "partial-config");
  assertMatchesObject(row, { qualityScore: 1, coverage: 1 / 226, score: 1 / 226 });
});

await test("leaderboard data: a partial run cannot look complete", () => {
  const declared = {
    runs: [
      {
        runId: "run-partial",
        submissionId: "submission-partial",
        contract: "edit-v1",
        definitions: {
          runner: { id: "explicit-edit-benchmark", version: "1" },
          benchmark: { id: "org/edit", version: "1" },
          // The bundle declares the whole benchmark, even though only one task has been run.
          taskSet: { taskIds: Array.from({ length: 226 }, (_, index) => `task-${index}`) },
        },
      },
    ],
  };
  const rows = aggregateLeaderboard(
    declared,
    [{ ...profiles[0], runId: "run-partial" }],
    [{ ...trials[0], runId: "run-partial", firstExactPassed: true, finalExactPassed: true }],
    [],
  );
  assertMatchesObject(rows[0], { taskCount: 1, benchmarkTaskCount: 226, complete: false });
  assertCloseTo(rows[0].coverage, 1 / 226);
});

await test("leaderboard data: runs judged by different rules never merge", () => {
  const first = {
    ...index.runs[0],
    taskSetSha256: "set-a",
    verifierSha256: "verifier-a",
    policy: { oracleRecoveries: 5, retryFailures: 0, timeoutMs: 120000, concurrency: 1 },
  };
  const second = {
    ...first,
    runId: "run-b",
    submissionId: "submission-b",
    policy: { ...first.policy, timeoutMs: 900000 },
  };
  const rows = aggregateLeaderboard(
    { runs: [first, second] },
    [profiles[0], { ...profiles[0], runId: "run-b" }],
    [trials[0], { ...trials[0], runId: "run-b" }],
    [],
  );
  // Same benchmark, same id and version, same configuration: still two incomparable groups.
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.flatMap((row) => [...row.runIds]).sort(), ["run-a", "run-b"]);
  assert.equal(new Set(rows.map((row) => row.policy)).size, 2);
});

await test("leaderboard data: how many trials ran at once does not split a group", () => {
  const base = {
    ...index.runs[0],
    taskSetSha256: "set-a",
    verifierSha256: "verifier-a",
    policy: { oracleRecoveries: 5, retryFailures: 0, timeoutMs: 120000, concurrency: 2 },
  };
  const rows = aggregateLeaderboard(
    { runs: [base, { ...base, runId: "run-b", policy: { ...base.policy, concurrency: 10 } }] },
    [profiles[0], { ...profiles[0], runId: "run-b" }],
    [trials[0], { ...trials[0], runId: "run-b" }],
    [],
  );
  // Same rules, same task set, same verifier: one group, with the scheduling recorded next to it.
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].concurrencies, [2, 10]);
});

await test("describeDistribution: summarizes spread with quartiles instead of a single average", () => {
  assert.deepEqual(describeDistribution([1, 2, 3, 4, 5]), {
    count: 5,
    min: 1,
    p25: 2,
    median: 3,
    p75: 4,
    max: 5,
    mean: 3,
  });
  assertMatchesObject(describeDistribution([2, 1]), { count: 2, min: 1, max: 2, median: 1.5 });
});

await test("describeDistribution: returns null when nothing was observed", () => {
  assert.equal(describeDistribution([]), null);
  assert.equal(describeDistribution([Number.NaN, null, undefined]), null);
});

await test("trial samples: keeps per-trial values so any cell can explain its own spread", () => {
  const [row] = aggregateLeaderboard(index, profiles, trials, rounds);
  assert.deepEqual(
    row.trialSamples.map((sample) => [
      sample.taskId,
      sample.firstExactPassed,
      sample.finalExactPassed,
    ]),
    [
      ["replace-all-10-plain", true, true],
      ["language-replace-10-typescript-plain", false, true],
    ],
  );
  assert.equal(row.trialSamples[0].seconds, 5);
  assertCloseTo(row.trialSamples[0].costUsd, 0.3);
  assert.equal(row.trialSamples[0].tokens, 300);
  // Cost and tokens stay missing when a round did not report them.
  assert.equal(row.trialSamples[1].costUsd, null);
  assert.equal(row.trialSamples[1].tokens, null);
});

await test("tool usage: joins calls to model and harness and reports share and calls per trial", () => {
  const toolRounds = [
    { runId: "run-a", roundId: "round-pass", trialId: "trial-pass" },
    { runId: "run-a", roundId: "round-fail", trialId: "trial-fail" },
  ];
  const calls = [
    { runId: "run-a", roundId: "round-pass", tool: "read" },
    { runId: "run-a", roundId: "round-pass", tool: "read" },
    { runId: "run-a", roundId: "round-fail", tool: "replace" },
  ];

  assert.deepEqual(aggregateToolUsage(index, profiles, trials, toolRounds, calls), [
    {
      key: JSON.stringify(["model", "ide", "4.5.6"]),
      model: "model",
      harness: "ide",
      harnessVersion: "4.5.6",
      trials: 2,
      calls: 3,
      callsPerTrial: 1.5,
      tools: [
        { tool: "read", calls: 2, share: 2 / 3, callsPerTrial: 1 },
        { tool: "replace", calls: 1, share: 1 / 3, callsPerTrial: 0.5 },
      ],
    },
  ]);
  assertMatchesObject(
    aggregateToolUsage(index, profiles, trials, toolRounds, calls, {
      taskFamily: ["Replace all"],
    })[0],
    { trials: 1, calls: 2, callsPerTrial: 2 },
  );
});

await test("tool trial counts: counts one tool per trial, including trials that never called it", () => {
  const toolRounds = [
    { runId: "run-a", roundId: "round-pass", trialId: "trial-pass" },
    { runId: "run-a", roundId: "round-fail", trialId: "trial-fail" },
  ];
  const calls = [
    { runId: "run-a", roundId: "round-pass", tool: "read" },
    { runId: "run-a", roundId: "round-pass", tool: "read" },
    { runId: "run-a", roundId: "round-fail", tool: "replace" },
  ];

  assert.deepEqual(toolTrialCounts(index, profiles, trials, toolRounds, calls, "read"), [
    {
      key: JSON.stringify(["model", "ide", "4.5.6"]),
      trialId: "trial-pass",
      taskId: "replace-all-10-plain",
      calls: 2,
    },
    {
      key: JSON.stringify(["model", "ide", "4.5.6"]),
      trialId: "trial-fail",
      taskId: "language-replace-10-typescript-plain",
      calls: 0,
    },
  ]);
});

const sample = (taskId, firstExactPassed, finalExactPassed = firstExactPassed) => ({
  taskId,
  firstExactPassed,
  finalExactPassed,
});
// A configuration row as the leaderboard builds it, including the coverage
// discount that makes averaging configuration scores misleading.
const configuration = (trialSamples, benchmarkTaskCount = 4) => {
  const rate = (pick) =>
    trialSamples.reduce((total, item) => total + Number(pick(item)), 0) / trialSamples.length;
  const quality =
    0.75 * rate((item) => item.firstExactPassed) + 0.25 * rate((item) => item.finalExactPassed);
  const tasks = new Set(trialSamples.map((item) => item.taskId)).size;
  return {
    trialSamples,
    benchmarkTaskCount,
    observations: trialSamples.length,
    score: quality * (tasks / benchmarkTaskCount),
  };
};

await test("aggregateGroupScore: adds a partial run as evidence instead of letting it drag the group down", () => {
  const full = configuration([
    sample("t1", true),
    sample("t2", true),
    sample("t3", false),
    sample("t4", false),
  ]);
  const partial = configuration([sample("t1", true)]);

  const group = aggregateGroupScore([full, partial]);

  // Scores would average the coverage discount in: (0.5 + 0.25) / 2 = 0.375.
  assert.ok((0.5 + 0.25) / 2 < 0.5);
  assert.equal(group.taskCount, 4);
  assert.equal(group.coverage, 1);
  assertCloseTo(group.qualityScore, 0.5, 10);
  assertCloseTo(group.score, 0.5, 10);
});

await test("aggregateGroupScore: gives each configuration equal weight inside a task", () => {
  const repeatedPasses = configuration([
    sample("t1", true),
    sample("t1", true),
    sample("t1", true),
    sample("t1", true),
  ]);
  const oneFailure = configuration([sample("t1", false)]);

  const group = aggregateGroupScore([repeatedPasses, oneFailure]);

  assert.equal(group.observations, 5);
  assert.equal(group.firstExactRate, 0.5);
  assert.equal(group.finalExactRate, 0.5);
  assert.equal(group.qualityScore, 0.5);
});

await test("aggregateGroupScore: is invariant to row order", () => {
  const rows = [
    configuration([sample("t1", true), sample("t2", false)]),
    configuration([sample("t1", false, true)]),
  ];

  assert.deepEqual(aggregateGroupScore(rows), aggregateGroupScore(rows.toReversed()));
});

await test("aggregateGroupScore: scores a group with little evidence low instead of complete", () => {
  const group = aggregateGroupScore([configuration([sample("t1", true)])]);

  assert.equal(group.taskCount, 1);
  assert.equal(group.coverage, 0.25);
  assert.equal(group.qualityScore, 1);
  assertCloseTo(group.score, 0.25, 10);
});

await test("aggregateGroupScore: counts one task once however many configurations ran it", () => {
  const group = aggregateGroupScore([
    configuration([sample("t1", true), sample("t2", true)]),
    configuration([sample("t1", false, true), sample("t2", true)]),
  ]);

  assert.equal(group.taskCount, 2);
  assert.equal(group.observations, 4);
  assert.equal(group.coverage, 0.5);
  // t1 recovers on the second round, so the final rate is higher than first.
  assertCloseTo(group.firstExactRate, 0.75, 10);
  assert.equal(group.finalExactRate, 1);
  assertCloseTo(group.qualityScore, 0.75 * 0.75 + 0.25, 10);
});
