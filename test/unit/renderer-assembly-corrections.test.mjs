import assert from "node:assert/strict";
import test from "node:test";
import { assemblyCorrections } from "../../src/suites/explicit-edit-multi-agent/extraction/assembly-corrections.mjs";
import {
  compareLineDifferences,
  prepareLineDifferences,
} from "../../src/suites/explicit-edit-multi-agent/grading/line-differences.mjs";

const A = "float twice(float x) {\n  return x * 2.0f;\n}\n";
const B = "struct Pair {\n  int left;\n  int right;\n};\n";
const C = "using Real = float;\nconstexpr int kCount = 3;\n";
const D = "int answer() {\n  return 42;\n}\n";
const MAIN = '#include "a.h"\nint main() { return answer(); }\n';
const slot = (region, index) => `// __EXPLICIT_EDIT_SLOT_${region}_${index}__`;
const named = (id, file, kind, signature, text, marker) => ({
  id,
  file,
  kind: "named",
  description: { scope: "", kind, signature },
  text,
  marker,
});
const items = [
  named("a-1", "a.h", "function", "float twice(float x)", A, slot(1, 1)),
  named("a-2", "a.h", "struct", "struct Pair", B, slot(1, 2)),
  { id: "a-3", file: "a.h", kind: "block", text: C, marker: slot(1, 3) },
  named("b-1", "b.cpp", "function", "int answer()", D, slot(2, 1)),
];
const regions = [
  {
    file: "a.h",
    headerLines: ["#pragma once"],
    body: `#include <cmath>\n${slot(1, 1)}\n${slot(1, 2)}\n${slot(1, 3)}\n`,
    items: items.slice(0, 3),
  },
  { file: "b.cpp", headerLines: ['#include "a.h"'], body: `${slot(2, 1)}\n`, items: [items[3]] },
];
// As in preparation: a unit's text ends without a line break and replaces its placeholder.
for (const item of items) item.text = item.text.trimEnd();
const fill = (region) =>
  region.headerLines.map((line) => line + "\n").join("") +
  region.items.reduce((body, item) => body.replace(item.marker, item.text), region.body);
const setup = {
  items,
  regions,
  trees: {
    final: {
      "main.cpp": MAIN,
      ...Object.fromEntries(regions.map((region) => [region.file, fill(region)])),
    },
  },
};
const prepared = prepareLineDifferences({ "main.cpp": A + B + C + D + MAIN }, setup.trees.final);
const corrections = (candidate) =>
  assemblyCorrections(setup, prepared, compareLineDifferences(prepared, candidate), candidate);
const bodyLines = (text) => text.split("\n").slice(1, -2);

test("units are named by problem and place; only lost text is quoted", () => {
  const altered = A.replace("x * 2.0f", "x + x");
  const assignments = corrections({
    "main.cpp": MAIN,
    "a.h": `#pragma once\n#include <cmath>\n${altered}\n${C}\n${C}\n`,
    "b.cpp": `#include "a.h"\n${B}${D}\n`,
    "notes.txt": "int stray;\n",
  });
  const byFile = Object.fromEntries(assignments.map(({ file, prompt }) => [file, prompt]));
  assert.deepEqual(Object.keys(byFile).sort(), ["a.h", "notes.txt"]);
  const header = byFile["a.h"];
  assert.match(header, /The struct `struct Pair` in the global namespace belongs in a\.h after/);
  assert.match(
    header,
    /It is currently in b\.cpp, around line 2, after the line `#include "a\.h"`/,
  );
  assert.match(header, /An extra copy of the block of 2 lines from `using Real = float;`/);
  assert.match(
    header,
    /no longer exists anywhere in the project\. It belongs after the line `#include <cmath>` and before the struct `struct Pair` in the global namespace\. Its changed version is around line 4 of a\.h, from the line ` {2}return x \+ x;` to the line ` {2}return x \+ x;`; replace those lines/,
  );
  assert.equal(header.match(/^\d+\. /gm).length, 3, "The changed version has no separate item");
  assert.ok(header.includes("  return x * 2.0f;"), "Lost text is given in full");
  for (const line of [...bodyLines(B), "constexpr int kCount = 3;\n"])
    assert.ok(!header.includes(line.trim() + "\n"), `Existing unit text was quoted: ${line}`);
  assert.match(
    byFile["notes.txt"],
    /^Correct the project file notes\.txt\.[\s\S]*1\. Delete the file notes\.txt\./,
  );
});

test("an extra file gives its units back before it is deleted, a missing file is created first", () => {
  const assignments = corrections({
    "main.cpp": `${MAIN}${D}`,
    "a.h": `#pragma once\n#include <cmath>\n${A}\n${C}\n`,
    "a.hpp": B,
  });
  const byFile = Object.fromEntries(assignments.map(({ file, prompt }) => [file, prompt]));
  assert.deepEqual(Object.keys(byFile).sort(), ["a.hpp", "b.cpp"]);
  assert.match(
    byFile["a.hpp"],
    /1\. The struct `struct Pair`[^\n]*belongs in a\.h after the function `float twice\(float x\)` in the global namespace and before the block of 2 lines/,
  );
  assert.match(byFile["a.hpp"], /2\. After moving these units, delete the file a\.hpp\./);
  const created = byFile["b.cpp"];
  assert.match(created, /1\. The file b\.cpp does not exist yet; create it first\./);
  assert.match(
    created,
    /2\. At the beginning of the file:\nAdd these lines:\n```\n#include "a\.h"\n```/,
  );
  assert.match(
    created,
    /3\. The function `int answer\(\)` in the global namespace belongs in b\.cpp after the line `#include "a\.h"` and at the end of the file\. It is currently in main\.cpp/,
  );
  assert.ok(!created.includes("return 42;"));
});

test("units that moved together are described as one run", () => {
  const [{ prompt }, ...rest] = corrections({
    "main.cpp": MAIN,
    "a.h": `#pragma once\n#include <cmath>\n${C}\n`,
    "b.cpp": `#include "a.h"\n${A}\n${B}\n${D}\n`,
  });
  assert.equal(rest.length, 0);
  assert.match(
    prompt,
    /1\. These 2 consecutive units belong in a\.h, in this order, after the line `#include <cmath>` and before the block of 2 lines[^\n]*\. They are currently together and in the same order in b\.cpp, from around line 2, after the line `#include "a\.h"`, to around line 9\.[^\n]*\n- the function `float twice\(float x\)`[^\n]*\n- the struct `struct Pair`/,
  );
  assert.equal(prompt.match(/^\d+\. /gm).length, 1);
});

test("a scripted reference result needs no correction", () => {
  assert.deepEqual(corrections(setup.trees.final), []);
});
