import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLineDifferences,
  prepareLineDifferences,
} from "../../src/suites/explicit-edit-multi-agent/grading/line-differences.mjs";
import { structuralUnitScore } from "../../src/suites/explicit-edit-multi-agent/grading/structural-unit-score.mjs";
import { lineDifferenceCorrections } from "../../src/suites/explicit-edit-multi-agent/execution/line-difference-corrections.mjs";

const structBody = "struct Ctx {\n  int a = {};\n  int b = 0;\n};\n";
const tail = Array.from({ length: 50 }, (_, index) => `int f${index}();\n`).join("");
// The moved block crosses more lines than it holds, so the cheapest diff moves the block.
const start = {
  "main.cpp": `#pragma region a.h\n#pragma endregion\n${tail}${structBody}int g();\n`,
};
const reference = {
  "main.cpp": `#pragma region a.h\n${structBody}int g();\n#pragma endregion\n${tail}`,
};
const cut = `#pragma region a.h\nstruct Ctx {\n  int a = {};\nint g();\n#pragma endregion\n${tail}  int b = 0;\n};\n`;

test("a move counts its removal and its insertion, blank lines and trailing spaces do not", () => {
  const prepared = prepareLineDifferences(start, reference);
  assert.equal(prepared.totalUnits, 2 * 5);
  const spaced = {
    "main.cpp": reference["main.cpp"].replace("int g();", "int g();   \n\n\n"),
  };
  assert.deepEqual(compareLineDifferences(prepared, spaced).differenceIds, []);
  assert.equal(compareLineDifferences(prepared, start).differenceIds.length, 10);
});

test("a struct that lost its closing lines costs only the lines that differ", () => {
  const prepared = prepareLineDifferences(start, reference);
  // A cut at the first `};` leaves the last field and the closing brace behind.
  const result = compareLineDifferences(prepared, { "main.cpp": cut });
  assert.equal(result.differenceIds.length, 4);
  const score = structuralUnitScore({
    initial: result,
    final: result,
    buildFirstPassed: false,
    preRecoveryBuildPassed: false,
    firstImageMatched: null,
    resultRecoveryAttempted: true,
    finalBuildPassed: false,
    finalImageMatched: null,
  });
  assert.equal(score.version, "renderer-line-difference-score-v1");
  assert.equal(score.structural.rawBalance, 6);
});

test("missing, extra and non-UTF-8 files are differences, order matters", () => {
  const prepared = prepareLineDifferences(
    { "main.cpp": "int a;\n" },
    {
      "main.cpp": "int b;\nint c;\n",
      "a.h": "#pragma once\n",
    },
  );
  const result = compareLineDifferences(prepared, {
    "main.cpp": "int c;\nint b;\n",
    "tool.py": "print(1)\n",
    "bad.h": Buffer.from([0xff]),
  });
  const kinds = result.differences.map(({ kind, unit }) => `${kind} ${unit.file} ${unit.kind}`);
  assert.ok(kinds.includes("missing-line a.h file"));
  assert.ok(kinds.includes("missing-line a.h line"));
  assert.ok(kinds.includes("extra-line tool.py file"));
  assert.ok(kinds.includes("extra-line bad.h bytes"));
  assert.equal(kinds.filter((kind) => kind.includes("main.cpp")).length, 2);
});

test("corrections describe each hunk in prose with its surrounding lines", () => {
  const prepared = prepareLineDifferences(start, reference);
  const result = compareLineDifferences(prepared, { "main.cpp": cut, "move.py": "import os\n" });
  const assignments = lineDifferenceCorrections(prepared, result);
  assert.deepEqual(
    assignments.map(({ file }) => file),
    ["main.cpp", "move.py"],
  );
  const [main, script] = assignments.map(({ prompt }) => prompt);
  assert.ok(main.startsWith("Correct the project file main.cpp."));
  assert.ok(
    main.includes(
      "right after these lines:\n```\n#pragma region a.h\nstruct Ctx {\n  int a = {};\n```",
    ),
  );
  assert.ok(main.includes("Add these lines:\n```\n  int b = 0;\n};\n```"));
  assert.ok(main.includes("Remove these lines:\n```\n  int b = 0;\n};\n```"));
  assert.ok(
    main.includes("right after these lines:\n```\nint f47();\nint f48();\nint f49();\n```"),
  );
  assert.ok(script.startsWith("Delete the file move.py."));
  assert.ok(!main.includes("\u0000") && !main.includes('{"'));
  assert.deepEqual(
    assignments.flatMap(({ differenceIds }) => differenceIds).sort(),
    [...result.differenceIds].sort(),
  );
});

test("a round without reference changes is rejected during preparation", () => {
  assert.throws(() => prepareLineDifferences(start, start), {
    code: "LINE_DIFFERENCES_EMPTY_REFERENCE",
  });
});
