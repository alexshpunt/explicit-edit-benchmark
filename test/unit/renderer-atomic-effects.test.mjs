import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atomicEffectGraph,
  atomicOrder,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-effects.mjs";
import { prepareAtomicGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-gate.mjs";

const node = (id, dependencies = []) => ({ id, taskId: "task-001", dependencies });
const gate = (before, after) => prepareAtomicGate({ "main.cpp": before }, { "main.cpp": after });
const bindingNode = (id) => ({ ...node(id), operations: [{ phase: "names" }] });
const bindingPlan = (source, from, to) => ({
  edits: [...source.matchAll(new RegExp(`\\b${from}\\b`, "g"))].map((match) => ({
    file: "main.cpp",
    start: match.index,
    old: from,
    new: to,
  })),
});

test("disjoint compiler bindings in the same owner do not gain artificial dependencies", () => {
  const first = "int sum(int a, int b) { return a + b; }\n";
  const second = "int sum(int left, int b) { return left + b; }\n";
  const final = "int sum(int left, int right) { return left + right; }\n";
  const nodes = [bindingNode("a"), bindingNode("b")];
  const original = structuredClone(nodes);
  const graph = atomicEffectGraph(nodes, [
    { id: "a", gate: gate(first, second), plan: bindingPlan(first, "a", "left") },
    { id: "b", gate: gate(second, final), plan: bindingPlan(first, "b", "right") },
  ]);
  assert.deepEqual(graph.nodes[1].dependencies, []);
  assert.deepEqual(nodes, original);
});

test("different owner effects in one file remain concurrently ready", () => {
  const first = "int left(int a) { return a; }\nint right(int b) { return b; }\n";
  const second = first.replaceAll(" a", " value").replace("return a", "return value");
  const final = second.replaceAll(" b", " other").replace("return b", "return other");
  const graph = atomicEffectGraph(
    [node("a"), node("b")],
    [
      { id: "a", gate: gate(first, second) },
      { id: "b", gate: gate(second, final) },
    ],
  );
  assert.deepEqual(
    graph.nodes.map((item) => item.dependencies),
    [[], []],
  );
});

test("a cross-owner binding and a disjoint parameter remain independent", () => {
  const first = "int helper(int a) { return a; }\nint run(int x) { return helper(x); }\n";
  const second = first.replaceAll("helper", "identity");
  const final = second.replaceAll("int x", "int value").replace("identity(x)", "identity(value)");
  const graph = atomicEffectGraph(
    [bindingNode("rename"), bindingNode("parameter")],
    [
      { id: "rename", gate: gate(first, second), plan: bindingPlan(first, "helper", "identity") },
      { id: "parameter", gate: gate(second, final), plan: bindingPlan(first, "x", "value") },
    ],
  );
  assert.deepEqual(graph.nodes[1].dependencies, []);
});

test("overlapping physical binding plans cannot masquerade as separate atoms", () => {
  const source = "int a;\n";
  const effect = gate(source, "int value;\n");
  const plan = bindingPlan(source, "a", "value");
  assert.throws(
    () =>
      atomicEffectGraph(
        [bindingNode("a"), bindingNode("b")],
        [
          { id: "a", gate: effect, plan },
          { id: "b", gate: effect, plan },
        ],
      ),
    /overlap|same binding/i,
  );
  assert.throws(() => atomicEffectGraph([bindingNode("a")], [{ id: "a", gate: effect }]), /plan/i);
});
test("context-only guard changes do not turn unrelated header moves into a chain", () => {
  const main =
    "#ifndef FIRST\n#define FIRST\nint first;\n#endif\n#ifndef SECOND\n#define SECOND\nint second;\n#endif\n";
  const initial = { "main.cpp": main };
  const afterFirst = {
    "main.cpp": '#include "first.h"\n#ifndef SECOND\n#define SECOND\nint second;\n#endif\n',
    "first.h": "#ifndef FIRST\n#define FIRST\nint first;\n#endif\n",
  };
  const afterSecond = {
    "main.cpp": '#include "first.h"\n#include "second.h"\n',
    "first.h": afterFirst["first.h"],
    "second.h": "#ifndef SECOND\n#define SECOND\nint second;\n#endif\n",
  };
  const graph = atomicEffectGraph(
    [node("a"), node("b")],
    [
      { id: "a", gate: prepareAtomicGate(initial, afterFirst) },
      { id: "b", gate: prepareAtomicGate(afterFirst, afterSecond) },
    ],
  );
  assert.deepEqual(
    graph.nodes.map((item) => item.dependencies),
    [[], []],
  );
});

test("preparation follows selector dependencies before sealing owner effects", () => {
  const nodes = [node("rename", ["consumer"]), node("consumer")];
  assert.deepEqual(
    atomicOrder(nodes).map((item) => item.id),
    ["consumer", "rename"],
  );
  assert.throws(() => atomicOrder([node("a", ["b"]), node("b", ["a"])]), /cyclic/i);
  assert.throws(() => atomicOrder([node("a", ["missing"])]), /prerequisite/i);
});

test("missing, repeated and out-of-order private effects fail closed", () => {
  const a = gate("int a;\n", "int b;\n");
  assert.throws(() => atomicEffectGraph([node("a")], []), /effect/i);
  assert.throws(
    () =>
      atomicEffectGraph(
        [node("a")],
        [
          { id: "a", gate: a },
          { id: "a", gate: a },
        ],
      ),
    /effect/i,
  );
  assert.throws(
    () =>
      atomicEffectGraph(
        [node("a"), node("b", ["a"])],
        [
          { id: "b", gate: a },
          { id: "a", gate: a },
        ],
      ),
    /order|prerequisite/i,
  );
});
