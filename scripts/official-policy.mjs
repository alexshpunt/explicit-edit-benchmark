import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function validateRunner(runner, label) {
  exactKeys(runner, ["contract", "taskSetSha256", "verifierSha256", "tasks"], label);
  if (!SHA256.test(runner.taskSetSha256) || !SHA256.test(runner.verifierSha256))
    throw Error(`${label}: invalid identity hash`);
  if (typeof runner.contract !== "string" || !runner.contract)
    throw Error(`${label}: invalid contract`);
  if (!Array.isArray(runner.tasks) || !runner.tasks.length)
    throw Error(`${label}.tasks: empty task registry`);
  const ids = new Set();
  for (const [index, task] of runner.tasks.entries()) {
    exactKeys(task, ["id", "fixtureSha256"], `${label}.tasks[${index}]`);
    if (
      typeof task.id !== "string" ||
      !task.id ||
      !SHA256.test(task.fixtureSha256) ||
      ids.has(task.id)
    )
      throw Error(`${label}.tasks[${index}]: invalid task identity`);
    ids.add(task.id);
  }
}

function validateTeamRelease(suites) {
  exactKeys(suites, [MULTI_AGENT_BENCHMARK], "policy.suites");
  const suite = suites[MULTI_AGENT_BENCHMARK];
  exactKeys(
    suite,
    ["runner", "graphSha256", "scheduleSha256", "runPolicy"],
    "policy.suites.multi-agent",
  );
  validateRunner(suite.runner, "policy.suites.multi-agent.runner");
  if (
    suite.runner.contract !== MULTI_AGENT_PROTOCOL ||
    !SHA256.test(suite.graphSha256) ||
    !SHA256.test(suite.scheduleSha256)
  )
    throw Error("policy.suites.multi-agent: invalid protocol or graph identity");
  const expected = Array.from(
    { length: 71 },
    (_, index) => `task-${String(index + 1).padStart(3, "0")}`,
  );
  if (JSON.stringify(suite.runner.tasks.map((task) => task.id).sort()) !== JSON.stringify(expected))
    throw Error("policy.suites.multi-agent: expected the full 71-task registry");
  exactKeys(
    suite.runPolicy,
    ["partialRuns", "oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"],
    "policy.suites.multi-agent.runPolicy",
  );
  if (
    suite.runPolicy.partialRuns !== true ||
    suite.runPolicy.oracleRecoveries !== 3 ||
    suite.runPolicy.retryFailures !== 0 ||
    suite.runPolicy.concurrency !== 15 ||
    suite.runPolicy.timeoutMs !== null
  )
    throw Error("policy.suites.multi-agent: expected 15 agents, three corrections and no deadline");
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label}: expected object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw Error(`${label}: expected fields ${expected.join(", ")}; got ${actual.join(", ")}`);
}

/** Load and strictly validate a repository-owned official-run release policy. */
export async function loadOfficialPolicy(file) {
  const source = typeof file === "string" ? path.resolve(file) : file;
  const policy = JSON.parse(await readFile(source, "utf8"));
  exactKeys(
    policy,
    [
      "schemaVersion",
      "policyId",
      "attestation",
      "workflows",
      "runner",
      "benchmark",
      "modelRegistry",
      "normalizedSchemas",
      "runPolicy",
      "fullRunPolicy",
      ...(Object.hasOwn(policy, "suites") ? ["suites"] : []),
    ],
    "policy",
  );
  if (policy.schemaVersion !== 1 || !/^official-runs-v[1-9][0-9]*$/.test(policy.policyId))
    throw Error("policy: unsupported identity or schema");
  exactKeys(
    policy.attestation,
    ["issuer", "predicateType", "signerWorkflow", "denySelfHosted"],
    "policy.attestation",
  );
  if (policy.attestation.issuer !== "https://token.actions.githubusercontent.com")
    throw Error("policy.attestation: unsupported issuer");
  if (policy.attestation.predicateType !== "https://slsa.dev/provenance/v1")
    throw Error("policy.attestation: unsupported predicate type");
  if (policy.attestation.denySelfHosted !== true)
    throw Error("policy.attestation: self-hosted must be denied");
  if (!Array.isArray(policy.workflows) || !policy.workflows.length)
    throw Error("policy.workflows: at least one workflow is required");
  for (const [index, workflow] of policy.workflows.entries()) {
    exactKeys(workflow, ["sha", "runnerSha", "status"], `policy.workflows[${index}]`);
    if (!COMMIT.test(workflow.sha) || !COMMIT.test(workflow.runnerSha))
      throw Error(`policy.workflows[${index}]: invalid commit SHA`);
    if (!["active", "revoked"].includes(workflow.status))
      throw Error(`policy.workflows[${index}]: invalid status`);
  }
  exactKeys(policy.benchmark, ["repository"], "policy.benchmark");
  if (policy.benchmark.repository !== "alexshpunt/explicit-edit-benchmark")
    throw Error("policy.benchmark: unsupported repository");
  exactKeys(policy.modelRegistry, ["id", "sha256"], "policy.modelRegistry");
  if (
    typeof policy.modelRegistry.id !== "string" ||
    !policy.modelRegistry.id ||
    !SHA256.test(policy.modelRegistry.sha256)
  )
    throw Error("policy.modelRegistry: invalid identity");
  validateRunner(policy.runner, "policy.runner");
  if (Object.hasOwn(policy, "suites")) validateTeamRelease(policy.suites);
  if (
    !Array.isArray(policy.normalizedSchemas) ||
    !policy.normalizedSchemas.length ||
    policy.normalizedSchemas.some((version) => !Number.isInteger(version))
  )
    throw Error("policy.normalizedSchemas: invalid schema list");
  for (const [name, runPolicy] of [
    ["runPolicy", policy.runPolicy],
    ["fullRunPolicy", policy.fullRunPolicy],
  ]) {
    exactKeys(
      runPolicy,
      ["partialRuns", "oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"],
      `policy.${name}`,
    );
    if (runPolicy.partialRuns !== true) throw Error(`policy.${name}: partial runs must be allowed`);
    for (const key of ["oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"])
      if (!Number.isInteger(runPolicy[key]) || runPolicy[key] < 0)
        throw Error(`policy.${name}: invalid ${key}`);
  }
  return policy;
}

/** Select the exact run policy for the measured scope. */
export function runPolicyForLifecycle(policy, lifecycleState) {
  return lifecycleState === "full-measurement" ? policy.fullRunPolicy : policy.runPolicy;
}

/** Resolve an active workflow to its immutable runner revision. */
export function approvedWorkflow(policy, signerSha) {
  if (!COMMIT.test(signerSha)) throw Error("Invalid signer workflow SHA");
  const entry = policy.workflows.find((candidate) => candidate.sha === signerSha);
  if (!entry) throw Error(`Unknown signer workflow SHA: ${signerSha}`);
  if (entry.status !== "active") throw Error(`Revoked signer workflow SHA: ${signerSha}`);
  return entry;
}
