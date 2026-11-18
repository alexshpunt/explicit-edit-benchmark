import assert from "node:assert/strict";
import test from "node:test";
import {
  gradeMixedProbe,
  mixedProbeVerdict,
  renameProse,
} from "../../src/suites/explicit-edit-multi-agent/extraction/mixed-probe.mjs";

const marker = "// __EXPLICIT_EDIT_SLOT_1_1__";
const unit = "struct Pair {\n  int left;\n};";
const start = [
  "#pragma region a.h",
  marker,
  "#pragma endregion",
  "",
  unit,
  "int twice(int value) { return value + value; }",
  "int use(Pair p) { return twice(p.left); }",
  "",
].join("\n");
const expected = [
  "#pragma region a.h",
  unit.replace("left", "first"),
  "#pragma endregion",
  "",
  "",
  "int doubled(int value) { return value + value; }",
  "int use(Pair p) { return doubled(p.first); }",
  "",
].join("\n");
const probe = {
  setup: { markers: new Set([marker]) },
  start: { "main.cpp": start },
  expected: { "main.cpp": expected },
  moves: [{ id: "a-1", file: "a.h", text: unit }],
  renames: [
    { kind: "unique", role: "function", name: "twice", newName: "doubled" },
    { kind: "shared", role: "field", name: "left", newName: "first", container: "Pair" },
  ],
};

test("the reference passes every check and the start none", () => {
  const reference = gradeMixedProbe(probe, expected);
  assert.deepEqual(reference.all, { passed: 3, total: 3 });
  assert.equal(reference.exact, true);
  assert.deepEqual(gradeMixedProbe(probe, start).all, { passed: 0, total: 3 });
});

test("each move and rename is graded on its own", () => {
  // The unit moved without its rename, and one use kept the old function name.
  const partial = expected
    .replace("int first;", "int left;")
    .replace("return doubled(p.first)", "return twice(p.first)");
  const grade = gradeMixedProbe(probe, partial);
  assert.deepEqual(grade.moves, { passed: 1, total: 1 });
  assert.deepEqual(grade.failed.sort(), ["rename-shared-left", "rename-unique-twice"]);
  // A copy left behind fails the move, but not the renames.
  const copy = expected.replace(
    "\n\n\nint doubled",
    `\n\n${unit.replace("left", "first")}\nint doubled`,
  );
  assert.deepEqual(gradeMixedProbe(probe, copy).failed, ["a-1"]);
});

test("the integrity gate catches unrelated code moved into a destination region", () => {
  const clean = gradeMixedProbe(probe, expected);
  const declaration = "int use(Pair p) { return doubled(p.first); }";
  const candidate = expected
    .replace(declaration + "\n", "")
    .replace("#pragma endregion", declaration + "\n#pragma endregion");
  const grade = gradeMixedProbe(probe, candidate);
  assert.deepEqual(grade.all, clean.all);
  assert.equal(grade.integrity.passed, false);
  assert.equal(grade.integrity.lines.misplaced, 1);
  assert.equal(grade.integrity.affectedLines, 1);
  assert.deepEqual(grade.integrity.byRegion["a.h"].candidate, { misplaced: 1 });
  const verdict = (checks, failedDeliveries = 0) =>
    mixedProbeVerdict({
      status: "complete",
      checks,
      buildPassed: true,
      resultMatched: true,
      failedDeliveries,
    });
  assert.equal(verdict(grade), "integrity-failed");
  assert.equal(verdict(clean), "pass");
  assert.equal(verdict(clean, 1), "incomplete");
  assert.equal(verdict(gradeMixedProbe(probe, start)), "incomplete");
  assert.equal(clean.integrity.passed, true);
});

test("missed tasks, wrong same-spelled renames and blank layout lines are not collateral", () => {
  const untouched = gradeMixedProbe(probe, start);
  assert.equal(untouched.integrity.passed, true);
  const wrongField = start.replace("int twice", "int first");
  // Change only an occurrence of the original spelling, but not the assigned field.
  const withOther = (text) => text + "struct Other { int left; };\n";
  const other = {
    ...probe,
    start: { "main.cpp": withOther(start) },
    expected: { "main.cpp": withOther(expected) },
  };
  const partial = withOther(expected)
    .replace("Other { int left;", "Other { int first;")
    .replace("int first;\n};", "int left;\n};");
  const grade = gradeMixedProbe(other, "  \n" + partial.replace("int use", "   int use"));
  assert.equal(grade.integrity.passed, true);
  assert.ok(grade.failed.includes("rename-shared-left"));
  assert.equal(gradeMixedProbe(probe, wrongField).integrity.passed, false);
});

test("the gate distinguishes loss, duplication, replacement and added text", () => {
  const suffix =
    'int keep = 2;\nint lost = 1;\n// twice\nint separator = 3;\nconst char* text = "twice";\n';
  const extended = {
    ...probe,
    start: { "main.cpp": start + suffix },
    expected: { "main.cpp": expected + suffix },
  };
  const damaged =
    expected +
    suffix
      .replace("int lost = 1;\n", "")
      .replace("// twice", "// doubled")
      .replace("int separator = 3;", "int separator = 3;\nint keep = 2;")
      .replace('"twice"', '"doubled"') +
    "int extra = 4;\n";
  const integrity = gradeMixedProbe(extended, damaged).integrity;
  assert.equal(integrity.passed, false);
  // Deletion and replacement in the same hunk count one replacement and one
  // loss. Addition and replacement in the last hunk count one of each.
  assert.deepEqual(integrity.lines, { changed: 2, lost: 1, duplicated: 1, misplaced: 0, added: 1 });
  assert.equal(integrity.affectedLines, 5);
});

test("keeping a second copy of an assigned move fails integrity", () => {
  const grade = gradeMixedProbe(probe, expected + unit + "\n");
  assert.deepEqual(grade.failed, ["a-1"]);
  assert.equal(grade.integrity.passed, false);
  assert.equal(grade.integrity.lines.duplicated, 3);
});

test("rename prose names the symbol and keeps comments and literals", () => {
  const prose = renameProse(probe.renames[1]);
  assert.match(prose, /rename the field `left` of the struct `Pair` to `first`/);
  assert.match(prose, /Comments and string literals stay unchanged/);
  assert.match(prose, /Several agents are editing main\.cpp at the same time/);
});
