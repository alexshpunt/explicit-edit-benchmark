import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { executionIdentity } from "./official-identities.mjs";
import { approvedWorkflow, loadOfficialPolicy, runPolicyForLifecycle } from "./official-policy.mjs";
import { validateNormalizedRun } from "./validate-normalized-run.mjs";
import { explicitEditTasks } from "../src/suites/explicit-edit/fixtures.ts";
import { verifierSha256 } from "./verifier-identity.mjs";
import { suiteVerifier } from "./run-multi-agent-batch.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`${label}: expected fields ${expected.join(", ")}; got ${actual.join(", ")}`);
}

async function jsonLines(file) {
  return (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
}

/** Build the signed envelope metadata from a validated normalized bundle. */
export async function buildOfficialManifest(normalizedDirectory, options) {
  const root = path.resolve(normalizedDirectory);
  const normalized = await validateNormalizedRun(root);
  const configurations = await jsonLines(path.join(root, "configurations.jsonl"));
  const trials = await jsonLines(path.join(root, "trials.jsonl"));
  const hashes = configurations.map((row) => row.configurationHash);
  const execution = executionIdentity({
    repository: options.repository,
    runId: options.runId,
    producerAttempt: options.producerAttempt,
    invocation: options.invocation,
    configurationHashes: hashes,
  });
  const team = normalized.suite;
  const infrastructureFailures = team
    ? team.observations.filter((item) => !["pass", "blocked"].includes(item.status)).length
    : trials.filter((trial) => trial.infrastructureFailure !== null).length;
  const observedTrials = team
    ? trials.filter((trial) => trial.rounds > 0).length
    : trials.length - infrastructureFailures;
  const tasks = trials.flatMap((trial) =>
    (trial.taskIds ?? [trial.taskId]).map((id) => ({ id, fixtureSha256: trial.fixtureSha256 })),
  );
  const selectedTasks = new Set(tasks.map((task) => task.id));
  const lifecycleState =
    observedTrials === 0
      ? "infrastructure-failure"
      : selectedTasks.size === (team ? 71 : explicitEditTasks().length)
        ? "full-measurement"
        : "partial-measurement";
  return {
    schemaVersion: 1,
    policyId: options.policyId,
    source: {
      repository: options.repository,
      callerSha: options.callerSha,
      workflowRef: options.workflowRef,
    },
    executionIdentity: execution,
    runnerSha: options.runnerSha,
    normalized: {
      schemaVersion: normalized.schemaVersion,
      contract: normalized.contract,
      selectedTaskSetSha256: normalized.taskSetSha256,
      verifierSha256: normalized.verifierSha256,
      configurationHashes: [...new Set(hashes)].sort(),
      tasks,
      runPolicy: normalized.policy,
    },
    lifecycle: {
      state: lifecycleState,
      plannedTrials: trials.length,
      observedTrials,
      infrastructureFailures,
    },
    environment: {
      runnerOs: options.runnerOs,
      runnerArch: options.runnerArch,
      runnerImage: options.runnerImage,
    },
  };
}

/** Validate signed metadata against a repository-owned release policy and normalized bytes. */
export async function validateOfficialManifest(
  manifestFile,
  normalizedDirectory,
  policyFile,
  signerSha,
) {
  const manifest = JSON.parse(await readFile(path.resolve(manifestFile), "utf8"));
  const policy = await loadOfficialPolicy(policyFile);
  const workflow = approvedWorkflow(policy, signerSha);
  const normalized = await validateNormalizedRun(normalizedDirectory);
  const team = normalized.suite;
  const release = team ? policy.suites?.[team.id] : null;
  if (team && !release) throw Error("official manifest: suite has no approved release policy");
  const runner = release?.runner ?? policy.runner;
  if (team) {
    if (
      runner.taskSetSha256 !== team.workloadSha256 ||
      release.graphSha256 !== team.graphSha256 ||
      release.scheduleSha256 !== team.scheduleSha256
    )
      throw Error("official manifest: workload, graph or schedule does not match policy");
    if (runner.verifierSha256 !== (await suiteVerifier()))
      throw Error("release policy: verifier does not match trusted multi-agent runner");
  }
  const canonicalTasks = explicitEditTasks();
  const canonicalTaskSetSha256 = createHash("sha256")
    .update(JSON.stringify(canonicalTasks))
    .digest("hex");
  const canonicalVerifierSha256 = verifierSha256(
    await readFile(new URL("../src/suites/explicit-edit/files.ts", import.meta.url)),
  );
  if (policy.runner.taskSetSha256 !== canonicalTaskSetSha256)
    throw Error("release policy: canonical task set does not match trusted runner");
  if (policy.runner.verifierSha256 !== canonicalVerifierSha256)
    throw Error("release policy: verifier does not match trusted runner");
  exactKeys(
    manifest,
    [
      "schemaVersion",
      "policyId",
      "source",
      "executionIdentity",
      "runnerSha",
      "normalized",
      "lifecycle",
      "environment",
    ],
    "official manifest",
  );
  if (manifest.schemaVersion !== 1 || manifest.policyId !== policy.policyId)
    throw Error("official manifest: unsupported schema or policy");
  exactKeys(
    manifest.source,
    ["repository", "callerSha", "workflowRef"],
    "official manifest.source",
  );
  exactKeys(
    manifest.executionIdentity,
    ["repository", "runId", "producerAttempt", "invocation", "configurationHashes", "executionId"],
    "official manifest.executionIdentity",
  );
  exactKeys(
    manifest.normalized,
    [
      "schemaVersion",
      "contract",
      "selectedTaskSetSha256",
      "verifierSha256",
      "configurationHashes",
      "tasks",
      "runPolicy",
    ],
    "official manifest.normalized",
  );
  exactKeys(
    manifest.lifecycle,
    ["state", "plannedTrials", "observedTrials", "infrastructureFailures"],
    "official manifest.lifecycle",
  );
  exactKeys(
    manifest.environment,
    ["runnerOs", "runnerArch", "runnerImage"],
    "official manifest.environment",
  );
  if (!COMMIT.test(manifest.runnerSha) || manifest.runnerSha !== workflow.runnerSha)
    throw Error("official manifest: runner revision does not match signer policy");
  if (manifest.normalized.contract !== runner.contract)
    throw Error("official manifest: contract does not match policy");
  if (!(team ? [3] : policy.normalizedSchemas).includes(manifest.normalized.schemaVersion))
    throw Error("official manifest: normalized schema is not allowed");
  if (manifest.normalized.verifierSha256 !== runner.verifierSha256)
    throw Error("official manifest: verifier does not match policy");
  const expectedRunPolicy =
    release?.runPolicy ?? runPolicyForLifecycle(policy, manifest.lifecycle.state);
  for (const key of ["oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"])
    if (manifest.normalized.runPolicy[key] !== expectedRunPolicy[key])
      throw Error(`official manifest: run policy does not match policy: ${key}`);
  const tasks = new Map(runner.tasks.map((task) => [task.id, task.fixtureSha256]));
  if (!manifest.normalized.tasks.length) throw Error("official manifest: empty task selection");
  for (const task of manifest.normalized.tasks)
    if (tasks.get(task.id) !== task.fixtureSha256)
      throw Error(`official manifest: task identity does not match policy: ${task.id}`);
  const configurations = await jsonLines(path.join(normalizedDirectory, "configurations.jsonl"));
  const trials = await jsonLines(path.join(normalizedDirectory, "trials.jsonl"));
  const expected = await buildOfficialManifest(normalizedDirectory, {
    policyId: policy.policyId,
    repository: manifest.source.repository,
    runId: manifest.executionIdentity.runId,
    producerAttempt: manifest.executionIdentity.producerAttempt,
    invocation: manifest.executionIdentity.invocation,
    callerSha: manifest.source.callerSha,
    workflowRef: manifest.source.workflowRef,
    runnerSha: manifest.runnerSha,
    runnerOs: manifest.environment.runnerOs,
    runnerArch: manifest.environment.runnerArch,
    runnerImage: manifest.environment.runnerImage,
  });
  if (JSON.stringify(manifest) !== JSON.stringify(expected))
    throw Error("official manifest: metadata does not match normalized evidence");
  if (normalized.taskSetSha256 !== manifest.normalized.selectedTaskSetSha256)
    throw Error("official manifest: selected task-set hash mismatch");
  if (
    configurations.some((row) => !SHA256.test(row.configurationHash)) ||
    trials.length !== manifest.lifecycle.plannedTrials
  )
    throw Error("official manifest: invalid normalized identity");
  return { manifest, policy, workflow };
}

/** Validate a producer bundle against an active pinned runner before it receives signing authority. */
export async function validateOfficialManifestForRunner(
  manifestFile,
  normalizedDirectory,
  policyFile,
  runnerSha,
) {
  const policy = await loadOfficialPolicy(policyFile);
  const workflow = policy.workflows.find(
    (candidate) => candidate.status === "active" && candidate.runnerSha === runnerSha,
  );
  if (!workflow) throw Error(`Unknown active official runner SHA: ${runnerSha}`);
  return validateOfficialManifest(manifestFile, normalizedDirectory, policyFile, workflow.sha);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "build") {
    const [normalizedDirectory, output, encodedOptions] = args;
    if (!normalizedDirectory || !output || !encodedOptions)
      throw Error("Usage: official-result.mjs build NORMALIZED OUTPUT OPTIONS_JSON");
    const manifest = await buildOfficialManifest(normalizedDirectory, JSON.parse(encodedOptions));
    await writeFile(path.resolve(output), `${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "validate") {
    const [manifest, normalized, policy, signerSha] = args;
    if (!manifest || !normalized || !policy || !signerSha)
      throw Error("Usage: official-result.mjs validate MANIFEST NORMALIZED POLICY SIGNER_SHA");
    await validateOfficialManifest(manifest, normalized, policy, signerSha);
    return;
  }
  if (command === "validate-runner") {
    const [manifest, normalized, policy, runnerSha] = args;
    if (!manifest || !normalized || !policy || !runnerSha)
      throw Error(
        "Usage: official-result.mjs validate-runner MANIFEST NORMALIZED POLICY RUNNER_SHA",
      );
    await validateOfficialManifestForRunner(manifest, normalized, policy, runnerSha);
    return;
  }
  throw Error("Usage: official-result.mjs <build|validate|validate-runner> ...");
}

if (process.argv[1] === new URL(import.meta.url).pathname) await main();
