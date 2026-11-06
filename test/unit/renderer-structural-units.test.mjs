import assert from "node:assert/strict";
import test from "node:test";
import { canonicalCppUnits } from "../../src/suites/explicit-edit-multi-agent/grading/canonical-snapshot.mjs";
import {
  compareStructuralUnits,
  prepareStructuralUnits,
} from "../../src/suites/explicit-edit-multi-agent/grading/structural-units.mjs";

const helper = "int helper(int value) {\n  return value + 1;\n}\n";
const other = "int other() {\n  return 2;\n}\n";
const start = {
  "main.cpp": `#include "shape.h"\n${helper}${other}int main() {\n  return helper(other());\n}\n`,
  "shape.h": "#pragma once\nint helper(int value);\n",
  "shape.cpp": '#include "shape.h"\n',
};
const reference = {
  ...start,
  "main.cpp": `#include "shape.h"\n${other}int main() {\n  return helper(other());\n}\n`,
  "shape.cpp": `#include "shape.h"\n${helper}`,
};

async function measure(candidate, from = start, to = reference) {
  const prepared = await prepareStructuralUnits(from, to);
  return { prepared, result: await compareStructuralUnits(prepared, candidate) };
}

test("a move counts its removal and its appearance", async () => {
  const { prepared, result } = await measure(reference);
  assert.equal(prepared.totalUnits, 2);
  assert.deepEqual(result.differenceIds, []);
});

test("an unchanged candidate misses both halves of a move", async () => {
  const { result } = await measure(start);
  assert.deepEqual(result.differences.map(({ kind }) => kind).sort(), [
    "missing-addition",
    "missing-removal",
  ]);
});

test("a copy without removal costs one disagreement", async () => {
  const { result } = await measure({ ...start, "shape.cpp": reference["shape.cpp"] });
  assert.deepEqual(
    result.differences.map(({ kind, unit }) => [kind, unit.file]),
    [["missing-removal", "main.cpp"]],
  );
});

test("an altered move and an altered unrelated function each cost two", async () => {
  const renamed = reference["shape.cpp"].replace("value + 1", "value + 2");
  const altered = await measure({ ...reference, "shape.cpp": renamed });
  assert.equal(altered.result.differenceIds.length, 2);
  const damaged = await measure({
    ...reference,
    "main.cpp": reference["main.cpp"].replace("return 2", "return 3"),
  });
  assert.deepEqual(damaged.result.differences.map(({ kind }) => kind).sort(), [
    "unexpected-addition",
    "unexpected-removal",
  ]);
});

test("deleting an unrelated function costs one", async () => {
  const { result } = await measure({
    ...reference,
    "main.cpp": reference["main.cpp"].replace(other, ""),
  });
  assert.deepEqual(
    result.differences.map(({ kind }) => kind),
    ["unexpected-removal"],
  );
});

test("a stray empty declaration moved between files costs two", async () => {
  const { result } = await measure(
    {
      ...reference,
      "main.cpp": reference["main.cpp"] + ";\n",
      "shape.cpp": reference["shape.cpp"] + ";\n",
    },
    { ...start, "main.cpp": start["main.cpp"] + ";\n" },
    { ...reference, "main.cpp": reference["main.cpp"] + ";\n" },
  );
  assert.equal(result.differenceIds.length, 1);
  const moved = await measure(
    { ...reference, "shape.cpp": reference["shape.cpp"] + ";\n" },
    { ...start, "main.cpp": start["main.cpp"] + ";\n" },
    { ...reference, "main.cpp": reference["main.cpp"] + ";\n" },
  );
  assert.deepEqual(moved.result.differences.map(({ kind }) => kind).sort(), [
    "unexpected-addition",
    "unexpected-removal",
  ]);
});

test("a rename changes every unit that spells the old name", async () => {
  const before = { "a.cpp": "int f();\nint g() {\n  return f();\n}\nint h() {\n  return 0;\n}\n" };
  const after = { "a.cpp": "int k();\nint g() {\n  return k();\n}\nint h() {\n  return 0;\n}\n" };
  const prepared = await prepareStructuralUnits(before, after);
  assert.equal(prepared.totalUnits, 4);
  const partial = await compareStructuralUnits(prepared, {
    "a.cpp": "int k();\nint g() {\n  return f();\n}\nint h() {\n  return 0;\n}\n",
  });
  assert.deepEqual(partial.differences.map(({ kind }) => kind).sort(), [
    "missing-addition",
    "missing-removal",
  ]);
});

test("duplicates count by multiplicity and placement inside a scope is ignored", async () => {
  const before = { "a.cpp": "int a() {\n  return 1;\n}\nint b() {\n  return 2;\n}\n" };
  const prepared = await prepareStructuralUnits(before, {
    "a.cpp": before["a.cpp"] + "int c() {\n  return 3;\n}\n",
  });
  const reordered = await compareStructuralUnits(prepared, {
    "a.cpp": "int c() {\n  return 3;\n}\nint b() {\n  return 2;\n}\nint a() {\n  return 1;\n}\n",
  });
  assert.deepEqual(reordered.differenceIds, []);
  const twice = await compareStructuralUnits(prepared, {
    "a.cpp": before["a.cpp"] + "int c() {\n  return 3;\n}\n".repeat(3),
  });
  assert.deepEqual(
    twice.differences.map(({ kind }) => kind),
    ["unexpected-addition", "unexpected-addition"],
  );
  assert.equal(new Set(twice.differenceIds).size, 2);
});

test("class members are units inside the class scope", async () => {
  const before = { "s.h": "struct S {\n  int x;\n  void m() {}\n  void n() {}\n};\n" };
  const after = { "s.h": "struct S {\n  int x;\n  void m() {}\n  void p() {}\n};\n" };
  const prepared = await prepareStructuralUnits(before, after);
  assert.equal(prepared.totalUnits, 2);
  const wrongScope = await compareStructuralUnits(prepared, {
    "s.h": "struct S {\n  int x;\n  void m() {}\n};\nstruct T {\n  void p() {}\n};\n",
  });
  assert.deepEqual(
    wrongScope.differences.map(({ kind, unit }) => [kind, unit.scope.join(" / ")]).sort(),
    [
      ["missing-addition", "struct S"],
      ["unexpected-addition", "struct T"],
    ],
  );
});

test("ordered members and directives keep their relative order", async () => {
  const before = { "a.h": "#include <a>\n#include <b>\nstruct S {\n  int x;\n  int y;\n};\n" };
  const prepared = await prepareStructuralUnits(before, {
    "a.h": before["a.h"] + "int z();\n",
  });
  const swapped = await compareStructuralUnits(prepared, {
    "a.h": "#include <b>\n#include <a>\nstruct S {\n  int y;\n  int x;\n};\nint z();\n",
  });
  assert.equal(swapped.differenceIds.length, 4);
});

test("conditional branches and namespaces are distinct scopes", async () => {
  const units = await canonicalCppUnits(
    "namespace a::b {\nint f();\n}\n#if X\nint k;\n#else\nint l;\n#endif\nstruct E {};\n",
  );
  assert.deepEqual(
    units.map(({ scope, kind, text }) => [scope.join(" / "), kind, text]),
    [
      ["namespace a / namespace b", "declaration", "int f ( ) ;"],
      ["#if X", "declaration", "int k ;"],
      ["#if X; #else", "declaration", "int l ;"],
      ["struct E", "empty-scope", ""],
    ],
  );
});

test("malformed, non-UTF-8, non-C++ and missing files are scored without throwing", async () => {
  const prepared = await prepareStructuralUnits(start, reference);
  const result = await compareStructuralUnits(prepared, {
    "main.cpp": "int main( {\n",
    "shape.h": Buffer.from([0xff, 0xfe, 0x41]),
    "notes.txt": "one\ntwo\n",
  });
  assert.ok(result.differenceIds.length > 0);
  assert.ok(result.differences.some(({ unit }) => unit.kind === "bytes"));
  assert.ok(result.differences.some(({ unit }) => unit.kind === "line"));
});

test("a round without reference changes is rejected during trusted preparation", async () => {
  await assert.rejects(prepareStructuralUnits(start, start), {
    code: "STRUCTURAL_UNITS_EMPTY_REFERENCE",
  });
});
