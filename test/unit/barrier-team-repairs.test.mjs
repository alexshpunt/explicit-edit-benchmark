import assert from "node:assert/strict";
import test from "node:test";
import {
  barrierRepairNodes,
  compilerDiagnostics,
} from "../../src/suites/explicit-edit-multi-agent/grading/repair-diagnostics.mjs";
import { partitionAtomicQueues } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";

const rename = (id, fn, from, to, signature = "int (int)") => ({
  id,
  taskId: id.split("-")[0],
  dependencies: [],
  prompt: `PUBLIC ${id}`,
  operations: [
    {
      phase: "names",
      category: "locals-parameters",
      mapping: [{ from, to }],
      selectors: [
        {
          kind: "variable",
          scope: `${fn}::${from}`,
          owner: { scope: fn, signature, definition: true },
        },
      ],
    },
  ],
});
function binding(tree, file, fn, name, signature = "int (int)") {
  const offset = tree[file].indexOf(name);
  const prefix = tree[file].slice(0, offset);
  return {
    file,
    offset,
    line: prefix.split("\n").length,
    column: offset - prefix.lastIndexOf("\n"),
    translationUnit: file,
    role: "variable",
    name,
    scope: `${fn}::${name}`,
    declaringScope: fn,
    owner: { scope: fn, signature, definition: true },
    definition: true,
    internal: false,
    id: `PRIVATE_${file}_${fn}_${name}`,
    files: [file],
  };
}
const work = (repairs) => repairs.flatMap((repair) => repair.operations);

test("source failures produce current problem work and only candidate compiler context is public", () => {
  const tree = { "a.cpp": "int a() { return 1; }\n", "b.cpp": "int b() { return 2; }\n" };
  const result = barrierRepairNodes({
    category: "structure",
    tree,
    nodes: [],
    diagnostics: [
      {
        file: "a.cpp",
        selector: "PRIVATE_SIGNATURE",
        tokens: ["PRIVATE_TOKEN"],
        usr: "PRIVATE_USR",
      },
    ],
    compiler: [
      {
        category: "build",
        file: "a.cpp",
        line: 1,
        column: 1,
        severity: "error",
        message: "candidate error",
      },
      { category: "build", file: "b.cpp", severity: "error", message: "other error" },
    ],
  });
  assert.equal(result.length, 2);
  assert.deepEqual(
    result.map((node) => node.operations[0].target.file),
    ["a.cpp", "b.cpp"],
  );
  assert.ok(
    result.every(
      (node) => node.operations[0].action === "inspect" && !Object.hasOwn(node, "original"),
    ),
  );
  assert.deepEqual(
    result.map((node) => node.diagnostics.length),
    [1, 1],
  );
  assert.equal(JSON.stringify(result).includes("PRIVATE_"), false);
});

test("multiple current problems in a file stay together without executor attribution", () => {
  const tree = {
    "a.cpp": "int f(int BeforeA, int BeforeB) { return BeforeA + BeforeB; }\n",
    "b.cpp": "int g(int BeforeC, int BeforeD) { return BeforeC + BeforeD; }\n",
  };
  const cases = [
    ["a.cpp", "f", "BeforeA", "first"],
    ["a.cpp", "f", "BeforeB", "second"],
    ["b.cpp", "g", "BeforeC", "first"],
    ["b.cpp", "g", "BeforeD", "second"],
  ];
  const signature = "int (int, int)";
  const nodes = cases.map(([, fn, from, to], index) =>
    rename(`task-${index}`, fn, from, to, signature),
  );
  const bindings = cases.map(([file, fn, from]) => binding(tree, file, fn, from, signature));
  const repairs = barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    bindings,
    diagnostics: [{ file: "a.cpp" }, { file: "b.cpp" }],
  });
  assert.equal(work(repairs).length, 4);
  const queues = partitionAtomicQueues(repairs, 4).filter((queue) => queue.length);
  assert.equal(queues.length, 2);
  for (const queue of queues)
    assert.equal(new Set(queue.flatMap((item) => item.repairFiles)).size, 1);
  assert.ok(repairs.every((repair) => !Object.hasOwn(repair, "original")));
});

test("a regressed earlier public requirement generates a new current repair", () => {
  const tree = {
    "a.cpp": "int f(int Before) { return Before; }\n",
    "b.cpp": "int g(int after) { return after; }\n",
  };
  const nodes = [
    rename("earlier-a", "f", "Before", "after"),
    rename("current-b", "g", "Before", "after"),
  ];
  const bindings = [binding(tree, "a.cpp", "f", "Before"), binding(tree, "b.cpp", "g", "after")];
  const repairs = barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    bindings,
    diagnostics: [{ file: "a.cpp" }],
  });
  assert.equal(work(repairs).length, 1);
  assert.equal(work(repairs)[0].target.name, "Before");
  assert.equal(work(repairs)[0].required.name, "after");
  assert.ok(repairs.every((repair) => !nodes.some((node) => node.id === repair.id)));
});

test("an already satisfied same-file requirement does not become repair work", () => {
  const tree = {
    "a.cpp": "int f(int after) { return after; }\nint g(int Before) { return Before; }\n",
  };
  const nodes = [
    rename("first-a", "f", "Before", "after"),
    rename("second-a", "g", "Before", "after"),
  ];
  const bindings = [binding(tree, "a.cpp", "f", "after"), binding(tree, "a.cpp", "g", "Before")];
  const repairs = barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    bindings,
    diagnostics: [{ file: "a.cpp" }],
  });
  assert.equal(work(repairs).length, 1);
  assert.equal(work(repairs)[0].target.scope, "g::Before");
  assert.equal(work(repairs)[0].required.name, "after");
});

test("a binding spanning failed files keeps its current repair on one queue", () => {
  const tree = {
    "a.cpp": "int Before(int value) { return value; }\n",
    "b.cpp": "int Before(int);\nint caller() { return Before(1); }\n",
  };
  const nodes = [
    {
      id: "old-function",
      taskId: "task-one",
      dependencies: [],
      prompt: "PUBLIC_OLD_FUNCTION",
      operations: [
        {
          phase: "names",
          category: "functions-types",
          mapping: [{ from: "Before", to: "after" }],
          selectors: [false, true].map((definition) => ({
            kind: "function",
            scope: "Before",
            owner: { scope: "Before", signature: "int (int)", definition },
          })),
        },
      ],
    },
  ];
  const bindings = [
    {
      file: "a.cpp",
      offset: 4,
      line: 1,
      column: 5,
      translationUnit: "a.cpp",
      role: "function",
      name: "Before",
      scope: "Before",
      declaringScope: "",
      owner: { scope: "Before", signature: "int (int)", definition: true },
      definition: true,
      internal: false,
      id: "PRIVATE_FUNCTION",
      files: ["a.cpp", "b.cpp"],
    },
  ];
  const repairs = barrierRepairNodes({
    category: "structure",
    tree,
    nodes,
    bindings,
    diagnostics: [{ file: "a.cpp" }, { file: "b.cpp" }],
  });
  assert.equal(work(repairs).length, 1);
  assert.deepEqual(repairs[0].repairFiles, ["a.cpp", "b.cpp"]);
  assert.equal(partitionAtomicQueues(repairs, 15).filter((queue) => queue.length).length, 1);
  assert.equal(JSON.stringify(repairs).includes("PRIVATE_"), false);
});

test("unlocated and pixel failures produce fresh team problem work", () => {
  for (const category of ["structure", "build", "behavior"]) {
    const repairs = barrierRepairNodes({ category, nodes: [], diagnostics: [] });
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].operations[0].action, "inspect");
    assert.equal(typeof repairs[0].prompt, "string");
    assert.equal(Object.hasOwn(repairs[0], "original"), false);
  }
});

test("compiler feedback preserves source locations and strips commands and external paths", () => {
  const tree = { "a.cpp": "int f() { return missing; }" };
  const result = compilerDiagnostics(
    "/workspace/a.cpp:1:18: error: missing /private/answer\nCommand failed: bwrap /secret/path",
    tree,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].file, "a.cpp");
  assert.equal(result[0].line, 1);
  assert.equal(JSON.stringify(result).includes("/private"), false);
  assert.equal(JSON.stringify(result).includes("/secret"), false);
});
