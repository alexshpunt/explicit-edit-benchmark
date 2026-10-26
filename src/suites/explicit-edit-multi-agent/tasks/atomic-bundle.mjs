import assert from "node:assert/strict";
import { atomicWorkload } from "./atomic-workload.mjs";
import { atomicOrder } from "./atomic-effects.mjs";
import { sealAtomicEffects } from "./atomic-preparation.mjs";
import { coherentNamingPlans } from "./coherent-naming-plans.mjs";
import { prepareAtomicNamingBatch, applyAtomicNamingBatch } from "./atomic-naming-replay.mjs";
import { prepareCoherentContract, evaluateCoherentContract } from "../grading/coherent-grade.mjs";
import { treeIdentity } from "../generation/generator.mjs";
import { applyCoherentStructure } from "../reference/coherent-edit.mjs";
import { prepareAtomicEffect } from "./atomic-structural-effects.mjs";
import { prepareAtomicRoundFootprints } from "../grading/round-footprints.mjs";
import { cppStructure, emptyNamespaceSpans } from "../cpp/cpp-structure.mjs";

function originalOperation(operation) {
  const { bindingGroups: _groups, bindingCertification: _certification, ...original } = operation;
  return original;
}

function certifiedTask(task, record) {
  assert.equal(
    record?.version,
    "renderer-coherent-atomic-plans-v1",
    "Missing certified naming plan record",
  );
  assert.equal(
    record.bindings?.length,
    task.operations.length,
    "Incomplete certified operation records",
  );
  const operations = task.operations.map((original, index) => {
    const operation = record.bindings[index].operation;
    assert.deepEqual(
      originalOperation(operation),
      originalOperation(original),
      "Certified operation differs from its coarse operation",
    );
    if (Object.hasOwn(original, "bindingGroups") || Object.hasOwn(original, "bindingCertification"))
      assert.deepEqual(operation, original, "Coarse operation certification differs");
    return structuredClone(operation);
  });
  return { ...task, operations };
}

function namingBindings(tree, task, nodes, record) {
  assert.equal(
    record.before,
    treeIdentity(tree),
    "Certified naming plan source differs from group start",
  );
  assert.equal(record.plans?.length, task.operations.length, "Incomplete certified union plans");
  // Reuse the sealer's complete union/atom checks rather than trusting indexes or
  // selector checksums alone. Rebased plans must already match this group source.
  const sealed = coherentNamingPlans(
    tree,
    record.plans,
    [],
    record.bindings.map((binding, index) => ({
      ...binding,
      plan: record.plans[index],
    })),
  );
  assert.deepEqual(sealed, record, "Certified naming plan record differs from its sealed evidence");
  return nodes.map((node) => {
    assert.equal(node.sourceOperations.length, 1, "Atomic binding has multiple source operations");
    const operationIndex = node.sourceOperations[0];
    assert.ok(
      Number.isSafeInteger(operationIndex) && operationIndex >= 0,
      "Invalid binding operation index",
    );
    const binding = record.bindings[operationIndex];
    assert.ok(
      Number.isSafeInteger(node.bindingGroup) && node.bindingGroup >= 0,
      "Invalid atomic binding group index",
    );
    const atom = binding?.atoms[node.bindingGroup];
    assert.equal(
      node.bindingCount,
      binding?.operation.bindingGroups[node.bindingGroup]?.bindingCount,
      "Atomic binding count differs from its certified group",
    );
    assert.ok(
      atom && atom.bindingGroup === node.bindingGroup,
      "Missing certified atomic binding plan",
    );
    assert.deepEqual(
      node.operations,
      [atom.operation],
      "Atomic public operation differs from its certified binding",
    );
    return { id: node.id, plan: atom.plan };
  });
}

/** Assemble public atomic requests and separate private binding batches from a
 * trusted coherent preparation. Plans must have been compiler-certified and hash-
 * bound by the caller; this function checks their exact source, operation indexes,
 * union coverage and every original cumulative endpoint without invoking a compiler.
 * It never changes the supplied coarse tasks or invents cross-task dependencies.
 * Returned workload nodes are public requests; batches contain expected tokens and
 * physical binding slots and must never enter editing-worker mounts or prompts.
 * The caller still owns coarse scheduling, proof identities and full live barriers.
 */
export function assembleAtomicBundle(initialTree, tasks, { namingPlans, contracts }) {
  assert.ok(namingPlans instanceof Map, "Missing private naming plan map");
  assert.ok(contracts instanceof Map, "Missing coarse contract map");
  const namingIds = new Set(tasks.filter((task) => task.phase === "names").map((task) => task.id));
  for (const id of namingPlans.keys())
    assert.ok(namingIds.has(id), "Unexpected private naming plan group");
  const certified = tasks.map((task) =>
    task.phase === "names" ? certifiedTask(task, namingPlans.get(task.id)) : task,
  );
  const workload = atomicWorkload(certified);
  const groups = new Map(tasks.map((task) => [task.id, []]));
  for (const node of workload.nodes) groups.get(node.taskId).push(node);
  const updated = new Map();
  const batches = [];
  let tree = structuredClone(initialTree);
  for (const task of tasks) {
    const contract = contracts.get(task.id);
    assert.ok(contract, `Missing coarse endpoint contract: ${task.id}`);
    const nodes = groups.get(task.id);
    if (task.phase === "names") {
      const bindings = namingBindings(tree, task, nodes, namingPlans.get(task.id));
      const batch = prepareAtomicNamingBatch(tree, bindings);
      tree = applyAtomicNamingBatch(
        tree,
        batch,
        atomicOrder(nodes).map((node) => node.id),
      ).tree;
      batches.push({ taskId: task.id, batch });
      for (const node of nodes) updated.set(node.id, node);
    } else {
      const result = sealAtomicEffects(tree, nodes);
      tree = result.tree;
      for (const node of result.graph.nodes) updated.set(node.id, node);
    }
    assert.equal(
      evaluateCoherentContract(tree, contract).status,
      "pass",
      `Atomic split changed the coarse endpoint: ${task.id}`,
    );
  }
  workload.nodes = workload.nodes.map((node) => updated.get(node.id));
  workload.summary.dependencyEdges = workload.nodes.reduce(
    (sum, node) => sum + node.dependencies.length,
    0,
  );
  return { workload, batches, tree };
}

function structuralRepairScopes(before, after, operation) {
  const files = [...new Set([operation.file, "main.cpp"].filter(Boolean))];
  const selectors = [
    ...(operation.targets ?? []).map((target) => target.selector),
    ...(operation.selector ? [operation.selector] : []),
  ];
  const descriptors = selectors.flatMap((selector) =>
    files.map((file) => ({
      file,
      scope: selector.scope === "::" ? "" : selector.scope,
      selector: selector.declarator,
    })),
  );
  if (operation.guard) {
    const guards = [
      operation.guard,
      ...(operation.action === "vendor-header" ? [operation.macro] : []),
    ];
    for (const tree of [before, after])
      for (const file of files) {
        if (tree[file] === undefined) continue;
        const records = prepareCoherentContract({ [file]: tree[file] }).obligations;
        for (const record of records)
          if (
            record.selector !== undefined &&
            record.conditions.some((condition) => guards.some((guard) => condition.includes(guard)))
          )
            for (const owner of files)
              descriptors.push({ file: owner, scope: record.scope, selector: record.selector });
      }
  }
  return [
    ...new Map(
      (descriptors.length ? descriptors : files.map((file) => ({ file }))).map((descriptor) => [
        JSON.stringify(descriptor),
        descriptor,
      ]),
    ).values(),
  ];
}

/** Replay trusted effects only at the original barrier boundaries. No candidate
 * source enters this calculation; it creates no intermediate acceptance gates.
 */
export function atomicCheckpoints(
  initialTree,
  workload,
  batches,
  schedule,
  contracts,
  { roundCredit = false } = {},
) {
  assert.equal(typeof roundCredit, "boolean", "Invalid round credit preparation mode");
  assert.equal(workload.version, "renderer-atomic-workload-v1");
  atomicOrder(workload.nodes);
  const parents = new Set(workload.nodes.map((node) => node.taskId));
  const assigned = new Set();
  const roundIds = new Set();
  for (const round of schedule) {
    assert.ok(!roundIds.has(round.id), "Repeated atomic barrier");
    roundIds.add(round.id);
    for (const { task } of round.assignments) {
      assert.ok(parents.has(task), "Unknown atomic scoring group");
      assert.ok(!assigned.has(task), "Repeated atomic scoring group");
      assigned.add(task);
    }
  }
  assert.deepEqual([...assigned].sort(), [...parents].sort(), "Atomic barrier coverage differs");
  const rounds = new Map();
  const previous = new Set();
  const scopes = new Map();
  let tree = initialTree;
  for (const round of schedule) {
    const selected = new Set(round.assignments.map((assignment) => assignment.task));
    const beforeTree = tree;
    const effects = [];
    const nodes = workload.nodes
      .filter((node) => selected.has(node.taskId))
      .map((node) => ({
        ...node,
        dependencies: node.dependencies.filter((id) => !previous.has(id)),
      }));
    const ordered = atomicOrder(nodes);
    for (const node of ordered.filter((item) =>
      item.operations.every((operation) => operation.phase === "structure"),
    )) {
      const before = tree;
      const cleanupScopes = [];
      tree = node.operations.reduce((current, operation) => {
        if (roundCredit && operation.action === "cleanup-empty-namespaces")
          cleanupScopes.push(
            ...emptyNamespaceSpans(cppStructure(current["main.cpp"])).map(({ scope }) => ({
              file: "main.cpp",
              scope,
            })),
          );
        return applyCoherentStructure(current, operation);
      }, tree);
      if (roundCredit)
        effects.push({
          id: node.id,
          effect: prepareAtomicEffect(before, tree),
          filesBefore: Object.keys(before).sort(),
          filesAfter: Object.keys(tree).sort(),
          cleanupScopes,
        });
      scopes.set(
        node.id,
        node.operations.flatMap((operation) => structuralRepairScopes(before, tree, operation)),
      );
    }
    const structuralFootprints =
      roundCredit && effects.length
        ? prepareAtomicRoundFootprints(beforeTree, effects, tree)
        : undefined;
    for (const entry of batches.filter((item) => selected.has(item.taskId))) {
      const result = applyAtomicNamingBatch(tree, entry.batch, entry.batch.ids);
      tree = result.tree;
      for (const [id, descriptors] of result.repairScopes) {
        if (!scopes.has(id)) scopes.set(id, []);
        for (const descriptor of descriptors)
          if (!scopes.get(id).some((item) => JSON.stringify(item) === JSON.stringify(descriptor)))
            scopes.get(id).push(descriptor);
      }
    }
    const contract = contracts.get(round.id);
    assert.ok(contract, "Missing atomic barrier contract");
    assert.equal(
      evaluateCoherentContract(tree, contract).status,
      "pass",
      "Trusted replay differs from its full barrier contract",
    );
    rounds.set(round.id, {
      nodes,
      expectedTree: tree,
      repairScopes: new Map(scopes),
      ...(roundCredit
        ? {
            credit: {
              beforeTree,
              structuralFootprints,
              namingBatches: batches
                .filter((item) => selected.has(item.taskId))
                .map(({ batch }) => batch),
            },
          }
        : {}),
    });
    for (const node of nodes) previous.add(node.id);
  }
  return { rounds, tree };
}
