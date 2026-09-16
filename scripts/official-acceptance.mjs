import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { commit, downloadFile, listCommits, listFiles, snapshotDownload } from "@huggingface/hub";
import { ingestSubmission } from "./benchmark-ingestion.mjs";
import { buildSubmission } from "./benchmark-submission.mjs";
import { submissionMetadata } from "./benchmark-submit.mjs";
import { buildPublicDatasetFromStore } from "./build-public-dataset.mjs";
import {
  assertPreserved,
  headCommit,
  publishDirectory,
  readDatasetIndex,
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

/** Verify, append, rebuild, and atomically publish one immutable official candidate revision. */
export async function acceptOfficialCandidate({
  repository,
  candidateNumber,
  accessToken,
  workspaceDirectory,
  hub = defaultHub,
  attestationVerifier = verifyAttestation,
  close = closeCandidate,
}) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  if (!/^\d+$/.test(String(candidateNumber))) throw Error("Candidate number must be numeric");
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required to accept an official candidate");
  const repo = { type: "dataset", name: repository };
  const parentCommit = await headCommit(hub, repo, token);
  const workspace = path.resolve(workspaceDirectory);
  await mkdir(workspace, { recursive: true });
  const mainSnapshot = await hub.snapshotDownload({
    repo,
    revision: parentCommit,
    accessToken: token,
    cacheDir: path.join(workspace, "cache-main"),
  });
  const candidateRoot = path.join(workspace, "candidate-snapshot");
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
  const extracted = path.join(workspace, "extracted");
  await rm(extracted, { recursive: true, force: true });
  const verdict = await officialVerdict({
    candidateDirectory: candidate,
    extractedDirectory: extracted,
    policyFile: "policies/official-runs/v1.json",
    signerSha: transport.signerWorkflowSha,
    verifyAttestation: attestationVerifier,
  });
  if (verdict.status !== "accepted")
    throw new OfficialVerificationError(
      verdict.code,
      `Official candidate rejected: ${verdict.code}: ${verdict.message ?? ""}`,
    );
  const verified = verdict.evidence;
  const store = path.join(workspace, "store");
  const outputDirectory = path.join(workspace, "dataset");
  await rm(store, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await cp(path.join(mainSnapshot, "source"), store, { recursive: true, dereference: true });
  const normalized = path.join(extracted, "normalized");
  const runId = verified.manifest.executionIdentity.executionId;
  const metadata = await submissionMetadata(normalized, runId);
  metadata.purpose = "official";
  const submission = await buildSubmission(normalized, metadata);
  const result = await ingestSubmission(
    store,
    { ownerId: verified.transport.producer.repository, verification: "verified" },
    submission,
  );
  if (!result.created) throw Error("Official observation already exists on main");
  const proofRoot = path.join(store, "official");
  await mkdir(proofRoot, { recursive: true });
  const proof = path.join(proofRoot, runId);
  await mkdir(proof, { recursive: false });
  await Promise.all([
    cp(verified.artifact, path.join(proof, "official-result.tar.gz")),
    cp(verified.attestation, path.join(proof, "attestation.jsonl")),
    cp(path.join(candidate, "transport.json"), path.join(proof, "transport.json")),
    writeFile(
      path.join(proof, "acceptance.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          executionId: runId,
          artifactSha256: verified.artifactSha256,
          candidateNumber: Number(candidateNumber),
          candidateCommit,
          datasetParentCommit: parentCommit,
          signerWorkflowSha: transport.signerWorkflowSha,
          policyId: verified.policy.policyId,
        },
        null,
        2,
      )}\n`,
    ),
  ]);
  const index = await buildPublicDatasetFromStore(outputDirectory, store);
  assertPreserved(await readDatasetIndex(mainSnapshot), index);
  const commitOid = await publishDirectory({
    hub,
    repo,
    accessToken: token,
    parentCommit,
    outputDirectory,
    title: `Accept verified benchmark execution ${runId}`,
  });
  let candidateClosed = true;
  let closeError = null;
  try {
    await close(
      repository,
      Number(candidateNumber),
      token,
      `Accepted verified execution ${runId} in Dataset commit ${commitOid}.`,
    );
  } catch (error) {
    candidateClosed = false;
    closeError = String(error?.message ?? error);
  }
  return { executionId: runId, candidateCommit, commitOid, candidateClosed, closeError };
}

/** List open official candidate numbers without trusting their titles as verification. */
export async function listOpenOfficialCandidates(repository, fetchImpl = fetch) {
  if (!REPOSITORY.test(repository ?? "")) throw Error("Dataset repository must be owner/name");
  const response = await fetchImpl(
    `https://huggingface.co/api/datasets/${repository}/discussions?status=open`,
  );
  if (!response.ok) throw Error(`Hugging Face candidate listing failed (${response.status})`);
  const body = await response.json();
  return body.discussions
    .filter(
      (item) =>
        item.isPullRequest &&
        item.status === "open" &&
        item.title.startsWith("Contribute official benchmark execution "),
    )
    .map((item) => item.num);
}
