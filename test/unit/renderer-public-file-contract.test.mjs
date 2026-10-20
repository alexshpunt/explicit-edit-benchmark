import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceFilesAfter } from "../../src/suites/explicit-edit-multi-agent/tasks/task-constraints.mjs";
import { applyCoherentStructure } from "../../src/suites/explicit-edit-multi-agent/reference/coherent-edit.mjs";
import {
  evaluateCoherentContract,
  prepareCoherentContract,
} from "../../src/suites/explicit-edit-multi-agent/grading/coherent-grade.mjs";

test("public file effects match the actual guarded-header move and exclude an extra facade", () => {
  const before = {
    "main.cpp": "#ifndef NORTH_H\n#define NORTH_H\ninline int North() { return 1; }\n#endif\n",
  };
  const operation = {
    phase: "structure",
    action: "header",
    file: "north.h",
    guard: "NORTH_H",
    includes: [],
  };
  const after = applyCoherentStructure(before, operation);
  const declared = sourceFilesAfter(Object.keys(before), [operation]);
  assert.deepEqual(declared, Object.keys(after).sort());
  const contract = prepareCoherentContract(after);
  assert.deepEqual(contract.files, declared);
  assert.equal(evaluateCoherentContract(after, contract).status, "pass");
  const extra = { ...after, "forward.h": '#include "north.h"\n' };
  const grade = evaluateCoherentContract(extra, contract);
  assert.equal(grade.status, "fail");
  assert.equal(grade.obligations.find((item) => item.id === "files").status, "fail");
  assert.deepEqual(sourceFilesAfter(Object.keys(before), [operation]), declared);
});

test("only declared creation actions expand the cumulative source inventory", () => {
  const operations = [
    { phase: "structure", action: "header", file: "math.h" },
    { phase: "structure", action: "implementation", file: "math.cpp" },
    { phase: "structure", action: "implementation", file: "math.cpp" },
    { phase: "structure", action: "vendor-header", file: "support/image.h" },
    { phase: "structure", action: "vendor-implementation", file: "support/stb.cpp" },
    { phase: "structure", action: "remove-generated-declaration", file: "math.cpp" },
    { phase: "structure", action: "cleanup-empty-namespaces" },
    { phase: "names", category: "helpers", file: "math.cpp" },
  ];
  const expected = ["main.cpp", "math.cpp", "math.h", "support/image.h", "support/stb.cpp"];
  assert.deepEqual(sourceFilesAfter(["main.cpp"], operations), expected);
  let current = ["main.cpp"];
  for (const operation of operations) current = sourceFilesAfter(current, [operation]);
  assert.deepEqual(current, expected);
  assert.deepEqual(sourceFilesAfter(current, operations.slice(-3)), expected);
});

test("undeclared actions and unsafe source paths cannot silently define public permissions", () => {
  for (const file of ["../outside.h", "/absolute.cpp", "support/../other.h", "script.js"]) {
    assert.throws(() =>
      sourceFilesAfter(["main.cpp"], [{ phase: "structure", action: "header", file }]),
    );
  }
  assert.throws(() =>
    sourceFilesAfter(["main.cpp"], [{ phase: "structure", action: "unknown", file: "extra.h" }]),
  );
});
