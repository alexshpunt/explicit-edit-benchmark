import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Public benchmark identity; never reuse the original Exact Edit identity. */
export const MULTI_AGENT_BENCHMARK = "explicit-edit-multi-agent";
/** Execution protocol, including explicit participant disclosure. */
export const MULTI_AGENT_PROTOCOL = "shared-project-rotating-v1";
/** Public version of the fixed 71-task maximal-team benchmark. */
export const MULTI_AGENT_VERSION = "1";
/** Version of the safe, standalone result format. */
export const MULTI_AGENT_RESULT_VERSION = "explicit-edit-multi-agent-result-v1";
/** Fixed candidate policy; changed policies need a new protocol. */
export const MULTI_AGENT_POLICY = Object.freeze({
  trialTimeoutMs: null,
  attemptTimeoutMs: null,
  oracleRecoveries: 3,
  feedbackMode: "coarse",
  workspace: "shared-live",
  checkpoint: "ready-task-barrier",
  commitOrder: "observed-not-prescribed",
  assignment: "rotating-stable-ready-order",
});
const statuses = new Set([
  "pass",
  "blocked",
  "provider_failure",
  "driver_exit",
  "infrastructure",
  "cancelled",
  "timeout",
]);
const failureCategories = new Set(["structure", "build", "behavior"]);
const usageKeys = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"];
const hash = (value) => createHash("sha256").update(value).digest("hex");
function integer(value, minimum = 0) {
  assert.ok(Number.isSafeInteger(value) && value >= minimum, "Expected a nonnegative integer");
}
function number(value) {
  assert.ok(Number.isFinite(value) && value >= 0, "Expected a nonnegative finite number");
}
function digest(value) {
  assert.match(value, /^[a-f0-9]{64}$/);
}
function keys(object, expected) {
  assert.ok(object && typeof object === "object" && !Array.isArray(object));
  assert.deepEqual(Object.keys(object).sort(), [...expected].sort(), "Unexpected result fields");
}
function policy(raw) {
  const selected = Object.fromEntries(
    Object.keys(MULTI_AGENT_POLICY).map((key) => [key, raw[key]]),
  );
  assert.deepEqual(selected, MULTI_AGENT_POLICY, "Unsupported Multi-Agent policy");
  return selected;
}
function comparisonKey(result) {
  return hash(
    JSON.stringify({
      protocol: result.protocol,
      identity: result.identity,
      agents: result.configuration.agents,
      runtime: result.configuration.runtime,
      harness: result.configuration.harness,
      policy: result.policy,
    }),
  );
}

/** Validate one safe result. This checks internal consistency, not authenticity of
 * locally supplied evidence. Public results contain no free-form error messages,
 * commands, source, prompts, file paths or agent receipts. */
export function validateMultiAgentResult(result) {
  keys(result, [
    "schemaVersion",
    "benchmark",
    "protocol",
    "mode",
    "status",
    "identity",
    "configuration",
    "policy",
    "progress",
    "execution",
    "terminal",
    "usage",
    "comparisonKey",
  ]);
  assert.equal(result.schemaVersion, MULTI_AGENT_RESULT_VERSION);
  assert.equal(result.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(result.protocol, MULTI_AGENT_PROTOCOL);
  assert.ok(["scripted", "live"].includes(result.mode));
  assert.ok(statuses.has(result.status));
  keys(result.identity, [
    "workloadSha256",
    "graphSha256",
    "scheduleSha256",
    "contractsSha256",
    "initial",
  ]);
  for (const value of Object.values(result.identity)) digest(value);
  keys(result.configuration, ["agents", "graphWidth", "model", "thinking", "harness", "runtime"]);
  integer(result.configuration.agents, 1);
  integer(result.configuration.graphWidth, 1);
  assert.ok(result.configuration.agents <= result.configuration.graphWidth);
  const { model, thinking, harness, runtime } = result.configuration;
  if (model !== null) {
    assert.match(model, /^[a-z0-9][a-z0-9._:-]*\/[a-z0-9][a-z0-9._:/-]*$/i);
    assert.doesNotMatch(
      model,
      /(?:^|[/:])(sk[-_]|gh[pousr]_|github_pat_|xox[baprs]-)/i,
      "Credential-shaped model identifier",
    );
  }
  if (thinking !== null)
    assert.ok(["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking));
  assert.ok(harness === null || harness === "baseline-agent");
  if (runtime !== null) {
    keys(runtime, ["agent", "version", "platform", "architecture"]);
    assert.deepEqual(runtime, {
      agent: "pi",
      version: "1.0.1",
      platform: "linux",
      architecture: "x64",
    });
  }
  if (result.mode === "live" && ["pass", "blocked"].includes(result.status)) {
    assert.ok(model && thinking && runtime);
    assert.equal(harness, "baseline-agent");
  }
  if (result.mode === "scripted")
    assert.deepEqual([model, thinking, harness, runtime], [null, null, null, null]);
  keys(result.policy, Object.keys(MULTI_AGENT_POLICY));
  policy(result.policy);
  keys(result.progress, [
    "acceptedTasks",
    "totalTasks",
    "acceptedRounds",
    "totalRounds",
    "completion",
  ]);
  const progress = result.progress;
  for (const field of ["acceptedTasks", "totalTasks", "acceptedRounds", "totalRounds"])
    integer(progress[field]);
  assert.ok(progress.totalTasks > 0 && progress.totalRounds > 0);
  assert.ok(
    progress.acceptedTasks <= progress.totalTasks &&
      progress.acceptedRounds <= progress.totalRounds,
  );
  assert.equal(progress.completion, progress.acceptedTasks / progress.totalTasks);
  keys(result.execution, ["deliveries", "repairs", "elapsedMs", "agentsClosed"]);
  integer(result.execution.deliveries);
  integer(result.execution.repairs);
  assert.ok(result.execution.repairs <= result.execution.deliveries);
  number(result.execution.elapsedMs);
  if (result.execution.agentsClosed !== null)
    assert.equal(typeof result.execution.agentsClosed, "boolean");
  if (result.status === "pass") {
    assert.equal(progress.acceptedTasks, progress.totalTasks);
    assert.equal(progress.acceptedRounds, progress.totalRounds);
    assert.equal(result.terminal, null);
    if (result.mode === "live") assert.equal(result.execution.agentsClosed, true);
  } else {
    assert.ok(progress.acceptedRounds < progress.totalRounds);
    keys(result.terminal, ["round", "category", "failureCategory"]);
    assert.equal(result.terminal.category, result.status);
    if (result.terminal.round !== null) assert.match(result.terminal.round, /^round-\d{3,}$/);
    if (result.status === "blocked") {
      assert.ok(result.terminal.round);
      assert.ok(failureCategories.has(result.terminal.failureCategory));
    } else assert.equal(result.terminal.failureCategory, null);
  }
  if (result.usage !== null) {
    keys(result.usage, usageKeys);
    for (const value of Object.values(result.usage)) if (value !== null) number(value);
  }
  assert.equal(result.comparisonKey, comparisonKey(result));
  return result;
}

/** Project a finished native concurrent report into safe benchmark facts. Derive
 * accepted progress from barrier evidence, never from partial obligation counts.
 * Old experimental reports without an explicit protocol label cannot be silently
 * relabelled as this candidate. Unknown raw fields are discarded. */
export function multiAgentResult(raw) {
  assert.equal(raw.version, "renderer-concurrent-run-v1");
  assert.equal(raw.benchmark, MULTI_AGENT_BENCHMARK);
  assert.equal(raw.protocol, MULTI_AGENT_PROTOCOL);
  assert.ok(statuses.has(raw.status), "Only finished runs can be exported");
  integer(raw.agents, 1);
  integer(raw.graphWidth, 1);
  assert.ok(raw.agents <= raw.graphWidth);
  assert.ok(Array.isArray(raw.schedule) && raw.schedule.length > 0);
  assert.equal(hash(JSON.stringify(raw.schedule)), raw.scheduleSha256, "Schedule digest differs");
  const tasks = new Set();
  const rounds = new Map();
  for (const [index, round] of raw.schedule.entries()) {
    assert.equal(round.id, `round-${String(index + 1).padStart(3, "0")}`);
    assert.ok(round.assignments.length > 0);
    for (const assignment of round.assignments) {
      integer(assignment.agent);
      assert.ok(assignment.agent < raw.agents);
      assert.match(assignment.task, /^task-\d{3,}$/);
      assert.ok(!tasks.has(assignment.task), "Repeated scheduled task");
      tasks.add(assignment.task);
    }
    rounds.set(round.id, round);
  }
  assert.equal(raw.totalTasks, tasks.size);
  assert.equal(raw.totalRounds, rounds.size);
  integer(raw.acceptedRounds);
  assert.ok(raw.acceptedRounds <= rounds.size);
  const accepted = raw.schedule.slice(0, raw.acceptedRounds);
  assert.equal(
    raw.acceptedTasks,
    accepted.reduce((sum, round) => sum + round.assignments.length, 0),
  );
  assert.ok(Array.isArray(raw.checks) && raw.checks[0]?.contractId === "initial");
  assert.equal(raw.checks.filter((item) => item.contractId === "initial").length, 1);
  if (raw.acceptedRounds > 0) assert.equal(raw.checks[0].status, "pass");
  if (raw.status === "pass") assert.equal(raw.terminal ?? null, null);
  const labels = new Set(raw.checks.map((item) => item.label));
  assert.equal(labels.size, raw.checks.length, "Duplicate barrier check");
  const passed = raw.checks.filter(
    (item) => item.contractId !== "initial" && item.status === "pass",
  );
  assert.deepEqual(
    passed.map((item) => item.contractId),
    accepted.map((round) => round.id),
  );
  for (const round of accepted) {
    const checks = raw.checks.filter((item) => item.contractId === round.id);
    assert.ok(checks.length >= 1 && checks.length <= 4);
    for (const [index, check] of checks.entries()) {
      assert.equal(check.label, `${round.id}-attempt-${index + 1}`);
      assert.equal(check.status, index === checks.length - 1 ? "pass" : "fail");
    }
  }
  const next = raw.schedule[raw.acceptedRounds];
  assert.ok(
    raw.checks.every(
      (item) =>
        item.contractId === "initial" ||
        accepted.some((round) => round.id === item.contractId) ||
        item.contractId === next?.id,
    ),
  );
  if (raw.status === "blocked") {
    assert.equal(raw.terminal.id, next?.id);
    const failures = raw.checks.filter((item) => item.contractId === next.id);
    assert.equal(failures.length, 4, "Editing stop must exhaust three corrections");
    for (const [index, check] of failures.entries()) {
      assert.equal(check.label, `${next.id}-attempt-${index + 1}`);
      assert.equal(check.status, "fail");
      assert.ok(failureCategories.has(check.category));
    }
  }
  assert.ok(Array.isArray(raw.executions));
  const deliveries = new Set();
  for (const execution of raw.executions) {
    const round = rounds.get(execution.round);
    assert.ok(round);
    integer(execution.attempt, 1);
    assert.ok(execution.attempt <= 4);
    const id = `${execution.round}:${execution.attempt}:${execution.agent}`;
    assert.ok(!deliveries.has(id), "Duplicate agent delivery");
    deliveries.add(id);
    assert.deepEqual(
      execution.tasks,
      round.assignments.filter((item) => item.agent === execution.agent).map((item) => item.task),
    );
    assert.ok(execution.tasks.length > 0);
  }
  for (const check of raw.checks.filter((item) => item.contractId !== "initial")) {
    const match = /^round-\d{3,}-attempt-(\d)$/.exec(check.label);
    assert.ok(match);
    const round = rounds.get(check.contractId);
    for (const agent of new Set(round.assignments.map((item) => item.agent)))
      assert.ok(
        deliveries.has(`${round.id}:${match[1]}:${agent}`),
        "Barrier lacks a participant delivery",
      );
  }
  assert.equal(raw.deliveries, raw.executions.length);
  assert.equal(raw.repairs, raw.executions.filter((item) => item.attempt > 1).length);
  const contractIds = ["initial", ...rounds.keys()];
  assert.deepEqual(Object.keys(raw.contractHashes).sort(), [...contractIds].sort());
  for (const value of Object.values(raw.contractHashes)) digest(value);
  const result = {
    schemaVersion: MULTI_AGENT_RESULT_VERSION,
    benchmark: raw.benchmark,
    protocol: raw.protocol,
    mode: raw.mode,
    status: raw.status,
    identity: {
      workloadSha256: raw.workloadSha256,
      graphSha256: raw.graphSha256,
      scheduleSha256: raw.scheduleSha256,
      contractsSha256: hash(JSON.stringify(contractIds.map((id) => [id, raw.contractHashes[id]]))),
      initial: raw.initial,
    },
    configuration: {
      agents: raw.agents,
      graphWidth: raw.graphWidth,
      model: raw.model ?? null,
      thinking: raw.thinking ?? null,
      harness: raw.harness ?? null,
      runtime: raw.runtime
        ? Object.fromEntries(
            ["agent", "version", "platform", "architecture"].map((key) => [key, raw.runtime[key]]),
          )
        : null,
    },
    policy: policy(raw.policy),
    progress: {
      acceptedTasks: raw.acceptedTasks,
      totalTasks: raw.totalTasks,
      acceptedRounds: raw.acceptedRounds,
      totalRounds: raw.totalRounds,
      completion: raw.acceptedTasks / raw.totalTasks,
    },
    execution: {
      deliveries: raw.deliveries,
      repairs: raw.repairs,
      elapsedMs: raw.elapsedMs,
      agentsClosed: Array.isArray(raw.agentsClosed)
        ? raw.agentsClosed.length === raw.agents &&
          raw.agentsClosed.every((value) => value === true)
        : null,
    },
    terminal:
      raw.status === "pass"
        ? null
        : {
            round: raw.terminal?.id ?? null,
            category: raw.status,
            failureCategory: raw.status === "blocked" ? raw.terminal?.failure?.category : null,
          },
    usage: raw.usage
      ? Object.fromEntries(usageKeys.map((key) => [key, raw.usage[key] ?? null]))
      : null,
    comparisonKey: "",
  };
  result.comparisonKey = comparisonKey(result);
  return validateMultiAgentResult(result);
}

/** Export only safe facts into a new file; never modify original run evidence. */
export async function exportMultiAgentResult(runDirectory, outputFile) {
  const raw = JSON.parse(await readFile(path.join(runDirectory, "report.json"), "utf8"));
  const result = multiAgentResult(raw);
  await writeFile(outputFile, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return result;
}
