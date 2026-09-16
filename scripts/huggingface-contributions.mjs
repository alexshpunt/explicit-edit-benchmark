import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  commit,
  listCommits,
  listFiles,
  snapshotDownload,
  uploadFiles,
  whoAmI,
} from "@huggingface/hub";
import { buildSubmission } from "./benchmark-submission.mjs";
import { ingestSubmission } from "./benchmark-ingestion.mjs";
import { buildPublicDatasetFromStore } from "./build-public-dataset.mjs";
import { resolveHuggingFaceToken } from "./huggingface-auth.mjs";

const TABLES = [
  "profiles.jsonl",
  "configurations.jsonl",
  "trials.jsonl",
  "rounds.jsonl",
  "tool-calls.jsonl",
];
const CANDIDATE_FILES = ["manifest.json", ...TABLES, "submission.json"];
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const defaultHub = { commit, listCommits, listFiles, snapshotDownload, uploadFiles, whoAmI };

function datasetRepository(repository) {
  if (!REPOSITORY.test(repository ?? ""))
    throw Error("Hugging Face dataset repository must be owner/name");
  return { type: "dataset", name: repository };
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index]))
    throw Error(`${label}: fields must be exactly ${keys.join(", ")}`);
}

export async function headCommit(hub, repo, accessToken) {
  for await (const item of hub.listCommits({ repo, revision: "main", accessToken }))
    return item.oid;
  throw Error("Hugging Face dataset main has no commits");
}

async function directoryFiles(root, directory = root) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await directoryFiles(root, absolute)));
    else if (entry.isFile())
      result.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        content: pathToFileURL(absolute),
      });
    else throw Error(`Dataset output contains unsupported entry: ${absolute}`);
  }
  return result;
}

export async function publishDirectory({
  hub,
  repo,
  accessToken,
  parentCommit,
  outputDirectory,
  title,
}) {
  const files = await directoryFiles(outputDirectory);
  const generatedPaths = new Set(files.map((file) => file.path));
  const operations = files.map((file) => ({ operation: "addOrUpdate", ...file }));
  for await (const file of hub.listFiles({
    repo,
    revision: parentCommit,
    accessToken,
    recursive: true,
  })) {
    if (
      (!file.type || file.type === "file") &&
      file.path !== ".gitattributes" &&
      !generatedPaths.has(file.path) &&
      !file.path.startsWith("candidates/")
    )
      operations.push({ operation: "delete", path: file.path });
  }
  const result = await hub.commit({
    repo,
    accessToken,
    branch: "main",
    parentCommit,
    title,
    operations,
  });
  if (!result?.commit?.oid) throw Error("Hugging Face did not return a dataset commit");
  return result.commit.oid;
}

async function validateCandidateMetadata(metadata) {
  exactKeys(
    metadata,
    ["schemaVersion", "ownerId", "clientRunId", "purpose", "definitions"],
    "candidate metadata",
  );
  if (metadata.schemaVersion !== 1) throw Error("candidate metadata: schemaVersion must be 1");
  if (typeof metadata.ownerId !== "string" || !SAFE_SEGMENT.test(metadata.ownerId))
    throw Error("candidate metadata: invalid ownerId");
  return metadata;
}

async function ingestCandidate(storeDirectory, candidateDirectory) {
  const metadata = await validateCandidateMetadata(
    JSON.parse(await readFile(path.join(candidateDirectory, "submission.json"), "utf8")),
  );
  const submission = await buildSubmission(candidateDirectory, metadata);
  const result = await ingestSubmission(storeDirectory, { ownerId: metadata.ownerId }, submission);
  if (!result.created) throw Error("Candidate observation already exists on main");
  return { result, runId: submission.bundle.manifest.runId };
}

/** Upload a validated normalized bundle and safe metadata to a Hugging Face dataset pull request. */
export async function submitHuggingFaceCandidate({
  bundleDirectory,
  metadataFile,
  repository,
  accessToken,
  hub = defaultHub,
  homeDirectory,
  env,
}) {
  const repo = datasetRepository(repository);
  const token = await resolveHuggingFaceToken({ accessToken, homeDirectory, env });
  if (!token)
    throw Error("Hugging Face authentication is required; run `hf auth login` or set HF_TOKEN");
  const metadata = JSON.parse(await readFile(path.resolve(metadataFile), "utf8"));
  exactKeys(metadata, ["clientRunId", "purpose", "definitions"], "submission metadata");
  const submission = await buildSubmission(bundleDirectory, metadata);
  const runId = submission.bundle.manifest.runId;
  if (!SAFE_SEGMENT.test(runId)) throw Error(`Invalid runId: ${runId}`);
  const identity = await hub.whoAmI({ accessToken: token });
  const candidateMetadata = await validateCandidateMetadata({
    schemaVersion: 1,
    ownerId: identity.name,
    clientRunId: submission.clientRunId,
    purpose: submission.purpose,
    definitions: submission.definitions,
  });

  // Ingestion writes atomically, so validate in an isolated temporary store.
  const temporaryStore = await mkdtemp(path.join(os.tmpdir(), "hf-candidate-store-"));
  try {
    await ingestSubmission(temporaryStore, { ownerId: candidateMetadata.ownerId }, submission);
  } finally {
    await rm(temporaryStore, { recursive: true, force: true });
  }

  const prefix = `candidates/${runId}`;
  const files = await Promise.all([
    ...["manifest.json", ...TABLES].map(async (name) => ({
      path: `${prefix}/${name}`,
      content: new Blob([await readFile(path.join(bundleDirectory, name))]),
    })),
    Promise.resolve({
      path: `${prefix}/submission.json`,
      content: new Blob([`${JSON.stringify(candidateMetadata, null, 2)}\n`]),
    }),
  ]);
  const parentCommit = await headCommit(hub, repo, token);
  const result = await hub.uploadFiles({
    repo,
    accessToken: token,
    files,
    isPullRequest: true,
    parentCommit,
    commitTitle: `Contribute benchmark observation ${runId}`,
  });
  if (!result?.pullRequestUrl) throw Error("Hugging Face did not return a pull request URL");
  return { runId, pullRequestUrl: result.pullRequestUrl, commitOid: result.commit.oid };
}

function candidateRef(value) {
  if (!value) throw Error("A candidate PR number or revision is required");
  return /^\d+$/.test(value) ? `refs/pr/${value}` : value;
}

async function findCandidate(snapshot) {
  const root = path.join(snapshot, "candidates");
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT")
      throw Error("Candidate revision contains no candidates directory", { cause: error });
    throw error;
  }
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length !== 1 || entries.length !== 1)
    throw Error("Candidate revision must contain exactly one candidate directory");
  const directory = path.join(root, directories[0].name);
  const candidateEntries = await readdir(directory, { withFileTypes: true });
  const candidateTypes = await Promise.all(
    candidateEntries.map((entry) => stat(path.join(directory, entry.name))),
  );
  if (candidateTypes.some((entry) => !entry.isFile()))
    throw Error("Every candidate bundle entry must resolve to a regular file");
  const files = candidateEntries.map((entry) => entry.name).sort();
  if (
    files.length !== CANDIDATE_FILES.length ||
    files.some((name, index) => name !== [...CANDIDATE_FILES].sort()[index])
  )
    throw Error(`Candidate files must be exactly ${[...CANDIDATE_FILES].sort().join(", ")}`);
  return directory;
}

export async function readDatasetIndex(snapshot) {
  try {
    return JSON.parse(await readFile(path.join(snapshot, "dataset-index.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return { runs: [] };
    throw error;
  }
}

export function assertPreserved(currentIndex, nextIndex) {
  const next = new Map(nextIndex.runs.map((run) => [run.runId, run]));
  for (const run of currentIndex.runs ?? []) {
    const retained = next.get(run.runId);
    if (!retained) throw Error(`Dataset rebuild would drop existing observation ${run.runId}`);
    if (run.manifestSha256 && retained.manifestSha256 !== run.manifestSha256)
      throw Error(`Dataset rebuild would change existing observation ${run.runId}`);
  }
}

/** Accept one HF candidate against current main and atomically publish a complete rebuilt dataset. */
export async function acceptHuggingFaceCandidate({
  repository,
  candidateRevision,
  accessToken,
  workspaceDirectory,
  dryRun = false,
  hub = defaultHub,
}) {
  const repo = datasetRepository(repository);
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required to accept a Hugging Face candidate");
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
    revision: candidateRef(candidateRevision),
    accessToken: token,
    cacheDir: path.join(workspace, "cache-candidate"),
  });
  const source = path.join(mainSnapshot, "source");
  try {
    await readFile(path.join(source, "index.json"));
  } catch (error) {
    if (error?.code === "ENOENT")
      throw Error("Dataset main has no retained source bundles", {
        cause: error,
      });
    throw error;
  }
  const store = path.join(workspace, "store");
  const outputDirectory = path.join(workspace, "dataset");
  await rm(store, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
  await cp(source, store, { recursive: true, dereference: true });
  const candidate = await findCandidate(candidateSnapshot);
  const materializedCandidate = path.join(workspace, "candidate");
  await rm(materializedCandidate, { recursive: true, force: true });
  await cp(candidate, materializedCandidate, { recursive: true, dereference: true });
  const accepted = await ingestCandidate(store, materializedCandidate);
  const index = await buildPublicDatasetFromStore(outputDirectory, store);
  assertPreserved(await readDatasetIndex(mainSnapshot), index);
  if (dryRun) return { index, outputDirectory, commitOid: null, runId: accepted.runId };
  const commitOid = await publishDirectory({
    hub,
    repo,
    accessToken: token,
    parentCommit,
    outputDirectory,
    title: `Accept benchmark observation ${accepted.runId}`,
  });
  return { index, outputDirectory, commitOid, runId: accepted.runId };
}
