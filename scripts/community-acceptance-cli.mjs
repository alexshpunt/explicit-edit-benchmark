#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acceptHuggingFaceCandidate } from "./huggingface-contributions.mjs";
import { isDeferredHubError } from "./official-acceptance.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** List open ordinary benchmark observation pull requests. */
export async function listOpenCommunityCandidates(repository, fetchImpl = fetch) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const response = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions?status=open`,
  );
  if (!response.ok) throw Error(`Hugging Face candidate listing failed (${response.status})`);
  const body = await response.json();
  const prefix = "Contribute benchmark observation ";
  return body.discussions
    .filter((item) => item.isPullRequest && item.status === "open" && item.title.startsWith(prefix))
    .map((item) => ({ number: item.num, runId: item.title.slice(prefix.length) }));
}

/** Validate and append a bounded batch without downloading historical Dataset files. */
export async function acceptCommunityCandidates({
  repository,
  candidates,
  accessToken,
  discussionAccessToken,
  workspaceDirectory,
  dryRun = false,
  accept = acceptHuggingFaceCandidate,
}) {
  const accepted = [];
  const rejected = [];
  const deferred = [];
  for (const candidate of candidates) {
    try {
      const result = await accept({
        repository,
        candidateRevision: String(candidate.number),
        accessToken,
        discussionAccessToken,
        workspaceDirectory: path.join(workspaceDirectory, `community-${candidate.number}`),
        dryRun,
      });
      accepted.push({
        candidate: candidate.number,
        runId: result.runId,
        commitOid: result.commitOid,
        candidateCommit: result.candidateCommit,
        candidateClosed: result.candidateClosed ?? null,
        closeError: result.closeError ?? null,
        operationCount: result.operationCount,
        duplicate: result.duplicate ?? false,
      });
    } catch (error) {
      const item = {
        candidate: candidate.number,
        runId: candidate.runId,
        code: error.code ?? "candidate-error",
        message: error.message,
      };
      (isDeferredHubError(error) ? deferred : rejected).push(item);
    }
  }
  const published = accepted.filter((item) => !item.duplicate && item.commitOid);
  return {
    changed: !dryRun && published.length > 0,
    datasetRevision: published.at(-1)?.commitOid ?? accepted.at(-1)?.commitOid ?? null,
    addedRuns: dryRun ? [] : published.map((item) => item.runId),
    dryRun,
    accepted,
    rejected,
    deferred,
  };
}

async function main() {
  const repository = process.env.DATASET_REPOSITORY ?? "alexshpunt/explicit-edit-benchmark";
  const maximum = Number(process.env.MAX_CANDIDATES ?? 4);
  const dryRun = process.env.DRY_RUN === "true";
  const candidates = (await listOpenCommunityCandidates(repository)).slice(0, maximum);
  const result = await acceptCommunityCandidates({
    repository,
    candidates,
    accessToken: process.env.HF_TOKEN,
    discussionAccessToken: process.env.HF_DISCUSSION_TOKEN,
    workspaceDirectory: process.env.RUNNER_TEMP
      ? path.join(process.env.RUNNER_TEMP, "community-accept-batch")
      : path.resolve(".tmp", "community-accept-batch"),
    dryRun,
  });
  console.log(JSON.stringify({ candidates: candidates.length, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await main();
