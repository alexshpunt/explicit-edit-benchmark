#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptOfficialCandidates,
  listOpenOfficialCandidates,
  rebuildOfficialDataset,
} from "./official-acceptance.mjs";

/** Return a failure only when an explicitly requested candidate is rejected. */
export function acceptanceExitCode(command, result) {
  return command === "accept" && result.rejected.length > 0 ? 1 : 0;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const repository = process.env.DATASET_REPOSITORY ?? "alexshpunt/explicit-edit-benchmark";
  const dryRun = process.env.DRY_RUN === "true";
  if (command === "accept") {
    const candidate = args[0];
    if (!candidate) throw Error("Usage: official-acceptance-cli.mjs accept CANDIDATE_NUMBER");
    const result = await acceptOfficialCandidates({
      repository,
      candidateNumbers: [candidate],
      accessToken: process.env.HF_TOKEN,
      workspaceDirectory: process.env.RUNNER_TEMP
        ? path.join(process.env.RUNNER_TEMP, `official-accept-${candidate}`)
        : path.resolve(".tmp", `official-accept-${candidate}`),
      dryRun,
    });
    console.log(JSON.stringify(result));
    process.exitCode = acceptanceExitCode(command, result);
  } else if (command === "poll") {
    const maximum = Number(process.env.MAX_CANDIDATES ?? 4);
    const candidates = (await listOpenOfficialCandidates(repository)).slice(0, maximum);
    const result = await acceptOfficialCandidates({
      repository,
      candidateNumbers: candidates,
      accessToken: process.env.HF_TOKEN,
      workspaceDirectory: process.env.RUNNER_TEMP
        ? path.join(process.env.RUNNER_TEMP, "official-accept-batch")
        : path.resolve(".tmp", "official-accept-batch"),
      dryRun,
    });
    console.log(JSON.stringify({ candidates: candidates.length, ...result }));
    process.exitCode = acceptanceExitCode(command, result);
  } else if (command === "rebuild") {
    const result = await rebuildOfficialDataset({
      repository,
      accessToken: process.env.HF_TOKEN,
      workspaceDirectory: process.env.RUNNER_TEMP
        ? path.join(process.env.RUNNER_TEMP, "official-rebuild")
        : path.resolve(".tmp", "official-rebuild"),
    });
    console.log(JSON.stringify(result));
  } else {
    throw Error("Usage: official-acceptance-cli.mjs <accept CANDIDATE_NUMBER|poll|rebuild>");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
