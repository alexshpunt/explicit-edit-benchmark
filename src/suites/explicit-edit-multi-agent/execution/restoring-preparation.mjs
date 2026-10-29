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
export const RESTORING_INPUTS_VERSION = "renderer-restoring-inputs-v1";

/** Validate immutable files and derive the original schedule without applying edits.
 * The fingerprint includes the manifest's exact bytes, every file read through it,
 * and the complete initial source identity. It does not authorize an execution.
 */
export async function loadRestoringInputs(preparationPath, { agents } = {}) {
  const preparation = path.resolve(preparationPath);
  const files = [];
  const input = async (file) => {
    const bytes = await readFile(path.join(preparation, file));
    files.push({ file, sha256: digest(bytes) });
    return bytes;
  };
  const manifest = JSON.parse((await input("manifest.json")).toString("utf8"));
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
  const bytes = await input("tasks.json");
  assert.equal(digest(bytes), manifest.workloadSha256);
  const taskList = JSON.parse(bytes);
  assert.equal(taskList.length, manifest.tasks);
  const atomicBytes = await input("atomic/tasks.json");
  const batchBytes = await input("atomic/batches.json");
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
  const graphBytes = await input("graph.json");
  assert.equal(digest(graphBytes), manifest.graphSha256);
  const graph = JSON.parse(graphBytes);
  const transitions = [];
  for (const task of taskList) {
    const content = await input(`transitions/${task.id}.json`);
    assert.equal(digest(content), manifest.transitionHashes[task.id]);
    transitions.push(JSON.parse(content));
  }
  assert.deepEqual(graph, dependencyGraph(taskList, transitions));
  agents ??= graph.width;
  const schedule = rotatingSchedule(graph, agents);
  const scheduleSha256 = digest(JSON.stringify(schedule));
  const initialBytes = await input("contracts/initial.json");
  assert.equal(digest(initialBytes), manifest.initialContractSha256);
  const initialContract = JSON.parse(initialBytes);
  const initial = await readTree(path.join(preparation, "initial"));
  assert.equal(treeIdentity(initial), manifest.initial);
  files.sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
  const inputFingerprint = digest(
    JSON.stringify({ version: RESTORING_INPUTS_VERSION, files, initial: manifest.initial }),
  );
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
    transitions,
    inputFingerprint,
  };
}

/** Preserve legacy restoration preparation, including full trusted replay and
 * its default credit preparation. Canonical cache loading uses the input reader.
 */
export async function loadRestoringPreparation(
  preparationPath,
  { agents, roundCredit = true } = {},
) {
  assert.equal(typeof roundCredit, "boolean", "Invalid round credit preparation mode");
  const inputs = await loadRestoringInputs(preparationPath, { agents });
  const {
    manifest,
    taskList,
    atomicWorkload,
    atomicBatches,
    graph,
    schedule,
    scheduleSha256,
    initial,
    initialContract,
    transitions,
    inputFingerprint,
  } = inputs;
  const contracts = checkpointContracts(initial, initialContract, taskList, transitions, schedule);
  const atomicIntervals = atomicCheckpoints(
    initial,
    atomicWorkload,
    atomicBatches,
    schedule,
    contracts,
    { roundCredit },
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
    agents: inputs.agents,
    schedule,
    scheduleSha256,
    initial,
    initialContract,
    contracts,
    contractHashes,
    atomicIntervals,
    plannedAtoms,
    inputFingerprint,
  };
}
