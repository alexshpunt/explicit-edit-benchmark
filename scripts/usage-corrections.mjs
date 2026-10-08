import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { commit, downloadFile, listCommits } from "@huggingface/hub";
import { createAggregateState, verifyAggregateState } from "./aggregate-state.mjs";
import { ingestSubmission } from "./benchmark-ingestion.mjs";
import { buildSubmission } from "./benchmark-submission.mjs";
import {
  buildDerivedDatasetFromAggregateState,
  buildPublicDataset,
} from "./build-public-dataset.mjs";
import {
  downloadHuggingFaceCandidate,
  headCommit,
  verifyIncrementalDatasetState,
} from "./huggingface-contributions.mjs";
import { resolveHuggingFaceToken } from "./huggingface-auth.mjs";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";

const TABLES = [
  "profiles.jsonl",
  "configurations.jsonl",
  "trials.jsonl",
  "rounds.jsonl",
  "tool-calls.jsonl",
];
const USAGE = [
  "costUsd",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "totalTokens",
];
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const rows = (content) =>
  content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
const withoutUsage = (round) =>
  Object.fromEntries(Object.entries(round).filter(([key]) => !USAGE.includes(key)));

/** Reject anything except an explicitly pinned batch of ordinary usage corrections. */
export function validateCorrectionRequests(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > 10)
    throw Error("Provide between one and ten correction requests");
  const seen = new Set();
  for (const request of requests) {
    assert.deepEqual(
      Object.keys(request).sort(),
      [
        "candidate",
        "author",
        "candidateCommit",
        "manifestSha256",
        "roundsSha256",
        "totalTokens",
        "costUsd",
      ].sort(),
    );
    if (
      !Number.isSafeInteger(request.candidate) ||
      request.candidate < 1 ||
      seen.has(request.candidate)
    )
      throw Error("Invalid or repeated candidate number");
    seen.add(request.candidate);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(request.author)) throw Error("Invalid contributor");
    if (!/^[a-f0-9]{40}$/.test(request.candidateCommit))
      throw Error("Pin an immutable candidate commit");
    for (const key of ["manifestSha256", "roundsSha256"])
      if (!/^[a-f0-9]{64}$/.test(request[key])) throw Error(`Invalid ${key}`);
    if (
      !Number.isSafeInteger(request.totalTokens) ||
      request.totalTokens < 0 ||
      !Number.isFinite(request.costUsd) ||
      request.costUsd < 0
    )
      throw Error("Invalid expected usage totals");
  }
  return requests;
}

/** Compare validated bundles and return usage totals; all other evidence must stay identical. */
export function assertUsageOnlyCorrection(previous, next) {
  const oldManifest = structuredClone(previous.manifest);
  const newManifest = structuredClone(next.manifest);
  delete oldManifest.files["rounds.jsonl"];
  delete newManifest.files["rounds.jsonl"];
  assert.deepEqual(newManifest, oldManifest, "Correction changed non-usage manifest fields");
  assert.deepEqual(next.tables, previous.tables, "Correction changed a non-usage table");
  assert.deepEqual(
    next.rounds.map(withoutUsage),
    previous.rounds.map(withoutUsage),
    "Correction changed non-usage round evidence",
  );
  const totals = Object.fromEntries(USAGE.map((key) => [key, 0]));
  for (const round of next.rounds) {
    for (const key of USAGE) {
      const value = round[key];
      if (value === null) continue;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (key !== "costUsd" && !Number.isSafeInteger(value))
      )
        throw Error(`Invalid corrected ${key}`);
      totals[key] += value;
    }
    const buckets = [
      round.inputTokens,
      round.outputTokens,
      round.cacheReadTokens,
      round.cacheWriteTokens,
    ];
    if (
      buckets.every((value) => typeof value === "number") &&
      round.totalTokens !== buckets.reduce((sum, value) => sum + value, 0)
    )
      throw Error("Corrected totalTokens does not equal token buckets");
  }
  return totals;
}

async function evidence(directory) {
  const manifest = await validateNormalizedRun(directory);
  const tables = {};
  for (const name of TABLES) tables[name] = await readFile(path.join(directory, name), "utf8");
  const rounds = rows(tables["rounds.jsonl"]);
  delete tables["rounds.jsonl"];
  return { manifest, tables, rounds };
}

async function download(hub, repo, revision, token, file) {
  const blob = await hub.downloadFile({ repo, revision, accessToken: token, path: file });
  if (!blob) throw Error(`Dataset is missing ${file}`);
  return Buffer.from(await blob.arrayBuffer());
}

async function outputFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await outputFiles(root, file)));
    else if (entry.isFile())
      files.push({
        operation: "addOrUpdate",
        path: path.relative(root, file).split(path.sep).join("/"),
        content: new Blob([await readFile(file)]),
      });
    else throw Error("Unexpected file type in correction output");
  }
  return files;
}

/** Validate a bounded batch, replace existing evidence atomically, and leave PRs under manual control. */
export async function correctUsage({
  repository,
  requests,
  accessToken,
  workspaceDirectory,
  dryRun = true,
  expectedDatasetRevision,
  hub = { commit, downloadFile, listCommits },
  fetchImpl = fetch,
}) {
  validateCorrectionRequests(requests);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("Dataset repository must be owner/name");
  if (!dryRun && !/^[a-f0-9]{40}$/.test(expectedDatasetRevision ?? ""))
    throw Error("Production requires the reviewed dry-run Dataset revision");
  const token = await resolveHuggingFaceToken({ accessToken });
  if (!token) throw Error("HF_TOKEN is required");
  const repo = { type: "dataset", name: repository };
  const parentCommit = await headCommit(hub, repo, token);
  if (expectedDatasetRevision && expectedDatasetRevision !== parentCommit)
    throw Error("Dataset changed since review; run a new dry run");
  const workspace = path.resolve(workspaceDirectory);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  const readJson = async (file) =>
    JSON.parse((await download(hub, repo, parentCommit, token, file)).toString("utf8"));
  const [sourceIndex, datasetIndex, aggregateState] = await Promise.all([
    readJson("source/index.json"),
    readJson("dataset-index.json"),
    readJson("aggregate-state.json"),
  ]);
  verifyIncrementalDatasetState(sourceIndex, datasetIndex, aggregateState);
  const originalSource = structuredClone(sourceIndex);
  const originalDataset = structuredClone(datasetIndex);
  const replacements = new Map();
  const corrected = [];
  const output = path.join(workspace, "output");
  const seenRuns = new Set();
  for (const request of requests) {
    const candidate = path.join(workspace, `candidate-${request.candidate}`);
    const info = await downloadHuggingFaceCandidate({
      hub,
      repo,
      repository,
      candidateNumber: request.candidate,
      accessToken: token,
      directory: candidate,
      fetchImpl,
    });
    if (
      info.candidateCommit !== request.candidateCommit ||
      info.submittedBy.accountId !== request.author
    )
      throw Error("Candidate commit or contributor differs from reviewed request");
    if (seenRuns.has(info.runId)) throw Error("Repeated run in correction batch");
    seenRuns.add(info.runId);
    const source = sourceIndex.submissions.find((item) => item.runId === info.runId);
    const oldRun = datasetIndex.runs.find((item) => item.runId === info.runId);
    if (!source || !oldRun || oldRun.official || source.verification !== "unverified")
      throw Error("Correction requires an existing ordinary unverified observation");
    if (!/^[a-f0-9]{64}$/.test(source.submissionId)) throw Error("Invalid accepted submission ID");
    if (
      source.ownerId !== request.author ||
      source.submittedBy?.accountId !== request.author ||
      source.submissionUrl !== info.submissionUrl
    )
      throw Error("Correction contributor does not own this accepted PR observation");
    const manifestContent = await readFile(path.join(candidate, "manifest.json"));
    const roundsContent = await readFile(path.join(candidate, "rounds.jsonl"));
    if (
      sha256(manifestContent) !== request.manifestSha256 ||
      sha256(roundsContent) !== request.roundsSha256
    )
      throw Error("Corrected bundle hashes differ from reviewed request");
    const metadata = JSON.parse(await readFile(path.join(candidate, "submission.json"), "utf8"));
    assert.deepEqual(
      metadata,
      Object.fromEntries(
        ["schemaVersion", "ownerId", "clientRunId", "purpose", "definitions"].map((key) => [
          key,
          source[key],
        ]),
      ),
      "Correction changed submission identity or definitions",
    );
    const previous = path.join(workspace, `previous-${request.candidate}`);
    await mkdir(previous);
    for (const name of ["manifest.json", ...TABLES]) {
      await writeFile(
        path.join(previous, name),
        await download(
          hub,
          repo,
          parentCommit,
          token,
          `source/accepted/${source.submissionId}/${name}`,
        ),
      );
    }
    if (sha256(await readFile(path.join(previous, "manifest.json"))) !== oldRun.manifestSha256)
      throw Error("Accepted source manifest does not match Dataset index");
    const totals = assertUsageOnlyCorrection(await evidence(previous), await evidence(candidate));
    if (
      totals.totalTokens !== request.totalTokens ||
      Math.abs(totals.costUsd - request.costUsd) > 1e-9
    )
      throw Error("Corrected usage totals differ from reviewed request");
    const validationStore = path.join(workspace, `validate-${request.candidate}`);
    const submission = await buildSubmission(candidate, metadata);
    await ingestSubmission(validationStore, { ownerId: metadata.ownerId }, submission);
    const validated = JSON.parse(await readFile(path.join(validationStore, "index.json"), "utf8"))
      .submissions[0];
    source.contentHash = validated.contentHash;
    source.usageCorrections = [
      ...(source.usageCorrections ?? []),
      {
        previousDatasetRevision: parentCommit,
        previousManifestSha256: oldRun.manifestSha256,
        manifestSha256: request.manifestSha256,
        candidateCommit: request.candidateCommit,
        submissionUrl: info.submissionUrl,
      },
    ];
    const runOutput = path.join(workspace, `run-${request.candidate}`);
    const single = await buildPublicDataset(runOutput, [candidate]);
    const run = { ...oldRun, ...single.runs[0] };
    const unchangedRun = (item) => {
      const copy = structuredClone(item);
      delete copy.manifestSha256;
      delete copy.files;
      return copy;
    };
    assert.deepEqual(
      unchangedRun(run),
      unchangedRun(oldRun),
      "Correction changed non-usage run facts",
    );
    for (const table of ["profiles", "configurations", "trials", "tool-calls"])
      assert.deepEqual(
        run.files[table],
        oldRun.files[table],
        "Correction changed a non-usage shard",
      );
    if (run.manifestSha256 !== request.manifestSha256)
      throw Error("Generated manifest hash changed");
    const rawEvidence = {};
    for (const [key, table] of [
      ["profiles", "profiles"],
      ["trials", "trials"],
      ["rounds", "rounds"],
      ["toolCalls", "tool-calls"],
    ]) {
      rawEvidence[key] = rows(
        gunzipSync(
          await readFile(path.join(runOutput, "data", table, `${info.runId}.jsonl.gz`)),
        ).toString("utf8"),
      );
    }
    replacements.set(
      info.runId,
      createAggregateState({ sourceIndex, run, ...rawEvidence }).contributions[0],
    );
    datasetIndex.runs[datasetIndex.runs.findIndex((item) => item.runId === info.runId)] = run;
    const destination = path.join(output, "source", "accepted", source.submissionId);
    await mkdir(destination, { recursive: true });
    for (const name of ["manifest.json", ...TABLES])
      await cp(path.join(candidate, name), path.join(destination, name));
    await writeFile(
      path.join(destination, "submission.json"),
      JSON.stringify(source, null, 2) + "\n",
    );
    for (const table of ["profiles", "configurations", "trials", "rounds", "tool-calls"]) {
      await mkdir(path.join(output, "data", table), { recursive: true });
      await cp(
        path.join(runOutput, "data", table, `${info.runId}.jsonl.gz`),
        path.join(output, "data", table, `${info.runId}.jsonl.gz`),
      );
    }
    corrected.push({
      candidate: request.candidate,
      runId: info.runId,
      submissionId: source.submissionId,
      candidateCommit: request.candidateCommit,
      manifestSha256: request.manifestSha256,
      roundsSha256: request.roundsSha256,
      totals,
    });
  }
  assert.deepEqual(
    sourceIndex.submissions.map((item) => [item.runId, item.submissionId]),
    originalSource.submissions.map((item) => [item.runId, item.submissionId]),
  );
  for (const oldRun of originalDataset.runs) {
    if (!seenRuns.has(oldRun.runId))
      assert.deepEqual(
        datasetIndex.runs.find((item) => item.runId === oldRun.runId),
        oldRun,
      );
  }
  const nextState = {
    ...aggregateState,
    source: createAggregateState({
      sourceIndex,
      run: [],
      profiles: [],
      trials: [],
      rounds: [],
      toolCalls: [],
    }).source,
    contributions: aggregateState.contributions.map(
      (item) => replacements.get(item.run.runId) ?? item,
    ),
  };
  for (const previous of aggregateState.contributions) {
    const next = nextState.contributions.find((item) => item.run.runId === previous.run.runId);
    const nonUsage = (item) => {
      const copy = structuredClone(item);
      delete copy.run.manifestSha256;
      delete copy.run.files.rounds;
      for (const trial of copy.trials) {
        delete trial.metrics.costUsd;
        delete trial.metrics.totalTokens;
      }
      return copy;
    };
    assert.deepEqual(
      nonUsage(next),
      nonUsage(previous),
      "Correction changed non-usage aggregate facts",
    );
  }
  verifyAggregateState(nextState, sourceIndex);
  verifyIncrementalDatasetState(sourceIndex, datasetIndex, nextState);
  const sourceContent = JSON.stringify(sourceIndex, null, 2) + "\n";
  await writeFile(path.join(output, "source", "index.json"), sourceContent);
  datasetIndex.source = {
    path: "source/index.json",
    bytes: Buffer.byteLength(sourceContent),
    sha256: sha256(sourceContent),
  };
  await buildDerivedDatasetFromAggregateState(output, datasetIndex, nextState);
  const operations = await outputFiles(output);
  const result = {
    dryRun,
    changed: false,
    parentCommit,
    datasetRevision: parentCommit,
    operationCount: operations.length,
    observationCount: datasetIndex.runs.length,
    corrected,
  };
  if (dryRun) return result;
  const published = await hub.commit({
    repo,
    accessToken: token,
    branch: "main",
    parentCommit,
    title: `Correct usage for ${corrected.length} existing observation(s)`,
    operations,
  });
  if (!published.commit.oid) throw Error("Hugging Face did not return a Dataset commit");
  result.changed = true;
  result.datasetRevision = published.commit.oid;
  for (const item of corrected) {
    try {
      const response = await fetchImpl(
        `https://huggingface.co/api/datasets/${repository}/discussions/${item.candidate}/comment`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            comment: `Accepted the usage-only correction for existing observation ${item.runId} in Dataset commit ${result.datasetRevision}. Total tokens including cache: ${item.totals.totalTokens}; CLI-reported USD cost: ${item.totals.costUsd.toFixed(9)}. Validated the corrected bundle hashes and unchanged non-usage evidence. The existing run and submission IDs, task results, timings and recovery outcomes are preserved; no new observation was added. Canonical evidence and derived usage views have been updated. CLI-reported cost is not an invoice amount. This PR remains open under manual review.`,
          }),
        },
      );
      if (!response.ok)
        throw Error(`Receipt failed (${response.status}): ${await response.text()}`);
      item.receiptPosted = true;
    } catch (error) {
      item.receiptPosted = false;
      item.receiptError = String(error?.message ?? error);
    }
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (!process.env.GITHUB_ACTIONS || !process.env.RUNNER_TEMP)
    throw Error("Run usage corrections through the maintainer GitHub workflow");
  const requests = JSON.parse(process.env.CORRECTION_REQUESTS);
  console.log(
    JSON.stringify(
      await correctUsage({
        repository: process.env.DATASET_REPOSITORY,
        requests,
        accessToken: process.env.HF_TOKEN,
        workspaceDirectory: path.join(process.env.RUNNER_TEMP, "usage-corrections"),
        dryRun: process.env.DRY_RUN !== "false",
        expectedDatasetRevision: process.env.EXPECTED_DATASET_REVISION || undefined,
      }),
    ),
  );
}
