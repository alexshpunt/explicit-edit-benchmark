import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readTree, treeIdentity } from "../generation/generator.mjs";
import { dependencyGraph, rotatingSchedule } from "../tasks/concurrent-schedule.mjs";
import { checkpointContracts } from "../grading/concurrent-contracts.mjs";
import { atomicCheckpoints } from "../tasks/atomic-bundle.mjs";
import { atomicOrder } from "../tasks/atomic-effects.mjs";
import { sourceFilesAfter } from "../tasks/task-constraints.mjs";
import { ATOMIC_DISPATCH_POLICY } from "./atomic-stream.mjs";
import { MULTI_AGENT_POLICY } from "../results.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Validate immutable workload inputs without accepting a historical execution proof.
 * Restoring execution seals separate requirements and needs its own execution proof.
 */
export async function loadRestoringPreparation(preparationPath, { agents } = {}) {
  const preparation = path.resolve(preparationPath);
  const json = async (file) => JSON.parse(await readFile(file, "utf8"));
  const manifest = await json(path.join(preparation, "manifest.json"));
  assert.equal(manifest.version, "renderer-concurrent-v2");
  assert.deepEqual(
    manifest.policy,
    MULTI_AGENT_POLICY,
    "Unsupported Multi-Agent preparation policy",
  );
  assert.equal(
    manifest.atomic?.version,
    ATOMIC_DISPATCH_POLICY.version,
    "Unsupported atomic stream preparation",
  );
  assert.equal(
    manifest.atomic.dispatchPolicySha256,
    digest(JSON.stringify(ATOMIC_DISPATCH_POLICY)),
    "Atomic dispatch policy changed",
  );
  const bytes = await readFile(path.join(preparation, "tasks.json"));
  assert.equal(digest(bytes), manifest.workloadSha256);
  const taskList = JSON.parse(bytes);
  assert.equal(taskList.length, manifest.tasks);
  const atomicBytes = await readFile(path.join(preparation, "atomic/tasks.json"));
  const batchBytes = await readFile(path.join(preparation, "atomic/batches.json"));
  assert.equal(digest(atomicBytes), manifest.atomic.workloadSha256, "Atomic workload changed");
  assert.equal(
    digest(batchBytes),
    manifest.atomic.batchesSha256,
    "Private atomic bindings changed",
  );
  const atomicWorkload = JSON.parse(atomicBytes);
  assert.equal(atomicWorkload.version, "renderer-atomic-workload-v1");
  assert.equal(atomicWorkload.nodes.length, manifest.atomic.edits);
  atomicOrder(atomicWorkload.nodes);
  assert.deepEqual(
    [...new Set(atomicWorkload.nodes.map((node) => node.taskId))].sort(),
    taskList.map((task) => task.id).sort(),
    "Atomic scoring-group coverage differs",
  );
  const atomicBatches = JSON.parse(batchBytes);
  assert.ok(Array.isArray(atomicBatches), "Invalid private atomic binding batches");
  const graphBytes = await readFile(path.join(preparation, "graph.json"));
  assert.equal(digest(graphBytes), manifest.graphSha256);
  const graph = JSON.parse(graphBytes);
  const transitions = [];
  for (const task of taskList) {
    const content = await readFile(path.join(preparation, "transitions", task.id + ".json"));
    assert.equal(digest(content), manifest.transitionHashes[task.id]);
    transitions.push(JSON.parse(content));
  }
  assert.deepEqual(graph, dependencyGraph(taskList, transitions));
  agents ??= graph.width;
  const schedule = rotatingSchedule(graph, agents);
  const scheduleSha256 = digest(JSON.stringify(schedule));
  const initialBytes = await readFile(path.join(preparation, "contracts/initial.json"));
  assert.equal(digest(initialBytes), manifest.initialContractSha256);
  const initialContract = JSON.parse(initialBytes);
  const initial = await readTree(path.join(preparation, "initial"));
  assert.equal(treeIdentity(initial), manifest.initial);
  const contracts = checkpointContracts(initial, initialContract, taskList, transitions, schedule);
  const atomicIntervals = atomicCheckpoints(
    initial,
    atomicWorkload,
    atomicBatches,
    schedule,
    contracts,
    { roundCredit: true },
  );
  assert.equal(
    treeIdentity(atomicIntervals.tree),
    manifest.final,
    "Atomic schedule changed the final restoration",
  );

  let requiredSourceFiles = Object.keys(initial);
  for (const round of schedule) {
    requiredSourceFiles = sourceFilesAfter(
      requiredSourceFiles,
      atomicIntervals.rounds.get(round.id).nodes.flatMap((node) => node.operations),
    );
    assert.deepEqual(
      requiredSourceFiles,
      contracts.get(round.id).files,
      "Public task file effects differ from the full round contract",
    );
  }
  const contractHashes = Object.fromEntries(
    [...contracts].map(([id, contract]) => [id, digest(JSON.stringify(contract))]),
  );
  const plannedAtoms = schedule.map(({ id }) => ({
    round: id,
    totalAtoms: atomicIntervals.rounds.get(id).nodes.length,
  }));
  return {
    manifest,
    taskList,
    atomicWorkload,
    atomicBatches,
    graph,
    agents,
    schedule,
    scheduleSha256,
    initial,
    initialContract,
    contracts,
    contractHashes,
    atomicIntervals,
    plannedAtoms,
  };
}
