import assert from "node:assert/strict";
import test from "node:test";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

const source = "int sum(int a, int b) { return a + b + 1; }\n";
const initial = { "main.cpp": source };
function binding(id, from, to) {
  const edits = [...source.matchAll(new RegExp(`\\b${from}\\b`, "g"))].map((match) => ({
    file: "main.cpp",
    start: match.index,
    old: from,
    new: to,
  }));
  return { id, plan: { id, edits } };
}
const nodes = [
  { id: "a", taskId: "names", dependencies: [], operations: [{ phase: "names" }] },
  { id: "b", taskId: "names", dependencies: [], operations: [{ phase: "names" }] },
];
const batches = [
  {
    taskId: "names",
    batch: prepareAtomicNamingBatch(initial, [
      binding("a", "a", "left"),
      binding("b", "b", "right"),
    ]),
  },
];

await test("combined binding checkpoints accept a correct atom without crediting an incomplete peer", () => {
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  const actual = { "main.cpp": source.replaceAll(" a", " left").replace("int b", "int right") };
  const state = { settled: new Set(["a", "b"]), completed: new Set(), writers: new Set() };
  assert.equal(checkpoint.check(actual, "a", state).status, "pass");
  assert.equal(checkpoint.check(actual, "b", state).status, "fail");
  assert.equal(checkpoint.check(actual, "b", { ...state, input: true }).status, "pass");
  assert.equal(
    checkpoint.check(actual, "b", { ...state, completed: new Set(["a"]) }).status,
    "fail",
  );
  assert.equal(
    checkpoint.check({ "main.cpp": actual["main.cpp"].replace("+ 1", "+ 2") }, "a", state).status,
    "unobservable",
  );
});

await test("revalidation uses a combined frontier rather than removing an ancestor's effect", () => {
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  const expected = checkpoint.expected(new Set(["a", "b"])).tree;
  const state = {
    settled: new Set(["a", "b"]),
    completed: new Set(["a", "b"]),
    writers: new Set(),
  };
  assert.equal(checkpoint.check(expected, "a", state).status, "pass");
  const regressed = { "main.cpp": expected["main.cpp"].replace("return left", "return a") };
  assert.equal(checkpoint.check(regressed, "a", state).status, "fail");
  assert.equal(checkpoint.check(regressed, "b", { ...state, input: true }).status, "unobservable");
});

await test("combined opaque checkpoints preserve inactive branches and independent repair slots", () => {
  const text = `#define BIAS 7
#ifndef COUPLED_H
#define COUPLED_H
#ifdef MODE
int sum(int left,
#else
int sum(double left,
#endif
int right) { const char* text = "left"; return left + right + BIAS; }
#endif
`;
  const tree = { "main.cpp": text };
  const bindings = [
    ["A", "left", "longLeft"],
    ["B", "right", "r"],
  ].map(([id, from, to]) => ({
    id,
    plan: {
      edits: cppTokens(text)
        .filter((token) => token.text === from)
        .map((token) => ({
          file: "main.cpp",
          start: token.start,
          old: from,
          new: to,
        })),
    },
  }));
  const batch = prepareAtomicNamingBatch(tree, bindings);
  assert.ok(batch.owners.some((owner) => owner.opaque));
  const checkpoint = createAtomicCheckpoint(
    tree,
    bindings.map(({ id }) => ({
      id,
      taskId: "opaque",
      dependencies: [],
      operations: [{ phase: "names" }],
    })),
    [{ taskId: "opaque", batch }],
  );
  const state = {
    completed: new Set(["A"]),
    started: new Set(["A", "B"]),
    settled: new Set(["A", "B"]),
    writers: new Set(),
  };
  const expected = checkpoint.expected(state.settled).tree;
  const partial = {
    "main.cpp": expected["main.cpp"].replace("return longLeft + r", "return longLeft + right"),
  };
  assert.equal(checkpoint.check(partial, "A", state).status, "pass");
  assert.equal(checkpoint.check(partial, "B", state).status, "fail");
  assert.equal(checkpoint.check(partial, "B", { ...state, input: true }).status, "pass");
  assert.deepEqual([...checkpoint.revalidate(partial, state).completed], ["A"]);
  const inactiveRegression = {
    "main.cpp": expected["main.cpp"].replace("double longLeft", "double left"),
  };
  assert.equal(checkpoint.check(inactiveRegression, "A", state).status, "fail");
  assert.equal(checkpoint.check(expected, "A", state).status, "pass");
  expected["main.cpp"] = expected["main.cpp"].replace("+ BIAS", "- BIAS");
  assert.equal(
    checkpoint.check(expected, "A", state).status,
    "unobservable",
    "Reusing trusted frontier data must never cache a candidate acceptance",
  );
});
await test("active peer positions defer a missing output without masking verified predecessors", () => {
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  const state = { settled: new Set(), completed: new Set(), writers: new Set(["b"]) };
  assert.equal(checkpoint.check(initial, "a", state).status, "pending");
  const left = checkpoint.expected(new Set(["a"])).tree;
  assert.equal(checkpoint.check(left, "a", state).status, "pass");
  assert.equal(
    checkpoint.check(initial, "b", { ...state, completed: new Set(["a"]), input: true }).status,
    "pending",
  );
});

await test("structural peers rebuild exact guard context in either settlement order", () => {
  const tree = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nstruct A { int n; };\n#endif\n#ifndef B_H\n#define B_H\nstruct B { int n; };\n#endif\n",
  };
  const moves = ["A", "B"].map((name) => ({
    id: name,
    taskId: name,
    dependencies: [],
    operations: [{ action: "header", file: `${name}.h`, guard: `${name}_H`, includes: [] }],
  }));
  const checkpoint = createAtomicCheckpoint(tree, moves, []);
  const actual = checkpoint.expected(new Set(["A", "B"])).tree;
  for (const id of ["A", "B"]) {
    const state = { settled: new Set(["A", "B"]), completed: new Set(), writers: new Set() };
    assert.equal(checkpoint.check(actual, id, state).status, "pass");
  }
  const corrupted = { ...actual, "B.h": actual["B.h"].replace("int n", "int wrong") };
  const state = { settled: new Set(["A", "B"]), completed: new Set(), writers: new Set() };
  assert.equal(checkpoint.check(corrupted, "A", state).status, "pass");
  assert.equal(checkpoint.check(corrupted, "B", state).status, "fail");
});

await test("a move remains verifiable after its renamed dependent changes its declarator", () => {
  const tree = { "main.cpp": "#ifndef A_H\n#define A_H\nstruct A { int old; };\n#endif\n" };
  const move = {
    id: "move",
    taskId: "move",
    dependencies: [],
    operations: [{ action: "header", file: "A.h", guard: "A_H", includes: [] }],
  };
  const moved = applyCoherentStructure(tree, move.operations[0]);
  const start = moved["A.h"].indexOf("A {");
  const batch = prepareAtomicNamingBatch(moved, [
    { id: "rename", plan: { edits: [{ file: "A.h", start, old: "A", new: "Renamed" }] } },
  ]);
  const rename = {
    id: "rename",
    taskId: "names",
    dependencies: ["move"],
    operations: [{ phase: "names" }],
  };
  const checkpoint = createAtomicCheckpoint(tree, [move, rename], [{ taskId: "names", batch }]);
  const expected = checkpoint.expected(new Set(["move", "rename"])).tree;
  const state = {
    completed: new Set(["move", "rename"]),
    settled: new Set(["move", "rename"]),
    writers: new Set(),
  };
  assert.equal(checkpoint.check(expected, "move", state).status, "pass");
  const duplicate = {
    ...expected,
    "main.cpp": expected["main.cpp"] + "\nstruct A { int old; };\n",
  };
  assert.equal(checkpoint.check(duplicate, "move", state).status, "fail");
  assert.equal(
    checkpoint.check(
      { ...expected, "A.h": expected["A.h"].replace("int old", "int lost") },
      "move",
      state,
    ).status,
    "fail",
  );
});

await test("an incomplete naming descendant does not revoke a correct physical move", () => {
  const tree = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nstruct A { int old; int read() const { return old; } };\n#endif\n",
  };
  const move = {
    id: "move",
    taskId: "move",
    dependencies: [],
    operations: [{ action: "header", file: "A.h", guard: "A_H", includes: [] }],
  };
  const moved = applyCoherentStructure(tree, move.operations[0]);
  const batch = prepareAtomicNamingBatch(moved, [
    {
      id: "rename",
      plan: {
        edits: [...moved["A.h"].matchAll(/\bold\b/g)].map((match) => ({
          file: "A.h",
          start: match.index,
          old: "old",
          new: "value",
        })),
      },
    },
  ]);
  const rename = {
    id: "rename",
    taskId: "names",
    dependencies: ["move"],
    operations: [{ phase: "names" }],
  };
  const checkpoint = createAtomicCheckpoint(tree, [move, rename], [{ taskId: "names", batch }]);
  const actual = { ...moved, "A.h": moved["A.h"].replace("int old", "int value") };
  const state = {
    completed: new Set(["move"]),
    started: new Set(["move", "rename"]),
    settled: new Set(["move", "rename"]),
    writers: new Set(),
  };
  assert.equal(checkpoint.check(actual, "move", state).status, "pass");
  assert.equal(checkpoint.check(actual, "rename", state).status, "fail");
  state.settled = new Set(["move"]);
  assert.equal(checkpoint.check(actual, "move", state).status, "pass");
  assert.ok(checkpoint.revalidate(actual, state).completed.has("move"));
  assert.notEqual(
    checkpoint.check(
      { ...actual, "A.h": actual["A.h"].replace("return old", "return 7") },
      "move",
      state,
    ).status,
    "pass",
  );
});
await test("a selected file-local binding retains legitimate identical owners in other translation units", () => {
  const body = "static int helper(int arg) { return arg; }\n";
  const tree = { "first.cpp": body, "second.cpp": body };
  const node = {
    id: "rename",
    taskId: "names",
    dependencies: [],
    operations: [{ phase: "names" }],
  };
  const batch = prepareAtomicNamingBatch(tree, [
    {
      id: node.id,
      plan: {
        edits: [...body.matchAll(/\barg\b/g)].map((match) => ({
          file: "first.cpp",
          start: match.index,
          old: "arg",
          new: "value",
        })),
      },
    },
  ]);
  batch.owners[0].fileHint = "first.cpp";
  const checkpoint = createAtomicCheckpoint(tree, [node], [{ taskId: "names", batch }]);
  const actual = checkpoint.expected(new Set([node.id])).tree;
  const context = { completed: new Set(), settled: new Set([node.id]), writers: new Set() };
  assert.equal(checkpoint.check(actual, node.id, context).status, "pass");
  assert.equal(actual["second.cpp"], body);
  assert.notEqual(
    checkpoint.check(
      { ...actual, "extra.cpp": body.replace("return arg", "return 5") },
      node.id,
      context,
    ).status,
    "pass",
  );
});
await test("source observations must remain stable through both reads and the frontier check", async () => {
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  const renamed = checkpoint.expected(new Set(["a"])).tree;
  const completed = new Set();
  const context = {
    get completed() {
      return new Set(completed);
    },
    settled: new Set(["a"]),
    writers: new Set(),
  };
  let reads = 0;
  const changedSource = await checkpoint.observe(
    async () => (++reads === 1 ? renamed : initial),
    "a",
    context,
  );
  assert.equal(changedSource.status, "pending");
  reads = 0;
  const changedFrontier = await checkpoint.observe(
    async () => {
      if (++reads === 2) completed.add("b");
      return renamed;
    },
    "a",
    context,
  );
  assert.equal(changedFrontier.status, "pending");
  completed.clear();
  assert.equal((await checkpoint.observe(async () => renamed, "a", context)).status, "pass");
  const controller = new AbortController();
  await assert.rejects(
    checkpoint.observe(
      async () => {
        controller.abort(Error("cancel observation"));
        return renamed;
      },
      "a",
      context,
      { signal: controller.signal },
    ),
    /cancel observation/,
  );
});
await test("transient source-read failures defer while writers run without hiding host I/O failures", async () => {
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  const context = { completed: new Set(), settled: new Set(), writers: new Set(["b"]) };
  const missing = async () => {
    throw Object.assign(Error("file moved during read"), { code: "ENOENT" });
  };
  assert.equal((await checkpoint.observe(missing, "a", context)).status, "pending");
  context.writers.clear();
  assert.equal((await checkpoint.observe(missing, "a", context)).status, "unobservable");
  const denied = Object.assign(Error("denied"), { code: "EACCES" });
  await assert.rejects(
    checkpoint.observe(
      async () => {
        throw denied;
      },
      "a",
      context,
    ),
    (error) => error === denied,
  );
});
await test("distinct naming groups sharing owners reject before any dispatch", () => {
  const first = prepareAtomicNamingBatch(initial, [binding("a", "a", "left")]);
  const named = { "main.cpp": source.replaceAll(/\ba\b/g, "left") };
  const second = prepareAtomicNamingBatch(named, [
    {
      id: "b",
      plan: {
        edits: [...named["main.cpp"].matchAll(/\bb\b/g)].map((match) => ({
          file: "main.cpp",
          start: match.index,
          old: "b",
          new: "right",
        })),
      },
    },
  ]);
  const split = nodes.map((node) => ({ ...node, taskId: node.id }));
  assert.throws(
    () =>
      createAtomicCheckpoint(initial, split, [
        { taskId: "a", batch: first },
        { taskId: "b", batch: second },
      ]),
    /naming groups.*owner/i,
  );
  assert.throws(
    () => createAtomicCheckpoint(initial, nodes, [batches[0], batches[0]]),
    /Repeated checkpoint naming group/,
  );
});
await test("checkpoint preparation rejects missing binding coverage and unknown selected nodes", () => {
  assert.throws(() => createAtomicCheckpoint(initial, nodes, []), /binding/i);
  const checkpoint = createAtomicCheckpoint(initial, nodes, batches);
  assert.throws(() => checkpoint.expected(new Set(["unknown"])), /Unknown/);
});
