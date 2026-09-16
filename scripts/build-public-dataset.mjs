#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";
import {
  aggregateGroupScore,
  aggregateLeaderboard,
  aggregateToolUsage,
  taskFamily,
} from "./result-aggregation.mjs";
const TABLES = ["profiles", "configurations", "trials", "rounds", "tool-calls"];

function withRunId(content, runId) {
  return (
    content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.stringify({ runId, ...JSON.parse(line) }))
      .join("\n") + "\n"
  );
}

/**
 * One row per model family, built from the same aggregates the Explorer shows. This is the table
 * people ask for first: how a model did overall, across every harness that ran it.
 */
/** Percent for the card, or a dash when a value was never observed. */
function formatScore(value) {
  return value == null ? "-" : `${(value * 100).toFixed(1)}%`;
}

function modelLeaderboard(groups = {}, leaderboardRows = []) {
  const harnesses = new Map();
  for (const row of leaderboardRows) {
    const families = harnesses.get(row.modelFamily) ?? new Set();
    families.add(row.harnessFamily);
    harnesses.set(row.modelFamily, families);
  }
  return Object.entries(groups)
    .map(([modelFamily, group]) => ({
      modelFamily,
      score: group.score ?? null,
      qualityScore: group.qualityScore ?? null,
      coverage: group.coverage ?? null,
      firstExactRate: group.firstExactRate ?? null,
      finalExactRate: group.finalExactRate ?? null,
      taskCount: group.taskCount ?? null,
      benchmarkTaskCount: group.benchmarkTaskCount ?? null,
      observations: group.observations ?? null,
      harnessFamilies: [...(harnesses.get(modelFamily) ?? [])].sort(),
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function datasetCard({ includeSubmissions = false, models = [] } = {}) {
  const tables = [
    ["profiles", "data/profiles/*.jsonl.gz"],
    ["configurations", "data/configurations/*.jsonl.gz"],
    ["trials", "data/trials/*.jsonl.gz"],
    ["rounds", "data/rounds/*.jsonl.gz"],
    ["tool-calls", "data/tool-calls/*.jsonl.gz"],
    ...(models.length ? [["models", "data/models.jsonl.gz"]] : []),
    ...(includeSubmissions ? [["submissions", "data/submissions.jsonl.gz"]] : []),
  ];
  const configs = tables
    .map(([name, file]) =>
      [
        `  - config_name: ${name}`,
        "    data_files:",
        "      - split: train",
        `        path: ${file}`,
      ].join("\n"),
    )
    .join("\n");
  return [
    "---",

    "pretty_name: Explicit Edit Benchmark",
    "language:",
    "- en",
    "license: cc-by-4.0",
    "size_categories:",
    "- 10K<n<100K",
    "task_categories:",
    "- text-generation",
    "tags:",
    "- benchmark",
    "- evaluation",
    "- coding-agents",
    "- software-engineering",
    "- text",
    "configs:",
    configs,
    "---",
    "",
    "# Explicit Edit Benchmark",
    "",
    "226 deterministic exact-edit tasks, run by different agents, harnesses, models and configurations. Every observation records what the harness did and whether the resulting files matched byte for byte.",
    "",
    "**Source code and benchmark runner:** [GitHub — Explicit Edit Benchmark](https://github.com/alexshpunt/explicit-edit-benchmark)",
    "",
    "**[Open the interactive Explorer](https://huggingface.co/spaces/alexshpunt/benchmark-explorer)** to compare agents, harnesses, models, versions, reasoning modes, correctness, recovery, time, cost and tokens.",
    "",
    ...(models.length
      ? [
          "## Leaderboard by model",
          "",
          "Score v2 = coverage × quality, where quality is 75% first exact and 25% final exact.",
          "Repeated runs are averaged inside each configuration and task; configurations then have",
          "equal weight inside each task, and tasks have equal weight. The same numbers are in",
          "`views.json`, and the",
          "[Explorer](https://huggingface.co/spaces/alexshpunt/benchmark-explorer) breaks them down by",
          "harness, version and reasoning mode.",
          "",
          "| Model | Score | Coverage | Tasks | Observations | Harnesses |",
          "| --- | --- | --- | --- | --- | --- |",
          ...models.map(
            (row) =>
              `| \`${row.modelFamily}\` | ${formatScore(row.score)} | ${formatScore(row.coverage)} | ${row.taskCount ?? "-"} | ${row.observations ?? "-"} | ${row.harnessFamilies.length} |`,
          ),
          "",
          "The harness list behind each row is in `data/models.jsonl.gz`, and `views.json` holds the same",
          "aggregates for the other groupings: by harness, by agent and by reasoning mode.",
          "",
        ]
      : []),
    "## Tables",
    "",
    "| Config | One row per |",
    "| --- | --- |",
    "| `profiles` | configuration that was run, with its agent, harness, model and exact versions |",
    "| `configurations` | recipe behind a configuration, safe to publish |",
    "| `trials` | task and attempt, with the first and final exact result |",
    "| `rounds` | attempt, with timing, tokens, cost and timeout state |",
    "| `tool-calls` | tool the agent used, with its category and outcome |",
    "| `submissions` | accepted run, with its owner, purpose and definitions |",
    "",
    "The Dataset Viewer shows every config. `dataset-index.json` holds the source hashes, contracts, task sets, completeness and counts, and `views.json`, `leaderboard.json` and `summary.json` hold the aggregated rankings.",
    "",
    "## Source and contribution",
    "",
    "Source code, run instructions and the contribution guide live at [alexshpunt/explicit-edit-benchmark](https://github.com/alexshpunt/explicit-edit-benchmark). Accepted bundles are kept under `source/`, the shards and summaries are views rebuilt from them, and each accepted harness family has a README badge under `badges/`.",
    "",
    "Observations hold no prompts, arguments, commands, output, sessions, workspaces or credentials.",
    "",
  ].join("\n");
}
/** Map a 0..1 group score to a shields.io color name. */
function badgeColor(score) {
  if (score == null) return "lightgrey";
  if (score >= 0.9) return "brightgreen";
  if (score >= 0.75) return "green";
  if (score >= 0.5) return "yellow";
  if (score >= 0.25) return "orange";
  return "red";
}

/** Keep only the highest accepted semantic version of each harness family. */
export function latestHarnessRows(rows) {
  const families = Map.groupBy(rows, (row) => row.harnessFamily);
  return Object.fromEntries(
    [...families].map(([family, members]) => {
      const latest = members
        .map((row) => row.harnessVersion)
        .filter(Boolean)
        .reduce(
          (current, version) =>
            current == null || compareVersions(current, version) < 0 ? version : current,
          null,
        );
      return [family, members.filter((row) => row.harnessVersion === latest)];
    }),
  );
}

function latestHarnessGroups(rows) {
  return Object.fromEntries(
    Object.entries(latestHarnessRows(rows)).map(([family, members]) => [
      family,
      aggregateGroupScore(members),
    ]),
  );
}

function compareVersions(left, right) {
  const values = (version) =>
    version.split(/[.-]/u).map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
  const a = values(left);
  const b = values(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index] == null) return 1;
    if (b[index] == null) return -1;
    if (typeof a[index] === "number" && typeof b[index] === "number") return a[index] - b[index];
    return String(a[index]).localeCompare(String(b[index]), undefined, { numeric: true });
  }
  return 0;
}

/** Build one README badge per accepted harness family, in the shields.io endpoint format. */
async function writeHarnessBadges(outputDirectory, groups) {
  const files = {};
  for (const [harness, group] of Object.entries(groups ?? {})) {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(harness)) continue;
    const score = group.score ?? null;
    files[`${harness}.json`] =
      JSON.stringify({
        schemaVersion: 1,
        label: "Explicit Edit Benchmark",
        message: score == null ? "no data" : `${(score * 100).toFixed(1)}%`,
        color: badgeColor(score),
        labelColor: "24292e",
        style: "flat-square",
        cacheSeconds: 300,
      }) + "\n";
  }
  if (!Object.keys(files).length) return null;
  await mkdir(path.join(outputDirectory, "badges"), { recursive: true });
  await Promise.all(
    Object.entries(files).map(([name, content]) =>
      writeFile(path.join(outputDirectory, "badges", name), content),
    ),
  );
  return {
    directory: "badges",
    files: Object.fromEntries(
      Object.entries(files).map(([name, content]) => [
        name,
        {
          bytes: Buffer.byteLength(content),
          sha256: createHash("sha256").update(content).digest("hex"),
        },
      ]),
    ),
  };
}

/** Build gzip JSONL shards ready for review and upload to a Hugging Face Dataset. */
export async function buildPublicDataset(outputDirectory, bundleDirectories) {
  if (!bundleDirectories.length) throw Error("At least one normalized bundle is required");
  const output = path.resolve(outputDirectory);
  const runs = [];
  const seen = new Set();
  for (const directory of bundleDirectories) {
    const manifest = await validateNormalizedRun(directory);
    if (seen.has(manifest.runId)) throw Error(`Duplicate runId: ${manifest.runId}`);
    seen.add(manifest.runId);
    const manifestContent = await readFile(path.join(directory, "manifest.json"));
    const files = {};
    for (const table of TABLES) {
      const source = await readFile(path.join(directory, `${table}.jsonl`), "utf8");
      const compressed = gzipSync(withRunId(source, manifest.runId), { level: 6, mtime: 0 });
      const relative = path.join("data", table, `${manifest.runId}.jsonl.gz`);
      await mkdir(path.join(output, "data", table), { recursive: true });
      await writeFile(path.join(output, relative), compressed, { flag: "wx" });
      files[table] = {
        path: relative,
        bytes: compressed.byteLength,
        sha256: createHash("sha256").update(compressed).digest("hex"),
      };
    }
    runs.push({
      runId: manifest.runId,
      bundleSchemaVersion: manifest.schemaVersion,
      contract: manifest.contract,
      taskSetSha256: manifest.taskSetSha256,
      verifierSha256: manifest.verifierSha256 ?? null,
      policy: manifest.policy,
      ...(manifest.sourceRuns ? { sourceRuns: manifest.sourceRuns } : {}),
      counts: manifest.counts,
      completeness: manifest.completeness,
      manifestSha256: createHash("sha256").update(manifestContent).digest("hex"),
      files,
    });
  }
  const index = { schemaVersion: 1, runs };
  await mkdir(output, { recursive: true });
  await Promise.all([
    writeFile(path.join(output, "dataset-index.json"), JSON.stringify(index, null, 2) + "\n", {
      flag: "wx",
    }),
    writeFile(path.join(output, "README.md"), datasetCard(), { flag: "wx" }),
  ]);
  return index;
}

function summarizeTrials(trials) {
  const byTask = new Map();
  const byProfile = new Map();
  for (const trial of trials) {
    for (const [map, key] of [
      [byTask, trial.taskId],
      [byProfile, trial.profileId],
    ]) {
      const item = map.get(key) ?? { id: key, observations: 0, exactPasses: 0 };
      item.observations += 1;
      item.exactPasses += Number(trial.finalExactPassed);
      map.set(key, item);
    }
  }
  const tasks = [...byTask.values()].map((item) => ({
    ...item,
    exactRate: item.observations ? item.exactPasses / item.observations : null,
  }));
  const profiles = [...byProfile.values()].map((item) => ({
    ...item,
    exactRate: item.observations ? item.exactPasses / item.observations : null,
  }));
  return {
    observations: trials.length,
    tasks,
    profiles,
    macroTaskExactRate: tasks.length
      ? tasks.reduce((sum, item) => sum + item.exactRate, 0) / tasks.length
      : null,
  };
}
function summarizeEfficiency(trials, rounds) {
  const profileByTrial = new Map(
    trials.map((trial) => [
      `${trial.runId}::${trial.trialId}`,
      { runId: trial.runId, profileId: trial.profileId },
    ]),
  );
  const profiles = new Map();
  for (const round of rounds) {
    const identity = profileByTrial.get(`${round.runId}::${round.trialId}`);
    if (!identity) continue;
    const key = `${identity.runId}::${identity.profileId}`;
    const item = profiles.get(key) ?? {
      runId: identity.runId,
      profileId: identity.profileId,
      rounds: 0,
      durationSeconds: 0,
      durationObservedRounds: 0,
      costUsd: 0,
      costObservedRounds: 0,
      totalTokens: 0,
      tokenObservedRounds: 0,
      toolCalls: 0,
      toolCallObservedRounds: 0,
      eventErrors: 0,
      eventErrorObservedRounds: 0,
      failedToolCalls: 0,
      failedToolCallObservedRounds: 0,
      invalidToolCalls: 0,
      invalidToolCallObservedRounds: 0,
    };
    item.rounds += 1;
    for (const [field, total, coverage] of [
      ["seconds", "durationSeconds", "durationObservedRounds"],
      ["costUsd", "costUsd", "costObservedRounds"],
      ["totalTokens", "totalTokens", "tokenObservedRounds"],
      ["toolCallCount", "toolCalls", "toolCallObservedRounds"],
      ["eventErrors", "eventErrors", "eventErrorObservedRounds"],
      ["failedToolCalls", "failedToolCalls", "failedToolCallObservedRounds"],
      ["invalidToolCalls", "invalidToolCalls", "invalidToolCallObservedRounds"],
    ]) {
      if (round[field] !== null && round[field] !== undefined) {
        item[total] += round[field];
        item[coverage] += 1;
      }
    }
    profiles.set(key, item);
  }
  return [...profiles.values()].map((item) => {
    for (const [total, coverage] of [
      ["durationSeconds", "durationObservedRounds"],
      ["costUsd", "costObservedRounds"],
      ["totalTokens", "tokenObservedRounds"],
      ["toolCalls", "toolCallObservedRounds"],
      ["eventErrors", "eventErrorObservedRounds"],
      ["failedToolCalls", "failedToolCallObservedRounds"],
      ["invalidToolCalls", "invalidToolCallObservedRounds"],
    ])
      if (!item[coverage]) item[total] = null;
    return item;
  });
}

/** Build a public dataset from every accepted observation in an ingestion store. */
export async function buildPublicDatasetFromStore(outputDirectory, storeDirectory) {
  const store = path.resolve(storeDirectory);
  const sourceIndex = JSON.parse(await readFile(path.join(store, "index.json"), "utf8"));
  if (sourceIndex.schemaVersion !== 1 || !Array.isArray(sourceIndex.submissions))
    throw Error("Invalid ingestion store index");
  const bundles = sourceIndex.submissions.map((item) =>
    path.join(store, "accepted", item.submissionId),
  );
  const index = await buildPublicDataset(outputDirectory, bundles);
  const sourceDirectory = path.join(outputDirectory, "source");
  await mkdir(sourceDirectory, { recursive: true });
  await cp(path.join(store, "index.json"), path.join(sourceDirectory, "index.json"), {
    errorOnExist: true,
    force: false,
  });
  await cp(path.join(store, "accepted"), path.join(sourceDirectory, "accepted"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  try {
    await cp(path.join(store, "official"), path.join(sourceDirectory, "official"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const sourceIndexContent = await readFile(path.join(sourceDirectory, "index.json"));
  const metadataByRun = new Map(sourceIndex.submissions.map((item) => [item.runId, item]));
  index.schemaVersion = 1;
  index.source = {
    path: "source/index.json",
    bytes: sourceIndexContent.byteLength,
    sha256: createHash("sha256").update(sourceIndexContent).digest("hex"),
  };
  index.runs = index.runs.map((run) => {
    const metadata = metadataByRun.get(run.runId);
    if (!metadata) throw Error(`Missing submission metadata for ${run.runId}`);
    return {
      ...run,
      submissionId: metadata.submissionId,
      ownerId: metadata.ownerId,
      purpose: metadata.purpose,
      // Bundles accepted before source verification existed are the trusted initial corpus.
      verification: metadata.verification ?? "verified",
      definitions: metadata.definitions,
    };
  });
  const trialGroups = await Promise.all(
    index.runs.map(async (run) => ({
      runId: run.runId,
      profiles: (
        await readFile(path.join(store, "accepted", run.submissionId, "profiles.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ runId: run.runId, ...JSON.parse(line) })),
      trials: (
        await readFile(path.join(store, "accepted", run.submissionId, "trials.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ runId: run.runId, ...JSON.parse(line) })),
      rounds: (
        await readFile(path.join(store, "accepted", run.submissionId, "rounds.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ runId: run.runId, ...JSON.parse(line) })),
      toolCalls: (
        await readFile(path.join(store, "accepted", run.submissionId, "tool-calls.jsonl"), "utf8")
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => ({ runId: run.runId, ...JSON.parse(line) })),
    })),
  );
  const allTrials = trialGroups.flatMap((group) => group.trials);
  const allRounds = trialGroups.flatMap((group) => group.rounds);
  const allProfiles = trialGroups.flatMap((group) => group.profiles);
  const allToolCalls = trialGroups.flatMap((group) => group.toolCalls);
  const publicIndex = { runs: index.runs };
  const serializeLeaderboard = (rows) =>
    rows.map(
      ({
        trialSamples: _trialSamples,
        configurationTaskCells: _configurationTaskCells,
        configurationLabels,
        ...row
      }) => ({
        ...row,
        configurationLabels: [...configurationLabels],
      }),
    );
  const leaderboard = {
    schemaVersion: 1,
    scoring: {
      id: "explicit-edit-score",
      version: 2,
      formula: "coverage * (0.75 * taskBalancedFirstExactRate + 0.25 * taskBalancedFinalExactRate)",
      repetitionUnit: "mean within configurationHash × task",
      rollup: "equal configurations within task; equal tasks",
      source: "scripts/result-aggregation.mjs",
    },
    rows: serializeLeaderboard(
      aggregateLeaderboard(publicIndex, allProfiles, allTrials, allRounds),
    ),
  };
  const taskFamilies = [...new Set(allTrials.map((trial) => taskFamily(trial.taskId)))].sort();
  const groupScores = (rows) => {
    const dimensions = ["modelFamily", "agentFamily", "harnessFamily", "thinking"];
    return Object.fromEntries(
      dimensions.map((dimension) => {
        const groups = Map.groupBy(rows, (row) => row[dimension]);
        return [
          dimension,
          Object.fromEntries(
            [...groups].map(([name, members]) => [name, aggregateGroupScore(members)]),
          ),
        ];
      }),
    );
  };
  const leaderboardRows = aggregateLeaderboard(publicIndex, allProfiles, allTrials, allRounds);
  const familyRows = Object.fromEntries(
    taskFamilies.map((family) => [
      family,
      aggregateLeaderboard(publicIndex, allProfiles, allTrials, allRounds, {
        taskFamily: [family],
      }),
    ]),
  );
  const views = {
    schemaVersion: 1,
    scoring: leaderboard.scoring,
    leaderboard: leaderboardRows,
    groups: groupScores(leaderboardRows),
    taskFamilies: familyRows,
    taskFamilyGroups: Object.fromEntries(
      Object.entries(familyRows).map(([family, rows]) => [family, groupScores(rows)]),
    ),
    toolUsage: aggregateToolUsage(publicIndex, allProfiles, allTrials, allRounds, allToolCalls),
  };
  const models = modelLeaderboard(views.groups.modelFamily, leaderboardRows);
  const modelsContent =
    models.map((row) => JSON.stringify(row)).join("\n") + (models.length ? "\n" : "");
  const modelsCompressed = gzipSync(modelsContent, { level: 6, mtime: 0 });
  await writeFile(path.join(outputDirectory, "data", "models.jsonl.gz"), modelsCompressed);
  index.models = {
    path: "data/models.jsonl.gz",
    bytes: modelsCompressed.byteLength,
    sha256: createHash("sha256").update(modelsCompressed).digest("hex"),
  };
  const viewsContent = JSON.stringify(views) + "\n";
  await writeFile(path.join(outputDirectory, "views.json"), viewsContent);
  index.views = {
    path: "views.json",
    bytes: Buffer.byteLength(viewsContent),
    sha256: createHash("sha256").update(viewsContent).digest("hex"),
  };
  const badges = await writeHarnessBadges(outputDirectory, latestHarnessGroups(leaderboardRows));
  if (badges) index.badges = badges;
  const leaderboardContent = JSON.stringify(leaderboard, null, 2) + "\n";
  await writeFile(path.join(outputDirectory, "leaderboard.json"), leaderboardContent);
  index.leaderboard = {
    path: "leaderboard.json",
    bytes: Buffer.byteLength(leaderboardContent),
    sha256: createHash("sha256").update(leaderboardContent).digest("hex"),
  };
  const summary = {
    schemaVersion: 1,
    ...summarizeTrials(allTrials),
    models: models.length,
    configurations: leaderboardRows.length,
    efficiency: summarizeEfficiency(allTrials, allRounds),
  };
  const summaryContent = JSON.stringify(summary, null, 2) + "\n";
  await writeFile(path.join(outputDirectory, "summary.json"), summaryContent);
  index.summary = {
    path: "summary.json",
    bytes: Buffer.byteLength(summaryContent),
    sha256: createHash("sha256").update(summaryContent).digest("hex"),
  };
  const submissions =
    index.runs.map((run) => JSON.stringify(run)).join("\n") + (index.runs.length ? "\n" : "");
  const compressed = gzipSync(submissions, { level: 6, mtime: 0 });
  await writeFile(path.join(outputDirectory, "data", "submissions.jsonl.gz"), compressed);
  index.submissions = {
    path: "data/submissions.jsonl.gz",
    bytes: compressed.byteLength,
    sha256: createHash("sha256").update(compressed).digest("hex"),
  };
  await writeFile(
    path.join(outputDirectory, "dataset-index.json"),
    JSON.stringify(index, null, 2) + "\n",
  );
  await writeFile(
    path.join(outputDirectory, "README.md"),
    datasetCard({ includeSubmissions: true, models }),
  );
  return index;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...bundles] = process.argv.slice(2);
  if (!output || !bundles.length)
    throw Error("Usage: build-public-dataset.mjs OUTPUT NORMALIZED_BUNDLE [...]");
  console.log(JSON.stringify(await buildPublicDataset(output, bundles)));
}
