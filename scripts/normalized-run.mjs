#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callData, toolCategory } from "./build-trajectory-analysis.mjs";
import { inspectHarnessOutput } from "./harness-runtime.mjs";
import { canonicalModelProvider, loadModelRegistry } from "./model-registry.mjs";

import { MULTI_AGENT_BENCHMARK } from "../src/suites/explicit-edit-multi-agent/results.mjs";
import { validateTeamSuite, validateTeamTables } from "./normalized-team-protocol.mjs";

export const NORMALIZED_SCHEMA_VERSION = 2;

const COMMAND_FEATURES = [
  ["search", /(^|[;&|()\s])(rg|grep|find)(\s|$)/],
  ["read", /(^|[;&|()\s])(cat|head|tail|sed|awk|wc)(\s|$)/],
  ["byte-check", /(^|[;&|()\s])(xxd|od|file)(\s|$)/],
  ["checksum", /(^|[;&|()\s])(sha\w*sum|md5sum)(\s|$)/],
  ["compare", /(^|[;&|()\s])(diff|cmp)(\s|$)/],
  ["list", /(^|[;&|()\s])ls(\s|$)/],
  ["file-operation", /(^|[;&|()\s])(cp|mv|rm|touch|mkdir)(\s|$)/],
  ["script", /(^|[;&|()\s])(python\d*|node|perl|ruby)(\s|$)/],
  ["test-or-build", /(^|[;&|()\s])(npm|pnpm|yarn|bun|pytest|vitest|tsc)(\s|$)/],
];

function likelyWorkspaceWrite(command, args) {
  if (args.shellToolInfo?.hasWriteFileRedirection) return true;
  const redirects = [...command.matchAll(/(?:^|[^<])>{1,2}\s*["']?([^\s;|"']+)/g)];
  if (redirects.some((match) => !match[1].startsWith("/tmp/") && !match[1].startsWith("/dev/")))
    return true;
  if (!/\b(sed|perl)\s+[^;&|]*-i\b|\btee\b|(^|[;&|]\s*)(cp|mv|rm|touch|mkdir)\b/.test(command))
    return false;
  return command.includes("/workspace/") || !command.includes("/tmp/");
}

function commandFeatures(command, args) {
  const features = COMMAND_FEATURES.filter(([, expression]) => expression.test(command)).map(
    ([name]) => name,
  );
  if (likelyWorkspaceWrite(command, args)) features.push("likely-workspace-write");
  return [...new Set(features)];
}

/** Convert one harness-native tool event into a safe, argument-free fact. */
export function normalizeToolEvent(raw, ordinal) {
  const call = callData(raw);
  const command = ["bash", "command_execution", "read_bash"].includes(call.name)
    ? String(call.args.command ?? "")
    : "";
  return {
    ordinal,
    tool: call.name,
    category: toolCategory(call.name).replace("native code", "native-code"),
    outcome: call.error == null ? null : call.error ? "error" : "completed",
    commandFeatures: command ? commandFeatures(command, call.args) : [],
  };
}

const jsonLine = (rows) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";

async function readCalls(root, result, round) {
  const file = result.recovery?.attempts
    ? path.join(root, "trials", result.id, "rounds", String(round), "tool-calls.json")
    : path.join(root, "trials", result.id, "tool-calls.json");
  return readCallsFile(file);
}

async function readCallsFile(file) {
  try {
    const calls = JSON.parse(await readFile(file, "utf8"));
    if (calls === null) return { calls: [], observed: false };
    if (!Array.isArray(calls)) throw Error("tool-calls.json must contain an array or null");
    return { calls, observed: true };
  } catch (error) {
    if (error.code === "ENOENT") return { calls: [], observed: false };
    throw error;
  }
}

async function readHistoricalMetrics(root, result, round, harnessKind) {
  const file = result.recovery?.attempts
    ? path.join(root, "trials", result.id, "rounds", String(round), "agent", "stdout.jsonl")
    : path.join(root, "trials", result.id, "agent", "stdout.jsonl");
  try {
    return await inspectHarnessOutput(harnessKind, file);
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}
async function readDifferenceMap(root) {
  try {
    const cases = JSON.parse(
      await readFile(path.join(root, "failure-review", "cases.json"), "utf8"),
    );
    const differences = new Map();
    for (const chain of cases) {
      for (const round of chain.rounds ?? []) {
        const cleanStructure = !(
          round.missing?.length ||
          round.unexpected?.length ||
          round.invalid?.length
        );
        const onlyEof =
          cleanStructure &&
          round.changes?.length > 0 &&
          round.changes.every((change) => change.onlyEof);
        differences.set(
          `${chain.id}::${round.number}`,
          round.passed ? "pass" : onlyEof ? "eof" : "other",
        );
      }
    }
    return differences;
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}
function infrastructureKind(error) {
  if (!error) return null;
  const message = String(error);
  if (message.includes("ERR_FS_FILE_TOO_LARGE")) return "file-too-large";
  if (message.includes("ENOENT")) return "missing-file";
  if (message.includes("timed out")) return "timeout";
  return "runner-error";
}
const IDENTITY_FIELDS = [
  "agentFamily",
  "agentVersion",
  "modelFamily",
  "modelVersion",
  "harnessFamily",
  "adapterVersion",
];

const CONFIGURATION_METADATA_FIELDS = [
  "tools",
  "extensions",
  "rules",
  "runtimeFlags",
  "environment",
];

/** Reject adapters that would publish missing configuration metadata as empty lists. */
export function assertConfigurationMetadata(adapter, label = "adapter") {
  if (!adapter.configuration || typeof adapter.configuration !== "object") {
    throw Error(`${label}: configuration metadata is required`);
  }
  for (const field of CONFIGURATION_METADATA_FIELDS) {
    const value = adapter.configuration[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw Error(`${label}: configuration.${field} must be an array of strings`);
    }
  }
}

/** Reject adapters that cannot produce the canonical public identity. */
export function assertNormalizedIdentity(adapter, label = "adapter") {
  assertConfigurationMetadata(adapter, label);
  const missing = IDENTITY_FIELDS.filter(
    (key) => typeof adapter[key] !== "string" || !adapter[key],
  );
  if (!Array.isArray(adapter.configurationLabels)) missing.push("configurationLabels");
  if (missing.length) throw Error(`${label}: missing normalized identity: ${missing.join(", ")}`);
}
/** Fields the configuration hash covers, in the order the hash is computed over. */
export const CONFIGURATION_IDENTITY_FIELDS = [
  "configurationId",
  "agentFamily",
  "agentVersion",
  "modelFamily",
  "modelVersion",
  "provider",
  "harnessFamily",
  "harnessVersion",
  "adapterVersion",
  "model",
  "thinking",
  "transport",
  "harnessKind",
  "tools",
  "extensions",
  "rules",
  "runtimeFlags",
  "environment",
  "configurationLabels",
];

const hashIdentity = (identity) => ({
  ...identity,
  configurationHash: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
});

/**
 * Recompute the configuration hash of an already published row. A documented migration renames
 * facts inside the identity, and the hash has to follow them.
 */
export function rehashConfiguration(row) {
  return hashIdentity(
    Object.fromEntries(CONFIGURATION_IDENTITY_FIELDS.map((key) => [key, row[key]])),
  );
}

export function safeConfiguration(adapter) {
  const identity = {
    configurationId: adapter.configurationId ?? `${adapter.harnessFamily}/default`,
    agentFamily: adapter.agentFamily,
    agentVersion: adapter.agentVersion,
    modelFamily: adapter.modelFamily,
    modelVersion: adapter.modelVersion,
    provider: adapter.provider ?? null,
    harnessFamily: adapter.harnessFamily,
    harnessVersion: String(adapter.harnessVersion ?? adapter.version).split(/\r?\n/, 1)[0],
    adapterVersion: adapter.adapterVersion,
    model: adapter.model,
    thinking: adapter.thinking,
    transport: adapter.transport ?? null,
    harnessKind: adapter.kind,
    tools: [...(adapter.configuration?.tools ?? [])].sort(),
    extensions: [...(adapter.configuration?.extensions ?? [])].sort(),
    rules: [...(adapter.configuration?.rules ?? [])].sort(),
    runtimeFlags: [...(adapter.configuration?.runtimeFlags ?? [])].sort(),
    environment: [...(adapter.configuration?.environment ?? [])].sort(),
    configurationLabels: [...adapter.configurationLabels].sort(),
  };
  return hashIdentity(identity);
}
function safeProfile(profileId, adapter, configuration) {
  return {
    profileId,
    modelId: adapter.modelId ?? adapter.model,
    harnessId: adapter.harnessId ?? adapter.kind,
    model: adapter.model,
    thinking: adapter.thinking,
    harnessVersion: configuration.harnessVersion,
    harnessKind: adapter.kind,
    transport: adapter.transport ?? null,
    sourceCommit: adapter.sourceCommit ?? null,
    agentFamily: adapter.agentFamily,
    agentVersion: adapter.agentVersion,
    modelFamily: adapter.modelFamily,
    modelVersion: adapter.modelVersion,
    provider: adapter.provider ?? null,
    harnessFamily: adapter.harnessFamily,
    adapterVersion: adapter.adapterVersion,
    configurationHash: configuration.configurationHash,
    configurationLabels: configuration.configurationLabels,
  };
}

/** Project a shared team report into the common trial and delivery tables.
 * A trial is a jointly graded barrier; taskIds carry its task credit. A round is
 * one participant delivery, so costs and native events are never repeated per task.
 * Unreached barriers remain visible without claiming inference or editing failures.
 */
export function normalizeTeamReport(report, profile, fixtureSha256) {
  const trials = [];
  const rounds = [];
  const scheduledTasks = new Set();
  const checks = new Map();
  for (const check of report.checks) {
    if (checks.has(check.label)) throw Error("Duplicate team grade label");
    checks.set(check.label, check);
  }
  let acceptedTasks = 0;
  let acceptedRounds = 0;
  let stopped = false;
  const barrierIds = new Set();
  for (const barrier of report.schedule) {
    if (!/^round-\d{3}$/.test(barrier.id) || barrierIds.has(barrier.id))
      throw Error("Invalid or duplicate team barrier");
    barrierIds.add(barrier.id);
    const taskIds = barrier.assignments.map((item) => item.task);
    for (const task of taskIds) {
      if (scheduledTasks.has(task)) throw Error("Duplicate scheduled task");
      scheduledTasks.add(task);
    }
    const deliveries = report.executions
      .filter((item) => item.round === barrier.id)
      .sort((left, right) => left.attempt - right.attempt || left.agent - right.agent);
    const trialId = `${barrier.id}__${profile.profileId}`;
    const deliveryKeys = new Set();
    for (const [ordinal, item] of deliveries.entries()) {
      if (
        !Number.isInteger(item.attempt) ||
        item.attempt < 1 ||
        item.attempt > 4 ||
        !Number.isInteger(item.agent) ||
        item.agent < 0 ||
        item.agent >= report.agents
      )
        throw Error("Invalid participant delivery position");
      const key = `${item.attempt}:${item.agent}`;
      if (deliveryKeys.has(key)) throw Error("Duplicate participant delivery");
      deliveryKeys.add(key);
      const assigned = barrier.assignments
        .filter((assignment) => assignment.agent === item.agent)
        .map((assignment) => assignment.task);
      if (!assigned.length || JSON.stringify(assigned) !== JSON.stringify(item.tasks))
        throw Error("Participant delivery contradicts scheduled tasks");
      const grade = checks.get(`${barrier.id}-attempt-${item.attempt}`);
      const exactPassed = grade?.status === "pass";
      const receipt = item.receipt ?? {};
      const tokenFields = [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
        "totalTokens",
      ];
      const tokensObserved = tokenFields.every(
        (field) => receipt[field] !== null && receipt[field] !== undefined,
      );
      rounds.push({
        roundId: `${trialId}::${ordinal}`,
        trialId,
        round: ordinal,
        agent: item.agent,
        barrierAttempt: item.attempt - 1,
        taskIds: item.tasks,
        exactPassed,
        normalizedPassed: exactPassed,
        difference: exactPassed
          ? "pass"
          : grade?.status === "fail" && ["structure", "build", "behavior"].includes(grade.category)
            ? "other"
            : "unknown",
        timedOut: Boolean(receipt.timedOut),
        providerFailure: receipt.providerFailure ?? null,
        exitCode: receipt.exitCode ?? null,
        seconds: receipt.processSeconds ?? null,
        toolCallCount: receipt.toolCalls ?? null,
        modelRoundCount: receipt.modelRounds ?? null,
        eventErrors: receipt.eventErrors ?? null,
        toolCallsObserved: receipt.toolCallsObserved ?? false,
        costUsd: receipt.costUsd ?? null,
        ...Object.fromEntries(
          tokenFields.map((field) => [field, tokensObserved ? receipt[field] : null]),
        ),
        failedToolCalls: receipt.failedToolCalls ?? null,
        invalidToolCalls: receipt.invalidToolCalls ?? null,
      });
    }
    const firstAttempt = deliveries[0]?.attempt;
    const lastAttempt = deliveries.at(-1)?.attempt;
    const finalExactPassed = checks.get(`${barrier.id}-attempt-${lastAttempt}`)?.status === "pass";
    if (finalExactPassed) {
      if (stopped) throw Error("Joint accepted progress is not a verified prefix");
      const last = deliveries.filter((item) => item.attempt === lastAttempt);
      const participants = new Set(barrier.assignments.map((item) => item.agent));
      if (last.length !== participants.size || last.some((item) => item.status !== "settled"))
        throw Error("Joint accepted barrier has unsettled participants");
      acceptedRounds++;
      acceptedTasks += taskIds.length;
    } else stopped = true;
    trials.push({
      trialId,
      taskId: barrier.id,
      taskIds,
      profileId: profile.profileId,
      modelId: profile.modelId,
      harnessId: profile.harnessId,
      fixtureSha256,
      firstExactPassed: checks.get(`${barrier.id}-attempt-${firstAttempt}`)?.status === "pass",
      finalExactPassed,
      rounds: deliveries.length,
      infrastructureFailure: deliveries.length ? null : "not-reached",
    });
  }
  if (scheduledTasks.size !== report.totalTasks)
    throw Error("Scheduled tasks contradict total workload");
  if (report.executions.length !== rounds.length)
    throw Error("Delivery has an unknown scheduled barrier");
  if (acceptedTasks !== report.acceptedTasks || acceptedRounds !== report.acceptedRounds)
    throw Error("Joint accepted tasks contradict verified progress");
  return { trials, rounds };
}

/** Export the minimum normalized facts needed for aggregate and trajectory reports. */
export async function exportNormalizedRun(rootDirectory, outputDirectory, options = {}) {
  const root = path.resolve(rootDirectory);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const summary = JSON.parse(await readFile(path.join(root, "summary.json"), "utf8"));
  const adapters = Object.fromEntries(
    Object.entries(manifest.harnesses).map(([id, adapter]) => [
      id,
      { ...adapter, ...options.profileIdentity?.(id, adapter, manifest) },
    ]),
  );
  for (const [id, adapter] of Object.entries(adapters)) assertNormalizedIdentity(adapter, id);
  const modelRegistry = await loadModelRegistry();
  for (const adapter of Object.values(adapters))
    adapter.provider = canonicalModelProvider(
      modelRegistry,
      adapter.modelFamily ?? adapter.model,
      adapter.provider ?? null,
    );
  const team = manifest.suite?.id === MULTI_AGENT_BENCHMARK;
  const schemaVersion = team ? 3 : NORMALIZED_SCHEMA_VERSION;
  const observedProfiles = new Set(summary.results.map((result) => result.profile));
  if (team && observedProfiles.size !== summary.results.length)
    throw Error("Duplicate team profile result");
  const configurationsByHash = new Map();
  const profiles = Object.entries(adapters)
    .filter(([id]) => !team || observedProfiles.has(id))
    .map(([id, adapter]) => {
      const configuration = safeConfiguration(adapter);
      configurationsByHash.set(configuration.configurationHash, configuration);
      return safeProfile(id, adapter, configuration);
    });
  const configurations = [...configurationsByHash.values()];
  const differences = await readDifferenceMap(root);
  const trials = [];
  const rounds = [];
  const toolCalls = [];
  let suite;
  if (team) {
    suite = { ...manifest.suite, schedule: null, observations: [] };
    for (const result of summary.results) {
      const profile = profiles.find((candidate) => candidate.profileId === result.profile);
      if (!profile) throw Error("Unknown team profile");
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile.profileId))
        throw Error("Invalid team profile ID");
      const directory = path.join(root, "teams", profile.profileId);
      const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
      for (const field of [
        "agents",
        "graphWidth",
        "workloadSha256",
        "graphSha256",
        "scheduleSha256",
      ])
        if (report[field] !== suite[field]) throw Error(`Team report contradicts ${field}`);
      if (report.totalTasks !== 71 || report.totalRounds !== 28)
        throw Error("Incomplete team workload");
      if (suite.schedule && JSON.stringify(suite.schedule) !== JSON.stringify(report.schedule))
        throw Error("Team profiles have different schedules");
      suite.schedule = report.schedule;
      suite.observations.push({
        profileId: profile.profileId,
        status: report.status,
        elapsedMs: report.elapsedMs,
        terminalCategory: report.terminal?.category ?? null,
      });
      const projected = normalizeTeamReport(report, profile, manifest.tasks[0].fixtureSha256);
      trials.push(...projected.trials);
      rounds.push(...projected.rounds);
      for (const round of projected.rounds) {
        const delivery = path.join(
          directory,
          "deliveries",
          `agent-${round.agent}`,
          `${projected.trials.find((trial) => trial.trialId === round.trialId).taskId}-attempt-${round.barrierAttempt + 1}`,
        );
        const native = await readCallsFile(path.join(delivery, "tool-calls.json"));
        round.toolCallsObserved = native.observed;
        native.calls.forEach((raw, ordinal) =>
          toolCalls.push({ roundId: round.roundId, ...normalizeToolEvent(raw, ordinal) }),
        );
      }
    }
    validateTeamSuite(suite, manifest.contract, {
      oracleRecoveries: manifest.oracleRecoveries,
      retryFailures: manifest.retryFailures,
      concurrency: manifest.concurrency,
      timeoutMs: manifest.timeoutMs,
    });
    validateTeamTables(suite, profiles, trials, rounds);
    const scheduled = suite.schedule
      .flatMap((barrier) => barrier.assignments.map((item) => item.task))
      .sort();
    if (JSON.stringify(scheduled) !== JSON.stringify(manifest.tasks.map((task) => task.id).sort()))
      throw Error("Team raw task manifest contradicts the schedule");
  } else
    for (const result of summary.results) {
      const profile = profiles.find((candidate) => candidate.profileId === result.profile);
      if (!profile) throw Error(`${result.id}: unknown profile ${result.profile}`);
      const attempts =
        result.recovery?.attempts ??
        (Object.hasOwn(result, "exitCode") || Object.hasOwn(result, "timedOut")
          ? [
              {
                attempt: 0,
                passed: result.passed,
                execution: {
                  exitCode: result.exitCode,
                  signal: result.signal,
                  timedOut: result.timedOut,
                  providerFailure: result.providerFailure ?? null,
                  processSeconds: result.processSeconds,
                  toolCalls: result.toolCalls,
                  modelRounds: result.modelRounds,
                  errors: result.errors,
                  costUsd: result.costUsd,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  cacheReadTokens: result.cacheReadTokens,
                  cacheWriteTokens: result.cacheWriteTokens,
                  totalTokens: result.totalTokens,
                  failedToolCalls: result.failedToolCalls,
                  invalidToolCalls: result.invalidToolCalls,
                },
              },
            ]
          : []);
      trials.push({
        trialId: result.id,
        taskId: result.taskId,
        profileId: profile.profileId,
        modelId: profile.modelId,
        harnessId: profile.harnessId,
        fixtureSha256: result.fixtureSha256,
        firstExactPassed: Boolean(attempts[0]?.passed),
        finalExactPassed: Boolean(attempts.at(-1)?.passed),
        rounds: attempts.length,
        infrastructureFailure: attempts.length
          ? null
          : (infrastructureKind(result.error) ?? "missing-rounds"),
      });
      for (const attempt of attempts) {
        const historical = options.historicalMetrics
          ? await readHistoricalMetrics(root, result, attempt.attempt, profile.harnessKind)
          : {};
        const roundId = `${result.id}::${attempt.attempt}`;
        const exactPassed = Boolean(attempt.passed);
        const difference =
          attempt.difference ?? differences.get(roundId) ?? (exactPassed ? "pass" : "unknown");
        const round = {
          roundId,
          trialId: result.id,
          round: attempt.attempt,
          exactPassed,
          normalizedPassed: exactPassed || difference === "eof",
          difference,
          timedOut: Boolean(attempt.execution?.timedOut),
          providerFailure: attempt.execution?.providerFailure ?? historical.providerFailure ?? null,
          exitCode: attempt.execution?.exitCode ?? null,
          seconds: attempt.execution?.processSeconds ?? null,
          toolCallCount: attempt.execution?.toolCalls ?? null,
          modelRoundCount: attempt.execution?.modelRounds ?? null,
          eventErrors: Array.isArray(attempt.execution?.errors)
            ? attempt.execution.errors.length
            : null,
        };
        Object.assign(round, {
          costUsd: attempt.execution?.costUsd ?? historical.costUsd ?? null,
          inputTokens: attempt.execution?.inputTokens ?? historical.inputTokens ?? null,
          outputTokens: attempt.execution?.outputTokens ?? historical.outputTokens ?? null,
          cacheReadTokens: attempt.execution?.cacheReadTokens ?? historical.cacheReadTokens ?? null,
          cacheWriteTokens:
            attempt.execution?.cacheWriteTokens ?? historical.cacheWriteTokens ?? null,
          totalTokens: attempt.execution?.totalTokens ?? historical.totalTokens ?? null,
          failedToolCalls: attempt.execution?.failedToolCalls ?? historical.failedToolCalls ?? null,
          invalidToolCalls:
            attempt.execution?.invalidToolCalls ?? historical.invalidToolCalls ?? null,
        });
        rounds.push(round);
        const callData = await readCalls(root, result, attempt.attempt);
        rounds.at(-1).toolCallsObserved = callData.observed;
        callData.calls.forEach((raw, ordinal) => {
          toolCalls.push({ roundId, ...normalizeToolEvent(raw, ordinal) });
        });
      }
    }
  await mkdir(outputDirectory, { recursive: true });
  const files = {
    "profiles.jsonl": jsonLine(profiles),
    "configurations.jsonl": jsonLine(configurations),
    "trials.jsonl": jsonLine(trials),
    "rounds.jsonl": jsonLine(rounds),
    "tool-calls.jsonl": jsonLine(toolCalls),
  };
  const digests = Object.fromEntries(
    Object.entries(files).map(([name, content]) => [
      name,
      {
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      },
    ]),
  );
  const publicManifest = {
    schemaVersion,
    runId: path.basename(root),
    contract: manifest.contract,
    taskSetSha256: team
      ? suite.workloadSha256
      : createHash("sha256").update(JSON.stringify(manifest.tasks)).digest("hex"),
    ...(team ? { suite } : {}),
    verifierSha256: manifest.verifierSha256 ?? null,
    policy: {
      oracleRecoveries: manifest.oracleRecoveries,
      retryFailures: manifest.retryFailures,
      concurrency: manifest.concurrency,
      timeoutMs: manifest.timeoutMs,
    },
    counts: {
      profiles: profiles.length,
      configurations: configurations.length,
      trials: trials.length,
      rounds: rounds.length,
      toolCalls: toolCalls.length,
    },
    completeness: {
      eofClassification: rounds.some((round) => round.difference === "unknown")
        ? "partial"
        : "complete",
      unknownDifferences: rounds.filter((round) => round.difference === "unknown").length,
      toolCallCoverage: rounds.some((round) => !round.toolCallsObserved) ? "partial" : "complete",
      unobservedToolCallRounds: rounds.filter((round) => !round.toolCallsObserved).length,
    },
    files: digests,
  };
  await Promise.all([
    ...Object.entries(files).map(([name, content]) =>
      writeFile(path.join(outputDirectory, name), content),
    ),
    writeFile(
      path.join(outputDirectory, "manifest.json"),
      JSON.stringify(publicManifest, null, 2) + "\n",
    ),
  ]);
  return publicManifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  if (!root) throw Error("Usage: normalized-run.mjs RUN [OUTPUT]");
  const output = process.argv[3] || path.join(root, "normalized");
  const manifest = await exportNormalizedRun(root, output);
  console.log(JSON.stringify(manifest.counts));
}
