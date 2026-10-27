import assert from "node:assert/strict";
import { validateCurrentReferenceExecution } from "../src/suites/explicit-edit-multi-agent/reference/execution-proof.mjs";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareMultiAgent } from "../src/suites/explicit-edit-multi-agent/prepare.mjs";
import { runConcurrent } from "../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { harnessParticipant } from "./harness-participant.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
  MULTI_AGENT_POLICY,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";
import { suiteVerifier } from "../src/suites/explicit-edit-multi-agent/source-identity.mjs";
import { validateAtomicIdentity } from "./normalized-team-protocol.mjs";
import { ATOMIC_DISPATCH_POLICY } from "../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

export { suiteVerifier } from "../src/suites/explicit-edit-multi-agent/source-identity.mjs";

/** Run each selected model-harness configuration as a full, isolated 15-member team.
 * Teams run sequentially; participant state is private and only the project is shared.
 * The common harness runtime owns inference, native events, recovery and cancellation.
 */
export async function runMultiAgentBatch({
  root,
  preparation,
  profiles,
  safeAdapters,
  configSha256,
  batchSize = ATOMIC_DISPATCH_POLICY.defaultBatchSize,
  protocol = MULTI_AGENT_PROTOCOL,
  signal,
  log = console.log,
}) {
  signal?.throwIfAborted();
  assert.equal(protocol, MULTI_AGENT_PROTOCOL, "Restoring runs require the native restoring entry");
  assert.ok(Number.isSafeInteger(batchSize) && batchSize > 0, "Invalid delivery size");
  if (!preparation) {
    const input = path.join(root, "input");
    await prepareMultiAgent(input, { signal });
    preparation = path.join(input, "preparation");
    const proof = await runConcurrent(preparation, path.join(root, "reference-proof"), {
      agents: 15,
      batchSize,
      signal,
      log,
    });
    assert.equal(proof.status, "pass", "Reference proof must pass before any model calls");
  }
  preparation = path.resolve(preparation);
  const manifest = JSON.parse(await readFile(path.join(preparation, "manifest.json"), "utf8"));
  assert.deepEqual(
    manifest.policy,
    MULTI_AGENT_POLICY,
    "Unsupported Multi-Agent preparation policy",
  );
  assert.equal(manifest.tasks, 71, "Multi-Agent always uses the full 71-task workload");
  assert.equal(manifest.graphWidth, 15, "Multi-Agent uses the canonical maximal team");
  const proof = JSON.parse(await readFile(path.join(preparation, "verification-15.json"), "utf8"));
  assert.equal(proof.status, "pass");
  assert.equal(proof.protocol, MULTI_AGENT_PROTOCOL, "Unsupported Multi-Agent proof protocol");
  assert.deepEqual(proof.policy, MULTI_AGENT_POLICY, "Unsupported Multi-Agent proof policy");
  await validateCurrentReferenceExecution(proof, 15);
  validateAtomicIdentity(manifest.atomic);
  assert.deepEqual(
    proof.atomic,
    manifest.atomic,
    "Concurrent live runs need a matched atomic stream proof",
  );
  assert.equal(proof.agents, 15, "Atomic proof participant count differs");
  assert.equal(proof.batchSize, batchSize, "Reference proof delivery size differs");
  assert.equal(
    proof.acceptedAtomicEdits,
    manifest.atomic.edits,
    "Atomic proof inventory is incomplete",
  );
  for (const [file, field] of [
    ["tasks.json", "workloadSha256"],
    ["batches.json", "batchesSha256"],
  ]) {
    const bytes = await readFile(path.join(preparation, "atomic", file));
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      manifest.atomic[field],
      `Atomic ${file} changed`,
    );
    if (file === "tasks.json") {
      const workload = JSON.parse(bytes);
      assert.equal(workload.version, "renderer-atomic-workload-v1");
      assert.equal(workload.nodes.length, manifest.atomic.edits, "Atomic inventory count differs");
    }
  }
  const tasks = JSON.parse(await readFile(path.join(preparation, "tasks.json"), "utf8"));
  const json = (file, value) =>
    writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
  await json("manifest.json", {
    contract: MULTI_AGENT_PROTOCOL,
    attempts: 1,
    retryFailures: 0,
    oracleRecoveries: MULTI_AGENT_POLICY.oracleRecoveries,
    concurrency: 15,
    timeoutMs: null,
    harnesses: safeAdapters,
    configSha256,
    verifierSha256: await suiteVerifier(),
    tasks: tasks.map((task) => ({ id: task.id, fixtureSha256: manifest.initial })),
    suite: {
      id: MULTI_AGENT_BENCHMARK,
      protocol: MULTI_AGENT_PROTOCOL,
      agents: 15,
      graphWidth: manifest.graphWidth,
      workloadSha256: manifest.workloadSha256,
      graphSha256: manifest.graphSha256,
      scheduleSha256: proof.scheduleSha256,
      atomic: manifest.atomic,
      batchSize,
    },
  });
  const summary = { suite: MULTI_AGENT_BENCHMARK, profiles: {}, results: [] };
  await mkdir(path.join(root, "teams"));
  for (const [profile, adapter] of Object.entries(profiles)) {
    signal?.throwIfAborted();
    const directory = path.join(root, "teams", profile);
    log(`TEAM ${profile}: 15 agents, 71 tasks, no delivery deadline`);
    const report = await runConcurrent(preparation, directory, {
      agents: 15,
      batchSize,
      signal,
      log,
      createDriver: (workspace, state, agent) =>
        harnessParticipant(adapter, {
          workspace,
          state,
          artifacts: path.join(directory, "deliveries", `agent-${agent}`),
        }),
    });
    summary.profiles[profile] = {
      status: report.status,
      acceptedTasks: report.acceptedTasks,
      totalTasks: report.totalTasks,
      completion: report.acceptedTasks / report.totalTasks,
      deliveries: report.deliveries,
      repairs: report.repairs,
      elapsedMs: report.elapsedMs,
    };
    summary.results.push({ profile, ...summary.profiles[profile] });
    await json("summary.json", summary);
    if (report.status === "cancelled") break;
  }
  return summary;
}
