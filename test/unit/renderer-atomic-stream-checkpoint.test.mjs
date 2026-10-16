import assert from "node:assert/strict";
import test from "node:test";
import { runAtomicStream } from "../../src/suites/explicit-edit-multi-agent/execution/atomic-stream.mjs";
import { createAtomicCheckpoint } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-checkpoint.mjs";
import { prepareAtomicNamingBatch } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";

function setup() {
  const source = "int sum(int a, int b, int c) { return a + b + c; }\n";
  const initial = { "main.cpp": source };
  const names = [
    ["a", "left"],
    ["b", "right"],
    ["c", "last"],
  ];
  const nodes = names.map(([id, to]) => ({
    id,
    to,
    taskId: "names",
    dependencies: id === "c" ? ["a"] : [],
    operations: [{ phase: "names" }],
  }));
  const batch = prepareAtomicNamingBatch(
    initial,
    names.map(([id, to]) => ({
      id,
      plan: {
        edits: [...source.matchAll(new RegExp(`\\b${id}\\b`, "g"))].map((match) => ({
          file: "main.cpp",
          start: match.index,
          old: id,
          new: to,
        })),
      },
    })),
  );
  return {
    initial,
    nodes,
    checkpoint: createAtomicCheckpoint(initial, nodes, [{ taskId: "names", batch }]),
  };
}
const decision = (result) =>
  result.status === "pass" ? true : result.status === "pending" ? "pending" : false;
function gates(checkpoint, read) {
  return {
    checkInputs: async (node, signal, context) => {
      for (const predecessor of node.dependencies) {
        const checked = await checkpoint.observe(read, predecessor, context, { signal });
        if (checked.status !== "pass") return decision(checked);
      }
      return decision(await checkpoint.observe(read, node.id, context, { input: true, signal }));
    },
    verify: async (node, signal, _receipt, context) =>
      decision(await checkpoint.observe(read, node.id, context, { signal })),
  };
}

await test("clearing checkpoint caches preserves retained completions and fresh regression checks", () => {
  const { checkpoint } = setup();
  const completed = new Set(["a", "b", "c"]);
  const tree = checkpoint.expected(completed).tree;
  assert.equal(checkpoint.check(tree, "a", { completed }).status, "pass");
  checkpoint.clearCaches();
  checkpoint.clearCaches();
  assert.equal(checkpoint.check(tree, "a", { completed }).status, "pass");
  const corrupt = {
    "main.cpp": tree["main.cpp"].replace("left + right", "left - right"),
  };
  assert.notEqual(checkpoint.check(corrupt, "a", { completed }).status, "pass");
  assert.equal(checkpoint.revalidate(tree, { completed }).completed.size, 3);
});

await test("a 15-participant pool streams independent same-owner edits and verifies before dependent dispatch", async () => {
  const { initial, nodes, checkpoint } = setup();
  let tree = initial;
  const deliveries = [];
  const result = await runAtomicStream(nodes, {
    agents: 15,
    ...gates(checkpoint, async () => ({ ...tree })),
    execute: async (node, agent) => {
      deliveries.push([node.id, agent]);
      if (node.id === "c") assert.ok(tree["main.cpp"].includes("return left"));
      tree = {
        "main.cpp": tree["main.cpp"].replaceAll(new RegExp(`\\b${node.id}\\b`, "g"), node.to),
      };
    },
  });
  assert.equal(result.status, "pass");
  assert.deepEqual([...result.completed].sort(), ["a", "b", "c"]);
  assert.equal(new Set(deliveries.map(([, agent]) => agent)).size, 3);
  assert.deepEqual(tree, checkpoint.expected(new Set(["a", "b", "c"])).tree);
});

await test("frontier changes during deferred checks do not reject a correct multi-wave stream", async () => {
  const count = 32;
  const names = Array.from({ length: count }, (_, index) => `p${index}`);
  const source = `int sum(${names.map((name) => `int ${name}`).join(", ")}) { return ${names.join(" + ")}; }\n`;
  const initial = { "main.cpp": source };
  const nodes = names.map((id, index) => ({
    id,
    to: `value${index}`,
    taskId: "names",
    dependencies: [],
    operations: [{ phase: "names" }],
  }));
  const batch = prepareAtomicNamingBatch(
    initial,
    nodes.map((node) => ({
      id: node.id,
      plan: {
        edits: [...source.matchAll(new RegExp(`\\b${node.id}\\b`, "g"))].map((match) => ({
          file: "main.cpp",
          start: match.index,
          old: node.id,
          new: node.to,
        })),
      },
    })),
  );
  const checkpoint = createAtomicCheckpoint(initial, nodes, [{ taskId: "names", batch }]);
  let tree = initial;
  const calls = [];
  const result = await runAtomicStream(nodes, {
    agents: 15,
    ...gates(checkpoint, async () => ({ ...tree })),
    execute: async (node) => {
      calls.push(node.id);
      tree = {
        "main.cpp": tree["main.cpp"].replaceAll(new RegExp(`\\b${node.id}\\b`, "g"), node.to),
      };
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.completed.size, count);
  assert.equal(calls.length, count, "Deferred grading must not redeliver edits");
  assert.equal(new Set(calls).size, count);
  assert.deepEqual(tree, checkpoint.expected(new Set(names)).tree);
});
await test("a new correction stream retains a move while its partial naming descendant waits for repair", async () => {
  const initial = {
    "main.cpp":
      "#ifndef A_H\n#define A_H\nstruct A { int old; int read() const { return old; } };\n#endif\n",
  };
  const move = {
    id: "move",
    taskId: "structure",
    dependencies: [],
    operations: [{ action: "header", file: "A.h", guard: "A_H", includes: [] }],
  };
  const moved = applyCoherentStructure(initial, move.operations[0]);
  const rename = {
    id: "rename",
    taskId: "names",
    dependencies: ["move"],
    operations: [{ phase: "names" }],
  };
  const nodes = [move, rename];
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
  const checkpoint = createAtomicCheckpoint(initial, nodes, [{ taskId: "names", batch }]);
  let tree = initial;
  const calls = [];
  const read = async () => ({ ...tree });
  const first = await runAtomicStream(nodes, {
    agents: 15,
    ...gates(checkpoint, read),
    execute: async (node) => {
      calls.push(node.id);
      tree =
        node.id === "move"
          ? applyCoherentStructure(tree, node.operations[0])
          : { ...tree, "A.h": tree["A.h"].replace("int old", "int value") };
    },
  });
  assert.equal(first.status, "blocked");
  assert.deepEqual([...first.completed], ["move"]);
  const repaired = await runAtomicStream(nodes, {
    agents: 15,
    completed: first.completed,
    started: first.started,
    ...gates(checkpoint, read),
    execute: async (node) => {
      calls.push(node.id);
      tree = { ...tree, "A.h": tree["A.h"].replaceAll(/\bold\b/g, "value") };
    },
  });
  assert.equal(repaired.status, "pass");
  assert.deepEqual(calls, ["move", "rename", "rename"]);
});
await test("repair revalidation removes a regressed prerequisite and its descendants but retains an independent correct peer", () => {
  const { nodes, checkpoint } = setup();
  const ids = new Set(nodes.map((node) => node.id));
  const expected = checkpoint.expected(ids).tree;
  const tree = { "main.cpp": expected["main.cpp"].replace("return left", "return a") };
  const retained = checkpoint.revalidate(tree, { completed: ids, started: ids, settled: ids });
  assert.deepEqual([...retained.completed], ["b"]);
  assert.ok(retained.invalidated.some((entry) => entry.id === "a" && entry.status === "fail"));
  assert.ok(
    retained.invalidated.some((entry) => entry.id === "c" && entry.reason === "prerequisite"),
  );
  assert.deepEqual([...ids], ["a", "b", "c"]);
});
await test("a failed binding drains peers, retains verified work and receives exactly one later repair delivery", async () => {
  const { initial, nodes, checkpoint } = setup();
  let tree = initial;
  const read = async () => ({ ...tree });
  const calls = [];
  const first = await runAtomicStream(nodes, {
    agents: 15,
    ...gates(checkpoint, read),
    execute: async (node) => {
      calls.push(node.id);
      tree = {
        "main.cpp":
          node.id === "b"
            ? tree["main.cpp"].replace("int b", "int right")
            : tree["main.cpp"].replaceAll(new RegExp(`\\b${node.id}\\b`, "g"), node.to),
      };
    },
  });
  assert.equal(first.status, "blocked");
  assert.ok(first.completed.has("a"));
  assert.ok(!first.completed.has("b"));
  assert.equal(calls.filter((id) => id === "b").length, 1);
  const repaired = await runAtomicStream(nodes, {
    agents: 15,
    completed: first.completed,
    started: first.started,
    rotation: first.rotation,
    ...gates(checkpoint, read),
    execute: async (node) => {
      calls.push(node.id);
      tree = {
        "main.cpp": tree["main.cpp"].replaceAll(new RegExp(`\\b${node.id}\\b`, "g"), node.to),
      };
    },
  });
  assert.equal(repaired.status, "pass");
  assert.equal(calls.filter((id) => id === "a").length, 1);
  assert.equal(calls.filter((id) => id === "b").length, 2);
});
