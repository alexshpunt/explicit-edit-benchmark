import assert from "node:assert/strict";
import test from "node:test";
import { cppTokens } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-tokens.mjs";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";
import {
  prepareAtomicGate,
  evaluateAtomicGate,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-gate.mjs";

const source = `#define BIAS 7
#ifndef COUPLED_H
#define COUPLED_H
#ifdef MODE
int sum(int left,
#else
int sum(double left,
#endif
int right) { const char* text = "left"; return left + right + BIAS; }
#endif
int peer() { return 3; }
`;

function fixture({ copies = false } = {}) {
  const initial = { "main.cpp": source, ...(copies ? { "other.cpp": source } : {}) };
  const bindings = [
    ["A", "left", "longLeft"],
    ["B", "right", "r"],
  ].map(([id, from, to]) => ({
    id,
    plan: {
      edits: cppTokens(source)
        .filter((token) => token.text === from)
        .map((token) => ({
          file: "main.cpp",
          start: token.start,
          old: from,
          new: to,
        })),
    },
  }));
  const batch = prepareAtomicNamingBatch(initial, bindings);
  assert.equal(batch.owners.length, 1);
  assert.equal(batch.owners[0].opaque, true);
  assert.equal(batch.owners[0].kind, "conditional");
  // Trusted origin disambiguation, not a candidate-derived guess.
  if (copies) batch.owners[0].fileHint = "main.cpp";
  const expected = applyAtomicNamingBatch(initial, batch, ["A", "B"]);
  const contract = prepareCoherentContract(expected.tree);
  const owner = expected.owners[0];
  const record = contract.obligations.find(
    (item) =>
      item.kind === owner.kind &&
      item.file === owner.file &&
      JSON.stringify(item.tokens) === JSON.stringify(owner.tokens),
  );
  assert.ok(record);
  assert.equal(Object.hasOwn(record, "selector"), false);
  const projection = (current, physicalOnly = false) => ({
    records: [
      {
        ...record,
        masks: owner.sites.map((site) => ({
          index: site.index,
          from: site.from,
          to: site.to,
          role: !physicalOnly && site.nodeId === current ? "current" : "peer",
        })),
      },
    ],
    familyRecords: contract.obligations,
  });
  return { initial, expected: expected.tree, record, projection };
}

await test("opaque conditional bindings remain independent in real sparse batch output", () => {
  const { expected, projection } = fixture();
  const actual = {
    ...expected,
    "main.cpp": expected["main.cpp"].replace("return longLeft + r", "return longLeft + right"),
  };
  assert.equal(evaluateAtomicBindingGate(actual, projection("A")).status, "pass");
  assert.equal(evaluateAtomicBindingGate(actual, projection("B")).status, "fail");
  assert.equal(evaluateAtomicBindingGate(actual, projection("B"), { input: true }).status, "pass");
  assert.equal(
    evaluateAtomicBindingGate(actual, projection("B", true), { physicalOnly: true }).status,
    "pass",
  );
  assert.equal(
    evaluateAtomicBindingGate(actual, projection("B"), { activeWrites: true }).status,
    "pending",
  );
  const inactiveMissing = {
    ...expected,
    "main.cpp": expected["main.cpp"].replace("double longLeft", "double left"),
  };
  assert.equal(evaluateAtomicBindingGate(inactiveMissing, projection("A")).status, "fail");
  assert.equal(
    evaluateAtomicBindingGate(inactiveMissing, projection("A"), { input: true }).status,
    "pass",
  );
});

await test("opaque binding masks preserve inactive syntax, literals, directives and macro context", () => {
  const { expected, projection } = fixture();
  const gate = projection("A");
  for (const changed of [
    expected["main.cpp"].replace('"left"', '"changed"'),
    expected["main.cpp"].replace("longLeft + r", "longLeft - r"),
    expected["main.cpp"].replace("double longLeft", "float longLeft"),
    expected["main.cpp"].replace("#ifdef MODE", "#ifdef OTHER"),
    expected["main.cpp"].replace("#define BIAS 7", "#define BIAS 9"),
  ]) {
    const actual = { "main.cpp": changed };
    assert.equal(evaluateAtomicBindingGate(actual, gate).status, "unobservable");
    assert.equal(evaluateAtomicBindingGate(actual, gate, { input: true }).status, "unobservable");
    assert.equal(evaluateAtomicBindingGate(actual, gate, { activeWrites: true }).status, "pending");
  }
  for (const changed of [
    { ...gate.records[0], directives: [] },
    { ...gate.records[0], directives: ["MODE"] },
    { ...gate.records[0], directives: [[7]] },
    { ...gate.records[0], selector: "invented" },
  ])
    assert.throws(
      () => evaluateAtomicBindingGate(expected, { ...gate, records: [changed] }),
      /conditional|directive|record/i,
    );
});

await test("complete opaque family references admit legitimate blocks but reject extra corrupted copies", () => {
  const { expected, projection } = fixture({ copies: true });
  const gate = projection("A");
  assert.equal(evaluateAtomicBindingGate(expected, gate).status, "pass");
  assert.equal(
    evaluateAtomicBindingGate(expected, { records: gate.records }).status,
    "unobservable",
  );
  assert.equal(
    evaluateAtomicBindingGate(expected, projection("A", true), { physicalOnly: true }).status,
    "pass",
  );
  for (const copy of [source, source.replace("left + right", "left - right")]) {
    const extra = { ...expected, "duplicate.cpp": copy };
    assert.equal(evaluateAtomicBindingGate(extra, gate).status, "unobservable");
    assert.equal(
      evaluateAtomicBindingGate(extra, projection("A", true), { physicalOnly: true }).status,
      "unobservable",
    );
  }
  assert.equal(
    evaluateAtomicBindingGate({ ...expected, "main.cpp": "" }, gate).status,
    "unobservable",
  );
});

await test("opaque physical-only delegation stays compatible with structural checks", () => {
  const { initial, expected, projection } = fixture();
  const record = projection("A", true).records[0];
  const gate = prepareAtomicGate(initial, expected);
  const partial = {
    ...expected,
    "main.cpp": expected["main.cpp"].replace("return longLeft + r", "return longLeft + right"),
  };
  assert.equal(
    evaluateAtomicGate(partial, gate, {
      bindingRecords: [record],
      familyRecords: projection("A").familyRecords,
    }).status,
    "pass",
  );
  const wrong = {
    ...partial,
    "main.cpp": partial["main.cpp"].replace("longLeft + right", "longLeft - right"),
  };
  assert.notEqual(
    evaluateAtomicGate(wrong, gate, {
      bindingRecords: [record],
      familyRecords: projection("A").familyRecords,
    }).status,
    "pass",
  );
});
