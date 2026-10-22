import assert from "node:assert/strict";
import test from "node:test";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  prepareAtomicNamingBatch,
  createAtomicNamingReplay,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";

function fixture() {
  const tree = {
    "shape.h": `namespace frond {
int evaluate(int firstShape, int firstElement, int firstUv);
int evaluate(int secondShape, int secondElement, int secondUv);
}\n`,
  };
  // Controlled physical plans isolate the loss of occurrence identity after six
  // independent parameter slots converge. No compiler certification is claimed.
  const bindings = [
    ["A", "firstShape", "shape"],
    ["B", "firstElement", "element"],
    ["C", "firstUv", "uv"],
    ["D", "secondShape", "shape"],
    ["E", "secondElement", "element"],
    ["F", "secondUv", "uv"],
  ].map(([id, from, to]) => ({
    id,
    plan: {
      edits: cppTokens(tree["shape.h"])
        .filter((token) => token.text === from)
        .map((token) => ({ file: "shape.h", start: token.start, old: from, new: to })),
    },
  }));
  const batch = prepareAtomicNamingBatch(tree, bindings);
  const replay = createAtomicNamingReplay(batch);
  const nodes = bindings.map(({ id }) => ({
    id,
    taskId: "parameters",
    dependencies: [],
    operations: [{ phase: "names" }],
  }));
  return { tree, bindings, batch, replay, nodes };
}

test("real compiler bindings retain six independent prototype parameters through convergence", async () => {
  const { mkdir, mkdtemp, rm } = await import("node:fs/promises");
  const path = await import("node:path");
  const { scopedNamingSession, applyScopedNamePlan } =
    await import("../../src/suites/explicit-edit-multi-agent/cpp/scoped-names.mjs");
  const { tree, bindings } = fixture();
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/convergent-parameters-"));
  const session = await scopedNamingSession({ "main.cpp": tree["shape.h"] }, root);
  try {
    const certification = await session.atomicPlans({
      id: "parameters",
      phase: "names",
      category: "locals-parameters",
      mapping: bindings.map(({ plan }) => ({ from: plan.edits[0].old, to: plan.edits[0].new })),
      selectors: [
        {
          kind: "function",
          scope: "frond::evaluate",
          signature: "int (int, int, int)",
          definition: false,
        },
      ],
    });
    session.close();
    assert.equal(certification.atoms.length, 6);
    assert.ok(certification.atoms.every((atom) => atom.plan.edits.length === 1));
    const source = { "main.cpp": tree["shape.h"] };
    const certified = certification.atoms.map((atom, index) => ({
      id: `cert-${index}`,
      plan: atom.plan,
    }));
    const batch = prepareAtomicNamingBatch(source, certified);
    const nodes = certified.map(({ id }) => ({
      id,
      taskId: "parameters",
      dependencies: [],
      operations: [{ phase: "names" }],
    }));
    const checkpoint = createAtomicCheckpoint(source, nodes, [{ taskId: "parameters", batch }]);
    const expected = applyScopedNamePlan(source, certification.plan);
    for (const { id } of nodes)
      assert.equal(
        checkpoint.check(expected, id, { settled: new Set(nodes.map((node) => node.id)) }).status,
        "pass",
      );
  } finally {
    session.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("six independent parameter edits remain attributable when their prototypes converge", () => {
  const { tree, bindings, batch, replay, nodes } = fixture();
  const checkpoint = createAtomicCheckpoint(tree, nodes, [{ taskId: "parameters", batch }]);
  assert.equal(nodes.length, 6);
  for (let bits = 1; bits < 64; bits++) {
    const selected = bindings.filter((_, index) => bits & (1 << index)).map(({ id }) => id);
    const expected = replay(tree, selected).tree;
    for (const id of selected)
      assert.equal(
        checkpoint.check(expected, id, { settled: new Set(selected) }).status,
        "pass",
        `${bits}: ${id}`,
      );
  }
  const full = replay(
    tree,
    bindings.map(({ id }) => id),
  ).tree;
  const state = {
    started: new Set(bindings.map(({ id }) => id)),
    settled: new Set(bindings.map(({ id }) => id)),
  };
  const firstWrong = { "shape.h": full["shape.h"].replace("int shape", "int mistaken") };
  const secondWrong = {
    "shape.h": full["shape.h"].replace(
      "int evaluate(int shape, int element, int uv);\n}",
      "int evaluate(int mistaken, int element, int uv);\n}",
    ),
  };
  assert.equal(checkpoint.check(firstWrong, "A", state).status, "fail");
  assert.equal(checkpoint.check(firstWrong, "D", state).status, "pass");
  assert.equal(checkpoint.check(secondWrong, "A", state).status, "pass");
  assert.equal(checkpoint.check(secondWrong, "D", state).status, "fail");
  const retained = checkpoint.revalidate(firstWrong, {
    completed: new Set(bindings.map(({ id }) => id)),
  });
  assert.ok(!retained.completed.has("A"));
  assert.ok(retained.completed.has("D"));
});

test("structural replay and an earlier length-changing rename supply current occurrence ordinals", async () => {
  const { applyCoherentStructure } =
    await import("../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs");
  const { tree, bindings, nodes } = fixture();
  const initial = {
    "main.cpp": `#ifndef SHAPE_H\n#define SHAPE_H\n${tree["shape.h"].replace("namespace frond {", "namespace frond { int tiny = 0;")}#endif\n`,
  };
  const move = {
    id: "move",
    taskId: "move",
    dependencies: [],
    operations: [{ action: "header", file: "shape.h", guard: "SHAPE_H", includes: [] }],
  };
  const moved = applyCoherentStructure(initial, move.operations[0]);
  const prefix = {
    id: "prefix",
    taskId: "prefix",
    dependencies: ["move"],
    operations: [{ phase: "names" }],
  };
  const prefixBatch = prepareAtomicNamingBatch(moved, [
    {
      id: "prefix",
      plan: {
        edits: [
          {
            file: "shape.h",
            start: moved["shape.h"].indexOf("tiny"),
            old: "tiny",
            new: "aMuchLongerMarker",
          },
        ],
      },
    },
  ]);
  const afterPrefix = createAtomicNamingReplay(prefixBatch)(moved, ["prefix"]).tree;
  const certified = bindings.map(({ id, plan }) => ({
    id,
    plan: {
      edits: plan.edits.map((edit) => ({
        ...edit,
        start: afterPrefix["shape.h"].indexOf(edit.old),
      })),
    },
  }));
  const batch = prepareAtomicNamingBatch(afterPrefix, certified);
  const checkpoint = createAtomicCheckpoint(
    initial,
    [move, prefix, ...nodes.map((node) => ({ ...node, dependencies: ["prefix"] }))],
    [
      { taskId: "prefix", batch: prefixBatch },
      { taskId: "parameters", batch },
    ],
  );
  const ids = nodes.map(({ id }) => id);
  const expected = checkpoint.expected(new Set(["move", "prefix", ...ids])).tree;
  assert.ok(expected["shape.h"].includes("aMuchLongerMarker"));
  const state = {
    completed: new Set(["move", "prefix"]),
    settled: new Set(ids),
    started: new Set(ids),
  };
  assert.equal(checkpoint.check(expected, "move", state).status, "pass");
  for (const id of ids) assert.equal(checkpoint.check(expected, id, state).status, "pass");
  const partial = {
    ...expected,
    "shape.h": expected["shape.h"].replace("int shape", "int mistaken"),
  };
  assert.equal(checkpoint.check(partial, "A", state).status, "fail");
  assert.equal(checkpoint.check(partial, "D", state).status, "pass");
});
test("convergent occurrence checks reject copy changes and tolerate layout and trusted relocation", () => {
  const { tree, batch, replay, nodes } = fixture();
  const ids = nodes.map(({ id }) => id);
  const checkpoint = createAtomicCheckpoint(tree, nodes, [{ taskId: "parameters", batch }]);
  const full = replay(tree, ids).tree;
  const state = { settled: new Set(ids) };
  const prototype = "int evaluate(int shape, int element, int uv);";
  for (const source of [
    full["shape.h"].replace(prototype, ""),
    full["shape.h"].replace(prototype, `${prototype}\n${prototype}`),
    full["shape.h"].replace("int element", "float element"),
  ])
    assert.notEqual(checkpoint.check({ "shape.h": source }, "A", state).status, "pass");
  assert.equal(
    checkpoint.check({ "shape.h": `\n\n${full["shape.h"]}` }, "A", state).status,
    "pass",
  );
  const shifted = { "shape.h": `\n${tree["shape.h"]}` };
  assert.deepEqual(replay(shifted, ids).tree, { "shape.h": `\n${full["shape.h"]}` });
  const movedTree = { "moved.h": tree["shape.h"] };
  const movedCheckpoint = createAtomicCheckpoint(movedTree, nodes, [
    { taskId: "parameters", batch },
  ]);
  assert.equal(movedCheckpoint.check(replay(movedTree, ids).tree, "A", state).status, "pass");
});
