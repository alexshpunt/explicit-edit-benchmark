#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  acceptOfficialCandidates,
  listOpenOfficialCandidates,
  rebuildOfficialDataset,
} from "./official-acceptance.mjs";

/** Return the durable backup root used by local Dataset rebuilds. */
export function localRebuildBackupRoot({
  homeDirectory = os.homedir(),
  environment = process.env,
} = {}) {
  return path.resolve(
    environment.DATASET_BACKUP_ROOT ??
      path.join(homeDirectory, ".local", "share", "explicit-edit-benchmark", "backups"),
  );
}

/** Resolve the optional CLI override for the local rebuild backup root. */
export function rebuildBackupRoot(args, options) {
  if (args.length === 0) return localRebuildBackupRoot(options);
  if (args.length === 2 && args[0] === "--backup-root" && args[1]) return path.resolve(args[1]);
  throw Error("Usage: official-acceptance-cli.mjs rebuild [--backup-root DIRECTORY]");
}

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
      discussionAccessToken: process.env.HF_DISCUSSION_TOKEN,
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
      discussionAccessToken: process.env.HF_DISCUSSION_TOKEN,
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
      backupDirectory: process.env.BACKUP_DIRECTORY,
      backupRootDirectory: process.env.RUNNER_TEMP ? undefined : rebuildBackupRoot(args),
    });
    console.log(JSON.stringify(result));
  } else {
    throw Error(
      "Usage: official-acceptance-cli.mjs <accept CANDIDATE_NUMBER|poll|rebuild [--backup-root DIRECTORY]>",
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
