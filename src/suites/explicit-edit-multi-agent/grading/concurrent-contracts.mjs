import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { prepareCoherentContract } from "./coherent-grade.mjs";
import { advanceContract } from "../tasks/concurrent-schedule.mjs";

/** Build private checkpoint expectations from the untouched initial source and
 * public module moves, never from a candidate. Moving a guard changes contexts
 * of other declarations without editing their bodies, so sequential structural
 * contract deltas cannot be applied to arbitrary ready waves. Rebuild the selected
 * layout, then compose the audited naming deltas for completed owners. The cache
 * belongs to preparation only and is never mounted into an editing process.
 */
export function checkpointContracts(
  initialTree,
  initialContract,
  tasks,
  transitions,
  schedule,
  cache = new Map(),
) {
  const done = new Set();
  const completed = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const contracts = new Map([["initial", initialContract]]);
  const changes = new Map(transitions.map((item) => [item.id, item]));
  for (const round of schedule) {
    for (const assignment of round.assignments) {
      if (done.has(assignment.task) || !byId.has(assignment.task))
        throw Error("Repeated or unknown checkpoint task");
      done.add(assignment.task);
      completed.push(byId.get(assignment.task));
    }
    const modules = completed.filter((task) => task.phase === "structure");
    const key = JSON.stringify(modules.map((task) => task.id));
    let contract = cache.get(key);
    if (!contract) {
      let expected = initialTree;
      for (const task of modules)
        expected = task.operations.reduce(applyCoherentStructure, expected);
      contract = modules.length ? prepareCoherentContract(expected) : initialContract;
      cache.set(key, contract);
    }
    for (const task of tasks.filter((task) => task.phase !== "structure" && done.has(task.id)))
      contract = advanceContract(contract, changes.get(task.id));
    contracts.set(round.id, contract);
  }
  return contracts;
}
