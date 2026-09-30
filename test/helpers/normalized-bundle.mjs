import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const digest = (value) => createHash("sha256").update(value).digest("hex");
/** Write a minimal valid normalized bundle for publication contract tests. */
export async function bundle(directory, runId, identity = {}, usage = {}) {
  await mkdir(directory, { recursive: true });
  const configuration = {
    configurationId: "test",
    agentFamily: "test-agent",
    agentVersion: "1",
    modelFamily: "test/model",
    modelVersion: "1",
    provider: null,
    harnessFamily: "test-harness",
    harnessVersion: "1",
    adapterVersion: "1",
    model: "test/model",
    thinking: "low",
    transport: null,
    harnessKind: "custom",
    tools: [],
    extensions: [],
    rules: [],
    runtimeFlags: [],
    environment: [],
    configurationLabels: [],
    ...identity,
  };
  const configurationHash = digest(JSON.stringify(configuration));
  const profile = {
    profileId: "p",
    modelId: "m",
    harnessId: "h",
    model: "test/model",
    thinking: "low",
    harnessVersion: "1",
    harnessKind: "custom",
    transport: null,
    sourceCommit: null,
    agentFamily: "test-agent",
    agentVersion: "1",
    modelFamily: "test/model",
    modelVersion: "1",
    provider: null,
    harnessFamily: "test-harness",
    adapterVersion: "1",
    ...identity,
    configurationHash,
    configurationLabels: [],
  };
  const trial = {
    trialId: "t",
    taskId: "replace-all-10-plain",
    profileId: "p",
    modelId: "m",
    harnessId: "h",
    fixtureSha256: "d".repeat(64),
    firstExactPassed: true,
    finalExactPassed: true,
    rounds: 1,
    infrastructureFailure: null,
  };
  const round = {
    roundId: "r",
    trialId: "t",
    round: 0,
    exactPassed: true,
    normalizedPassed: true,
    difference: "pass",
    timedOut: false,
    providerFailure: null,
    exitCode: 0,
    seconds: 2,
    toolCallCount: 0,
    modelRoundCount: 1,
    eventErrors: 0,
    toolCallsObserved: true,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    failedToolCalls: 0,
    invalidToolCalls: 0,
    ...usage,
  };
  const tables = {
    "profiles.jsonl": [profile],
    "configurations.jsonl": [{ ...configuration, configurationHash }],
    "trials.jsonl": [trial],
    "rounds.jsonl": [round],
    "tool-calls.jsonl": [],
  };
  const manifest = {
    schemaVersion: 2,
    runId,
    contract: "test-contract",
    taskSetSha256: "d".repeat(64),
    policy: { oracleRecoveries: 0, retryFailures: 0, concurrency: 1, timeoutMs: 1000 },
    counts: { profiles: 1, configurations: 1, trials: 1, rounds: 1, toolCalls: 0 },
    completeness: {
      eofClassification: "complete",
      unknownDifferences: 0,
      toolCallCoverage: "complete",
      unobservedToolCallRounds: 0,
    },
    files: {},
  };
  for (const [name, values] of Object.entries(tables)) {
    const content = values.map((row) => JSON.stringify(row)).join("\n") + "\n";
    manifest.files[name] = { bytes: Buffer.byteLength(content), sha256: digest(content) };
    await writeFile(path.join(directory, name), content);
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  const metadata = {
    schemaVersion: 1,
    ownerId: "alice",
    clientRunId: runId,
    purpose: "community",
    definitions: {
      benchmark: {
        id: "test-benchmark",
        version: "1",
        contract: "test-contract",
        kind: "experimental",
        hash: "d".repeat(64),
      },
      taskSet: { hash: "d".repeat(64), taskIds: [trial.taskId] },
      harnesses: [{ id: "h", name: "Test", version: "1", sourceHash: "d".repeat(64) }],
      runner: { id: "test-runner", name: "Test", version: "1" },
    },
  };
  await writeFile(path.join(directory, "submission.json"), JSON.stringify(metadata) + "\n");
  return metadata;
}
