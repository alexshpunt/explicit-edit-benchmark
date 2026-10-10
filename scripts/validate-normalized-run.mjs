#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { validateTeamSuite, validateTeamTables } from "./normalized-team-protocol.mjs";

const TABLES = {
  "profiles.jsonl": ["profiles", "profileId"],
  "configurations.jsonl": ["configurations", "configurationHash"],
  "trials.jsonl": ["trials", "trialId"],
  "rounds.jsonl": ["rounds", "roundId"],
  "tool-calls.jsonl": ["toolCalls", null],
};
const BASE_FIELDS = {
  "profiles.jsonl": [
    "profileId",
    "modelId",
    "harnessId",
    "model",
    "thinking",
    "harnessVersion",
    "harnessKind",
    "transport",
    "sourceCommit",
  ],
  "trials.jsonl": [
    "trialId",
    "taskId",
    "profileId",
    "modelId",
    "harnessId",
    "fixtureSha256",
    "firstExactPassed",
    "finalExactPassed",
    "rounds",
    "infrastructureFailure",
  ],
  "rounds.jsonl": [
    "roundId",
    "trialId",
    "round",
    "exactPassed",
    "normalizedPassed",
    "difference",
    "timedOut",
    "exitCode",
    "seconds",
    "toolCallCount",
    "modelRoundCount",
    "eventErrors",
    "toolCallsObserved",
  ],
  "tool-calls.jsonl": ["roundId", "ordinal", "tool", "category", "outcome", "commandFeatures"],
};
const PROVIDER_FAILURES = new Set(["rate-limit"]);
const SCHEMA_FIELDS = {
  ...BASE_FIELDS,
  "profiles.jsonl": [
    ...BASE_FIELDS["profiles.jsonl"],
    "agentFamily",
    "agentVersion",
    "modelFamily",
    "modelVersion",
    "provider",
    "harnessFamily",
    "adapterVersion",
    "configurationHash",
    "configurationLabels",
  ],
  "configurations.jsonl": [
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
    "configurationHash",
  ],
  "rounds.jsonl": [
    ...BASE_FIELDS["rounds.jsonl"],
    "costUsd",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "totalTokens",
    "failedToolCalls",
    "invalidToolCalls",
  ],
};

const CATEGORIES = new Set([
  "read",
  "search",
  "mutation",
  "command",
  "native-code",
  "planning/control",
  "other",
]);
const COMMAND_FEATURES = new Set([
  "search",
  "read",
  "byte-check",
  "checksum",
  "compare",
  "list",
  "file-operation",
  "script",
  "test-or-build",
  "likely-workspace-write",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    throw Error(`${label}: fields must be exactly ${expected.join(", ")}`);
}

function requiredString(row, key, label) {
  if (typeof row[key] !== "string" || !row[key]) throw Error(`${label}: invalid ${key}`);
}
function nullableString(row, key, label) {
  if (row[key] !== null && typeof row[key] !== "string") throw Error(`${label}: invalid ${key}`);
}
function boolean(row, key, label) {
  if (typeof row[key] !== "boolean") throw Error(`${label}: invalid ${key}`);
}
function integer(row, key, label) {
  if (!Number.isInteger(row[key]) || row[key] < 0) throw Error(`${label}: invalid ${key}`);
}
function nullableNumber(row, key, label) {
  if (row[key] !== null && (typeof row[key] !== "number" || !Number.isFinite(row[key])))
    throw Error(`${label}: invalid ${key}`);
}

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u,
  /\bsk[_-][A-Za-z0-9_-]{16,}/u,
  /\bhf_[A-Za-z0-9]{16,}/u,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/u,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/u,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/u,
  /\bAIza[0-9A-Za-z_-]{30,}/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /(?:^|["'])\/(?:root|home)\//u,
];

/** Reject published content that would leak credentials or machine-local paths. */
export function rejectSensitiveText(content, label) {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content)))
    throw Error(`${label}: possible credential or machine-local path`);
}

function parseJsonLines(content, name, schemaVersion) {
  return content
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const label = `${name}:${index + 1}`;
      const row = object(JSON.parse(line), label);
      const fields =
        schemaVersion >= 2 && name === "rounds.jsonl"
          ? [...SCHEMA_FIELDS[name], "providerFailure"]
          : SCHEMA_FIELDS[name];
      const teamFields =
        schemaVersion === 3
          ? name === "trials.jsonl"
            ? ["taskIds"]
            : name === "rounds.jsonl"
              ? ["agent", "barrierAttempt", "taskIds"]
              : []
          : [];
      exactKeys(row, [...fields, ...teamFields], label);
      if (teamFields.length) {
        if (
          !Array.isArray(row.taskIds) ||
          !row.taskIds.length ||
          row.taskIds.some((task) => typeof task !== "string")
        )
          throw Error(`${label}: invalid taskIds`);
        if (name === "rounds.jsonl") {
          integer(row, "agent", label);
          integer(row, "barrierAttempt", label);
        }
      }
      return row;
    });
}

function validateRow(name, row, index) {
  const label = `${name}:${index + 1}`;
  if (name === "profiles.jsonl") {
    for (const key of [
      "profileId",
      "modelId",
      "harnessId",
      "model",
      "thinking",
      "harnessVersion",
      "harnessKind",
    ])
      requiredString(row, key, label);
    nullableString(row, "transport", label);
    nullableString(row, "sourceCommit", label);
    for (const key of [
      "agentFamily",
      "agentVersion",
      "modelFamily",
      "modelVersion",
      "harnessFamily",
      "adapterVersion",
    ])
      requiredString(row, key, label);
    nullableString(row, "provider", label);
    if (
      !Array.isArray(row.configurationLabels) ||
      row.configurationLabels.some(
        (value) => typeof value !== "string" || !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(value),
      ) ||
      new Set(row.configurationLabels).size !== row.configurationLabels.length ||
      row.configurationLabels.some(
        (value, index) => index > 0 && value < row.configurationLabels[index - 1],
      )
    )
      throw Error(`${label}: invalid configurationLabels`);
    if (typeof row.configurationHash !== "string" || !/^[a-f0-9]{64}$/.test(row.configurationHash))
      throw Error(`${label}: invalid configurationHash`);
  } else if (name === "configurations.jsonl") {
    for (const key of [
      "configurationId",
      "agentFamily",
      "agentVersion",
      "modelFamily",
      "modelVersion",
      "harnessFamily",
      "harnessVersion",
      "adapterVersion",
      "model",
      "thinking",
      "harnessKind",
    ])
      requiredString(row, key, label);
    nullableString(row, "provider", label);
    nullableString(row, "transport", label);
    for (const key of [
      "tools",
      "extensions",
      "rules",
      "runtimeFlags",
      "environment",
      "configurationLabels",
    ]) {
      if (
        !Array.isArray(row[key]) ||
        row[key].some((value) => typeof value !== "string" || !value || value.length > 300) ||
        new Set(row[key]).size !== row[key].length ||
        row[key].some((value, index) => index > 0 && value < row[key][index - 1])
      )
        throw Error(`${label}: invalid ${key}`);
    }
    const { configurationHash, ...recipe } = row;
    if (typeof configurationHash !== "string" || !/^[a-f0-9]{64}$/.test(configurationHash))
      throw Error(`${label}: invalid configurationHash`);
    if (configurationHash !== createHash("sha256").update(JSON.stringify(recipe)).digest("hex"))
      throw Error(`${label}: configurationHash contradicts recipe`);
  } else if (name === "trials.jsonl") {
    for (const key of ["trialId", "taskId", "profileId", "modelId", "harnessId", "fixtureSha256"])
      requiredString(row, key, label);
    boolean(row, "firstExactPassed", label);
    boolean(row, "finalExactPassed", label);
    integer(row, "rounds", label);
    nullableString(row, "infrastructureFailure", label);
  } else if (name === "rounds.jsonl") {
    requiredString(row, "roundId", label);
    requiredString(row, "trialId", label);
    integer(row, "round", label);
    boolean(row, "exactPassed", label);
    boolean(row, "normalizedPassed", label);
    boolean(row, "timedOut", label);
    if (
      Object.hasOwn(row, "providerFailure") &&
      row.providerFailure !== null &&
      !PROVIDER_FAILURES.has(row.providerFailure)
    )
      throw Error(`${label}: invalid providerFailure`);
    boolean(row, "toolCallsObserved", label);
    if (!["pass", "eof", "other", "unknown"].includes(row.difference))
      throw Error(`${label}: invalid difference`);
    for (const key of ["exitCode", "seconds", "toolCallCount", "modelRoundCount", "eventErrors"])
      nullableNumber(row, key, label);
    nullableNumber(row, "costUsd", label);
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "failedToolCalls",
      "invalidToolCalls",
    ]) {
      if (row[key] !== null) integer(row, key, label);
    }
    if (row.costUsd !== null && row.costUsd < 0) throw Error(`${label}: invalid costUsd`);
    const tokenParts = [
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens,
    ];
    if (tokenParts.some((value) => value === null) !== tokenParts.every((value) => value === null))
      throw Error(`${label}: token components must be all present or all unavailable`);
    if ((row.totalTokens === null) !== tokenParts.every((value) => value === null))
      throw Error(`${label}: totalTokens availability contradicts token components`);
    if (
      row.totalTokens !== null &&
      tokenParts.every((value) => value !== null) &&
      row.totalTokens !== tokenParts.reduce((sum, value) => sum + value, 0)
    )
      throw Error(`${label}: totalTokens contradicts token components`);
    if (
      row.toolCallCount !== null &&
      row.failedToolCalls !== null &&
      row.failedToolCalls > row.toolCallCount
    )
      throw Error(`${label}: failedToolCalls exceeds toolCallCount`);
    if (
      row.failedToolCalls !== null &&
      row.invalidToolCalls !== null &&
      row.invalidToolCalls > row.failedToolCalls
    )
      throw Error(`${label}: invalidToolCalls exceeds failedToolCalls`);
    if (row.exactPassed !== (row.difference === "pass"))
      throw Error(`${label}: exact result contradicts difference`);
    if (row.normalizedPassed !== (row.exactPassed || row.difference === "eof"))
      throw Error(`${label}: normalized result contradicts difference`);
  } else {
    requiredString(row, "roundId", label);
    requiredString(row, "tool", label);
    integer(row, "ordinal", label);
    if (!CATEGORIES.has(row.category)) throw Error(`${label}: invalid category`);
    if (![null, "completed", "error"].includes(row.outcome))
      throw Error(`${label}: invalid outcome`);
    if (
      !Array.isArray(row.commandFeatures) ||
      row.commandFeatures.some((item) => !COMMAND_FEATURES.has(item))
    )
      throw Error(`${label}: invalid commandFeatures`);
  }
}

function unique(rows, key, label) {
  const values = new Set();
  for (const row of rows) {
    requiredString(row, key, label);
    const value = row[key];
    if (values.has(value)) throw Error(`${label}: duplicate ${key} ${value}`);
    values.add(value);
  }
  return values;
}

async function validateLayout(root) {
  const allowed = new Set(["manifest.json", ...Object.keys(TABLES), "submission.json", "report"]);
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) throw Error(`Unexpected normalized bundle entry: ${entry.name}`);
    if (entry.name !== "report" && !entry.isFile())
      throw Error(`Normalized bundle entry must be a file: ${entry.name}`);
  }
  try {
    const reportEntries = await readdir(path.join(root, "report"), { withFileTypes: true });
    for (const entry of reportEntries)
      if (!entry.isFile() || !["report.md", "results.csv"].includes(entry.name))
        throw Error(`Unexpected report entry: ${entry.name}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function validateManifest(manifest) {
  const manifestFields = [
    "schemaVersion",
    "runId",
    "contract",
    "taskSetSha256",
    "policy",
    "counts",
    "completeness",
    "files",
  ];
  if (Object.hasOwn(manifest, "sourceRuns")) manifestFields.push("sourceRuns");
  // Recorded from the first bundle that carried it; older archives predate it.
  if (Object.hasOwn(manifest, "verifierSha256")) manifestFields.push("verifierSha256");
  if (manifest.schemaVersion === 3) manifestFields.push("suite");
  exactKeys(manifest, manifestFields, "manifest");
  if (typeof manifest.runId !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(manifest.runId))
    throw Error(`Invalid runId: ${manifest.runId}`);
  if (![1, 2, 3].includes(manifest.schemaVersion))
    throw Error(`Unsupported schemaVersion: ${manifest.schemaVersion}; expected 1, 2 or 3`);
  if (manifest.sourceRuns !== undefined) {
    if (!Array.isArray(manifest.sourceRuns) || !manifest.sourceRuns.length)
      throw Error("manifest.sourceRuns: invalid value");
    const sourceIds = new Set();
    for (const [index, source] of manifest.sourceRuns.entries()) {
      exactKeys(source, ["runId"], `manifest.sourceRuns[${index}]`);
      requiredString(source, "runId", `manifest.sourceRuns[${index}]`);
      if (sourceIds.has(source.runId)) throw Error("manifest.sourceRuns: duplicate runId");
      sourceIds.add(source.runId);
    }
  }
  requiredString(manifest, "contract", "manifest");
  requiredString(manifest, "taskSetSha256", "manifest");
  if (Object.hasOwn(manifest, "verifierSha256"))
    requiredString(manifest, "verifierSha256", "manifest");
  exactKeys(
    manifest.policy,
    ["oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"],
    "manifest.policy",
  );
  if (manifest.schemaVersion === 3) {
    validateTeamSuite(manifest.suite, manifest.contract, manifest.policy);
    if (manifest.taskSetSha256 !== manifest.suite.workloadSha256)
      throw Error("Team task set digest contradicts workload");
  } else
    for (const key of ["oracleRecoveries", "retryFailures", "concurrency", "timeoutMs"])
      integer(manifest.policy, key, "manifest.policy");
  exactKeys(
    manifest.counts,
    ["profiles", "configurations", "trials", "rounds", "toolCalls"],
    "manifest.counts",
  );
  for (const key of ["profiles", "configurations", "trials", "rounds", "toolCalls"])
    integer(manifest.counts, key, "manifest.counts");
  exactKeys(
    manifest.completeness,
    ["eofClassification", "unknownDifferences", "toolCallCoverage", "unobservedToolCallRounds"],
    "manifest.completeness",
  );
  if (!["complete", "partial"].includes(manifest.completeness.eofClassification))
    throw Error("manifest.completeness: invalid eofClassification");
  if (!["complete", "partial"].includes(manifest.completeness.toolCallCoverage))
    throw Error("manifest.completeness: invalid toolCallCoverage");
  integer(manifest.completeness, "unknownDifferences", "manifest.completeness");
  integer(manifest.completeness, "unobservedToolCallRounds", "manifest.completeness");
  exactKeys(manifest.files, Object.keys(TABLES), "manifest.files");
}

/** Validate schema, hashes, safe fields, identities and semantic links in a normalized run. */
export async function validateNormalizedRun(directory) {
  const root = path.resolve(directory);
  await validateLayout(root);
  const manifestContent = await readFile(path.join(root, "manifest.json"), "utf8");
  rejectSensitiveText(manifestContent, "manifest.json");
  const manifest = object(JSON.parse(manifestContent), "manifest");
  validateManifest(manifest);
  const rows = {};
  for (const [name, [countName]] of Object.entries(TABLES)) {
    const content = await readFile(path.join(root, name), "utf8");
    rejectSensitiveText(content, name);
    const expected = object(
      object(manifest.files, "manifest.files")[name],
      `manifest.files.${name}`,
    );
    exactKeys(expected, ["bytes", "sha256"], `manifest.files.${name}`);
    integer(expected, "bytes", `manifest.files.${name}`);
    requiredString(expected, "sha256", `manifest.files.${name}`);
    const digest = createHash("sha256").update(content).digest("hex");
    if (expected.sha256 !== digest || expected.bytes !== Buffer.byteLength(content))
      throw Error(`${name}: digest or size mismatch`);
    rows[name] = parseJsonLines(content, name, manifest.schemaVersion);
    if (manifest.counts[countName] !== rows[name].length) throw Error(`${name}: count mismatch`);
    rows[name].forEach((row, index) => validateRow(name, row, index));
  }

  const profileIds = unique(rows["profiles.jsonl"], "profileId", "profiles.jsonl");
  const configurationHashes = unique(
    rows["configurations.jsonl"],
    "configurationHash",
    "configurations.jsonl",
  );
  const trialIds = unique(rows["trials.jsonl"], "trialId", "trials.jsonl");
  const roundIds = unique(rows["rounds.jsonl"], "roundId", "rounds.jsonl");
  const profiles = new Map(rows["profiles.jsonl"].map((row) => [row.profileId, row]));
  for (const profile of profiles.values())
    if (!configurationHashes.has(profile.configurationHash))
      throw Error(`profiles.jsonl: unknown configurationHash ${profile.configurationHash}`);
  const roundsByTrial = new Map();
  for (const trial of rows["trials.jsonl"]) {
    if (!profileIds.has(trial.profileId)) throw Error(`${trial.trialId}: unknown profileId`);
    const profile = profiles.get(trial.profileId);
    if (trial.modelId !== profile.modelId || trial.harnessId !== profile.harnessId)
      throw Error(`${trial.trialId}: profile identity mismatch`);
    roundsByTrial.set(trial.trialId, []);
  }
  for (const round of rows["rounds.jsonl"]) {
    if (!trialIds.has(round.trialId)) throw Error(`${round.roundId}: unknown trialId`);
    roundsByTrial.get(round.trialId).push(round);
  }
  for (const trial of rows["trials.jsonl"]) {
    const trialRounds = roundsByTrial
      .get(trial.trialId)
      .sort((left, right) => left.round - right.round);
    if (trial.rounds !== trialRounds.length) throw Error(`${trial.trialId}: round count mismatch`);
    if (trialRounds.some((round, index) => round.round !== index))
      throw Error(`${trial.trialId}: rounds are not contiguous`);
    const first = trialRounds[0];
    const last = trialRounds.at(-1);
    if (
      trial.firstExactPassed !== Boolean(first?.exactPassed) ||
      trial.finalExactPassed !== Boolean(last?.exactPassed)
    )
      throw Error(`${trial.trialId}: trial result contradicts rounds`);
    if ((trial.infrastructureFailure === null) !== trialRounds.length > 0)
      throw Error(`${trial.trialId}: infrastructure status contradicts rounds`);
  }

  if (manifest.schemaVersion === 3)
    validateTeamTables(
      manifest.suite,
      rows["profiles.jsonl"],
      rows["trials.jsonl"],
      rows["rounds.jsonl"],
    );

  const callsByRound = new Map([...roundIds].map((roundId) => [roundId, []]));
  for (const call of rows["tool-calls.jsonl"]) {
    if (!roundIds.has(call.roundId)) throw Error(`tool call: unknown roundId ${call.roundId}`);
    callsByRound.get(call.roundId).push(call);
  }
  for (const round of rows["rounds.jsonl"]) {
    const calls = callsByRound
      .get(round.roundId)
      .sort((left, right) => left.ordinal - right.ordinal);
    if (calls.some((call, index) => call.ordinal !== index))
      throw Error(`${round.roundId}: tool call ordinals are not contiguous`);
    if (
      round.toolCallsObserved &&
      round.toolCallCount !== null &&
      round.toolCallCount !== calls.length
    )
      throw Error(`${round.roundId}: tool call count mismatch`);
    if (!round.toolCallsObserved && calls.length)
      throw Error(`${round.roundId}: unobserved calls are present`);
  }

  const unknownDifferences = rows["rounds.jsonl"].filter(
    (round) => round.difference === "unknown",
  ).length;
  const unobserved = rows["rounds.jsonl"].filter((round) => !round.toolCallsObserved).length;
  if (manifest.completeness.unknownDifferences !== unknownDifferences)
    throw Error("manifest completeness contradicts unknown differences");
  if (manifest.completeness.unobservedToolCallRounds !== unobserved)
    throw Error("manifest completeness contradicts tool-call coverage");
  if (manifest.completeness.eofClassification !== (unknownDifferences ? "partial" : "complete"))
    throw Error("manifest EOF completeness is inconsistent");
  if (manifest.completeness.toolCallCoverage !== (unobserved ? "partial" : "complete"))
    throw Error("manifest tool-call completeness is inconsistent");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw Error("Usage: validate-normalized-run.mjs DIRECTORY");
  const manifest = await validateNormalizedRun(directory);
  console.log(`Validated normalized run ${manifest.runId}`);
}
