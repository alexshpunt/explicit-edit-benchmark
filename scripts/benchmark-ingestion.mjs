#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";
import { hashApiKey, loadBenchmarkAccounts } from "./benchmark-accounts.mjs";

const TABLES = [
  "profiles.jsonl",
  "configurations.jsonl",
  "trials.jsonl",
  "rounds.jsonl",
  "tool-calls.jsonl",
];
const PURPOSES = new Set(["official", "community", "exploratory", "smoke", "debug"]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/;

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label} must be an object`);
  return value;
}
function exactKeys(value, keys, label) {
  const actual = Object.keys(object(value, label)).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw Error(`${label}: fields must be exactly ${expected.join(", ")}`);
}
function text(value, label, maximum = 200) {
  if (typeof value !== "string" || !value || value.length > maximum || !ID.test(value))
    throw Error(`${label}: invalid value`);
  return value;
}
function plainText(value, label, maximum = 200) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw Error(`${label}: invalid value`);
  return value;
}
function hashText(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw Error(`${label}: invalid SHA-256`);
  return value;
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function parseRows(content) {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * A submission declares one version per harness, while each configuration records the exact
 * version it ran. The declared version has to be one of them, not the only one: an archive may
 * hold several builds of the same tool.
 */
export function assertDeclaredHarnessVersions(harnesses, profiles) {
  const declaredById = new Map(harnesses.map((harness) => [harness.id, harness.version]));
  const versionsByHarness = new Map();
  for (const profile of profiles) {
    if (!declaredById.has(profile.harnessId))
      throw Error("profile references an undeclared harness");
    if (!profile.harnessVersion) continue;
    const versions = versionsByHarness.get(profile.harnessId) ?? new Set();
    versions.add(profile.harnessVersion);
    versionsByHarness.set(profile.harnessId, versions);
  }
  for (const [harnessId, versions] of versionsByHarness) {
    const declared = declaredById.get(harnessId);
    if (declared && !versions.has(declared))
      throw Error(
        `harness ${harnessId} declares version ${declared}, but this bundle only ran ${[...versions].sort().join(", ")}`,
      );
  }
}

function validateEnvelope(input) {
  exactKeys(
    input,
    ["schemaVersion", "clientRunId", "purpose", "definitions", "bundle"],
    "submission",
  );
  if (input.schemaVersion !== 1) throw Error("submission: schemaVersion must be 1");
  text(input.clientRunId, "submission.clientRunId");
  if (!PURPOSES.has(input.purpose)) throw Error("submission: invalid purpose");

  exactKeys(input.definitions, ["benchmark", "taskSet", "harnesses", "runner"], "definitions");
  const benchmark = input.definitions.benchmark;
  exactKeys(benchmark, ["id", "version", "contract", "kind", "hash"], "definitions.benchmark");
  text(benchmark.id, "benchmark.id");
  plainText(benchmark.version, "benchmark.version");
  plainText(benchmark.contract, "benchmark.contract");
  hashText(benchmark.hash, "benchmark.hash");
  if (!["official", "experimental"].includes(benchmark.kind))
    throw Error("benchmark.kind: invalid value");

  const taskSet = input.definitions.taskSet;
  exactKeys(taskSet, ["hash", "taskIds"], "definitions.taskSet");
  hashText(taskSet.hash, "taskSet.hash");
  if (!Array.isArray(taskSet.taskIds) || !taskSet.taskIds.length)
    throw Error("taskSet.taskIds: invalid value");
  taskSet.taskIds.forEach((id) => text(id, "taskSet.taskIds[]"));
  if (new Set(taskSet.taskIds).size !== taskSet.taskIds.length)
    throw Error("taskSet.taskIds: duplicate value");

  if (!Array.isArray(input.definitions.harnesses) || !input.definitions.harnesses.length)
    throw Error("definitions.harnesses: invalid value");
  for (const [index, harness] of input.definitions.harnesses.entries()) {
    exactKeys(harness, ["id", "name", "version", "sourceHash"], `definitions.harnesses[${index}]`);
    text(harness.id, "harness.id");
    plainText(harness.name, "harness.name");
    plainText(harness.version, "harness.version");
    hashText(harness.sourceHash, "harness.sourceHash");
  }

  const runner = input.definitions.runner;
  exactKeys(runner, ["id", "name", "version"], "definitions.runner");
  text(runner.id, "runner.id");
  plainText(runner.name, "runner.name");
  plainText(runner.version, "runner.version");
  const serializedDefinitions = stable(input.definitions);
  if (
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|\b(?:sk|hf|ghp|github_pat)_[A-Za-z0-9_-]{16,}|(?:^|["'])\/(?:root|home)\//u.test(
      serializedDefinitions,
    )
  )
    throw Error("definitions contain a credential or machine-local path");
  exactKeys(input.bundle, ["manifest", "tables"], "bundle");
  exactKeys(input.bundle.tables, TABLES, "bundle.tables");
  for (const name of TABLES)
    if (typeof input.bundle.tables[name] !== "string")
      throw Error(`bundle.tables.${name}: invalid value`);
  return input;
}

async function readIndex(root) {
  try {
    return JSON.parse(await readFile(path.join(root, "index.json"), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: 1, submissions: [] };
  }
}
async function writeIndex(root, index) {
  const temporary = path.join(root, `.index-${process.pid}-${Date.now()}.json`);
  await writeFile(temporary, JSON.stringify(index, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temporary, path.join(root, "index.json"));
}

/** Return accepted submission metadata from an append-only ingestion store. */
export async function listAcceptedSubmissions(storeDirectory) {
  await mkdir(storeDirectory, { recursive: true });
  const index = await readIndex(storeDirectory);
  return index.submissions;
}

/** Validate and atomically append one normalized observation bundle. */
export async function ingestSubmission(storeDirectory, account, rawSubmission) {
  const submission = validateEnvelope(object(rawSubmission, "submission"));
  await mkdir(path.join(storeDirectory, "accepted"), { recursive: true });
  const index = await readIndex(storeDirectory);
  const ownerClient = index.submissions.find(
    (item) => item.ownerId === account.ownerId && item.clientRunId === submission.clientRunId,
  );
  const contentHash = digest(
    stable({ definitions: submission.definitions, bundle: submission.bundle }),
  );
  if (ownerClient) {
    if (ownerClient.contentHash !== contentHash)
      throw Error("clientRunId was already used for different content");
    return { submissionId: ownerClient.submissionId, created: false };
  }
  const duplicate = index.submissions.find((item) => item.contentHash === contentHash);
  if (duplicate) return { submissionId: duplicate.submissionId, created: false };
  const duplicateRun = index.submissions.find(
    (item) => item.runId === submission.bundle.manifest.runId,
  );
  if (duplicateRun) throw Error("runId was already used for different content");

  const staging = await mkdtemp(path.join(os.tmpdir(), "benchmark-submission-"));
  try {
    await Promise.all([
      writeFile(
        path.join(staging, "manifest.json"),
        JSON.stringify(submission.bundle.manifest, null, 2) + "\n",
      ),
      ...TABLES.map((name) => writeFile(path.join(staging, name), submission.bundle.tables[name])),
    ]);
    const manifest = await validateNormalizedRun(staging);
    if (manifest.contract !== submission.definitions.benchmark.contract)
      throw Error("benchmark definition contradicts manifest contract");
    if (manifest.taskSetSha256 !== submission.definitions.taskSet.hash)
      throw Error("task-set definition contradicts manifest");
    const trials = parseRows(submission.bundle.tables["trials.jsonl"]);
    const taskIds = new Set(submission.definitions.taskSet.taskIds);
    if (trials.some((trial) => !taskIds.has(trial.taskId)))
      throw Error("trial references a task outside the declared task set");
    const profiles = parseRows(submission.bundle.tables["profiles.jsonl"]);
    assertDeclaredHarnessVersions(submission.definitions.harnesses, profiles);

    const submissionId = contentHash;
    const destination = path.join(storeDirectory, "accepted", submissionId);
    await mkdir(destination, { recursive: false });
    await Promise.all([
      writeFile(
        path.join(destination, "manifest.json"),
        JSON.stringify(submission.bundle.manifest, null, 2) + "\n",
        { flag: "wx" },
      ),
      ...TABLES.map((name) =>
        writeFile(path.join(destination, name), submission.bundle.tables[name], { flag: "wx" }),
      ),
    ]);
    const metadata = {
      schemaVersion: submission.schemaVersion,
      bundleSchemaVersion: manifest.schemaVersion,
      submissionId,
      contentHash,
      ownerId: account.ownerId,
      ...(account.submittedBy ? { submittedBy: account.submittedBy } : {}),
      ...(account.sourceRepository ? { sourceRepository: account.sourceRepository } : {}),
      ...(account.submissionUrl ? { submissionUrl: account.submissionUrl } : {}),
      clientRunId: submission.clientRunId,
      runId: manifest.runId,
      purpose: submission.purpose,
      verification: account.verification ?? "unverified",
      definitions: submission.definitions,
    };
    await writeFile(
      path.join(destination, "submission.json"),
      JSON.stringify(metadata, null, 2) + "\n",
      { flag: "wx" },
    );
    index.submissions.push(metadata);
    await writeIndex(storeDirectory, index);
    return { submissionId, created: true };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/** Start the authenticated benchmark ingestion HTTP service. */
export async function createIngestionServer({
  storeDirectory,
  apiKeys = {},
  apiKeyHashes = {},
  host = "127.0.0.1",
  port = 0,
  maxBytes = 32 * 1024 * 1024,
}) {
  const accounts = {
    ...apiKeyHashes,
    ...Object.fromEntries(
      Object.entries(apiKeys).map(([key, account]) => [hashApiKey(key), account]),
    ),
  };
  await mkdir(storeDirectory, { recursive: true });
  if (!(await listAcceptedSubmissions(storeDirectory)).length)
    await writeIndex(storeDirectory, { schemaVersion: 1, submissions: [] });
  let queue = Promise.resolve();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/submissions")
      return json(response, 404, { code: "not-found" });
    const header = request.headers.authorization ?? "";
    const key = header.startsWith("Bearer ") ? header.slice(7) : "";
    const suppliedHash = hashApiKey(key);
    const match = Object.entries(accounts).find(([candidate]) =>
      safeEqual(candidate, suppliedHash),
    );
    if (!match) return json(response, 401, { code: "unauthorized" });
    const [, account] = match;
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      tooLarge = tooLarge || bytes > maxBytes;
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("error", () => {
      if (!response.headersSent) json(response, 400, { code: "request-error" });
    });
    request.on("end", () => {
      if (tooLarge) return json(response, 413, { code: "payload-too-large" });
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return json(response, 400, { code: "invalid-json" });
      }
      const action = queue.then(() => ingestSubmission(storeDirectory, account, payload));
      queue = action.catch(() => undefined);
      action
        .then((result) => json(response, result.created ? 201 : 200, result))
        .catch((error) =>
          json(response, 400, { code: "invalid-submission", message: error.message }),
        );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const storeDirectory = process.env.BENCHMARK_STORE;
  const accountsFile = process.env.BENCHMARK_ACCOUNTS;
  if (!storeDirectory || !accountsFile)
    throw Error("BENCHMARK_STORE and BENCHMARK_ACCOUNTS are required");
  const server = await createIngestionServer({
    storeDirectory,
    apiKeyHashes: await loadBenchmarkAccounts(accountsFile),
    host: process.env.BENCHMARK_HOST ?? "127.0.0.1",
    port: Number(process.env.BENCHMARK_PORT ?? 8787),
  });
  console.log(`Benchmark ingestion listening at ${server.url}`);
}
