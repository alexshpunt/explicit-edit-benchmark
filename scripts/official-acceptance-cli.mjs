#!/usr/bin/env node
import path from "node:path";
import {
  acceptOfficialCandidates,
  listOpenOfficialCandidates,
  rebuildOfficialDataset,
} from "./official-acceptance.mjs";

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
  if (result.rejected.length) process.exitCode = 1;
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
  if (result.rejected.length) process.exitCode = 1;
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
