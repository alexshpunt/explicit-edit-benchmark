import test from "node:test";
import assert from "node:assert/strict";
import { cppStructure } from "../../src/suites/explicit-edit-multi-agent/cpp/cpp-structure.mjs";

test("a local macro directive remains part of the enclosing function", () => {
  const source =
    "int f() {\n#define STEP(x) ((x) + 1)\n  int a = STEP(2);\n#undef STEP\n  return a;\n}\nint g();\n";
  const result = cppStructure(source);
  assert.equal(result.units.length, 2);
  assert.equal(
    source.slice(result.units[0].start, result.units[0].end),
    source.slice(0, source.indexOf("\nint g")),
  );
});

test("an include inside a source unit is not silently accepted", () => {
  assert.throws(() => cppStructure('void f() {\n#include "nested.h"\n}\n'));
});
