import assert from "node:assert/strict";
import test from "node:test";
import {
  gradeMixedProbe,
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

test("rename prose names the symbol and keeps comments and literals", () => {
  const prose = renameProse(probe.renames[1]);
  assert.match(prose, /rename the field `left` of the struct `Pair` to `first`/);
  assert.match(prose, /Comments and string literals stay unchanged/);
  assert.match(prose, /Several agents are editing main\.cpp at the same time/);
});
