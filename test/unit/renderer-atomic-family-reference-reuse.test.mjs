import assert from "node:assert/strict";
import test from "node:test";
import { createAtomicInventory } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-inventory.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";

const tree = { "main.cpp": "int sum(int left) { return left + 7; }\n" };
const owner = prepareCoherentContract(tree).obligations.find((record) => record.kind === "owner");
const projection = () => ({
  ...structuredClone(owner),
  masks: owner.tokens.flatMap((token, index) =>
    token === "left" ? [{ index, from: "a", to: "left", role: "current" }] : [],
  ),
});

await test("immutable family references never cache candidate acceptance or family counts", () => {
  const readInventory = createAtomicInventory();
  const familyRecords = readInventory(tree).obligations;
  const gate = { records: [projection()], familyRecords };
  assert.equal(evaluateAtomicBindingGate(tree, gate, { readInventory }).status, "pass");
  assert.equal(evaluateAtomicBindingGate(tree, gate, { readInventory }).status, "pass");
  assert.equal(
    evaluateAtomicBindingGate({ "main.cpp": tree["main.cpp"].replace("7", "8") }, gate, {
      readInventory,
    }).status,
    "unobservable",
  );
  assert.equal(
    evaluateAtomicBindingGate({ ...tree, "extra.cpp": tree["main.cpp"] }, gate, { readInventory })
      .status,
    "unobservable",
  );
  assert.equal(evaluateAtomicBindingGate(tree, gate, { readInventory }).status, "pass");
});

await test("freezing a family array does not make mutable records safe to reuse", () => {
  const reference = structuredClone(owner);
  const gate = { records: [projection()], familyRecords: Object.freeze([reference]) };
  assert.equal(evaluateAtomicBindingGate(tree, gate).status, "pass");
  reference.count = 0;
  assert.throws(() => evaluateAtomicBindingGate(tree, gate), /family reference count/);
});

await test("frozen caller getters cannot acquire immutable inventory provenance", () => {
  let count = owner.count;
  const reference = Object.freeze({
    ...structuredClone(owner),
    tokens: Object.freeze([...owner.tokens]),
    get count() {
      return count;
    },
  });
  const gate = { records: [projection()], familyRecords: Object.freeze([reference]) };
  assert.equal(evaluateAtomicBindingGate(tree, gate).status, "pass");
  count = 0;
  assert.throws(() => evaluateAtomicBindingGate(tree, gate), /family reference count/);
});

await test("frozen family records with mutable token arrays are revalidated", () => {
  const reference = Object.freeze(structuredClone(owner));
  const gate = { records: [projection()], familyRecords: Object.freeze([reference]) };
  assert.equal(evaluateAtomicBindingGate(tree, gate).status, "pass");
  reference.tokens[0] = 17;
  assert.throws(() => evaluateAtomicBindingGate(tree, gate), /family reference declarator/);
});
