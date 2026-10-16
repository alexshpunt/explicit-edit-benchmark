import assert from "node:assert/strict";
import test from "node:test";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import {
  prepareAtomicGate,
  evaluateAtomicGate,
  checkAtomicInputs,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-gate.mjs";

const initial = {
  "main.cpp": `#ifndef FIRST_H
#define FIRST_H
namespace frond { struct First { int value; }; }
#endif
#ifndef SECOND_H
#define SECOND_H
namespace frond {
#ifdef FIRST_H
struct Second { int value; };
#else
struct Second { int fallback; };
#endif
}
#endif
#ifdef FIRST_H
int residual(int old) { return old; }
#endif
`,
};
const atoms = [
  { id: "first", action: "header", file: "first.h", guard: "FIRST_H", includes: [] },
  { id: "second", action: "header", file: "second.h", guard: "SECOND_H", includes: ["first.h"] },
];
const structural = (tree, id) =>
  applyCoherentStructure(
    tree,
    atoms.find((atom) => atom.id === id),
  );

// Test-local controller recipe, deliberately using trusted source and public moves.
// Provisional effects choose context; this helper does not grant dependency credit.
function layout(ids) {
  return atoms.filter((atom) => ids.has(atom.id)).reduce(applyCoherentStructure, initial);
}
function structuralGate(id, provisional) {
  const before = layout(new Set([...provisional].filter((peer) => peer !== id)));
  return prepareAtomicGate(before, structural(before, id));
}
function normalize(contract) {
  return {
    ...contract,
    obligations: [...contract.obligations].sort((left, right) => left.id.localeCompare(right.id)),
  };
}
function residualRename(tree) {
  return {
    ...tree,
    "main.cpp": tree["main.cpp"].replace(
      "residual(int old) { return old; }",
      "residual(int value) { return value; }",
    ),
  };
}

await test("independent header extraction changes the peer's macro context without changing its tokens", () => {
  const first = structural(initial, "first");
  const find = (tree) =>
    prepareCoherentContract(tree).obligations.find(
      (record) =>
        record.kind === "owner" &&
        record.selector.includes("Second") &&
        record.tokens.includes("value"),
    );
  const original = find(initial);
  const shifted = find(first);
  assert.deepEqual(shifted.tokens, original.tokens);
  assert.deepEqual(shifted.conditions, original.conditions);
  assert.notEqual(shifted.macros, original.macros);
  const both = structural(first, "second");
  const reverse = structural(structural(initial, "second"), "first");
  assert.deepEqual(
    normalize(prepareCoherentContract(both)),
    normalize(prepareCoherentContract(reverse)),
  );
  const fixed = prepareAtomicGate(initial, first);
  assert.equal(evaluateAtomicGate(first, fixed).status, "pass");
  assert.equal(evaluateAtomicGate(both, fixed).status, "fail");
  assert.ok(
    evaluateAtomicGate(both, fixed).obligations.some(
      (item) => item.status === "fail" && item.file === "main.cpp",
    ),
  );
});

await test("an actively changing peer layout stays pending until trusted context can be rebuilt", () => {
  const first = structural(initial, "first");
  const both = structural(first, "second");
  const stale = prepareAtomicGate(initial, first);
  assert.equal(evaluateAtomicGate(both, stale, { activeWrites: true }).status, "pending");
  assert.equal(
    evaluateAtomicGate(both, structuralGate("first", new Set(["second"]))).status,
    "pass",
  );
});
await test("trusted provisional structural frontiers accept either settling order and already-written peers", () => {
  const both = structural(structural(initial, "first"), "second");
  for (const id of ["first", "second"]) {
    const peer = id === "first" ? "second" : "first";
    const gate = structuralGate(id, new Set([peer]));
    assert.equal(checkAtomicInputs(structural(initial, peer), gate).status, "pass");
    assert.equal(evaluateAtomicGate(both, gate).status, "pass");
    assert.equal(evaluateAtomicGate(both, structuralGate(id, new Set([id, peer]))).status, "pass");
  }
});

await test("provisional peer layout is not proof of peer bodies or dependency readiness", () => {
  const both = structural(structural(initial, "first"), "second");
  const badPeer = { ...both, "second.h": both["second.h"].replace("int value", "int wrong") };
  const settled = new Set(["first", "second"]);
  const verified = new Set();
  assert.equal(evaluateAtomicGate(badPeer, structuralGate("first", settled)).status, "pass");
  verified.add("first");
  assert.equal(evaluateAtomicGate(badPeer, structuralGate("second", settled)).status, "fail");
  assert.equal(
    ["second"].every((id) => verified.has(id)),
    false,
  );
  assert.equal(
    ["first"].every((id) => verified.has(id)),
    true,
  );
  const next = { ...both, "second.h": both["second.h"].replace("int value", "int renamed") };
  const successor = prepareAtomicGate(both, next);
  assert.equal(checkAtomicInputs(badPeer, successor).status, "fail");
});

await test("a malformed peer source is a global observation failure, not evidence against the selected owner", () => {
  const both = structural(structural(initial, "first"), "second");
  const actual = { ...both, "second.h": "namespace frond {" };
  const gate = structuralGate("first", new Set(["second"]));
  assert.equal(evaluateAtomicGate(actual, gate, { activeWrites: true }).status, "pending");
  const drained = evaluateAtomicGate(actual, gate);
  assert.equal(drained.status, "fail");
  assert.ok(drained.obligations.some((item) => item.kind === "source" && item.status === "fail"));
  assert.equal(evaluateAtomicGate(both, gate).status, "pass");
});
await test("rebased frontiers retain macro conditions and inactive-branch preservation checks", () => {
  const both = structural(structural(initial, "first"), "second");
  const gate = structuralGate("second", new Set(["first"]));
  for (const source of [
    both["second.h"].replace("#ifdef FIRST_H", "#ifdef OTHER"),
    both["second.h"].replace("int fallback", "int lost"),
    both["second.h"].replace("#define SECOND_H", "#define SECOND_H 9"),
  ]) {
    const bad = { ...both, "second.h": source };
    assert.equal(evaluateAtomicGate(bad, gate).status, "fail");
    assert.equal(evaluateAtomicGate(bad, gate, { activeWrites: true }).status, "pending");
  }
});

await test("naming an untouched residual owner can coexist with unrelated structural extraction only after context rebase", () => {
  const renamed = residualRename(initial);
  const fixed = prepareAtomicGate(initial, renamed);
  const peer = structural(initial, "first");
  const actual = residualRename(peer);
  assert.equal(evaluateAtomicGate(actual, fixed).status, "fail");
  const rebased = prepareAtomicGate(peer, residualRename(peer));
  assert.equal(checkAtomicInputs(peer, rebased).status, "pass");
  assert.equal(evaluateAtomicGate(actual, rebased).status, "pass");
  assert.equal(
    evaluateAtomicGate(
      { ...actual, "main.cpp": actual["main.cpp"].replace("return value", "return old") },
      rebased,
    ).status,
    "fail",
  );
});

await test("a structural gate must replay settled naming effects too, not reset them to the initial spelling", () => {
  const named = residualRename(initial);
  const actual = structural(named, "first");
  assert.equal(evaluateAtomicGate(actual, structuralGate("first", new Set())).status, "fail");
  const rebased = prepareAtomicGate(named, structural(named, "first"));
  assert.equal(evaluateAtomicGate(actual, rebased).status, "pass");
  assert.equal(
    evaluateAtomicGate(
      { ...actual, "main.cpp": actual["main.cpp"].replace("return value", "return old") },
      rebased,
    ).status,
    "fail",
  );
});
