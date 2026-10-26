import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { prepareAtomicEffect } from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-structural-effects.mjs";
import {
  prepareAtomicNamingBatch,
  applyAtomicNamingBatch,
} from "../../src/suites/explicit-edit-multi-agent/tasks/atomic-naming-replay.mjs";
import { prepareAtomicRoundFootprints } from "../../src/suites/explicit-edit-multi-agent/grading/round-footprints.mjs";
import { indexBarrierSymbolMap } from "../../src/suites/explicit-edit-multi-agent/grading/barrier-symbol-map.mjs";
import {
  prepareAtomicRoundCredit,
  evaluateAtomicRoundCredit,
} from "../../src/suites/explicit-edit-multi-agent/grading/atomic-round-credit.mjs";

const first = "int first() { return 1; }\n";
const second = "int second() { return 2; }\n";
const before = { "main.cpp": first + second + "int untouched() { return 7; }\n" };
const afterFirst = { "main.cpp": second + "int untouched() { return 7; }\n", "a.cpp": first };
const expected = { "main.cpp": "int untouched() { return 7; }\n", "a.cpp": first, "b.cpp": second };
const step = (id, from, to) => ({
  id,
  effect: prepareAtomicEffect(from, to),
  filesBefore: Object.keys(from).sort(),
  filesAfter: Object.keys(to).sort(),
});

async function fixture(
  t,
  initial = before,
  transitions = [step("a", before, afterFirst), step("b", afterFirst, expected)],
  final = expected,
  { structuralEndpoint = final, namingBatches = [], namingIds = [] } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "renderer-structural-credit-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let index = 0;
  const symbols = (tree) =>
    indexBarrierSymbolMap(tree, { evidence: path.join(directory, String(index++)) });
  const structuralFootprints = prepareAtomicRoundFootprints(
    initial,
    transitions,
    structuralEndpoint,
  );
  const prepared = prepareAtomicRoundCredit({
    beforeTree: initial,
    expectedTree: final,
    nodes: [
      ...transitions.map(({ id }) => ({ id, operations: [{ phase: "structure" }] })),
      ...namingIds.map((id) => ({ id, operations: [{ phase: "names" }] })),
    ],
    namingBatches,
    structuralFootprints,
    expectedSymbols: await symbols(final),
  });
  return (tree) =>
    symbols(tree).then((candidateSymbols) =>
      evaluateAtomicRoundCredit(tree, prepared, { candidateSymbols }),
    );
}
const outcomes = (result) => Object.fromEntries(result.atoms.map(({ id, passed }) => [id, passed]));

test("a certified spelling-only failure does not erase a correct mixed-round physical move", async (t) => {
  const source = "int first(int original) { return original; }\n";
  const initial = { "main.cpp": source + "int untouched() { return 7; }\n" };
  const moved = { "main.cpp": "int untouched() { return 7; }\n", "a.cpp": source };
  const batch = prepareAtomicNamingBatch(moved, [
    {
      id: "name",
      plan: {
        edits: [...source.matchAll(/\boriginal\b/g)].map((match) => ({
          file: "a.cpp",
          start: match.index,
          old: "original",
          new: "value",
        })),
      },
    },
  ]);
  const final = applyAtomicNamingBatch(moved, batch, batch.ids).tree;
  const grade = await fixture(t, initial, [step("move", initial, moved)], final, {
    structuralEndpoint: moved,
    namingBatches: [batch],
    namingIds: ["name"],
  });
  const unchangedName = await grade(moved);
  assert.deepEqual(outcomes(unchangedName), { move: true, name: false });
  assert.equal(unchangedName.integrityPassed, true);
  const good = await grade(final);
  assert.deepEqual(outcomes(good), { move: true, name: true });
  assert.equal(good.integrityPassed, true);
});

test("an incorrect new macro value still belongs to its assigned physical directive", async (t) => {
  const initial = { "main.cpp": "#define VALUE 1\n" + first.replace("return 1", "return VALUE") };
  const final = { "main.cpp": initial["main.cpp"].replace("VALUE 1", "VALUE 2") };
  const grade = await fixture(t, initial, [step("context", initial, final)], final);
  const result = await grade({ "main.cpp": final["main.cpp"].replace("VALUE 2", "VALUE 9") });
  assert.deepEqual(outcomes(result), { context: false });
  assert.equal(result.integrityPassed, true);
});
test("a context-only macro failure is attributable without claiming its unchanged consumers", async (t) => {
  const initial = { "main.cpp": "#define VALUE 1\n" + first.replace("return 1", "return VALUE") };
  const final = { "main.cpp": initial["main.cpp"].replace("VALUE 1", "VALUE 2") };
  const grade = await fixture(t, initial, [step("context", initial, final)], final);
  const result = await grade(initial);
  assert.deepEqual(outcomes(result), { context: false });
  assert.equal(result.integrityPassed, true);
});

test("context-only ownership cannot hide an untouched consumer body change", async (t) => {
  const initial = { "main.cpp": "#define VALUE 1\n" + first.replace("return 1", "return VALUE") };
  const final = { "main.cpp": initial["main.cpp"].replace("VALUE 1", "VALUE 2") };
  const grade = await fixture(t, initial, [step("context", initial, final)], final);
  const result = await grade({ "main.cpp": final["main.cpp"].replace("return VALUE", "return 8") });
  assert.equal(result.integrityPassed, false);
});

test("context-only ownership cannot hide an unrelated macro body change", async (t) => {
  const initial = {
    "main.cpp": "#define VALUE 1\n#define OTHER 3\n" + first.replace("return 1", "return VALUE"),
  };
  const final = { "main.cpp": initial["main.cpp"].replace("VALUE 1", "VALUE 2") };
  const grade = await fixture(t, initial, [step("context", initial, final)], final);
  const result = await grade({ "main.cpp": final["main.cpp"].replace("OTHER 3", "OTHER 8") });
  assert.equal(result.integrityPassed, false);
});

test("a later trusted inline conversion preserves earlier physical endpoint requirements", async (t) => {
  const initial = { "main.cpp": first + "int untouched() { return 7; }\n" };
  const middle = { "main.cpp": "int untouched() { return 7; }\n", "a.cpp": first };
  const final = { ...middle, "a.cpp": "inline " + first };
  const grade = await fixture(
    t,
    initial,
    [step("move", initial, middle), step("inline", middle, final)],
    final,
  );
  const good = await grade(final);
  assert.deepEqual(outcomes(good), { move: true, inline: true });
  assert.equal(good.integrityPassed, true);
  const damaged = await grade({
    ...final,
    "a.cpp": final["a.cpp"].replace("return 1", "return 9"),
  });
  assert.deepEqual(outcomes(damaged), { move: false, inline: false });
  assert.equal(damaged.integrityPassed, true);
});

test("a deleted endpoint remains absent for every earlier physical writer", async (t) => {
  const initial = { "main.cpp": first + "int untouched() { return 7; }\n" };
  const middle = { "main.cpp": "int untouched() { return 7; }\n", "a.cpp": first };
  const final = { ...middle, "a.cpp": "" };
  const grade = await fixture(
    t,
    initial,
    [step("move", initial, middle), step("delete", middle, final)],
    final,
  );
  const good = await grade(final);
  assert.deepEqual(outcomes(good), { move: true, delete: true });
  assert.equal(good.integrityPassed, true);
  const leftover = await grade(middle);
  assert.deepEqual(outcomes(leftover), { move: false, delete: false });
  assert.equal(leftover.integrityPassed, true);
});

test("explicit namespace cleanup rejects a leftover empty shell without a global veto", async (t) => {
  const setup = "#include <cstddef>\n";
  const initial = { "main.cpp": setup + "namespace spare { using std::size_t; }\n" };
  const final = { "main.cpp": setup };
  const transition = {
    ...step("cleanup", initial, final),
    cleanupScopes: [{ file: "main.cpp", scope: "spare" }],
  };
  const grade = await fixture(t, initial, [transition], final);
  const leftover = await grade({ "main.cpp": setup + "namespace spare { }\n" });
  assert.deepEqual(outcomes(leftover), { cleanup: false });
  assert.equal(leftover.integrityPassed, true);
  const good = await grade(final);
  assert.deepEqual(outcomes(good), { cleanup: true });
  assert.equal(good.integrityPassed, true);
});

for (const { name, candidate, passed } of [
  { name: "neither", candidate: before, passed: { a: false, b: false } },
  { name: "first", candidate: afterFirst, passed: { a: true, b: false } },
  { name: "both", candidate: expected, passed: { a: true, b: true } },
])
  test(`structural endpoint credit preserves independent ${name} moves`, async (t) => {
    const grade = await fixture(t);
    const result = await grade(candidate);
    assert.deepEqual(outcomes(result), passed);
    assert.equal(result.integrityPassed, true);
  });

test("leaving an old source copy fails its move but not an independent completed move", async (t) => {
  const grade = await fixture(t);
  const result = await grade({ ...expected, "main.cpp": first + expected["main.cpp"] });
  assert.deepEqual(outcomes(result), { a: false, b: true });
  assert.equal(result.integrityPassed, true);
});

test("damaging the still-unmoved assigned owner is attributable, not unrelated corruption", async (t) => {
  const grade = await fixture(t);
  const result = await grade({
    ...afterFirst,
    "main.cpp": afterFirst["main.cpp"].replace("return 2;", "return 8;"),
  });
  assert.deepEqual(outcomes(result), { a: true, b: false });
  assert.equal(result.integrityPassed, true);
});

test("unrequested unused-code corruption vetoes a structurally completed round", async (t) => {
  const grade = await fixture(t);
  const result = await grade({
    ...expected,
    "main.cpp": expected["main.cpp"].replace("return 7;", "return 8;"),
  });
  assert.equal(result.passed, 2);
  assert.equal(result.integrityPassed, false);
});

test("superseded physical destinations use the final endpoint for every affected atom", async (t) => {
  const initial = { "a.cpp": first };
  const middle = { "b.cpp": first };
  const final = { "c.cpp": first };
  const grade = await fixture(
    t,
    initial,
    [step("a", initial, middle), step("b", middle, final)],
    final,
  );
  const result = await grade(final);
  assert.deepEqual(outcomes(result), { a: true, b: true });
  assert.equal(result.integrityPassed, true);
});

test("missing optional-code import invalidates all moved consumers, not just its first writer", async (t) => {
  const setup = "#include <atomic>\n";
  const left = "int first() {\n#if 0\n atomic<int> left;\n#endif\n return 1; }\n";
  const right = "int second() {\n#if 0\n atomic<int> right;\n#endif\n return 2; }\n";
  const initial = { "main.cpp": setup + "using std::atomic;\n" + left + right };
  const middle = {
    "main.cpp": setup + "using std::atomic;\n" + right,
    "a.cpp": setup + "using std::atomic;\n" + left,
  };
  const final = { "main.cpp": setup, "a.cpp": setup + "using std::atomic;\n" + left + right };
  const grade = await fixture(
    t,
    initial,
    [step("a", initial, middle), step("b", middle, final)],
    final,
  );
  const result = await grade({
    ...final,
    "a.cpp": final["a.cpp"].replace("using std::atomic;\n", ""),
  });
  assert.deepEqual(outcomes(result), { a: false, b: false });
  assert.equal(result.integrityPassed, true);
});
