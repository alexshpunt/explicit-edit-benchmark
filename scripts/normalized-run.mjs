#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callData, toolCategory } from "./build-trajectory-analysis.mjs";
import { inspectHarnessOutput } from "./harness-runtime.mjs";

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
  const schemaVersion = 1;
  const configurationsByHash = new Map();
  const profiles = Object.entries(adapters).map(([id, adapter]) => {
    const configuration = safeConfiguration(adapter);
    configurationsByHash.set(configuration.configurationHash, configuration);
    return safeProfile(id, adapter, configuration);
  });
  const configurations = [...configurationsByHash.values()];
  const differences = await readDifferenceMap(root);
  const trials = [];
  const rounds = [];
  const toolCalls = [];
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
    taskSetSha256: createHash("sha256").update(JSON.stringify(manifest.tasks)).digest("hex"),
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
