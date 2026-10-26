import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareAtomicEffect } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-structural-effects.mjs";
import { prepareCoherentContract } from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";
import { prepareAtomicRoundFootprints } from "../../src/suites/explicit-edit-multi-agent/grading/round-footprints.mjs";

const first = "int first() { return 1; }\n";
const second = "int second() { return 2; }\n";
const tree = { "main.cpp": first + second };
const step = (id, before, after) => ({
  id,
  effect: prepareAtomicEffect(before, after),
  filesBefore: Object.keys(before).sort(),
  filesAfter: Object.keys(after).sort(),
});
const atom = (prepared, id) => prepared.atoms.find((item) => item.id === id);
const owned = (prepared, id, role = "physical") =>
  atom(prepared, id)
    .records.filter((item) => item.role === role)
    .map((item) => item.record);
const has = (record, name) => record.kind === "owner" && record.tokens.includes(name);

test("independent structural moves retain separate endpoint owner requirements", () => {
  const one = { "main.cpp": second, "a.cpp": first };
  const final = { "main.cpp": "", "a.cpp": first, "b.cpp": second };
  const result = prepareAtomicRoundFootprints(
    tree,
    [step("a", tree, one), step("b", one, final)],
    final,
  );
  assert.deepEqual(
    result.atoms.map(({ id }) => id),
    ["a", "b"],
  );
  assert.deepEqual(
    owned(result, "a")
      .filter((record) => has(record, "first"))
      .map(({ file }) => file),
    ["a.cpp"],
  );
  assert.deepEqual(
    owned(result, "b")
      .filter((record) => has(record, "second"))
      .map(({ file }) => file),
    ["b.cpp"],
  );
  assert.ok(!owned(result, "a").some((record) => has(record, "second")));
  assert.ok(
    atom(result, "a").counts.some(
      ({ record, count }) => record.file === "main.cpp" && has(record, "first") && count === 0,
    ),
  );
});

test("a later trusted move projects earlier atom ownership to the final destination", () => {
  const before = { "a.cpp": first };
  const middle = { "b.cpp": first };
  const final = { "c.cpp": first };
  const result = prepareAtomicRoundFootprints(
    before,
    [step("first", before, middle), step("later", middle, final)],
    final,
  );
  for (const id of ["first", "later"]) {
    assert.deepEqual(
      owned(result, id)
        .filter((record) => has(record, "first"))
        .map(({ file }) => file),
      ["c.cpp"],
    );
    assert.ok(!atom(result, id).records.some(({ record }) => record.file === "b.cpp"));
  }
});

test("context changes do not become physical ownership of untouched declarations", () => {
  const before = { "main.cpp": "#define VALUE 1\nint first() { return VALUE; }\n" };
  const final = { "main.cpp": "#define VALUE 2\nint first() { return VALUE; }\n" };
  const result = prepareAtomicRoundFootprints(before, [step("context", before, final)], final);
  assert.ok(owned(result, "context", "context").some((record) => has(record, "first")));
  assert.ok(!owned(result, "context").some((record) => has(record, "first")));
  assert.ok(owned(result, "context").some((record) => record.kind === "directive"));
});

test("an earlier physical writer keeps ownership through a later context change", () => {
  const before = { "main.cpp": first };
  const middle = {
    "a.cpp": "#define VALUE 1\n" + first.replace("return 1", "return VALUE"),
    "main.cpp": "",
  };
  const final = { ...middle, "a.cpp": middle["a.cpp"].replace("VALUE 1", "VALUE 2") };
  const result = prepareAtomicRoundFootprints(
    before,
    [step("move", before, middle), step("context", middle, final)],
    final,
  );
  const expected = prepareCoherentContract(final).obligations.find((record) =>
    has(record, "first"),
  );
  assert.ok(owned(result, "move").some(({ id }) => id === expected.id));
  assert.ok(owned(result, "context", "context").some(({ id }) => id === expected.id));
  assert.ok(!owned(result, "context").some((record) => has(record, "first")));
});

test("a later deletion retains explicit endpoint absence goals for earlier owners", () => {
  const before = { "a.cpp": first };
  const middle = { "b.cpp": first };
  const final = { "b.cpp": "" };
  const result = prepareAtomicRoundFootprints(
    before,
    [step("move", before, middle), step("delete", middle, final)],
    final,
  );
  assert.equal(owned(result, "move").length, 0);
  assert.ok(
    atom(result, "move").counts.some(
      ({ record, count }) => record.file === "b.cpp" && has(record, "first") && count === 0,
    ),
  );
  assert.ok(
    atom(result, "delete").counts.some(
      ({ record, count }) => record.file === "b.cpp" && has(record, "first") && count === 0,
    ),
  );
});

test("duplicate-count changes are explicit physical requirements", () => {
  const before = { "a.cpp": "int first();\nint first();\n" };
  const final = { "a.cpp": "int first();\n" };
  const result = prepareAtomicRoundFootprints(before, [step("deduplicate", before, final)], final);
  assert.ok(
    atom(result, "deduplicate").counts.some(
      ({ record, count }) => has(record, "first") && count === 1,
    ),
  );
  assert.ok(owned(result, "deduplicate").some((record) => has(record, "first")));
});

test("empty-file deletion remains a goal without inventing token requirements", () => {
  const before = { "a.cpp": "", "main.cpp": first };
  const final = { "main.cpp": first };
  const result = prepareAtomicRoundFootprints(before, [step("delete-file", before, final)], final);
  assert.deepEqual(atom(result, "delete-file").files, [{ file: "a.cpp", present: false }]);
  assert.equal(atom(result, "delete-file").records.length, 0);
});

test("stale, incomplete, repeated and forged trusted transitions are rejected", () => {
  const final = { "a.cpp": first, "main.cpp": second };
  const effect = step("move", tree, final);
  for (const effects of [
    [],
    [effect, effect],
    [{ ...effect, effect: { ...effect.effect, remove: [] } }],
    [{ ...effect, filesBefore: [] }],
    [
      {
        ...effect,
        effect: { ...effect.effect, add: [...effect.effect.add, ...effect.effect.add] },
      },
    ],
  ])
    assert.throws(() => prepareAtomicRoundFootprints(tree, effects, final));
  assert.throws(() =>
    prepareAtomicRoundFootprints(tree, [effect], { "a.cpp": first, "main.cpp": "" }),
  );
});
