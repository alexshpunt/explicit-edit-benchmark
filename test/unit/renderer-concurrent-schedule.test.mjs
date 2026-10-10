import assert from "node:assert/strict";
import { test } from "node:test";
import {
  advanceContract,
  contractTransition,
  dependencyGraph,
  rotatingSchedule,
} from "../../src/suites/explicit-edit-multi-agent/tasks/concurrent-schedule.mjs";

const contract = (...ids) => ({
  version: "example",
  files: ["main.cpp"],
  obligations: ids.map((id) => ({ id, count: 1 })),
});
const task = (id) => ({
  id,
  phase: "names",
  subsystem: id,
  operations: [{ category: "locals-parameters", selectors: [] }],
});
const tasks = [task("a"), task("b"), task("c")];
const initial = contract("x", "y");
const first = contract("x1", "y");
const second = contract("x1", "y1");
const final = contract("x2", "y1");
const transitions = [
  contractTransition("a", initial, first),
  contractTransition("b", first, second),
  contractTransition("c", second, final),
];

test("module extraction starts in parallel and naming waits for its own module, not the entire layout", () => {
  const nodes = [
    {
      ...task("math"),
      phase: "structure",
      operations: [{ action: "header", file: "math.h", includes: [] }],
    },
    {
      ...task("vendor"),
      phase: "structure",
      operations: [{ action: "vendor-header", file: "vendor.h" }],
    },
    {
      ...task("geometry"),
      phase: "structure",
      operations: [{ action: "header", file: "geometry.h", includes: ["math.h"] }],
    },
    {
      ...task("color"),
      phase: "structure",
      operations: [{ action: "header", file: "color.h", includes: ["math.h"] }],
    },
    { ...task("vendor-names"), subsystem: "vendor.h" },
  ];
  const states = [
    contract("math", "vendor", "geometry", "color"),
    contract("math1", "vendor", "geometry", "color"),
    contract("math1", "vendor1", "geometry", "color"),
    contract("math1", "vendor1", "geometry1", "color"),
    contract("math1", "vendor1", "geometry1", "color1"),
    contract("math1", "vendor2", "geometry1", "color1"),
  ];
  const changes = nodes.map((node, i) => contractTransition(node.id, states[i], states[i + 1]));
  const graph = dependencyGraph(nodes, changes);
  const parallel = rotatingSchedule(graph);
  assert.deepEqual(
    parallel[0].assignments.map((item) => item.task),
    ["math", "vendor"],
  );
  assert.deepEqual(
    parallel[1].assignments.map((item) => item.task),
    ["geometry", "color", "vendor-names"],
  );
  assert.deepEqual(graph.nodes[2].dependencies, ["math"]);
  assert.deepEqual(graph.nodes[4].dependencies, ["vendor"]);
  assert.deepEqual(
    rotatingSchedule(graph, 1).flatMap((round) => round.assignments.map((item) => item.task)),
    nodes.map((node) => node.id),
  );
});

test("moving an enclosing guard does not claim ownership of unchanged neighboring code", () => {
  const a = {
    file: "main.cpp",
    kind: "owner",
    scope: "frond",
    selector: "structA",
    tokens: ["struct", "A", "{", "}", ";"],
    count: 1,
    conditions: [["#", "ifndef", "OUTER"]],
    macros: "old",
    id: "a0",
  };
  const b = { ...a, selector: "structB", tokens: ["struct", "B", "{", "}", ";"], id: "b0" };
  const unwrapped = { ...b, conditions: [], macros: "new", id: "b1" };
  const nodes = [
    { ...task("extract-a"), phase: "structure" },
    { ...task("extract-b"), phase: "structure" },
  ];
  const changes = [
    {
      id: nodes[0].id,
      filesBefore: ["main.cpp"],
      filesAfter: ["a.h", "main.cpp"],
      remove: [a, b],
      add: [{ ...a, file: "a.h", id: "a1" }, unwrapped],
    },
    {
      id: nodes[1].id,
      filesBefore: ["a.h", "main.cpp"],
      filesAfter: ["a.h", "b.h", "main.cpp"],
      remove: [unwrapped],
      add: [{ ...unwrapped, file: "b.h", id: "b2" }],
    },
  ];
  const graph = dependencyGraph(nodes, changes);
  assert.equal(graph.width, 2);
  assert.deepEqual(
    graph.nodes.map((node) => node.dependencies),
    [[], []],
  );
});

test("equal private bodies in separate files are not the same ownership resource", () => {
  const owner = (file, name) => ({
    file,
    kind: "owner",
    scope: "frond",
    selector: `staticint${name}()`,
    tokens: ["static", "int", name, "(", ")", "{", "return", "1", ";", "}"],
    count: 1,
    id: file + name,
  });
  const nodes = [task("left"), task("right")];
  const changes = nodes.map((node, i) => ({
    id: node.id,
    filesBefore: ["left.cpp", "right.cpp"],
    filesAfter: ["left.cpp", "right.cpp"],
    remove: [owner(i ? "right.cpp" : "left.cpp", "old")],
    add: [owner(i ? "right.cpp" : "left.cpp", "helper")],
  }));
  assert.equal(dependencyGraph(nodes, changes).width, 2);
});

function normalized(value) {
  return [...value.obligations].sort((a, b) => a.id.localeCompare(b.id));
}

test("versioned resources allow only independent tasks together and one agent keeps the old route", () => {
  const graph = dependencyGraph(tasks, transitions);
  assert.equal(graph.width, 2);
  assert.deepEqual(
    graph.nodes.map((node) => node.dependencies),
    [[], [], ["a"]],
  );
  const parallel = rotatingSchedule(graph);
  assert.deepEqual(
    parallel.map((round) => round.assignments.map((item) => item.task)),
    [["a", "b"], ["c"]],
  );
  assert.equal(parallel[1].assignments[0].agent, 1);
  assert.deepEqual(
    rotatingSchedule(graph, 1).flatMap((round) => round.assignments.map((item) => item.task)),
    ["a", "b", "c"],
  );
  for (const order of [
    [0, 1, 2],
    [1, 0, 2],
  ]) {
    let current = initial;
    for (const index of order) current = advanceContract(current, transitions[index]);
    assert.deepEqual(normalized(current), normalized(final));
  }
  assert.throws(() => advanceContract(initial, transitions[2]), /Missing input/);
  assert.throws(() => rotatingSchedule(graph, 3), /agent count/);
});

test("the concurrency ceiling is the maximum antichain, not just the largest greedy wave", () => {
  const nodes = ["a", "b", "c", "d", "e"].map(task);
  const states = [
    contract("x", "y"),
    contract("x1", "y"),
    contract("x1", "y1"),
    contract("x1", "y1", "c"),
    contract("x1", "y1", "c", "d"),
    contract("x1", "y1", "c", "d", "e"),
  ];
  const changes = nodes.map((node, index) =>
    contractTransition(node.id, states[index], states[index + 1]),
  );
  nodes[0].operations = [
    { category: "functions-types", selectors: [], mapping: [{ from: "old", to: "new" }] },
  ];
  for (const node of nodes.slice(2)) node.operations[0].selectors = [{ scope: "new" }];
  const graph = dependencyGraph(nodes, changes);
  assert.equal(graph.width, 4);
  assert.deepEqual(
    graph.nodes.slice(2).map((node) => node.dependencies),
    [["a"], ["a"], ["a"]],
  );
  assert.equal(Math.max(...rotatingSchedule(graph).map((round) => round.assignments.length)), 3);
});

test("structural changes and selector renames guard prerequisites without serializing unrelated local owners", () => {
  const nodes = [
    {
      ...task("header"),
      phase: "structure",
      operations: [{ action: "header", file: "types.h", includes: [] }],
    },
    {
      ...task("implementation"),
      phase: "structure",
      operations: [
        {
          action: "implementation",
          file: "types.cpp",
          includes: [{ file: "types.h", quoted: true }],
        },
      ],
    },
    {
      ...task("locals"),
      operations: [{ category: "locals-parameters", selectors: [{ scope: "OldOwner" }] }],
    },
    {
      ...task("type"),
      operations: [
        {
          category: "functions-types",
          mapping: [{ from: "OldOwner", to: "Owner" }],
          selectors: [],
        },
      ],
    },
    {
      ...task("later"),
      operations: [{ category: "locals-parameters", selectors: [{ scope: "Owner" }] }],
    },
  ];
  const states = Array.from({ length: 6 }, (_, index) =>
    contract(...Array.from({ length: index + 1 }, (_, i) => `r${i}`)),
  );
  const changes = nodes.map((node, i) => contractTransition(node.id, states[i], states[i + 1]));
  const graph = dependencyGraph(nodes, changes);
  assert.deepEqual(graph.nodes[1].dependencies, ["header"]);
  assert.ok(graph.nodes[3].dependencies.includes("locals"));
  assert.ok(graph.nodes[4].dependencies.includes("type"));
});
