import assert from "node:assert/strict";
import test from "node:test";
import {
  compareStructuralUnits,
  prepareStructuralUnits,
} from "../../src/suites/explicit-edit-multi-agent/grading/structural-units.mjs";
import {
  STRUCTURAL_UNIT_CORRECTION_POLICY,
  structuralUnitCorrections,
} from "../../src/suites/explicit-edit-multi-agent/execution/structural-unit-corrections.mjs";

const start = {
  "main.cpp": '#include "a.h"\nint f() {\n  return 1;\n}\nint main() {\n  return f();\n}\n',
  "a.h": "#pragma once\n",
};
const reference = {
  "main.cpp": '#include "a.h"\nint main() {\n  return f();\n}\n',
  "a.h": "#pragma once\nint f() {\n  return 1;\n}\n",
};

test("each file with disagreements gets one prose assignment naming every unit", async () => {
  const prepared = await prepareStructuralUnits(start, reference);
  const comparison = await compareStructuralUnits(prepared, { ...start, "extra.cpp": "int x;\n" });
  const assignments = structuralUnitCorrections(prepared, comparison);
  assert.deepEqual(assignments.map(({ file }) => file).sort(), ["a.h", "extra.cpp", "main.cpp"]);
  assert.deepEqual(
    assignments.flatMap(({ differenceIds }) => differenceIds).sort(),
    [...comparison.differenceIds].sort(),
  );
  const byFile = Object.fromEntries(assignments.map((item) => [item.file, item.prompt]));
  assert.match(byFile["a.h"], /Add one copy of this code\. Scope: file level/);
  assert.match(byFile["a.h"], /int f \( \) \{/);
  assert.match(byFile["main.cpp"], /Remove one copy of this code/);
  assert.match(
    byFile["extra.cpp"],
    /does not exist in the required result\. Delete the whole file/,
  );
  for (const prompt of Object.values(byFile)) {
    assert.equal(/[{[]\s*"/.test(prompt), false, "Assignments must not contain JSON");
    assert.equal(/missing-|unexpected-|[0-9a-f]{64}/.test(prompt), false);
  }
});

test("order-sensitive units name the unit before them in the required result", async () => {
  const prepared = await prepareStructuralUnits(
    { "s.h": "struct S {\n  int a;\n};\n" },
    { "s.h": "struct S {\n  int a;\n  int b;\n};\n" },
  );
  const comparison = await compareStructuralUnits(prepared, {
    "s.h": "struct S {\n  int a;\n};\n",
  });
  const [assignment] = structuralUnitCorrections(prepared, comparison);
  assert.match(assignment.prompt, /Scope: struct S\./);
  assert.match(assignment.prompt, /it comes after this code in the same scope:\n```\nint a ;\n```/);
});

test("large files are split into bounded parts without losing units", async () => {
  const body = Array.from({ length: 45 }, (_, index) => `int f${index}();\n`).join("");
  const prepared = await prepareStructuralUnits({ "a.cpp": "" }, { "a.cpp": body });
  const comparison = await compareStructuralUnits(prepared, { "a.cpp": "" });
  const assignments = structuralUnitCorrections(prepared, comparison);
  assert.equal(assignments.length, 3);
  assert.ok(
    assignments.every(
      ({ differenceIds }) => differenceIds.length <= STRUCTURAL_UNIT_CORRECTION_POLICY.maximumItems,
    ),
  );
  assert.match(assignments[0].prompt, /\(part 1 of 3\)/);
  assert.equal(new Set(assignments.map(({ id }) => id)).size, 3);
  assert.equal(
    assignments.reduce((sum, { differenceIds }) => sum + differenceIds.length, 0),
    comparison.differenceIds.length,
  );
});
