import assert from "node:assert/strict";
import { test } from "node:test";
import { sealAtomicEffects } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-preparation.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

function rename(id, from, to) {
  return {
    id,
    taskId: "task-001",
    dependencies: [],
    sourceOperations: [0],
    operations: [
      {
        phase: "names",
        category: "locals-parameters",
        mapping: [{ from, to }],
        selectors: [
          { kind: "function", scope: "sum", signature: "int (int, int)", definition: true },
        ],
      },
    ],
  };
}
function plan(source, old, replacement) {
  const edits = [...source.matchAll(new RegExp(`\\b${old}\\b`, "g"))].map((match) => ({
    file: "main.cpp",
    start: match.index,
    old,
    new: replacement,
  }));
  return { edits };
}

const source = "int sum(int a, int b) { return a + b; }\n";

test("trusted binding plans derive independent effects and the same coarse endpoint", () => {
  const nodes = [rename("a", "a", "left"), rename("b", "b", "right")];
  const plans = new Map([
    ["a", plan(source, "a", "left")],
    ["b", plan(source, "b", "right")],
  ]);
  const final = { "main.cpp": "int sum(int left, int right) { return left + right; }\n" };
  const result = sealAtomicEffects({ "main.cpp": source }, nodes, {
    plans,
    expected: prepareCoherentContract(final),
  });
  assert.deepEqual(result.tree, final);
  assert.deepEqual(result.graph.nodes[1].dependencies, []);
  assert.deepEqual(
    result.effects.map(({ id }) => id),
    ["a", "b"],
  );
  assert.ok(result.effects.every(({ effect }) => effect.remove.length && effect.add.length));
  assert.deepEqual(
    nodes.map((node) => node.dependencies),
    [[], []],
  );
});

test("selector ordering precedes physical offset planning and is reflected in the effects", () => {
  const nodes = [rename("a", "a", "left"), rename("b", "b", "right")];
  nodes[0].dependencies = ["b"];
  const result = sealAtomicEffects({ "main.cpp": source }, nodes, {
    plans: new Map([
      ["a", plan(source, "a", "left")],
      ["b", plan(source, "b", "right")],
    ]),
  });
  assert.deepEqual(
    result.effects.map(({ id }) => id),
    ["b", "a"],
  );
  assert.deepEqual(result.graph.nodes[0].dependencies, ["b"]);
  assert.ok(result.tree["main.cpp"].includes("return left + right"));
});

test("missing, unrelated, overlapping and stale private binding effects are rejected", () => {
  const node = rename("a", "a", "left");
  const seal = (planned) =>
    sealAtomicEffects({ "main.cpp": source }, [node], { plans: new Map([["a", planned]]) });
  assert.throws(() => sealAtomicEffects({ "main.cpp": source }, [node]), /plan/i);
  assert.throws(() => seal({ edits: [] }), /empty|plan/i);
  assert.throws(() => seal(plan(source, "b", "right")), /mapping|binding/i);
  assert.throws(
    () => seal({ edits: [{ file: "main.cpp", start: 0, old: "a", new: "left" }] }),
    /stale|overlap/i,
  );
  const one = plan(source, "a", "left");
  assert.throws(() => seal({ edits: [...one.edits, one.edits[0]] }), /overlap/i);
  assert.throws(
    () =>
      sealAtomicEffects({ "main.cpp": source }, [node], {
        plans: new Map([["a", one]]),
        expected: prepareCoherentContract({ "main.cpp": "int wrong;\n" }),
      }),
    /endpoint/i,
  );
});

test("a structural atom is replayed from its public operations without saved replacement source", () => {
  const initial = {
    "main.cpp": "#ifndef MATH_H\n#define MATH_H\nint add(int x) { return x + 1; }\n#endif\n",
  };
  const node = {
    id: "header",
    taskId: "task-001",
    dependencies: [],
    operations: [
      { phase: "structure", action: "header", file: "math.h", guard: "MATH_H", includes: [] },
    ],
  };
  const result = sealAtomicEffects(initial, [node]);
  assert.ok(result.tree["math.h"].includes("return x + 1;"));
  assert.ok(result.effects[0].effect.remove.length > 0);
  assert.ok(result.effects[0].effect.add.some((record) => record.file === "math.h"));
  assert.equal(result.graph.nodes.length, 1);
});
