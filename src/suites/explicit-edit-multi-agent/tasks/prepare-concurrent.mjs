import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTree, writeTree, treeIdentity } from "../generation/generator.mjs";
import { contractTransition, dependencyGraph, rotatingSchedule } from "./concurrent-schedule.mjs";

import { checkpointContracts } from "../grading/concurrent-contracts.mjs";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalized = (contract) => ({
  ...contract,
  obligations: [...contract.obligations].sort((a, b) => a.id.localeCompare(b.id)),
});

/** Prepare dependencies and private checkpoints for the full audited workload.
 * Tasks and the initial shuffled monolith are unchanged. Moved code, required
 * files and selector reads determine readiness, not the old structural order.
 * The maximum antichain sets the default team. Independent module moves are
 * replayed in both orders to check expectations for all supported team sizes.
 * This preparation is not proof of concurrent execution: isolated scripted
 * workers must still complete the actual shared-workspace schedule.
 */
export async function prepareConcurrent(coherentPath, outputPath) {
  const coherent = path.resolve(coherentPath),
    output = path.resolve(outputPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const source = await json(path.join(coherent, "manifest.json"));
  const proof = await json(path.join(coherent, "verification.json"));
  assert.equal(source.version, "renderer-coherent-v1");
  assert.equal(proof.status, "pass");
  assert.equal(proof.tasksSha256, source.tasksSha256);
  assert.equal(proof.acceptedTasks, source.tasks);
  assert.equal(proof.checks, source.tasks + 1);
  assert.equal(proof.initial, source.initial);
  assert.equal(proof.final, source.final);
  assert.deepEqual(proof.contractHashes, source.contractHashes);
  const taskBytes = await readFile(path.join(coherent, "tasks.json"));
  assert.equal(digest(taskBytes), source.tasksSha256);
  const tasks = JSON.parse(taskBytes);
  const initial = await readTree(path.join(coherent, "initial"));
  assert.equal(treeIdentity(initial), source.initial);
  const contracts = new Map();
  for (const id of ["initial", ...tasks.map((task) => task.id)]) {
    const bytes = await readFile(path.join(coherent, "contracts", id + ".json"));
    assert.equal(digest(bytes), source.contractHashes[id]);
    contracts.set(id, JSON.parse(bytes));
  }
  let previous = contracts.get("initial");
  const transitions = tasks.map((task) => {
    const after = contracts.get(task.id);
    const delta = contractTransition(task.id, previous, after);
    previous = after;
    return delta;
  });
  const graph = dependencyGraph(tasks, transitions);
  const cache = new Map();
  // Every supported schedule must compose the same final obligations. Header
  // moves are replayed privately because surrounding guard contexts can change.
  // Reversing each ready wave must not alter its selected layout or naming result.
  for (let agents = 1; agents <= graph.width; agents++) {
    const schedule = rotatingSchedule(graph, agents);
    const forward = checkpointContracts(
      initial,
      contracts.get("initial"),
      tasks,
      transitions,
      schedule,
      cache,
    );
    const reverse = checkpointContracts(
      initial,
      contracts.get("initial"),
      tasks,
      transitions,
      schedule.map((round) => ({ ...round, assignments: [...round.assignments].reverse() })),
      cache,
    );
    for (const round of schedule)
      assert.deepEqual(normalized(forward.get(round.id)), normalized(reverse.get(round.id)));
    assert.deepEqual(normalized(forward.get(schedule.at(-1).id)), normalized(previous));
  }
  await mkdir(output);
  await mkdir(path.join(output, "contracts"));
  await mkdir(path.join(output, "transitions"));
  await writeTree(path.join(output, "initial"), initial);
  await writeFile(path.join(output, "tasks.json"), taskBytes);
  await copyFile(
    path.join(coherent, "contracts/initial.json"),
    path.join(output, "contracts/initial.json"),
  );
  const transitionHashes = {};
  for (const delta of transitions) {
    const bytes = JSON.stringify(delta) + "\n";
    transitionHashes[delta.id] = digest(bytes);
    await writeFile(path.join(output, "transitions", delta.id + ".json"), bytes);
  }
  const graphBytes = JSON.stringify(graph, null, 2) + "\n";
  await writeFile(path.join(output, "graph.json"), graphBytes);
  const manifest = {
    version: "renderer-concurrent-v2",
    scope: "complete-coherent-workload",
    initial: source.initial,
    workloadSha256: source.tasksSha256,
    graphSha256: digest(graphBytes),
    initialContractSha256: source.contractHashes.initial,
    transitionHashes,
    final: source.final,
    pixels: source.pixels,
    tasks: source.tasks,
    graphWidth: graph.width,
    defaultAgents: graph.width,
    policy: {
      trialTimeoutMs: null,
      attemptTimeoutMs: null,
      oracleRecoveries: 3,
      feedbackMode: "coarse",
      workspace: "shared-live",
      checkpoint: "ready-task-barrier",
      commitOrder: "observed-not-prescribed",
      assignment: "rotating-stable-ready-order",
    },
  };
  await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `PREPARED concurrent: ${source.tasks} unchanged tasks; dependency graph width ${graph.width}; default team ${graph.width}; one agent keeps the old route`,
  );
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await prepareConcurrent(process.argv[2], process.argv[3]);
