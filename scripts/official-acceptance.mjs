import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { commit, downloadFile, listCommits, listFiles, snapshotDownload } from "@huggingface/hub";
import { ingestSubmission } from "./benchmark-ingestion.mjs";
import { buildSubmission } from "./benchmark-submission.mjs";
import { submissionMetadata } from "./benchmark-submit.mjs";
import {
  buildDerivedDatasetFromAggregateState,
  buildPublicDataset,
  buildPublicDatasetFromStore,
} from "./build-public-dataset.mjs";
import { appendAggregateRun } from "./aggregate-state.mjs";
import {
  assertPreserved,
  headCommit,
  publishDirectory,
  readDatasetIndex,
  verifyIncrementalDatasetState,
} from "./huggingface-contributions.mjs";
import { resolveHuggingFaceToken } from "./huggingface-auth.mjs";
import { OfficialVerificationError, officialVerdict } from "./official-verifier.mjs";

const defaultHub = { commit, downloadFile, listCommits, listFiles, snapshotDownload };
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0 ? resolve() : reject(Error(`${command} exited with ${signal ?? code}`)),
    );
  });
}

async function verifyAttestation({ artifact, attestation, signerSha, repository }) {
  try {
    await run(process.execPath, [
      "scripts/verify-official-attestation.mjs",
      artifact,
      attestation,
      repository,
      "policies/official-runs/v1.json",
      signerSha,
    ]);
  } catch (error) {
    throw new OfficialVerificationError(
      "invalid-signature",
      "GitHub attestation verification failed",
      {
        cause: error,
      },
    );
  }
}

async function downloadOfficialCandidate(hub, repo, repository, candidateNumber, token, directory) {
  const response = await fetch(
    `https://huggingface.co/api/datasets/${repository}/discussions/${candidateNumber}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (!response.ok) throw Error(`Hugging Face candidate lookup failed (${response.status})`);
  const discussion = await response.json();
  const prefix = "Contribute official benchmark execution ";
  if (
    !discussion.isPullRequest ||
    discussion.status !== "open" ||
    !discussion.title.startsWith(prefix)
  )
    throw Error("Hugging Face candidate is not an open official pull request");
  const executionId = discussion.title.slice(prefix.length);
  if (!/^[a-f0-9]{64}$/.test(executionId))
    throw Error("Official candidate title has invalid execution ID");
  const commits = discussion.events.filter((event) => event.type === "commit");
  const candidateCommit = commits.at(-1)?.data?.oid;
  if (!/^[a-f0-9]{40}$/.test(candidateCommit ?? ""))
    throw Error("Official candidate has no immutable head commit");
  await mkdir(directory, { recursive: true });
  for (const name of ["attestation.jsonl", "official-result.tar.gz", "transport.json"]) {
    const blob = await hub.downloadFile({
      repo,
      path: `candidates/official/${executionId}/${name}`,
      revision: candidateCommit,
      accessToken: token,
    });
    if (!blob) throw Error(`Official candidate is missing ${name}`);
    await writeFile(path.join(directory, name), Buffer.from(await blob.arrayBuffer()), {
      flag: "wx",
    });
  }
  return { candidateCommit, executionId };
}

async function findOfficialCandidate(snapshot) {
  const root = path.join(snapshot, "candidates", "official");
  const executions = await readdir(root, { withFileTypes: true });
  const directories = executions.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || executions.length !== 1)
    throw Error("Official candidate must contain exactly one execution directory");
  const candidate = path.join(root, directories[0].name);
  const entries = await readdir(candidate, { withFileTypes: true });
  const expected = ["attestation.jsonl", "official-result.tar.gz", "transport.json"];
  const actual = entries.map((entry) => entry.name).sort();
  const types = await Promise.all(entries.map((entry) => stat(path.join(candidate, entry.name))));
  if (types.some((entry) => !entry.isFile()) || JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`Official candidate files must be exactly ${expected.join(", ")}`);
  return candidate;
}

async function closeAcceptedCandidates({
  accepted,
  repository,
  discussionToken,
  datasetCommit,
  close,
}) {
  for (const item of accepted) {
    try {
      const receipt = item.duplicate
        ? `Execution ${item.executionId} was already accepted on Dataset main at ${datasetCommit}.`
        : `Accepted verified execution ${item.executionId} in Dataset commit ${datasetCommit}.`;
      await close(repository, item.candidate, discussionToken, receipt);
      item.candidateClosed = true;
    } catch (error) {
      item.candidateClosed = false;
      item.closeError = error.message;
    }
  }
}
async function closeCandidate(repository, candidateNumber, token, receipt) {
  const response = await fetch(
    `https://huggingface.co/api/datasets/${repository}/discussions/${candidateNumber}/status`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "closed", comment: receipt }),
    },
  );
  if (!response.ok)
    throw Error(
      `Hugging Face candidate close failed (${response.status}): ${await response.text()}`,
    );
}

function parseJsonLines(content) {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function parseCompressedJsonLines(filePath) {
  return parseJsonLines(gunzipSync(await readFile(filePath)).toString("utf8"));
}

async function downloadJson(hub, repo, revision, accessToken, filePath) {
  const blob = await hub.downloadFile({ repo, revision, accessToken, path: filePath });
  if (!blob) throw Error(`Dataset is missing ${filePath}`);
  return JSON.parse(await blob.text());
}

export async function incrementalCommitOperations(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await incrementalCommitOperations(root, absolute)));
    else if (entry.isFile())
      files.push({
        operation: "addOrUpdate",
        path: path.relative(root, absolute).split(path.sep).join("/"),
        content: pathToFileURL(absolute),
      });
    else throw Error(`Unsupported incremental output entry: ${absolute}`);
  }
  return files;
}

/** Return true only for temporary Hub failures which should be retried later. */
export function isDeferredHubError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  return (
    status === 409 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    /\b(?:409|429|5\d\d)\b/u.test(String(error?.message ?? error))
  );
}

async function prepareVerifiedCandidate({
  hub,
  repo,
  repository,
  candidateNumber,
  token,
  workspace,
  attestationVerifier,
}) {
  const candidateRoot = path.join(workspace, `candidate-${candidateNumber}`);
  const candidateDirectory = path.join(candidateRoot, "candidates", "official", "execution");
  const { candidateCommit } = await downloadOfficialCandidate(
    hub,
    repo,
    repository,
    candidateNumber,
    token,
    candidateDirectory,
  );
  const candidate = await findOfficialCandidate(candidateRoot);
  const transport = JSON.parse(await readFile(path.join(candidate, "transport.json"), "utf8"));
  const extracted = path.join(workspace, `extracted-${candidateNumber}`);
  const verdict = await officialVerdict({
    candidateDirectory: candidate,
    extractedDirectory: extracted,
    policyFile: "policies/official-runs/v1.json",
    signerSha: transport.signerWorkflowSha,
    verifyAttestation: attestationVerifier,
  });
  if (verdict.status !== "accepted")
    throw new OfficialVerificationError(verdict.code, verdict.message ?? verdict.code);
  return { candidate, candidateCommit, extracted, transport, verified: verdict.evidence };
}

/**
 * Verify a bounded group of candidates, append only their new files, and publish one atomic commit.
 * Historical source bundles and historical data shards are never downloaded on this path.
 */
export async function acceptOfficialCandidates({
  repository,
  candidateNumbers,
  accessToken,
  workspaceDirectory,
  discussionAccessToken,
  hub = defaultHub,
  attestationVerifier = verifyAttestation,
  close = closeCandidate,
  dryRun = false,
}) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required to accept official candidates");
  const discussionToken = discussionAccessToken ?? token;
  const repo = { type: "dataset", name: repository };
  const parentCommit = await headCommit(hub, repo, token);
  const workspace = path.resolve(workspaceDirectory);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });

  let sourceIndex;
  let datasetIndex;
  let aggregateState;
  try {
    [sourceIndex, datasetIndex, aggregateState] = await Promise.all([
      downloadJson(hub, repo, parentCommit, token, "source/index.json"),
      downloadJson(hub, repo, parentCommit, token, "dataset-index.json"),
      downloadJson(hub, repo, parentCommit, token, "aggregate-state.json"),
    ]);
    verifyIncrementalDatasetState(sourceIndex, datasetIndex, aggregateState);
  } catch (error) {
    return {
      parentCommit,
      commitOid: null,
      accepted: [],
      rejected: [],
      deferred: candidateNumbers.map((candidate) => ({
        candidate,
        code: "aggregate-state-unavailable",
        message: error.message,
      })),
    };
  }

  const store = path.join(workspace, "store");
  const output = path.join(workspace, "output");
  await mkdir(store, { recursive: true });
  await writeFile(path.join(store, "index.json"), JSON.stringify(sourceIndex, null, 2) + "\n");
  const accepted = [];
  const rejected = [];
  const deferred = [];

  const acceptedExecutions = new Set(
    datasetIndex.runs.map((run) => run.official?.executionId).filter(Boolean),
  );
  for (const candidateReference of candidateNumbers) {
    const candidateNumber = candidateReference.number ?? candidateReference;
    const executionHint = candidateReference.executionId ?? null;
    if (executionHint && acceptedExecutions.has(executionHint)) {
      accepted.push({
        candidate: Number(candidateNumber),
        executionId: executionHint,
        duplicate: true,
        cached: true,
      });
      continue;
    }
    try {
      const prepared = await prepareVerifiedCandidate({
        hub,
        repo,
        repository,
        candidateNumber,
        token,
        workspace,
        attestationVerifier,
      });
      const normalized = path.join(prepared.extracted, "normalized");
      const normalizedManifestFile = path.join(normalized, "manifest.json");
      const normalizedManifest = JSON.parse(await readFile(normalizedManifestFile, "utf8"));
      await writeFile(normalizedManifestFile, JSON.stringify(normalizedManifest, null, 2) + "\n");
      const runId = prepared.verified.manifest.executionIdentity.executionId;
      const metadata = await submissionMetadata(normalized, runId);
      metadata.purpose = "official";
      const submission = await buildSubmission(normalized, metadata);
      const result = await ingestSubmission(
        store,
        {
          ownerId: prepared.verified.transport.producer.repository,
          sourceRepository: prepared.verified.transport.producer.repository,
          verification: "verified",
        },
        submission,
      );
      if (!result.created) {
        accepted.push({ candidate: Number(candidateNumber), executionId: runId, duplicate: true });
        continue;
      }
      sourceIndex = JSON.parse(await readFile(path.join(store, "index.json"), "utf8"));
      const runOutput = path.join(workspace, `run-${candidateNumber}`);
      const single = await buildPublicDataset(runOutput, [normalized]);
      const sourceMetadata = sourceIndex.submissions.find(
        (item) => item.runId === normalizedManifest.runId,
      );
      const run = {
        ...single.runs[0],
        submissionId: sourceMetadata.submissionId,
        ownerId: sourceMetadata.ownerId,
        ...(sourceMetadata.submittedBy ? { submittedBy: sourceMetadata.submittedBy } : {}),
        ...(sourceMetadata.sourceRepository
          ? { sourceRepository: sourceMetadata.sourceRepository }
          : {}),
        ...(sourceMetadata.submissionUrl ? { submissionUrl: sourceMetadata.submissionUrl } : {}),
        purpose: sourceMetadata.purpose,
        verification: "verified",
        definitions: sourceMetadata.definitions,
        official: {
          executionId: runId,
          proofPath: path.posix.join("source", "official", runId),
          artifactSha256: prepared.verified.artifactSha256,
          workflow: {
            repository: prepared.transport.producer.repository,
            runId: prepared.transport.producer.runId,
            attempt: prepared.transport.producer.producerAttempt,
            signerSha: prepared.transport.signerWorkflowSha,
          },
          policyId: prepared.verified.policy.policyId,
          acceptedCandidateCommit: prepared.candidateCommit,
        },
      };
      const previousSourceIndex = {
        ...sourceIndex,
        submissions: sourceIndex.submissions.slice(0, -1),
      };
      const evidence = {
        profiles: await parseCompressedJsonLines(
          path.join(runOutput, "data", "profiles", `${normalizedManifest.runId}.jsonl.gz`),
        ),
        trials: await parseCompressedJsonLines(
          path.join(runOutput, "data", "trials", `${normalizedManifest.runId}.jsonl.gz`),
        ),
        rounds: await parseCompressedJsonLines(
          path.join(runOutput, "data", "rounds", `${normalizedManifest.runId}.jsonl.gz`),
        ),
        toolCalls: await parseCompressedJsonLines(
          path.join(runOutput, "data", "tool-calls", `${normalizedManifest.runId}.jsonl.gz`),
        ),
      };
      aggregateState = appendAggregateRun(aggregateState, {
        previousSourceIndex,
        sourceIndex,
        run,
        ...evidence,
      });
      datasetIndex.runs.push(run);

      const proof = path.join(output, "source", "official", runId);
      const acceptedBundle = path.join(store, "accepted", result.submissionId);
      await mkdir(proof, { recursive: true });
      await mkdir(path.join(output, "source", "accepted"), { recursive: true });
      await cp(acceptedBundle, path.join(output, "source", "accepted", result.submissionId), {
        recursive: true,
      });
      await Promise.all([
        cp(prepared.verified.artifact, path.join(proof, "official-result.tar.gz")),
        cp(prepared.verified.attestation, path.join(proof, "attestation.jsonl")),
        cp(path.join(prepared.candidate, "transport.json"), path.join(proof, "transport.json")),
        writeFile(
          path.join(proof, "acceptance.json"),
          JSON.stringify(
            {
              schemaVersion: 1,
              executionId: runId,
              normalizedRunId: normalizedManifest.runId,
              artifactSha256: prepared.verified.artifactSha256,
              candidateNumber: Number(candidateNumber),
              candidateCommit: prepared.candidateCommit,
              datasetParentCommit: parentCommit,
              signerWorkflowSha: prepared.transport.signerWorkflowSha,
              policyId: prepared.verified.policy.policyId,
            },
            null,
            2,
          ) + "\n",
        ),
      ]);
      for (const table of ["profiles", "configurations", "trials", "rounds", "tool-calls"]) {
        await mkdir(path.join(output, "data", table), { recursive: true });
        await cp(
          path.join(runOutput, "data", table, `${normalizedManifest.runId}.jsonl.gz`),
          path.join(output, "data", table, `${normalizedManifest.runId}.jsonl.gz`),
        );
      }
      acceptedExecutions.add(runId);
      accepted.push({
        candidate: Number(candidateNumber),
        candidateCommit: prepared.candidateCommit,
        executionId: runId,
      });
    } catch (error) {
      const item = {
        candidate: Number(candidateNumber),
        code: error.code ?? "candidate-error",
        message: error.message,
      };
      (isDeferredHubError(error) ? deferred : rejected).push(item);
    }
  }

  if (!accepted.some((item) => !item.duplicate)) {
    if (!dryRun)
      await closeAcceptedCandidates({
        accepted,
        repository,
        discussionToken,
        datasetCommit: parentCommit,
        close,
      });
    return {
      changed: false,
      datasetRevision: parentCommit,
      addedRuns: [],
      parentCommit,
      commitOid: null,
      dryRun,
      accepted,
      rejected,
      deferred,
    };
  }
  await mkdir(path.join(output, "source"), { recursive: true });
  const sourceContent = JSON.stringify(sourceIndex, null, 2) + "\n";
  await writeFile(path.join(output, "source", "index.json"), sourceContent);
  datasetIndex.source = {
    path: "source/index.json",
    bytes: Buffer.byteLength(sourceContent),
    sha256: createHash("sha256").update(sourceContent).digest("hex"),
  };
  await buildDerivedDatasetFromAggregateState(output, datasetIndex, aggregateState);
  const operations = await incrementalCommitOperations(output);
  if (dryRun)
    return {
      changed: false,
      datasetRevision: parentCommit,
      addedRuns: accepted.filter((item) => !item.duplicate).map((item) => item.executionId),
      parentCommit,
      commitOid: null,
      dryRun: true,
      operationCount: operations.length,
      accepted: accepted.map((item) => ({ ...item, wouldAccept: !item.duplicate })),
      rejected,
      deferred,
    };
  const result = await hub.commit({
    repo,
    accessToken: token,
    branch: "main",
    parentCommit,
    title: `Accept ${accepted.filter((item) => !item.duplicate).length} verified benchmark execution(s)`,
    operations,
  });
  const commitOid = result.commit.oid;
  if (!commitOid) throw Error("Hugging Face did not return a dataset commit");
  await closeAcceptedCandidates({
    accepted,
    repository,
    discussionToken,
    datasetCommit: commitOid,
    close,
  });
  return {
    changed: true,
    datasetRevision: commitOid,
    addedRuns: accepted.filter((item) => !item.duplicate).map((item) => item.executionId),
    parentCommit,
    commitOid,
    accepted,
    rejected,
    deferred,
  };
}

/** Rebuild every derived Dataset file from immutable canonical source and publish atomically. */
export async function rebuildOfficialDataset({
  repository,
  accessToken,
  workspaceDirectory,
  backupDirectory,
  hub = defaultHub,
}) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required to rebuild the Dataset");
  const repo = { type: "dataset", name: repository };
  const parentCommit = await headCommit(hub, repo, token);
  const workspace = path.resolve(workspaceDirectory);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const snapshot = await hub.snapshotDownload({
    repo,
    revision: parentCommit,
    accessToken: token,
    cacheDir: path.join(workspace, "cache"),
  });
  if (backupDirectory) {
    await rm(backupDirectory, { recursive: true, force: true });
    await cp(snapshot, backupDirectory, { recursive: true, dereference: true });
  }
  const store = path.join(workspace, "store");
  const outputDirectory = path.join(workspace, "dataset");
  await cp(path.join(snapshot, "source"), store, { recursive: true, dereference: true });
  const index = await buildPublicDatasetFromStore(outputDirectory, store);
  assertPreserved(await readDatasetIndex(snapshot), index);
  const commitOid = await publishDirectory({
    hub,
    repo,
    accessToken: token,
    parentCommit,
    outputDirectory,
    title: "Rebuild canonical Dataset views",
  });
  return {
    changed: commitOid !== parentCommit,
    datasetRevision: commitOid,
    addedRuns: [],
    parentCommit,
    commitOid,
    scoring: 2,
    exclusionPolicy: "benchmark-exclusions-v1",
  };
}

/** List open official candidate numbers without trusting their titles as verification. */
export async function listOpenOfficialCandidates(repository, fetchImpl = fetch) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const response = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions?status=open`,
  );
  if (!response.ok) throw Error(`Hugging Face candidate listing failed (${response.status})`);
  const body = await response.json();
  const prefix = "Contribute official benchmark execution ";
  return body.discussions
    .filter((item) => item.isPullRequest && item.status === "open" && item.title.startsWith(prefix))
    .map((item) => ({ number: item.num, executionId: item.title.slice(prefix.length) }));
}
