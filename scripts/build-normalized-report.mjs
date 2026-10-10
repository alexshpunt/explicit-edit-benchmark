#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";

function jsonLines(content) {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const percent = (part, total) => (total ? `${((100 * part) / total).toFixed(1)}%` : "—");

/** Build a compact, reproducible Markdown and CSV report from one normalized bundle. */
export async function buildNormalizedReport(bundleDirectory, outputDirectory) {
  const root = path.resolve(bundleDirectory);
  const manifest = await validateNormalizedRun(root);
  const [profiles, configurations, trials, rounds, calls] = await Promise.all(
    [
      "profiles.jsonl",
      "configurations.jsonl",
      "trials.jsonl",
      "rounds.jsonl",
      "tool-calls.jsonl",
    ].map(async (name) => jsonLines(await readFile(path.join(root, name), "utf8"))),
  );
  const configurationsByHash = new Map(
    configurations.map((configuration) => [configuration.configurationHash, configuration]),
  );
  const byProfile = new Map();
  for (const profile of profiles)
    byProfile.set(profile.profileId, {
      profile,
      configuration: configurationsByHash.get(profile.configurationHash),
      trials: 0,
      firstExact: 0,
      finalExact: 0,
      finalNormalized: 0,
      rounds: 0,
      calls: 0,
      categories: {},
    });
  const trialProfile = new Map();
  for (const trial of trials) {
    const row = byProfile.get(trial.profileId);
    if (!row) throw Error(`${trial.trialId}: unknown profile`);
    const tasks = trial.taskIds?.length ?? 1;
    row.trials += tasks;
    row.firstExact += tasks * Number(trial.firstExactPassed);
    row.finalExact += tasks * Number(trial.finalExactPassed);
    trialProfile.set(trial.trialId, trial.profileId);
  }
  const roundProfile = new Map();
  const terminalByTrial = new Map();
  for (const round of rounds) {
    const profileId = trialProfile.get(round.trialId);
    const row = byProfile.get(profileId);
    if (!row) throw Error(`${round.roundId}: unknown trial`);
    row.rounds += 1;
    roundProfile.set(round.roundId, profileId);
    terminalByTrial.set(round.trialId, round);
  }
  for (const trial of trials) {
    const terminal = terminalByTrial.get(trial.trialId);
    if (terminal?.normalizedPassed)
      byProfile.get(trial.profileId).finalNormalized += trial.taskIds?.length ?? 1;
  }
  for (const call of calls) {
    const profileId = roundProfile.get(call.roundId);
    const row = byProfile.get(profileId);
    if (!row) throw Error(`${call.roundId}: unknown round`);
    row.calls += 1;
    row.categories[call.category] = (row.categories[call.category] ?? 0) + 1;
  }

  const rows = [...byProfile.values()].sort((a, b) =>
    a.profile.profileId.localeCompare(b.profile.profileId),
  );
  const csv =
    [
      "profile_id,configuration_id,agent_family,agent_version,model_family,model_version,harness_family,harness_version,trials,first_exact,final_exact,final_normalized,rounds,tool_calls",
      ...rows.map(
        ({
          profile,
          configuration,
          trials: count,
          firstExact,
          finalExact,
          finalNormalized,
          rounds: roundCount,
          calls: callCount,
        }) =>
          [
            profile.profileId,
            configuration.configurationId,
            profile.agentFamily,
            profile.agentVersion,
            profile.modelFamily,
            profile.modelVersion,
            profile.harnessFamily,
            profile.harnessVersion,
            count,
            firstExact,
            finalExact,
            finalNormalized,
            roundCount,
            callCount,
          ].join(","),
      ),
    ].join("\n") + "\n";
  const markdown = `# ${manifest.runId}\n\nGenerated from normalized schema v${manifest.schemaVersion}. Raw prompts, tool arguments, command text and command output are not part of this bundle.\n\n| Profile | Configuration | Agent | Model | Harness | First exact | Final exact | Final normalized | Rounds | Calls |\n| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |\n${rows
    .map(
      ({
        profile,
        configuration,
        trials: count,
        firstExact,
        finalExact,
        finalNormalized,
        rounds: roundCount,
        calls: callCount,
      }) =>
        `| ${profile.profileId} | ${configuration.configurationId} | ${profile.agentFamily} ${profile.agentVersion} | ${profile.modelFamily} ${profile.modelVersion} | ${profile.harnessFamily} ${profile.harnessVersion} | ${firstExact}/${count} (${percent(firstExact, count)}) | ${finalExact}/${count} (${percent(finalExact, count)}) | ${finalNormalized}/${count} (${percent(finalNormalized, count)}) | ${roundCount} | ${callCount} |`,
    )
    .join("\n")}\n\n## Tool categories\n\n| Profile | Categories |\n| --- | --- |\n${rows
    .map(
      ({ profile, categories }) =>
        `| ${profile.profileId} | ${Object.entries(categories)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([category, count]) => `${category}: ${count}`)
          .join(", ")} |`,
    )
    .join("\n")}\n`;
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, "report.md"), markdown),
    writeFile(path.join(outputDirectory, "results.csv"), csv),
  ]);
  return { profiles: rows.length, report: path.join(outputDirectory, "report.md") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bundle = process.argv[2];
  if (!bundle) throw Error("Usage: build-normalized-report.mjs BUNDLE [OUTPUT]");
  const output = process.argv[3] || path.join(bundle, "report");
  console.log(JSON.stringify(await buildNormalizedReport(bundle, output)));
}
