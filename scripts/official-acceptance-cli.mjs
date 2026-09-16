#!/usr/bin/env node
import path from "node:path";
import {
  acceptOfficialCandidate,
  listOpenOfficialCandidates,
  rebuildOfficialDataset,
} from "./official-acceptance.mjs";

const [command, ...args] = process.argv.slice(2);
const repository = process.env.DATASET_REPOSITORY ?? "alexshpunt/explicit-edit-benchmark";
if (command === "accept") {
  const candidate = args[0];
  if (!candidate) throw Error("Usage: official-acceptance-cli.mjs accept CANDIDATE_NUMBER");
  const result = await acceptOfficialCandidate({
    repository,
    candidateNumber: candidate,
    accessToken: process.env.HF_TOKEN,
    workspaceDirectory: process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, `official-accept-${candidate}`)
      : path.resolve(".tmp", `official-accept-${candidate}`),
  });
  console.log(JSON.stringify(result));
} else if (command === "poll") {
  const maximum = Number(process.env.MAX_CANDIDATES ?? 4);
  const candidates = (await listOpenOfficialCandidates(repository)).slice(0, maximum);
  const results = [];
  for (const candidate of candidates) {
    try {
      results.push(
        await acceptOfficialCandidate({
          repository,
          candidateNumber: candidate,
          accessToken: process.env.HF_TOKEN,
          workspaceDirectory: process.env.RUNNER_TEMP
            ? path.join(process.env.RUNNER_TEMP, `official-accept-${candidate}`)
            : path.resolve(".tmp", `official-accept-${candidate}`),
        }),
      );
    } catch (error) {
      results.push({ candidate, error: error.message });
    }
  }
  console.log(JSON.stringify({ candidates: candidates.length, results }));
  if (results.some((item) => item.error)) process.exitCode = 1;
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
