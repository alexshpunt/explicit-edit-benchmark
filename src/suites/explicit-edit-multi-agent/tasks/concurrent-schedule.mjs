const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function changedOwners(transition) {
  const counts = new Map();
  for (const [items, sign] of [
    [transition.remove, -1],
    [transition.add, 1],
  ])
    for (const item of items) {
      // Imports and guard bookkeeping are checked by the cumulative verifier.
      // They are not ownership of every body enclosed by a moved header.
      if (item.tokens && !["owner", "conditional", "comment"].includes(item.kind)) continue;
      const resource = item.tokens
        ? JSON.stringify([item.kind, item.scope ?? "", item.selector ?? "", item.tokens])
        : item.id;
      const location = JSON.stringify([item.file ?? "", resource]);
      counts.set(location, (counts.get(location) ?? 0) + sign * item.count);
    }
  return new Set([...counts].filter(([, count]) => count !== 0).map(([location]) => location));
}

/** Derive dependencies from moved or renamed code, required module files and
 * selector spellings. A surrounding guard or macro-context change is not a write
 * to every enclosed declaration. Independent module extraction is ready together;
 * only the final whole-monolith cleanup waits for all module moves.
 * Edges point forward in the audited route; one agent keeps its original order.
 * No graph or private resource data reaches agents.
 */
export function dependencyGraph(tasks, transitions) {
  if (
    !tasks.length ||
    tasks.length !== transitions.length ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length
  )
    throw Error("Invalid task graph input");
  const dependencies = tasks.map(() => new Set());
  const lastWriter = new Map();
  const fileProducer = new Map();
  for (const [index, task] of tasks.entries())
    if (task.phase === "structure") {
      for (const file of transitions[index].filesAfter.filter(
        (file) => !transitions[index].filesBefore.includes(file),
      ))
        fileProducer.set(file, index);
      for (const op of task.operations)
        if (
          ["header", "vendor-header", "vendor-implementation", "implementation"].includes(
            op.action,
          ) &&
          op.file
        )
          fileProducer.set(op.file, index);
    }
  const reasons = tasks.map(() => new Map());
  const depend = (to, from, reason) => {
    if (from === undefined || from === to) return;
    dependencies[to].add(from);
    if (!reasons[to].has(from)) reasons[to].set(from, new Set());
    reasons[to].get(from).add(reason);
  };
  const selectorWords = tasks.map(
    (task) =>
      new Set(
        task.operations.flatMap(
          (op) =>
            JSON.stringify({
              selectors: op.selectors,
              selector: op.selector,
              targets: op.targets,
            }).match(/[A-Za-z_]\w*/g) ?? [],
        ),
      ),
  );
  for (const [index, task] of tasks.entries()) {
    const transition = transitions[index];
    if (transition.id !== task.id) throw Error("Task transition identity differs");
    const resources = changedOwners(transition);
    if (
      !resources.size &&
      same(transition.filesBefore, transition.filesAfter) &&
      !transition.remove.length &&
      !transition.add.length
    )
      throw Error("Task has no editing effect");
    for (const resource of resources) {
      depend(index, lastWriter.get(resource), "source-owner");
      lastWriter.set(resource, index);
    }
    for (const op of task.operations) {
      for (const include of op.includes ?? []) {
        const file = typeof include === "string" ? include : include.file;
        depend(index, fileProducer.get(file), "required-file");
      }
      if (task.phase !== "structure")
        depend(index, fileProducer.get(op.file ?? task.subsystem), "owner-file");
      if (op.action === "cleanup-empty-namespaces")
        for (let previous = 0; previous < index; previous++)
          if (tasks[previous].phase === "structure") depend(index, previous, "monolith-cleanup");
    }
    for (const op of task.operations.filter(
      (operation) => operation.category === "functions-types" || operation.category === "helpers",
    )) {
      for (const { from, to } of op.mapping) {
        for (let other = 0; other < tasks.length; other++) {
          if (other < index && selectorWords[other].has(from))
            depend(index, other, "selector-spelling");
          if (other > index && selectorWords[other].has(to))
            depend(other, index, "selector-spelling");
        }
      }
    }
  }
  const reach = dependencies.map(() => new Set());
  for (let to = 0; to < tasks.length; to++)
    for (const from of dependencies[to]) {
      if (from >= to) throw Error("Cyclic or backward task dependency");
      reach[from].add(to);
    }
  for (let from = tasks.length - 1; from >= 0; from--)
    for (const to of [...reach[from]])
      for (const descendant of reach[to]) reach[from].add(descendant);
  // Dilworth: maximum antichain size = n - maximum matching in the transitive DAG.
  const matching = new Map();
  function match(from, visited) {
    for (const to of reach[from]) {
      if (visited.has(to)) continue;
      visited.add(to);
      if (!matching.has(to) || match(matching.get(to), visited)) {
        matching.set(to, from);
        return true;
      }
    }
    return false;
  }
  for (let from = 0; from < tasks.length; from++) match(from, new Set());
  return {
    version: "renderer-task-dag-v2",
    width: tasks.length - matching.size,
    nodes: tasks.map((task, index) => ({
      id: task.id,
      phase: task.phase,
      subsystem: task.subsystem,
      dependencies: [...dependencies[index]].sort((a, b) => a - b).map((i) => tasks[i].id),
      prerequisites: [...reasons[index]]
        .sort(([a], [b]) => a - b)
        .map(([i, kinds]) => ({ task: tasks[i].id, reasons: [...kinds].sort() })),
    })),
  };
}

/** Schedule ready tasks in stable original order, rotating their persistent agent
 * assignment at each checkpoint. Width is a theoretical upper bound, not a claim
 * that every round fills the team. One agent reproduces the old sequential route.
 */
export function rotatingSchedule(graph, agents = graph.width) {
  if (!Number.isInteger(agents) || agents < 1 || agents > graph.width)
    throw Error("Unsupported agent count for this graph");
  const done = new Set(),
    rounds = [];
  while (done.size < graph.nodes.length) {
    const ready = graph.nodes
      .filter((node) => !done.has(node.id) && node.dependencies.every((id) => done.has(id)))
      .slice(0, agents);
    if (!ready.length) throw Error("Blocked or cyclic task graph");
    const index = rounds.length;
    rounds.push({
      id: `round-${String(index + 1).padStart(3, "0")}`,
      assignments: ready.map((task, slot) => ({
        task: task.id,
        zone: task.subsystem,
        agent: (slot + index) % agents,
        slot,
      })),
    });
    for (const node of ready) done.add(node.id);
  }
  return rounds;
}

/** Apply a task's private consume/produce ledger to a checkpoint contract. Missing
 * or changed input resources reject an unsafe schedule before candidate grading.
 */
export function advanceContract(contract, transition) {
  const obligations = new Map(contract.obligations.map((item) => [item.id, item]));
  for (const item of transition.remove) {
    if (!same(obligations.get(item.id), item))
      throw Error(`Missing input obligation for ${transition.id}`);
    obligations.delete(item.id);
  }
  for (const item of transition.add) {
    if (obligations.has(item.id)) throw Error(`Conflicting output obligation for ${transition.id}`);
    obligations.set(item.id, item);
  }
  let files = contract.files;
  if (!same(transition.filesBefore, transition.filesAfter)) {
    if (!same(files, transition.filesBefore)) throw Error("Conflicting source-file transition");
    files = transition.filesAfter;
  }
  return { version: contract.version, files, obligations: [...obligations.values()] };
}

/** Extract the exact private resource delta between two audited task checkpoints. */
export function contractTransition(id, before, after) {
  const left = new Map(before.obligations.map((item) => [item.id, item]));
  const right = new Map(after.obligations.map((item) => [item.id, item]));
  return {
    id,
    filesBefore: before.files,
    filesAfter: after.files,
    remove: before.obligations.filter((item) => !same(item, right.get(item.id))),
    add: after.obligations.filter((item) => !same(item, left.get(item.id))),
  };
}
