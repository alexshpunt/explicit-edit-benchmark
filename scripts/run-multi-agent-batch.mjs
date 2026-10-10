import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareMultiAgent } from "../src/suites/explicit-edit-multi-agent/prepare.mjs";
import { runConcurrent } from "../src/suites/explicit-edit-multi-agent/execution/concurrent-run.mjs";
import { harnessParticipant } from "./harness-participant.mjs";
import {
  MULTI_AGENT_BENCHMARK,
  MULTI_AGENT_PROTOCOL,
} from "../src/suites/explicit-edit-multi-agent/results.mjs";
import { verifierSha256 } from "./verifier-identity.mjs";

/** Identify the trusted suite implementation using portable source-relative names.
 * No private configuration or generated run output is part of the verifier identity.
 */
export async function suiteVerifier() {
  const root = new URL("../src/suites/explicit-edit-multi-agent/", import.meta.url);
  const sources = [];
  async function visit(directory, relative = "") {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const name = relative + item.name;
      const file = new URL(item.name + (item.isDirectory() ? "/" : ""), directory);
      if (item.isDirectory()) await visit(file, name + "/");
      else if (item.isFile() && name.endsWith(".mjs"))
        sources.push([name, verifierSha256(await readFile(file))]);
    }
  }
  await visit(root);
  return createHash("sha256").update(JSON.stringify(sources)).digest("hex");
}

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
  signal,
  log = console.log,
}) {
  if (!preparation) {
    const input = path.join(root, "input");
    await prepareMultiAgent(input);
    preparation = path.join(input, "preparation");
    const proof = await runConcurrent(preparation, path.join(root, "reference-proof"), {
      agents: 15,
      signal,
      log,
    });
    assert.equal(proof.status, "pass", "Reference proof must pass before any model calls");
  }
  preparation = path.resolve(preparation);
  const manifest = JSON.parse(await readFile(path.join(preparation, "manifest.json"), "utf8"));
  assert.equal(manifest.tasks, 71, "Multi-Agent always uses the full 71-task workload");
  assert.equal(manifest.graphWidth, 15, "Multi-Agent uses the canonical maximal team");
  const proof = JSON.parse(await readFile(path.join(preparation, "verification-15.json"), "utf8"));
  assert.equal(proof.status, "pass");
  const tasks = JSON.parse(await readFile(path.join(preparation, "tasks.json"), "utf8"));
  const json = (file, value) =>
    writeFile(path.join(root, file), JSON.stringify(value, null, 2) + "\n");
  await json("manifest.json", {
    contract: MULTI_AGENT_PROTOCOL,
    attempts: 1,
    retryFailures: 0,
    oracleRecoveries: 3,
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
