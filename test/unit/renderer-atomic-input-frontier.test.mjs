import assert from "node:assert/strict";
import test from "node:test";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";
import {
  atomicFileTokens,
  atomicFileDirectives,
  atomicFileOwners,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";

const tree = (name = "original") => ({
  "main.cpp": `int evaluate(int ${name}) { return ${name} + 7; }\n`,
});

test("input masks use a trusted unrenamed frontier without materializing the current output", () => {
  const expected = tree();
  const familyRecords = prepareCoherentContract(expected).obligations;
  const record = familyRecords.find((item) => item.kind === "owner");
  const masks = record.tokens.flatMap((token, index) =>
    token === "original" ? [{ index, from: "original", to: "restored", role: "current" }] : [],
  );
  const projection = { records: [{ ...record, masks }], familyRecords };
  for (const name of ["original", "restored", "mistaken"])
    assert.equal(evaluateAtomicBindingGate(tree(name), projection, { input: true }).status, "pass");
  assert.equal(
    evaluateAtomicBindingGate(
      { "main.cpp": tree()["main.cpp"].replace("+ 7", "+ 8") },
      projection,
      { input: true },
    ).status,
    "unobservable",
  );
  assert.throws(() => evaluateAtomicBindingGate(tree(), projection), /trusted expected token/);
});

test("per-occurrence input masks retain exact copy ownership on an unrenamed frontier", () => {
  const expected = { "main.cpp": "void evaluate(int original);\nvoid evaluate(int original);\n" };
  const familyRecords = prepareCoherentContract(expected).obligations;
  const record = familyRecords.find((item) => item.kind === "owner");
  const tokens = atomicFileTokens(expected["main.cpp"]);
  const owners = atomicFileOwners(expected);
  const index = record.tokens.indexOf("original");
  const mask = { index, from: "original", to: "restored", role: "current" };
  const records = [
    {
      ...record,
      masks: [{ ...mask, role: "peer" }],
      occurrences: owners.map(({ tokenStart }) => ({ tokenStart, masks: [mask] })),
    },
  ];
  const projection = {
    records,
    familyRecords,
    occurrenceFiles: [
      {
        file: "main.cpp",
        tokens,
        directives: atomicFileDirectives(expected["main.cpp"]),
        slots: owners.map(({ tokenStart }) => tokenStart + index),
      },
    ],
  };
  const actual = { "main.cpp": expected["main.cpp"].replace("int original", "int mistaken") };
  assert.equal(evaluateAtomicBindingGate(actual, projection, { input: true }).status, "pass");
  assert.throws(() => evaluateAtomicBindingGate(actual, projection), /trusted expected token/);
  assert.equal(
    evaluateAtomicBindingGate(
      { "main.cpp": actual["main.cpp"] + "void evaluate(int original);\n" },
      projection,
      { input: true },
    ).status,
    "unobservable",
  );
});
