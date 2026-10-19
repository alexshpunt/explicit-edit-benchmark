import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cppStructure,
  unitDeclarator,
} from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

function fixture() {
  const source = `namespace sample {
int first(int value);
int second(int value);
int third(int value);
int fourth(int value);
int stable() { return 7; }
}
`;
  const initial = Object.freeze({ "main.cpp": source });
  const nodes = cppStructure(source, { expandNamespaceConditionals: true })
    .units.filter((unit) => unit.scope === "sample" && !unit.definition)
    .map((unit, index) => ({
      id: `remove-${index}`,
      taskId: "cleanup",
      dependencies: [],
      operations: [
        {
          phase: "structure",
          action: "remove-generated-declaration",
          file: "main.cpp",
          selector: {
            scope: unit.scope,
            declarator: unitDeclarator(source, unit),
            definition: false,
          },
        },
      ],
    }));
  assert.equal(nodes.length, 4);
  const fresh = (selection) =>
    nodes
      .filter((node) => selection.has(node.id))
      .reduce((tree, node) => node.operations.reduce(applyCoherentStructure, tree), initial);
  return { initial, nodes, fresh, checkpoint: createAtomicCheckpoint(initial, nodes, []) };
}

test("trusted structural frontiers stay byte-exact through growth, earlier insertions and rollback", () => {
  const { initial, nodes, fresh, checkpoint } = fixture();
  const selected = new Set();
  const sequences = [[], [0], [0, 2], [0, 1, 2], [0, 1, 2, 3], [0, 1], [3, 1], [], [0, 1, 2, 3]];
  for (const indices of sequences) {
    selected.clear();
    for (const index of indices) selected.add(nodes[index].id);
    const expected = fresh(selected);
    assert.deepEqual(checkpoint.expected(selected).tree, expected);
    for (const id of selected) {
      const context = { completed: selected, started: selected, settled: selected };
      assert.equal(checkpoint.check(expected, id, context).status, "pass");
      assert.notEqual(checkpoint.check(initial, id, context).status, "pass");
    }
  }
  assert.ok(initial["main.cpp"].includes("int first(int value);"));
});

test("clearing or mutating returned structural frontiers cannot preserve stale selected effects", () => {
  const { initial, nodes, fresh, checkpoint } = fixture();
  const selected = new Set([nodes[0].id, nodes[1].id]);
  const exposed = checkpoint.expected(selected);
  exposed.tree["main.cpp"] = "int corrupted;\n";
  exposed.structural.clear();
  assert.deepEqual(checkpoint.expected(selected).tree, fresh(selected));
  assert.throws(() => checkpoint.expected(new Set(["unknown"])), /Unknown atomic checkpoint node/);
  checkpoint.clearCaches();
  assert.deepEqual(checkpoint.expected(selected).tree, fresh(selected));
  assert.deepEqual(checkpoint.expected(new Set()).tree, initial);
  assert.equal(checkpoint.check(initial, nodes[0].id, { input: true }).status, "pass");
});

test("speculative outputs and reused input metadata never change current-source requirements", () => {
  const { initial, nodes, checkpoint } = fixture();
  const completed = new Set([nodes[0].id]);
  const context = { completed, settled: completed, started: completed, writers: new Set() };
  const current = checkpoint.expected(completed).tree;
  for (const index of [3, 1, 2, 1]) {
    const id = nodes[index].id;
    assert.notEqual(checkpoint.check(current, id, context).status, "pass");
    assert.equal(checkpoint.check(current, id, { ...context, input: true }).status, "pass");
    const changed = { "main.cpp": current["main.cpp"].replaceAll("int value", "double value") };
    assert.notEqual(checkpoint.check(changed, id, { ...context, input: true }).status, "pass");
    assert.equal(checkpoint.check(current, id, { ...context, input: true }).status, "pass");
    assert.deepEqual(checkpoint.expected(completed).tree, current);
  }
  completed.clear();
  assert.equal(checkpoint.check(initial, nodes[0].id, { ...context, input: true }).status, "pass");
  checkpoint.clearCaches();
  assert.deepEqual(checkpoint.expected(completed).tree, initial);
});
