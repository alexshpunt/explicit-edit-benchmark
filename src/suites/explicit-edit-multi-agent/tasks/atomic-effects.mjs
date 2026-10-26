import assert from "node:assert/strict";

/** Order public atomic requests by their explicit prerequisites, without changing
 * their identities. Trusted effect preparation must use this order too: a selector
 * consumer can precede a rename even when it appeared later in the coarse batch.
 */
export function atomicOrder(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(byId.size, nodes.length, "Duplicate atomic identity");
  const counts = new Map();
  const successors = new Map(nodes.map((node) => [node.id, []]));
  for (const node of nodes) {
    assert.ok(Array.isArray(node.dependencies), "Missing atomic prerequisites");
    assert.equal(
      new Set(node.dependencies).size,
      node.dependencies.length,
      "Repeated atomic prerequisite",
    );
    counts.set(node.id, node.dependencies.length);
    for (const dependency of node.dependencies) {
      assert.ok(byId.has(dependency), "Missing atomic prerequisite");
      successors.get(dependency).push(node.id);
    }
  }
  const ready = nodes.filter((node) => !node.dependencies.length);
  for (let cursor = 0; cursor < ready.length; cursor++) {
    for (const id of successors.get(ready[cursor].id)) {
      const count = counts.get(id) - 1;
      counts.set(id, count);
      if (!count) ready.push(byId.get(id));
    }
  }
  assert.equal(ready.length, nodes.length, "Cyclic atomic prerequisites");
  return ready;
}

function core(record) {
  // Guard/macro context is checked by full barriers. It is not
  // ownership of every otherwise unchanged body following an extracted header.
  return JSON.stringify([
    record.file,
    record.kind,
    record.scope ?? "",
    record.selector ?? "",
    record.tokens,
  ]);
}

function family(record) {
  return JSON.stringify([
    record.file,
    record.kind,
    record.scope ?? "",
    record.kind === "owner"
      ? record.selector
      : record.kind === "conditional"
        ? record.directives
        : record.tokens,
  ]);
}

function writtenFamilies(effect) {
  const counts = new Map();
  for (const [records, sign] of [
    [effect.remove, -1],
    [effect.add, 1],
  ])
    for (const record of records) {
      const key = core(record);
      const previous = counts.get(key);
      counts.set(key, { record, count: (previous?.count ?? 0) + sign * record.count });
    }
  return new Set(
    [...counts.values()].filter((item) => item.count !== 0).map((item) => family(item.record)),
  );
}

/** Audit one group's private effects and add actual structural write dependencies.
 * Naming plans share the group's compiler snapshot. Disjoint binding positions
 * commute even inside the same owner; overlapping plans require certification as
 * one binding, not a fabricated dependency. Public selector dependencies remain.
 * Context-only deltas do not serialize independent header moves. Only drained
 * cumulative barriers verify candidate edits.
 */
export function atomicEffectGraph(nodes, effects) {
  atomicOrder(nodes);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  assert.equal(effects.length, nodes.length, "Incomplete atomic effects");
  const seen = new Set();
  const writers = new Map();
  const dependencies = new Map(nodes.map((node) => [node.id, new Set(node.dependencies)]));
  const bindingWrites = new Map();
  for (const { id, effect, plan } of effects) {
    const node = byId.get(id);
    assert.ok(node && !seen.has(id), "Repeated or unknown atomic effect");
    assert.ok(
      node.dependencies.every((dependency) => seen.has(dependency)),
      "Atomic effect prerequisite order differs",
    );
    if (node.operations?.every((operation) => operation.phase === "names")) {
      assert.ok(plan?.edits?.length, "Missing compiler-selected atomic binding plan");
      for (const edit of plan.edits) {
        assert.ok(
          typeof edit.file === "string" &&
            Number.isSafeInteger(edit.start) &&
            edit.start >= 0 &&
            typeof edit.old === "string" &&
            edit.old.length > 0,
          "Invalid physical binding plan",
        );
        if (!bindingWrites.has(edit.file)) bindingWrites.set(edit.file, []);
        bindingWrites.get(edit.file).push({ start: edit.start, end: edit.start + edit.old.length });
      }
    } else {
      for (const resource of writtenFamilies(effect)) {
        const previous = writers.get(resource);
        if (previous) dependencies.get(id).add(previous);
        writers.set(resource, id);
      }
    }
    seen.add(id);
  }
  for (const edits of bindingWrites.values()) {
    edits.sort((a, b) => a.start - b.start);
    for (let index = 1; index < edits.length; index++)
      assert.ok(
        edits[index - 1].end <= edits[index].start,
        "Overlapping atomic binding plans require one certified binding",
      );
  }
  const graph = {
    version: "renderer-atomic-effects-v1",
    nodes: nodes.map((node) => ({ ...node, dependencies: [...dependencies.get(node.id)].sort() })),
  };
  atomicOrder(graph.nodes);
  return graph;
}
