import assert from "node:assert/strict";
import test from "node:test";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import {
  atomicFileTokens,
  atomicFileDirectives,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-frontier.mjs";
import { evaluateAtomicBindingGate } from "../../src/suites/explicit-edit-multi-agent/grading/atomic-binding-gate.mjs";

const declaration = (name = "value") => `int evaluate(int ${name});`;
const tree = (first = "value", second = "value") => ({
  "shape.h": `namespace frond {\n${declaration(first)}\nint marker() { return 7; }\n${declaration(second)}\n}\n`,
});
const tokensEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function projection(expected = tree()) {
  const familyRecords = prepareCoherentContract(expected).obligations;
  const record = familyRecords.find((item) => item.kind === "owner" && item.count === 2);
  const tokens = atomicFileTokens(expected[record.file]);
  const starts = tokens.flatMap((_, index) =>
    tokensEqual(tokens.slice(index, index + record.tokens.length), record.tokens) ? [index] : [],
  );
  const index = record.tokens.indexOf("value");
  const occurrences = starts.map((tokenStart, copy) => ({
    tokenStart,
    masks: [
      {
        index,
        from: copy ? "second_scrambled" : "first_scrambled",
        to: "value",
        role: copy ? "peer" : "current",
      },
    ],
  }));
  return {
    records: [{ ...record, masks: [{ ...occurrences[0].masks[0], role: "peer" }], occurrences }],
    familyRecords,
    occurrenceFiles: [
      {
        file: record.file,
        tokens,
        slots: starts.map((start) => start + index),
        directives: atomicFileDirectives(expected[record.file]),
      },
    ],
  };
}

function splitProjection(expected = tree("value", "second_scrambled")) {
  const familyRecords = prepareCoherentContract(expected).obligations;
  const tokens = atomicFileTokens(expected["shape.h"]);
  const slots = [];
  const records = familyRecords
    .filter((record) => record.kind === "owner" && record.tokens.includes("evaluate"))
    .map((record) => {
      const tokenStart = tokens.findIndex((_, start) =>
        tokensEqual(tokens.slice(start, start + record.tokens.length), record.tokens),
      );
      const index = record.tokens.indexOf("int", 1) + 1;
      const mask = {
        index,
        from: record.tokens[index] === "value" ? "first_scrambled" : "second_scrambled",
        to: "value",
        role: record.tokens[index] === "value" ? "current" : "peer",
      };
      slots.push(tokenStart + index);
      return {
        ...record,
        masks: [{ ...mask, role: "peer" }],
        occurrences: [{ tokenStart, masks: [mask] }],
      };
    });
  return {
    records,
    familyRecords,
    occurrenceFiles: [
      { file: "shape.h", tokens, slots, directives: atomicFileDirectives(expected["shape.h"]) },
    ],
  };
}
const check = (actual, prepared = projection(), options) =>
  evaluateAtomicBindingGate(actual, prepared, options);

test("distinct expected records may claim different physical copies of one actual aggregate", () => {
  const prepared = splitProjection();
  assert.equal(prepared.records.length, 2);
  assert.ok(prepared.records.every((record) => record.count === 1));
  for (const actual of [tree(), tree("value", "wrong_peer"), tree("value", "second_scrambled")]) {
    const result = check(actual, prepared);
    assert.equal(result.status, "pass");
    assert.ok(result.records.every((record) => record.status === "pass"));
    assert.equal(result.observedIds.length, actual["shape.h"] === tree()["shape.h"] ? 1 : 2);
  }
  const wrongCopy = check(tree("wrong_current", "value"), prepared);
  assert.equal(wrongCopy.status, "fail");
  assert.equal(
    wrongCopy.records.find((record) => record.id === prepared.records[0].id).status,
    "fail",
  );
  const incomplete = { ...prepared, records: [prepared.records[0]] };
  const incompleteResult = check(tree(), incomplete);
  assert.equal(incompleteResult.status, "unobservable");
  assert.deepEqual(incompleteResult.observedIds, []);
});

test("whole-aggregate reservations cannot overlap physical occurrence claims", () => {
  const prepared = splitProjection();
  const aggregate = { ...prepared.records[1] };
  delete aggregate.occurrences;
  const records = [prepared.records[0], aggregate];
  for (const order of [records, [...records].reverse()]) {
    const result = check(tree(), { ...prepared, records: order });
    assert.equal(result.status, "unobservable");
    assert.ok(result.records.every((record) => record.reason === "ambiguous-owner"));
    assert.equal(result.observedIds.length, 1);
  }
});

test("split occurrence families still reject missing, extra and duplicate physical claims", () => {
  const prepared = splitProjection();
  const complete = tree()["shape.h"];
  for (const source of [
    complete.replace(declaration(), ""),
    complete.replace(declaration(), declaration() + declaration()),
    complete.replace("int marker() { return 7; }", ""),
  ]) {
    const result = check({ "shape.h": source }, prepared);
    assert.equal(result.status, "unobservable");
    assert.deepEqual(result.observedIds, []);
  }
  const duplicate = structuredClone(prepared.records[0]);
  duplicate.id = "controller-invalid-duplicate-projection";
  const result = check(tree("value", "second_scrambled"), {
    ...prepared,
    records: [prepared.records[0], duplicate],
    familyRecords: [
      ...prepared.familyRecords,
      { ...duplicate, masks: undefined, occurrences: undefined },
    ],
  });
  assert.equal(result.status, "unobservable");
  assert.ok(result.records.every((record) => record.reason === "ambiguous-owner"));
  assert.deepEqual(result.observedIds, []);
});
test("convergent copies retain distinct current and peer masks at trusted token occurrences", () => {
  const prepared = projection();
  assert.equal(prepared.records[0].count, 2);
  assert.equal(check(tree("value", "wrong_peer"), prepared).status, "pass");
  assert.equal(check(tree("wrong_current", "value"), prepared).status, "fail");
  assert.equal(check(tree(), prepared).status, "pass");
  assert.equal(check(tree("first_scrambled", "second_scrambled"), prepared).status, "fail");
  const other = structuredClone(prepared);
  for (const [index, copy] of other.records[0].occurrences.entries())
    copy.masks[0].role = index ? "current" : "peer";
  assert.equal(check(tree("value", "wrong_peer"), other).status, "fail");
  assert.equal(check(tree("wrong_current", "value"), other).status, "pass");
});

test("repair input, physical-only and active-writer decisions preserve per-occurrence meaning", () => {
  const actual = tree("wrong_current", "wrong_peer");
  assert.equal(check(actual, undefined, { input: true }).status, "pass");
  assert.equal(check(actual, undefined, { activeWrites: true }).status, "pending");
  const physical = projection();
  for (const copy of physical.records[0].occurrences) copy.masks[0].role = "peer";
  assert.equal(check(actual, physical, { physicalOnly: true }).status, "pass");
  assert.throws(() => check(actual, physical), /current masks/);
});

test("occurrence witnesses ignore whitespace but reject lost copies and protected order or syntax changes", () => {
  const prepared = projection();
  const actual = tree("value", "wrong_peer");
  assert.equal(
    check({ "shape.h": "\n\n" + actual["shape.h"].replaceAll(";", ";\n\n") }, prepared).status,
    "pass",
  );
  const declarationText = declaration("wrong_peer");
  for (const text of [
    actual["shape.h"].replace(declarationText, ""),
    actual["shape.h"].replace(declarationText, declarationText + declarationText),
    actual["shape.h"].replace("return 7", "return 8"),
    actual["shape.h"].replace(declaration("value"), "int evaluate(double value);"),
    actual["shape.h"]
      .replace("int marker() { return 7; }", "")
      .replace("namespace frond {", "namespace frond { int marker() { return 7; }"),
  ]) {
    assert.equal(check({ "shape.h": text }, prepared).status, "unobservable");
    assert.equal(check({ "shape.h": text }, prepared, { activeWrites: true }).status, "pending");
  }
});

test("occurrence witnesses preserve preprocessing-sensitive directive whitespace", () => {
  const expected = { "shape.h": "#define F(x) x\n" + tree()["shape.h"] };
  const prepared = projection(expected);
  const actual = { "shape.h": expected["shape.h"].replace("#define F(x)", "#define F (x)") };
  assert.deepEqual(atomicFileTokens(actual["shape.h"]), atomicFileTokens(expected["shape.h"]));
  assert.equal(check(expected, prepared).status, "pass");
  assert.equal(check(actual, prepared).status, "unobservable");
  assert.equal(check(actual, prepared, { activeWrites: true }).status, "pending");
});

test("occurrence metadata cannot invent a copy, mask, token coordinate or expected file", () => {
  const mutations = [
    (value) => {
      value.records[0].occurrences.pop();
    },
    (value) => {
      value.records[0].occurrences[1].tokenStart = value.records[0].occurrences[0].tokenStart;
    },
    (value) => {
      value.records[0].occurrences[0].tokenStart = -1;
    },
    (value) => {
      value.records[0].occurrences[0].tokenStart = 10000;
    },
    (value) => {
      value.records[0].occurrences[0].masks[0].index = 0;
    },
    (value) => {
      value.records[0].occurrences[0].masks.push({ ...value.records[0].occurrences[0].masks[0] });
    },
    (value) => {
      value.occurrenceFiles[0].slots.pop();
    },
    (value) => {
      value.occurrenceFiles[0].slots.push(value.occurrenceFiles[0].slots[0]);
    },
    (value) => {
      value.occurrenceFiles[0].tokens[value.records[0].occurrences[0].tokenStart] = "different";
    },
    (value) => {
      value.occurrenceFiles[0].file = "missing.h";
    },
    (value) => {
      value.records[0].masks = [];
    },
    (value) => {
      delete value.occurrenceFiles;
    },
    (value) => {
      delete value.occurrenceFiles[0].directives;
    },
    (value) => {
      value.occurrenceFiles[0].directives = [7];
    },
  ];
  for (const mutate of mutations) {
    const prepared = projection();
    mutate(prepared);
    assert.throws(() => check(tree(), prepared));
  }
});

test("occurrence gates retain complete unrelated family multiplicity", () => {
  const expected = { ...tree(), "other.h": "namespace frond { int evaluate(int untouched); }" };
  const prepared = projection(expected);
  const actual = { ...tree("value", "wrong_peer"), "other.h": expected["other.h"] };
  assert.equal(check(actual, prepared).status, "pass");
  assert.equal(check({ ...actual, "other.h": "" }, prepared).status, "unobservable");
  assert.equal(check(actual, { ...prepared, familyRecords: undefined }).status, "unobservable");
});

test("complete physical coverage attributes collapsed aggregate variants without hiding failed current copies", () => {
  const first = "int evaluate(int value, int fixed);";
  const second = "int evaluate(int original, int peer);";
  const expected = { "shape.h": `namespace frond { ${first}\n${first}\n${second}\n${second}\n }` };
  const familyRecords = prepareCoherentContract(expected).obligations;
  const tokens = atomicFileTokens(expected["shape.h"]);
  const starts = [];
  const records = familyRecords
    .filter((item) => item.kind === "owner")
    .map((record) => {
      const tokenStarts = tokens.flatMap((_, index) =>
        tokensEqual(tokens.slice(index, index + record.tokens.length), record.tokens)
          ? [index]
          : [],
      );
      const masks = record.tokens.flatMap((token, index) =>
        ["value", "original", "fixed", "peer"].includes(token)
          ? [
              {
                index,
                from: "scrambled_" + index,
                to: token,
                role: token === "value" || token === "original" ? "current" : "peer",
              },
            ]
          : [],
      );
      starts.push(...tokenStarts.flatMap((start) => masks.map((mask) => start + mask.index)));
      return {
        ...record,
        masks: masks.map((mask) => ({ ...mask, role: "peer" })),
        occurrences: tokenStarts.map((tokenStart) => ({ tokenStart, masks })),
      };
    });
  const prepared = {
    records,
    familyRecords,
    occurrenceFiles: [
      {
        file: "shape.h",
        tokens,
        slots: starts,
        directives: atomicFileDirectives(expected["shape.h"]),
      },
    ],
  };
  const actual = {
    "shape.h": expected["shape.h"]
      .replaceAll(first, "int evaluate(int original, int fixed);")
      .replaceAll(second, "int evaluate(int original, int fixed);"),
  };
  for (const order of [records, [...records].reverse()]) {
    const result = check(actual, { ...prepared, records: order });
    assert.equal(result.status, "fail");
    assert.equal(result.records.find((item) => item.id === records[0].id).status, "fail");
    assert.equal(result.records.find((item) => item.id === records[1].id).status, "pass");
    assert.equal(result.observedIds.length, 1);
  }
});
