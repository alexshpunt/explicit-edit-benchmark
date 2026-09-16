import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { commit, listCommits, listFiles, snapshotDownload } from "@huggingface/hub";
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
import { verifyOfficialCandidate } from "./official-verifier.mjs";

const defaultHub = { commit, listCommits, listFiles, snapshotDownload };
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
  await run(process.execPath, [
    "scripts/verify-official-attestation.mjs",
    artifact,
    attestation,
    repository,
    "policies/official-runs/v1.json",
    signerSha,
  ]);
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
  const revision = `refs/pr/${candidateNumber}`;
  const parentCommit = await headCommit(hub, repo, token);
  const workspace = path.resolve(workspaceDirectory);
  await mkdir(workspace, { recursive: true });
  const mainSnapshot = await hub.snapshotDownload({
    repo,
    revision: parentCommit,
    accessToken: token,
    cacheDir: path.join(workspace, "cache-main"),
  });
  const candidateSnapshot = await hub.snapshotDownload({
    repo,
    revision,
    accessToken: token,
    cacheDir: path.join(workspace, "cache-candidate"),
  });
  const candidateCommit = path.basename(await realpath(candidateSnapshot));
  if (!/^[a-f0-9]{40}$/.test(candidateCommit))
    throw Error("Hugging Face candidate did not resolve to an immutable commit");
  const candidate = await findOfficialCandidate(candidateSnapshot);
  const transport = JSON.parse(await readFile(path.join(candidate, "transport.json"), "utf8"));
  const extracted = path.join(workspace, "extracted");
  await rm(extracted, { recursive: true, force: true });
  const verified = await verifyOfficialCandidate({
    candidateDirectory: candidate,
    extractedDirectory: extracted,
    policyFile: "policies/official-runs/v1.json",
    signerSha: transport.signerWorkflowSha,
    verifyAttestation: attestationVerifier,
  });
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
  await close(
    repository,
    Number(candidateNumber),
    token,
    `Accepted verified execution ${runId} in Dataset commit ${commitOid}.`,
  );
  return { executionId: runId, candidateCommit, commitOid };
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
